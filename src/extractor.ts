import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, sha256Bytes } from "./hash.ts";
import { FigmaRateLimitError, FigmaRestClient, mapPool } from "./figma.ts";
import { normalizeFigmaFile, sealHashes } from "./normalize.ts";
import { validateFingerprint } from "./validate.ts";
import { digestFingerprint } from "./digest.ts";
import type { DesignFingerprintV1, FigmaFileResponse, FigmaNode } from "./types.ts";

export interface ExtractOptions { fileKey: string; nodeId?: string; outputDir: string; token: string; scale?: number; }
/** Phase 1 of an extraction: the normalized node tree (seconds). Enough to plan assets while phase 2 waits for Figma's slow target render. */
export interface FetchedDesign { fingerprint: DesignFingerprintV1; refetched: boolean; client: FigmaRestClient; timings: Record<string, number>; startedAt: number; }
export interface ExtractionResult { fingerprint: DesignFingerprintV1; fingerprintPath: string; targetPath: string; manifestPath: string; digestPath: string; warnings: string[]; apiCalls: number; timings: Record<string, number>; }
interface AssetDownloadSummary { candidates: number; downloaded: number; cached: number; missing: number; failed: number; missingSamples: string[]; failedSamples: string[]; }

const FILL_URL_TTL_MS = 6 * 60 * 60 * 1000;
/** One imageRef→URL lookup per file per process: pages extracted side by side share it (a rejected one too — never re-ask after a 429). */
const fillUrlLookups = new Map<string, Promise<Record<string, string>>>();

function extension(contentType: string | null): string {
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return "jpg";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("svg")) return "svg";
  if (contentType?.includes("gif")) return "gif";
  return "bin";
}

/**
 * Image fills are file-wide and repeat across pages, so both the imageRef→URL map (one rate-limited
 * call) and the original bytes are cached per file key next to the extraction outputs.
 */
async function downloadImageAssets(client: FigmaRestClient, fileKey: string, fingerprint: DesignFingerprintV1, outputDir: string, warnings: string[]): Promise<AssetDownloadSummary> {
  const images = fingerprint.assets.items.filter((asset) => asset.type === "image" && asset.imageRef);
  const summary: AssetDownloadSummary = { candidates: images.length, downloaded: 0, cached: 0, missing: 0, failed: 0, missingSamples: [], failedSamples: [] };
  if (!images.length) return summary;
  const cacheDir = join(dirname(outputDir), ".cache", fileKey); const imageCacheDir = join(cacheDir, "images");
  await mkdir(imageCacheDir, { recursive: true });
  const cachedFiles = new Map((await readdir(imageCacheDir)).map((file) => [file.replace(/\.[^.]+$/, ""), file]));

  // Memoize the promise, not the value: every worker of every page must share ONE rate-limited lookup.
  const lookupKey = `${cacheDir}|${fileKey}`;
  const fillUrls = (): Promise<Record<string, string>> => {
    let lookup = fillUrlLookups.get(lookupKey);
    if (!lookup) {
      lookup = (async () => {
        const urlCachePath = join(cacheDir, "fills.json");
        try { const cached = JSON.parse(await readFile(urlCachePath, "utf8")) as { fetchedAt: number; urls: Record<string, string>; }; if (Date.now() - cached.fetchedAt < FILL_URL_TTL_MS) return cached.urls; } catch { /* no cache yet */ }
        const urls = await client.getImageFillUrls(fileKey);
        await writeFile(urlCachePath, JSON.stringify({ fetchedAt: Date.now(), urls }));
        return urls;
      })();
      fillUrlLookups.set(lookupKey, lookup);
    }
    return lookup;
  };
  let limited: FigmaRateLimitError | undefined;

  const assetsDir = join(outputDir, "assets", "images"); await mkdir(assetsDir, { recursive: true });
  await mapPool(images, 8, async (asset) => {
    try {
      let bytes: Uint8Array; let ext: string;
      const cachedName = cachedFiles.get(asset.imageRef!);
      if (cachedName) { bytes = new Uint8Array(await readFile(join(imageCacheDir, cachedName))); ext = cachedName.split(".").pop()!; summary.cached++; }
      else {
        const url = (await fillUrls())[asset.imageRef!];
        if (!url) { summary.missing++; if (summary.missingSamples.length < 5) summary.missingSamples.push(asset.imageRef!); return; }
        const image = await client.downloadWithContentType(url); bytes = image.bytes; ext = extension(image.contentType);
        await writeFile(join(imageCacheDir, `${asset.imageRef}.${ext}`), bytes); summary.downloaded++;
      }
      const hash = sha256Bytes(bytes); const filename = `${hash.slice(0, 20)}.${ext}`;
      await writeFile(join(assetsDir, filename), bytes); asset.hash = hash; asset.localPath = `assets/images/${filename}`;
    } catch (error) {
      // The target render may already have succeeded: keep it and report the missing photos plainly.
      if (error instanceof FigmaRateLimitError) { limited = error; summary.missing++; return; }
      summary.failed++; if (summary.failedSamples.length < 5) summary.failedSamples.push(asset.imageRef!);
    }
  });
  if (limited) warnings.push(`image fills unavailable — ${limited.message}`);
  if (summary.missing && summary.missingSamples.length) warnings.push(`${summary.missing} image fill(s) had no downloadable URL. Samples: ${summary.missingSamples.join(", ")}`);
  if (summary.failed) warnings.push(`${summary.failed} image fill(s) could not be downloaded. Samples: ${summary.failedSamples.join(", ")}`);
  return summary;
}

const timedInto = (timings: Record<string, number>) => async <T>(label: string, work: () => Promise<T>): Promise<T> => { const from = Date.now(); try { return await work(); } finally { timings[label] = Date.now() - from; } };

/**
 * Node trees of several targets of one file in ONE /nodes request — Tier-1 calls are the scarce resource
 * (View/Collab seats get a handful per month). A node that is a page resolves to its first frame, which
 * costs one extra request for that page only.
 */
const FILE_CACHE = fileURLToPath(new URL("../outputs/.cache/", import.meta.url));
/** Long enough to list a file's frames and then build them without asking Figma a second time. */
const WHOLE_FILE_TTL_MS = 12 * 60 * 60 * 1000;
export interface WholeFile { body: FigmaFileResponse; fetchedAt: number; cached: boolean; }

/**
 * The whole document in ONE Tier-1 request, cached per file key. On quota-starved seats (Starter plan,
 * View/Collab) it answers both "which frames are there" and every node lookup of the build that follows.
 */
export async function loadWholeFile(options: { fileKey: string; token?: string; client?: FigmaRestClient; refresh?: boolean; cacheOnly?: boolean; cacheDir?: string; /** Accept an older read (default: 12 h). */ maxAgeMs?: number; }): Promise<WholeFile | undefined> {
  const path = join(options.cacheDir ?? FILE_CACHE, options.fileKey, "file.json");
  if (!options.refresh) {
    const cached = await readFile(path, "utf8").then((text) => JSON.parse(text) as { fetchedAt: number; body: FigmaFileResponse; }, () => undefined);
    if (cached && Date.now() - cached.fetchedAt < (options.maxAgeMs ?? WHOLE_FILE_TTL_MS)) return { body: cached.body, fetchedAt: cached.fetchedAt, cached: true };
  }
  if (options.cacheOnly) return undefined;
  const client = options.client ?? new FigmaRestClient(options.token ?? "");
  const body = await client.getFile(options.fileKey); const fetchedAt = Date.now();
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ fetchedAt, body }));
  return { body, fetchedAt, cached: false };
}

/** The DOCUMENT → PAGE → node wrapper `getNodes` returns, carved out of a whole-file read. */
export function nodeFromWholeFile(file: FigmaFileResponse, fileKey: string, nodeId: string): FigmaFileResponse {
  const find = (node: FigmaNode): FigmaNode | undefined => node.id === nodeId ? node : ((node.children ?? []) as FigmaNode[]).map(find).find(Boolean);
  const node = find(file.document);
  if (!node) throw new Error(`Figma did not return node ${nodeId}. Check that it exists and is accessible.`);
  const page = node.type === "CANVAS" || node.type === "PAGE" ? node : { id: `synthetic-page:${nodeId}`, name: "Selected node", type: "CANVAS", children: [node] };
  return { name: file.name, version: file.version, lastModified: file.lastModified, document: { id: `document:${fileKey}`, name: file.name || "Selected Figma node", type: "DOCUMENT", children: [page] }, components: file.components, componentSets: file.componentSets, styles: file.styles };
}

/**
 * A reused extraction, re-read by the current normalizer from a whole-file read of the SAME file version: what a
 * newer compiler understands (prototype overlays, constraints…) without a request, while target.png and the
 * downloaded images stay valid. Undefined when no such read exists.
 */
export async function renormalize(fingerprint: DesignFingerprintV1, cacheDir?: string): Promise<DesignFingerprintV1 | undefined> {
  const { fileKey, version } = fingerprint.source; const target = fingerprint.targets[0];
  const whole = await loadWholeFile({ fileKey, cacheOnly: true, maxAgeMs: Infinity, cacheDir });
  if (!whole || !version || whole.body.version !== version) return undefined;
  let fresh: DesignFingerprintV1;
  try { fresh = normalizeFigmaFile(nodeFromWholeFile(whole.body, fileKey, target.nodeId), { fileKey, selectedNodeId: target.nodeId, extractedAt: fingerprint.source.extractedAt }); } catch { return undefined; }
  if (fresh.targets[0].nodeId !== target.nodeId) return undefined;
  const downloaded = new Map(fingerprint.assets.items.map((item) => [item.imageRef, item]));
  for (const item of fresh.assets.items) { const known = downloaded.get(item.imageRef); if (known) { item.localPath = known.localPath; item.hash = known.hash; } }
  Object.assign(fresh.targets[0], { imageUrl: target.imageUrl, localPath: target.localPath, scale: target.scale, hash: target.hash });
  fresh.hashes.assets = sha256(fresh.assets.items); sealHashes(fresh.hashes); validateFingerprint(fresh);
  return fresh;
}

export async function fetchDesignNodesBatch(options: { fileKey: string; nodeIds: string[]; token: string; client?: FigmaRestClient; /** A whole-file read to take the nodes from instead of asking Figma. */ wholeFile?: FigmaFileResponse; }): Promise<FetchedDesign[]> {
  const startedAt = Date.now(); const client = options.client ?? new FigmaRestClient(options.token);
  const shared: Record<string, number> = {}; const whole = options.wholeFile;
  const raws = whole ? Object.fromEntries(options.nodeIds.map((id) => [id, nodeFromWholeFile(whole, options.fileKey, id)])) : await timedInto(shared)("nodes", () => client.getNodes(options.fileKey, [...new Set(options.nodeIds)]));
  return Promise.all(options.nodeIds.map(async (nodeId) => {
    const timings = { ...shared };
    let fingerprint = normalizeFigmaFile(raws[nodeId], { fileKey: options.fileKey, selectedNodeId: nodeId });
    const refetched = fingerprint.targets[0].nodeId !== nodeId;
    if (refetched) {
      const resolved = fingerprint.targets[0].nodeId;
      const raw = whole ? nodeFromWholeFile(whole, options.fileKey, resolved) : await timedInto(timings)("nodesRefetch", () => client.getNode(options.fileKey, resolved));
      fingerprint = normalizeFigmaFile(raw, { fileKey: options.fileKey, selectedNodeId: fingerprint.targets[0].nodeId });
    }
    validateFingerprint(fingerprint);
    return { fingerprint, refetched, client, timings, startedAt };
  }));
}

export interface TargetRender { nodeId: string; width: number; height: number; scale: number; }
/**
 * Figma's renders of several targets of one file with as few requests as its render service tolerates:
 * one per scale, split only past `maxPixels`. A batch that fails for a reason other than a rate limit
 * (a render timeout) falls back to one request per node. Keys are `<nodeId>@<scale>`.
 */
export function renderTargetUrls(client: FigmaRestClient, fileKey: string, targets: TargetRender[], maxPixels = 60e6): Map<string, Promise<string>> {
  const urls = new Map<string, Promise<string>>(); const chunks: TargetRender[][] = [];
  const unique = [...new Map(targets.map((target) => [`${target.nodeId}@${target.scale}`, target])).values()];
  for (const scale of new Set(unique.map((target) => target.scale))) {
    let chunk: TargetRender[] = []; let pixels = 0;
    for (const target of unique.filter((entry) => entry.scale === scale)) {
      const area = target.width * target.height * scale * scale;
      if (chunk.length && pixels + area > maxPixels) { chunks.push(chunk); chunk = []; pixels = 0; }
      chunk.push(target); pixels += area;
    }
    if (chunk.length) chunks.push(chunk);
  }
  for (const chunk of chunks) {
    const scale = chunk[0].scale;
    const batch = client.getImageUrls(fileKey, chunk.map((target) => target.nodeId), { format: "png", scale });
    for (const target of chunk) {
      const url = batch.then(
        (images) => images[target.nodeId] ?? Promise.reject(new Error(`Figma did not return a PNG URL for node ${target.nodeId}.`)),
        (error: unknown) => error instanceof FigmaRateLimitError || chunk.length === 1 ? Promise.reject(error) : client.getPngUrl(fileKey, target.nodeId, scale));
      url.catch(() => undefined); // the page that awaits it reports the failure
      urls.set(`${target.nodeId}@${scale}`, url);
    }
  }
  return urls;
}

export async function fetchDesignNodes(options: Pick<ExtractOptions, "fileKey" | "nodeId" | "token">): Promise<FetchedDesign> {
  if (options.nodeId) return (await fetchDesignNodesBatch({ fileKey: options.fileKey, nodeIds: [options.nodeId], token: options.token }))[0];
  const startedAt = Date.now(); const timings: Record<string, number> = {}; const timed = timedInto(timings);
  const client = new FigmaRestClient(options.token);
  // Discovery pass: a shallow (depth=2) file read locates the first renderable target without downloading the full document tree.
  let raw = await timed("nodes", () => client.getFile(options.fileKey, { depth: 2 }));
  let fingerprint = normalizeFigmaFile(raw, { fileKey: options.fileKey, selectedNodeId: options.nodeId });
  // Whenever the resolved target is not literally the requested node (a page link resolved to its first
  // frame, or whole-file discovery), refetch just that subtree so the fingerprint is complete yet small.
  const refetched = fingerprint.targets[0].nodeId !== options.nodeId;
  if (refetched) {
    raw = await timed("nodesRefetch", () => client.getNode(options.fileKey, fingerprint.targets[0].nodeId));
    fingerprint = normalizeFigmaFile(raw, { fileKey: options.fileKey, selectedNodeId: fingerprint.targets[0].nodeId });
  }
  validateFingerprint(fingerprint);
  return { fingerprint, refetched, client, timings, startedAt };
}

/** Phase 2: image fills and Figma's render of the target, side by side, then everything is written to disk. */
export async function completeExtraction(fetched: FetchedDesign, options: ExtractOptions, shared: { /** From renderTargetUrls: this target's URL out of a batched render. */ targetUrl?: Promise<string>; } = {}): Promise<ExtractionResult> {
  const { fingerprint, refetched, client, timings, startedAt } = fetched; const timed = timedInto(timings);
  const target = fingerprint.targets[0]; const scale = options.scale ?? target.scale; const warnings = ["Variables registry is empty in v1 unless a compatible variables source is added."];
  await mkdir(options.outputDir, { recursive: true }); const targetPath = join(options.outputDir, "target.png"); const fingerprintPath = join(options.outputDir, "fingerprint.json"); const manifestPath = join(options.outputDir, "manifest.json");
  // The target render and the image-fill downloads are independent: run them side by side.
  const [assetDownload] = await Promise.all([
    timed("assets", () => downloadImageAssets(client, options.fileKey, fingerprint, options.outputDir, warnings)),
    timed("target", async () => {
      const imageUrl = await (shared.targetUrl ?? client.getPngUrl(options.fileKey, target.nodeId, scale)); const image = await client.download(imageUrl);
      target.imageUrl = imageUrl; target.localPath = "target.png"; target.scale = scale; target.hash = sha256Bytes(image);
      await writeFile(targetPath, image);
    }),
  ]);
  // Downloads mutate asset items (hash/localPath), so the asset section hash is refreshed before writing.
  fingerprint.hashes.assets = sha256(fingerprint.assets.items);
  sealHashes(fingerprint.hashes);
  await writeFile(fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`);
  const digest = digestFingerprint(fingerprint); const digestPath = join(options.outputDir, "digest.md");
  await writeFile(digestPath, digest.markdown);
  await writeFile(join(options.outputDir, "digest.json"), `${JSON.stringify(digest.data, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify({
    schema: "figma-extraction-manifest",
    version: "2.0",
    extractedAt: fingerprint.source.extractedAt,
    durationMs: Date.now() - startedAt,
    timings, apiCalls: client.apiCalls,
    source: fingerprint.source,
    files: { fingerprint: "fingerprint.json", target: "target.png", assets: "assets/images", digest: "digest.md", digestData: "digest.json" },
    targetSelection: { requestedNodeId: options.nodeId || null, resolvedTargetNodeId: target.nodeId, reason: options.nodeId ? (refetched ? "first-renderable-target-in-requested-page" : "requested-node") : "first-renderable-target-in-file" },
    selectedTarget: target,
    assetDownload,
    warnings
  }, null, 2)}\n`);
  return { fingerprint, fingerprintPath, targetPath, manifestPath, digestPath, warnings, apiCalls: client.apiCalls, timings };
}

export async function extractFigmaDesign(options: ExtractOptions): Promise<ExtractionResult> { return completeExtraction(await fetchDesignNodes(options), options); }

/** Test/fixture helper: the live REST download intentionally does not run here. */
export function normalizeFixture(raw: FigmaFileResponse, fileKey: string, nodeId?: string): DesignFingerprintV1 { const fingerprint = normalizeFigmaFile(raw, { fileKey, selectedNodeId: nodeId, extractedAt: "2026-08-07T00:00:00.000Z" }); validateFingerprint(fingerprint); return fingerprint; }

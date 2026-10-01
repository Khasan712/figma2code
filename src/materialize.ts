import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { FigmaRateLimitError, FigmaRestClient, mapPool } from "./figma.ts";
import { flatFileName, type FlatPlan, type IRResult, type RNode, type Tint } from "./ir.ts";

/**
 * Turns the IR's asset plan into files next to the generated page:
 *  - flats (icons, vectors, illustrations): ONE batched Figma render per format (SVG / PNG@2x),
 *    falling back to pixel-identical crops of target.png when the API is unavailable, when the
 *    node samples the page behind it, or when the compare proved an isolated render wrong;
 *  - image fills: copied once, capped at dpr × their largest displayed size.
 * A manifest in the assets dir remembers how each file was produced and where its pixels sit,
 * so unchanged assets are never re-rendered. A crop fallback stays until an explicit `--mode api`
 * run upgrades it: render requests are the scarcest Figma quota and are never spent implicitly.
 */
interface Rect { x: number; y: number; w: number; h: number; }
interface FlatEntry { file: string; source: "api" | "crop"; /** Root-relative rect the image covers. */ image?: Rect; /** Figma file version the pixels came from. */ version?: string; /** Crop chosen on purpose (backdrop / failed compare): never retry the API for it. */ pinned?: boolean; /** Layers divided out of a crop, so a changed plan re-crops. */ tints?: string; }
interface AssetManifest { flats: Record<string, FlatEntry>; images: Record<string, { capW: number; capH: number; }>; }
export interface RenderFlatsOptions { assetsDir: string; fileKey: string; token: string; plans: FlatPlan[]; version?: string; dpr?: number; }
export interface RenderFlatsResult { rendered: number; unplaceable: string[]; apiCalls: number; /** Set instead of throwing: whatever did render is kept. */ error?: Error; }
export interface MaterializeOptions {
  designDir: string; assetsDir: string; ir: IRResult; fileKey: string; mode: "auto" | "api" | "crop"; token?: string; dpr?: number; quality?: number;
  /** Figma file version of the extraction; assets rendered from another version are redone. */
  version?: string;
  /** Flats whose isolated render the compare proved wrong: use the design's own pixels and remember that choice. */
  forceCrop?: string[];
  /** Ignore what the manifest says is already rendered. */
  refresh?: boolean;
}
export interface MaterializeResult { flats: { api: number; crop: number; cached: number; }; images: { copied: number; resized: number; cached: number; }; apiCalls: number; warnings: string[]; ms: number; }

const r2 = (value: number): number => Math.round(value * 100) / 100;
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
/** Every rendering of a node: itself, inside a state's cases, and the copies a state renders elsewhere (`<id>~<where>`). */
function renderingsOf(node: RNode, id: string, found: RNode[] = []): RNode[] {
  if (node.id === id || node.id.startsWith(`${id}~`)) found.push(node);
  for (const child of [...node.children, ...(node.cases ?? [])]) renderingsOf(child, id, found);
  return found;
}

// One manifest object per assets dir for the whole process: concurrent page builds share it, writes are serialized.
const manifests = new Map<string, Promise<AssetManifest>>(); let writeChain: Promise<void> = Promise.resolve();
const manifestPathOf = (assetsDir: string): string => join(assetsDir, "figma2code-assets.json");
function loadManifest(assetsDir: string): Promise<AssetManifest> {
  let pending = manifests.get(assetsDir);
  if (!pending) { pending = readFile(manifestPathOf(assetsDir), "utf8").then((text) => JSON.parse(text) as AssetManifest, () => ({ flats: {}, images: {} })); manifests.set(assetsDir, pending); }
  return pending;
}
function saveManifest(assetsDir: string, manifest: AssetManifest): Promise<void> { writeChain = writeChain.then(() => writeFile(manifestPathOf(assetsDir), `${JSON.stringify(manifest, null, 2)}\n`)); return writeChain; }
/** After a rate limit there is no point asking again in the same run. */
let apiBlocked: Error | undefined;
/** How a crop is cut: the layers divided out of it and where the frame sits in Figma's render. */
const cropKey = (plan: FlatPlan, shift: { x: number; y: number; }): string => [plan.tints?.length ? JSON.stringify(plan.tints) : "", shift.x || shift.y ? `@${shift.x},${shift.y}` : ""].filter(Boolean).join("|");

/**
 * target.png holds the layers painted above a crop's rect; a translucent solid one (a modal's dimming backdrop)
 * is divided back out — B = (P − α·C) / (1 − α), topmost first — because the page paints it again on top.
 */
export function untint(data: Buffer, width: number, height: number, left: number, top: number, tints: Tint[]): void {
  for (const tint of [...tints].reverse()) {
    const keep = 1 - tint.alpha; if (keep <= 0.001) continue;
    const x0 = Math.max(0, Math.floor(tint.x - left)), y0 = Math.max(0, Math.floor(tint.y - top)), x1 = Math.min(width, Math.ceil(tint.x + tint.w - left)), y1 = Math.min(height, Math.ceil(tint.y + tint.h - top));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 4; if (data[at + 3] === 0) continue;
      for (let channel = 0; channel < 3; channel++) data[at + channel] = Math.max(0, Math.min(255, Math.round((data[at + channel] - tint.alpha * tint.color[channel]) / keep)));
    }
  }
}

/** Rendered by this process: fresh by definition, even under --refresh. */
const freshThisRun = new Set<string>();

interface CacheRules { assetsDir: string; mode: "auto" | "api" | "crop"; version?: string; refresh?: boolean; forced?: Set<string>; /** How a crop of this plan would be cut now; a crop cut differently is redone (free — never an API render). */ cropKey?: (plan: FlatPlan) => string; }
async function usable(plan: FlatPlan, entry: FlatEntry, rules: CacheRules): Promise<boolean> {
  if (rules.refresh && !entry.pinned && !freshThisRun.has(plan.id) || !await exists(join(rules.assetsDir, entry.file))) return false;
  if (entry.version && rules.version && entry.version !== rules.version) return false;
  if (entry.source === "crop" && rules.cropKey && (entry.tints ?? "") !== rules.cropKey(plan)) return false;
  if (rules.forced?.has(plan.id) || plan.backdrop) return entry.source === "crop";
  return entry.source === "api" || entry.pinned === true || rules.mode !== "api";
}
/** Plans the manifest cannot satisfy and an isolated Figma render can — what is worth asking the API for. */
export async function flatsToRender(plans: FlatPlan[], rules: Omit<CacheRules, "forced">): Promise<FlatPlan[]> {
  const manifest = await loadManifest(rules.assetsDir); const out: FlatPlan[] = [];
  for (const plan of plans) { const entry = manifest.flats[plan.id]; if (!plan.backdrop && !(entry && await usable(plan, entry, rules))) out.push(plan); }
  return out;
}

/**
 * An isolated Figma render is never cut by the node's ancestors, while the design's render bounds are.
 * When the two sizes disagree, the image is re-anchored on the side no ancestor clips.
 */
export function reconcile(plan: FlatPlan, natural: { w: number; h: number; }): Rect | undefined {
  const image: Rect = plan.hasRenderBounds ? { ...plan.rect } : { ...plan.box };
  const axis = (extra: number, startClipped: boolean, endClipped: boolean): "keep" | "start" | "end" | undefined => Math.abs(extra) <= 1 ? "keep" : extra > 1 && startClipped !== endClipped ? (endClipped ? "start" : "end") : undefined;
  const horizontal = axis(natural.w - image.w, !!plan.clipped?.left, !!plan.clipped?.right), vertical = axis(natural.h - image.h, !!plan.clipped?.top, !!plan.clipped?.bottom);
  if (!horizontal || !vertical) return undefined;
  if (horizontal !== "keep") { if (horizontal === "end") image.x = r2(image.x + image.w - natural.w); image.w = natural.w; }
  if (vertical !== "keep") { if (vertical === "end") image.y = r2(image.y + image.h - natural.h); image.h = natural.h; }
  return image;
}

/** The API half of the asset step. Needs neither target.png nor the downloaded fills, so it can run while Figma still renders the target. */
export async function renderFlats(options: RenderFlatsOptions): Promise<RenderFlatsResult> {
  const dpr = options.dpr ?? 2; const result: RenderFlatsResult = { rendered: 0, unplaceable: [], apiCalls: 0 };
  const plans = options.plans.filter((plan) => !plan.backdrop); if (!plans.length) return result;
  if (apiBlocked) return { ...result, error: apiBlocked };
  await mkdir(options.assetsDir, { recursive: true });
  const manifest = await loadManifest(options.assetsDir); const client = new FigmaRestClient(options.token);
  // Legacy fingerprints have no render bounds: render exactly the node box instead.
  const batches: { format: "svg" | "png"; exact: boolean; plans: FlatPlan[]; }[] = [];
  for (const format of ["svg", "png"] as const) for (const exact of [true, false]) { const group = plans.filter((plan) => plan.format === format && plan.hasRenderBounds === exact); if (group.length) batches.push({ format, exact, plans: group }); }
  try {
    await Promise.all(batches.map(async (batch) => {
      const urls = await client.getImageUrls(options.fileKey, batch.plans.map((plan) => plan.id), { format: batch.format, scale: batch.format === "png" ? dpr : undefined, useAbsoluteBounds: !batch.exact });
      await mapPool(batch.plans, 8, async (plan) => {
        const url = urls[plan.id]; if (!url) return;
        const bytes = await client.download(url); const meta = await sharp(bytes).metadata(); const scale = batch.format === "png" ? dpr : 1;
        const image = reconcile(plan, { w: (meta.width ?? 0) / scale, h: (meta.height ?? 0) / scale });
        if (!image) { result.unplaceable.push(plan.id); return; }
        const file = flatFileName(plan.id, batch.format); await writeFile(join(options.assetsDir, file), bytes);
        manifest.flats[plan.id] = { file, source: "api", image, version: options.version }; freshThisRun.add(plan.id); result.rendered++;
      });
    }));
  } catch (error) {
    result.error = error instanceof Error ? error : new Error(String(error));
    if (error instanceof FigmaRateLimitError) apiBlocked = error;
  }
  result.apiCalls = client.apiCalls; await saveManifest(options.assetsDir, manifest);
  return result;
}

export async function materialize(options: MaterializeOptions): Promise<MaterializeResult> {
  const startedAt = Date.now(); const dpr = options.dpr ?? 2; const quality = options.quality ?? 82;
  const result: MaterializeResult = { flats: { api: 0, crop: 0, cached: 0 }, images: { copied: 0, resized: 0, cached: 0 }, apiCalls: 0, warnings: [], ms: 0 };
  await mkdir(options.assetsDir, { recursive: true });
  const manifest = await loadManifest(options.assetsDir); const forced = new Set(options.forceCrop ?? []);

  // ── flats ──
  const apply = (plan: FlatPlan, entry: FlatEntry): void => {
    plan.file = entry.file; const image = entry.image ?? plan.box;
    const sameBox = Math.abs(image.x - plan.box.x) < 0.01 && Math.abs(image.y - plan.box.y) < 0.01 && Math.abs(image.w - plan.box.w) < 0.01 && Math.abs(image.h - plan.box.h) < 0.01;
    for (const node of renderingsOf(options.ir.root, plan.id)) {
      node.src = entry.file;
      node.imgStyle = sameBox ? undefined : { position: "absolute", left: r2(image.x - plan.box.x), top: r2(image.y - plan.box.y), width: r2(image.w), height: r2(image.h), maxWidth: "none" };
      // A crop is the finished composite: blending it again would apply the effect twice.
      if (entry.source === "crop") delete node.style.mixBlendMode;
    }
  };
  // target.png covers what the frame paints outside itself (shadow, overflow) when there is any: crops shift into it.
  const targetPath = join(options.designDir, "target.png");
  const meta = await sharp(targetPath, { limitInputPixels: 1e9 }).metadata().catch(() => undefined);
  const canvasW = meta?.width ?? 0, canvasH = meta?.height ?? 0; const { render } = options.ir;
  const shift = canvasW > Math.round(options.ir.root.w) || canvasH > Math.round(options.ir.root.h) ? { x: Math.round(render.dx), y: Math.round(render.dy) } : { x: 0, y: 0 };
  const rules: CacheRules = { assetsDir: options.assetsDir, mode: options.mode, version: options.version, refresh: options.refresh, forced, cropKey: (plan) => cropKey(plan, shift) };
  // Entries written before image rects were recorded: measure the file that is already on disk instead of rendering again.
  const located = async (plan: FlatPlan, entry: FlatEntry): Promise<boolean> => {
    if (entry.image) return true;
    const meta = await sharp(join(options.assetsDir, entry.file), { limitInputPixels: 1e9 }).metadata().catch(() => undefined); if (!meta?.width || !meta.height) return false;
    const scale = entry.source === "api" && /\.png$/i.test(entry.file) ? dpr : 1;
    entry.image = entry.source === "api" ? reconcile(plan, { w: meta.width / scale, h: meta.height / scale }) : { x: Math.floor(plan.rect.x), y: Math.floor(plan.rect.y), w: meta.width, h: meta.height };
    return !!entry.image;
  };
  let pending: FlatPlan[] = [];
  for (const plan of options.ir.flats) {
    const entry = manifest.flats[plan.id];
    if (entry && await usable(plan, entry, rules) && await located(plan, entry)) { apply(plan, entry); if (freshThisRun.has(plan.id)) result.flats.api++; else result.flats.cached++; } else pending.push(plan);
  }

  const renderable = pending.filter((plan) => !plan.backdrop && !forced.has(plan.id));
  if (renderable.length && options.mode !== "crop" && options.token) {
    const rendered = await renderFlats({ assetsDir: options.assetsDir, fileKey: options.fileKey, token: options.token, plans: renderable, version: options.version, dpr });
    result.apiCalls += rendered.apiCalls;
    if (rendered.unplaceable.length) result.warnings.push(`${rendered.unplaceable.length} Figma render(s) could not be aligned with the design (clipped on both sides) — using design crops: ${rendered.unplaceable.join(", ")}`);
    if (rendered.error) {
      if (options.mode === "api") throw rendered.error;
      result.warnings.push(`Figma render unavailable (${rendered.error.message}) — using target.png crops for ${renderable.length - rendered.rendered} flat asset(s); once the API opens, rebuild with --mode api to upgrade them.`);
    }
    pending = pending.filter((plan) => { const entry = manifest.flats[plan.id]; if (entry?.source !== "api" || !renderable.includes(plan) || entry.version !== options.version) return true; apply(plan, entry); result.flats.api++; return false; });
  }

  if (pending.length) {
    // The design's own pixels at 1×: exact in the compare by construction, soft on retina, background baked in.
    const tainted: string[] = [];
    await mapPool(pending, 4, async (plan) => {
      const left = Math.floor(plan.rect.x), top = Math.floor(plan.rect.y), right = Math.ceil(plan.rect.x + plan.rect.w), bottom = Math.ceil(plan.rect.y + plan.rect.h);
      // Cut in target.png's own pixels (shifted when the render covers more than the frame); the result stays in frame coordinates.
      const cl = Math.max(0, left + shift.x), ct = Math.max(0, top + shift.y), cr = Math.min(canvasW, right + shift.x), cb = Math.min(canvasH, bottom + shift.y);
      const file = flatFileName(plan.id, "png");
      if (cr <= cl || cb <= ct) await sharp({ create: { width: Math.max(1, right - left), height: Math.max(1, bottom - top), channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(join(options.assetsDir, file));
      else {
        const { data, info } = await sharp(targetPath, { limitInputPixels: 1e9 }).extract({ left: cl, top: ct, width: cr - cl, height: cb - ct })
          .extend({ left: cl - left - shift.x, top: ct - top - shift.y, right: right + shift.x - cr, bottom: bottom + shift.y - cb, background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (plan.tints?.length) untint(data, info.width, info.height, left, top, plan.tints);
        await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(join(options.assetsDir, file));
      }
      if (plan.tainted) tainted.push(plan.id);
      // The crop covers whole pixels: the image sits on that integer rect.
      const entry: FlatEntry = { file, source: "crop", image: { x: left, y: top, w: right - left, h: bottom - top }, version: options.version, ...(forced.has(plan.id) || plan.backdrop ? { pinned: true } : {}), ...(cropKey(plan, shift) ? { tints: cropKey(plan, shift) } : {}) };
      manifest.flats[plan.id] = entry; apply(plan, entry); result.flats.crop++;
    });
    if (tainted.length) result.warnings.push(`${tainted.length} crop(s) lie under a translucent layer that cannot be divided out (gradient, image or effect) — --mode api renders them cleanly: ${tainted.slice(0, 8).join(", ")}${tainted.length > 8 ? " …" : ""}`);
  }

  // ── image fills ──
  await mapPool(options.ir.images, 4, async (image) => {
    const source = join(options.designDir, "assets", "images", image.file); const dest = join(options.assetsDir, image.file);
    const capW = Math.ceil(image.maxW * dpr), capH = Math.ceil(image.maxH * dpr);
    const known = manifest.images[image.file];
    if (known && known.capW >= capW && known.capH >= capH && await exists(dest)) { result.images.cached++; return; }
    if (!await exists(source)) { result.warnings.push(`image fill ${image.file} missing from the extraction`); return; }
    const needW = Math.max(capW, known?.capW ?? 0), needH = Math.max(capH, known?.capH ?? 0);
    const pipeline = sharp(source, { limitInputPixels: 1e9 }).rotate(); const meta = await pipeline.metadata();
    if ((meta.width ?? 0) > needW && (meta.height ?? 0) > needH) {
      // "outside": the image must still COVER the largest box it is displayed in.
      const resized = pipeline.resize(needW, needH, { fit: "outside", withoutEnlargement: true });
      const buffer = /\.png$/i.test(image.file) ? await resized.png({ compressionLevel: 9, effort: 8 }).toBuffer() : /\.(jpe?g)$/i.test(image.file) ? await resized.jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer() : await resized.toBuffer();
      await writeFile(dest, buffer); result.images.resized++;
    } else { await copyFile(source, dest); result.images.copied++; }
    manifest.images[image.file] = { capW: needW, capH: needH };
  });

  await saveManifest(options.assetsDir, manifest);
  result.ms = Date.now() - startedAt;
  return result;
}

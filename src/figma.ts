import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FigmaFileResponse, FigmaNode } from "./types.ts";

export interface FigmaReference { fileKey: string; nodeId?: string; }

/** Accepts Figma design/file/proto URLs and normalizes node IDs to Figma's `12:34` form. */
export function parseFigmaReference(input: string): FigmaReference {
  const url = new URL(input);
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) throw new Error("Expected a figma.com URL.");
  const segments = url.pathname.split("/").filter(Boolean);
  const marker = segments.findIndex((segment) => ["design", "file", "proto"].includes(segment));
  const fileKey = marker >= 0 ? segments[marker + 1] : undefined;
  if (!fileKey) throw new Error("Could not find a Figma file key in the URL.");
  const nodeId = url.searchParams.get("node-id")?.replace(/-/g, ":") || undefined;
  return { fileKey, nodeId };
}

/**
 * Figma's file/image endpoints are tightly rate limited (per seat and plan). A 429 carries
 * Retry-After — surfacing it turns hours of blind polling into an informed decision.
 */
export class FigmaRateLimitError extends Error {
  readonly retryAfterSec: number | undefined;
  readonly planTier: string | undefined;
  readonly limitType: string | undefined;
  /** True when no request was sent: an earlier 429 said the endpoint stays closed until later. */
  readonly remembered: boolean;
  constructor(path: string, retryAfterSec: number | undefined, planTier: string | undefined, limitType: string | undefined, remembered = false) {
    const wait = retryAfterSec === undefined ? "unknown wait" : retryAfterSec >= 3600 ? `${(retryAfterSec / 3600).toFixed(1)}h` : `${Math.ceil(retryAfterSec / 60)}min`;
    // "low" is Figma's bucket for View/Collab seats on the plan that owns the file: a handful of file/render
    // requests per MONTH. A copy of the file in a team where the token's user has a Full/Dev seat is not throttled like that.
    const seatHint = limitType === "low" ? " Limit type \"low\" means the token's user only has a View/Collab seat on the plan that owns this file (a few file/render requests per month): use a token of a user with a Dev/Full seat there, or a copy of the file in a team where you have one." : "";
    super(`Figma API rate limit (429) for ${path.split("?")[0]} — retry after ${wait}${planTier ? `, plan tier ${planTier}` : ""}${limitType ? `, limit type ${limitType}` : ""}${remembered ? " (remembered from an earlier 429 — no request sent)" : ""}.${seatHint}`);
    this.name = "FigmaRateLimitError"; this.retryAfterSec = retryAfterSec; this.planTier = planTier; this.limitType = limitType; this.remembered = remembered;
  }
}

interface LimitState { until: string; planTier?: string; limitType?: string; }
const DEFAULT_LIMIT_STATE = fileURLToPath(new URL("../outputs/.cache/figma-rate-limit.json", import.meta.url));

/** Runs `worker` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index], index); }
  }));
  return results;
}

export interface ImageExportOptions { format: "png" | "svg"; scale?: number; useAbsoluteBounds?: boolean; }

export class FigmaRestClient {
  private readonly baseUrl = "https://api.figma.com/v1";
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  /** Count of rate-limited API calls made — the scarce resource worth reporting. */
  apiCalls = 0;
  /** Requests actually sent by every client in this process, per endpoint family (nodes / render / fills / file). */
  static readonly sent: Record<string, number> = {};
  /** Where 429 verdicts are remembered between runs; only the real network client persists them by default. */
  private readonly limitStatePath: string | undefined;
  /** Limits belong to the token's user: a verdict for one token must not block another. Never the token itself. */
  private readonly tokenTag: string;
  constructor(token: string, fetcher: typeof fetch = fetch, limitStatePath: string | undefined = fetcher === fetch ? DEFAULT_LIMIT_STATE : undefined) {
    if (!token) throw new Error("FIGMA_ACCESS_TOKEN is required for live Figma extraction.");
    this.token = token;
    this.tokenTag = createHash("sha256").update(token).digest("hex").slice(0, 12);
    this.fetcher = fetcher;
    this.limitStatePath = limitStatePath;
  }

  /** Figma throttles per endpoint family and per file's plan: `<fileKey>:<family>`. */
  private static bucket(path: string): string {
    const match = path.match(/^\/(files|images)\/([^/?]+)(\/nodes|\/images)?/);
    if (!match) return path.split("?")[0];
    return `${match[2]}:${match[1] === "images" ? "render" : match[3] === "/nodes" ? "nodes" : match[3] === "/images" ? "fills" : "file"}`;
  }
  private async limitState(): Promise<Record<string, LimitState>> {
    if (!this.limitStatePath) return {};
    return readFile(this.limitStatePath, "utf8").then((text) => JSON.parse(text) as Record<string, LimitState>, () => ({}));
  }

  /** A remembered 429 for this token on one endpoint family of a file, while it is still in force. */
  async blockedUntil(fileKey: string, family: "nodes" | "render" | "fills" | "file"): Promise<Date | undefined> {
    const entry = (await this.limitState())[`${this.tokenTag}:${fileKey}:${family}`];
    return entry && Date.parse(entry.until) > Date.now() ? new Date(entry.until) : undefined;
  }

  private async request(path: string): Promise<Response> {
    const bucket = `${this.tokenTag}:${FigmaRestClient.bucket(path)}`; const state = await this.limitState(); const blocked = state[bucket];
    if (blocked && Date.parse(blocked.until) > Date.now()) throw new FigmaRateLimitError(path, Math.ceil((Date.parse(blocked.until) - Date.now()) / 1000), blocked.planTier, blocked.limitType, true);
    this.apiCalls++; const family = bucket.split(":").pop()!; FigmaRestClient.sent[family] = (FigmaRestClient.sent[family] ?? 0) + 1;
    const response = await this.fetcher(`${this.baseUrl}${path}`, { headers: { "X-Figma-Token": this.token } });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")); const planTier = response.headers.get("x-figma-plan-tier") || undefined, limitType = response.headers.get("x-figma-rate-limit-type") || undefined;
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
      if (this.limitStatePath && seconds) {
        const next = { ...(await this.limitState()), [bucket]: { until: new Date(Date.now() + seconds * 1000).toISOString(), planTier, limitType } };
        await mkdir(dirname(this.limitStatePath), { recursive: true }); await writeFile(this.limitStatePath, `${JSON.stringify(next, null, 2)}\n`);
      }
      throw new FigmaRateLimitError(path, seconds, planTier, limitType);
    }
    if (!response.ok) throw new Error(`Figma API ${response.status} for ${path}: ${await response.text()}`);
    return response;
  }

  /** `depth` limits the returned tree (2 = pages plus their top-level children) for cheap target discovery. */
  async getFile(fileKey: string, options: { depth?: number } = {}): Promise<FigmaFileResponse> {
    const depth = options.depth ? `&depth=${options.depth}` : "";
    return this.request(`/files/${encodeURIComponent(fileKey)}?geometry=paths${depth}`).then((response) => response.json() as Promise<FigmaFileResponse>);
  }

  /** Fetches only a requested node subtree (see getNodes). */
  async getNode(fileKey: string, nodeId: string): Promise<FigmaFileResponse> {
    return (await this.getNodes(fileKey, [nodeId]))[nodeId];
  }

  /**
   * Several node subtrees of one file in ONE rate-limited request. Each is wrapped in a
   * minimal DOCUMENT → PAGE → node tree so the normalizer uses one code path.
   */
  async getNodes(fileKey: string, nodeIds: string[]): Promise<Record<string, FigmaFileResponse>> {
    const path = `/files/${encodeURIComponent(fileKey)}/nodes?ids=${nodeIds.map(encodeURIComponent).join(",")}&geometry=paths`;
    const body = await this.request(path).then((response) => response.json() as Promise<FigmaFileResponse & { nodes?: Record<string, { document?: FigmaNode; components?: Record<string, FigmaNode>; componentSets?: Record<string, FigmaNode>; styles?: Record<string, FigmaNode>; } | null>; }>);
    const result: Record<string, FigmaFileResponse> = {};
    for (const nodeId of nodeIds) {
      const selected = body.nodes?.[nodeId];
      if (!selected?.document) throw new Error(`Figma did not return node ${nodeId}. Check that it exists and is accessible.`);
      const node = selected.document;
      const isPage = node.type === "CANVAS" || node.type === "PAGE";
      const page = isPage ? node : { id: `synthetic-page:${nodeId}`, name: "Selected node", type: "CANVAS", children: [node] };
      result[nodeId] = {
        name: body.name,
        version: body.version,
        lastModified: body.lastModified,
        document: { id: `document:${fileKey}`, name: body.name || "Selected Figma node", type: "DOCUMENT", children: [page] },
        components: selected.components,
        componentSets: selected.componentSets,
        styles: selected.styles,
      };
    }
    return result;
  }

  /**
   * Render URLs for MANY nodes in ONE rate-limited request. Figma returns null for nodes it
   * cannot render (invisible/empty); callers decide the fallback.
   */
  async getImageUrls(fileKey: string, nodeIds: string[], options: ImageExportOptions): Promise<Record<string, string | null>> {
    if (!nodeIds.length) return {};
    const scale = options.scale ?? 1;
    if (!Number.isFinite(scale) || scale < 0.01 || scale > 4) throw new Error("Image scale must be between 0.01 and 4.");
    const query = [`ids=${nodeIds.map(encodeURIComponent).join(",")}`, `format=${options.format}`, options.format === "png" ? `scale=${scale}` : "svg_outline_text=true", options.useAbsoluteBounds ? "use_absolute_bounds=true" : ""].filter(Boolean).join("&");
    const body = await this.request(`/images/${encodeURIComponent(fileKey)}?${query}`).then((response) => response.json() as Promise<{ images?: Record<string, string | null>; err?: string; }>);
    if (!body.images) throw new Error(body.err || "Figma returned no image URLs.");
    return body.images;
  }

  async getPngUrl(fileKey: string, nodeId: string, scale = 1, options: { useAbsoluteBounds?: boolean } = {}): Promise<string> {
    const images = await this.getImageUrls(fileKey, [nodeId], { format: "png", scale, useAbsoluteBounds: options.useAbsoluteBounds });
    const imageUrl = images[nodeId];
    if (!imageUrl) throw new Error(`Figma did not return a PNG URL for node ${nodeId}.`);
    return imageUrl;
  }

  async download(url: string): Promise<Uint8Array> {
    return (await this.downloadWithContentType(url)).bytes;
  }

  /** Asset downloads hit S3/CDN URLs, not the rate-limited API. */
  async downloadWithContentType(url: string): Promise<{ bytes: Uint8Array; contentType: string | null; }> {
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Could not download Figma-rendered image (${response.status}).`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
  }

  async getImageFillUrls(fileKey: string): Promise<Record<string, string>> {
    const body = await this.request(`/files/${encodeURIComponent(fileKey)}/images`).then((response) => response.json() as Promise<{ images?: Record<string, string>; meta?: { images?: Record<string, string>; }; }>);
    // Figma has returned both the legacy top-level shape and the newer meta shape.
    if (body.images && Object.keys(body.images).length > 0) return body.images;
    return body.meta?.images || body.images || {};
  }
}

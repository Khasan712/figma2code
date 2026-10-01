import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FigmaRateLimitError, FigmaRestClient } from "../src/figma.ts";
import { completeExtraction, fetchDesignNodesBatch, renderTargetUrls } from "../src/extractor.ts";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
const frame = (id: string, x: number) => ({ id, name: `Page ${id}`, type: "FRAME", absoluteBoundingBox: { x, y: 0, width: 400, height: 300 }, children: [
  { id: `${id}0`, name: "Photo", type: "RECTANGLE", absoluteBoundingBox: { x: x + 10, y: 10, width: 100, height: 80 }, fills: [{ type: "IMAGE", imageRef: "shared-photo", scaleMode: "FILL" }] },
] });

/** A Figma stand-in that records every API request (downloads from the CDN are free and not recorded). */
function fakeFigma(fileKey: string, options: { renderFails?: "timeout" | "429"; } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://cdn.test/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
    const path = url.replace("https://api.figma.com/v1", ""); calls.push(path);
    if (path.startsWith(`/files/${fileKey}/nodes?ids=`)) {
      const ids = decodeURIComponent(path.split("ids=")[1].split("&")[0]).split(",");
      return Response.json({ name: "Site", version: "42", lastModified: "2026-09-01T00:00:00Z", nodes: Object.fromEntries(ids.map((id, index) => [id, { document: frame(id, index * 500) }])) });
    }
    if (path.startsWith(`/images/${fileKey}?ids=`)) {
      const ids = decodeURIComponent(path.split("ids=")[1].split("&")[0]).split(",");
      if (options.renderFails === "429") return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
      if (options.renderFails === "timeout" && ids.length > 1) return Response.json({ err: "Render timeout, try requesting fewer or smaller images" }, { status: 400 });
      return Response.json({ images: Object.fromEntries(ids.map((id) => [id, `https://cdn.test/${id}.png`])) });
    }
    if (path === `/files/${fileKey}/images`) return Response.json({ meta: { images: { "shared-photo": "https://cdn.test/photo.png" } } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, client: new FigmaRestClient("test-token", fetcher) };
}

test("N pages of one file cost one nodes request, one render request and one fills lookup", async () => {
  const fileKey = `batch${Date.now()}`; const { calls, client } = fakeFigma(fileKey);
  const root = await mkdtemp(join(tmpdir(), "f2c-batch-"));
  try {
    const nodeIds = ["1:1", "1:2", "1:3"];
    const fetched = await fetchDesignNodesBatch({ fileKey, nodeIds, token: "test-token", client });
    assert.deepEqual(fetched.map((page) => page.fingerprint.targets[0].nodeId), nodeIds);
    const urls = renderTargetUrls(client, fileKey, fetched.map((page) => ({ nodeId: page.fingerprint.targets[0].nodeId, width: 400, height: 300, scale: 1 })));
    const results = await Promise.all(fetched.map((page, index) => completeExtraction(page, { fileKey, nodeId: nodeIds[index], token: "test-token", outputDir: join(root, `page-${index}`) }, { targetUrl: urls.get(`${nodeIds[index]}@1`) })));
    assert.deepEqual(calls.map((path) => path.split("?")[0]), [`/files/${fileKey}/nodes`, `/images/${fileKey}`, `/files/${fileKey}/images`]);
    for (const result of results) {
      assert.deepEqual(await readFile(result.targetPath), Buffer.from(PNG));
      assert.ok(result.fingerprint.assets.items.every((item) => item.localPath), "every page got the shared photo");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a render batch that times out falls back to one request per page; a rate limit does not", async () => {
  const fileKey = `timeout${Date.now()}`; const slow = fakeFigma(fileKey, { renderFails: "timeout" });
  const urls = renderTargetUrls(slow.client, fileKey, [{ nodeId: "1:1", width: 400, height: 300, scale: 1 }, { nodeId: "1:2", width: 400, height: 300, scale: 1 }]);
  assert.deepEqual(await Promise.all([urls.get("1:1@1"), urls.get("1:2@1")]), ["https://cdn.test/1:1.png", "https://cdn.test/1:2.png"]);
  assert.equal(slow.calls.length, 3, "one failed batch + one request per page");

  const limitedKey = `limited${Date.now()}`; const limited = fakeFigma(limitedKey, { renderFails: "429" });
  const limitedUrls = renderTargetUrls(limited.client, limitedKey, [{ nodeId: "1:1", width: 400, height: 300, scale: 1 }, { nodeId: "1:2", width: 400, height: 300, scale: 1 }]);
  await assert.rejects(limitedUrls.get("1:1@1")!, FigmaRateLimitError);
  await assert.rejects(limitedUrls.get("1:2@1")!, FigmaRateLimitError);
  assert.equal(limited.calls.length, 1, "a 429 is never retried page by page");
});

test("huge targets are split across render requests by pixel budget", async () => {
  const fileKey = `split${Date.now()}`; const { calls, client } = fakeFigma(fileKey);
  const urls = renderTargetUrls(client, fileKey, [1, 2, 3].map((index) => ({ nodeId: `1:${index}`, width: 1920, height: 13000, scale: 1 })), 60e6);
  await Promise.all(urls.values());
  assert.deepEqual(calls.map((path) => decodeURIComponent(path.split("ids=")[1].split("&")[0])), ["1:1,1:2", "1:3"]);
});

test("a 429 is remembered per token and file: later requests are not sent until it expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "f2c-limit-")); const statePath = join(root, "limit.json");
  try {
    let sent = 0;
    const fetcher = (async () => { sent++; return new Response("{}", { status: 429, headers: { "retry-after": "3600", "x-figma-rate-limit-type": "low" } }); }) as unknown as typeof fetch;
    const client = new FigmaRestClient("token-a", fetcher, statePath);
    await assert.rejects(client.getImageUrls("file1", ["1:1"], { format: "png" }), (error: unknown) => error instanceof FigmaRateLimitError && !error.remembered && /View\/Collab seat/.test(error.message));
    const until = await client.blockedUntil("file1", "render");
    assert.ok(until && until.getTime() > Date.now() + 3500e3, "blocked for the Retry-After window");
    await assert.rejects(client.getImageUrls("file1", ["1:2"], { format: "png" }), (error: unknown) => error instanceof FigmaRateLimitError && error.remembered);
    assert.equal(sent, 1, "the remembered block sends nothing");
    assert.equal(await client.blockedUntil("file1", "nodes"), undefined, "other endpoint families stay open");
    assert.equal(await new FigmaRestClient("token-b", fetcher, statePath).blockedUntil("file1", "render"), undefined, "another token is not blocked by this one");
    await writeFile(statePath, "{}");
  } finally { await rm(root, { recursive: true, force: true }); }
});

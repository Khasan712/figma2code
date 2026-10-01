import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FigmaRestClient } from "../src/figma.ts";
import { fetchDesignNodesBatch, loadWholeFile, nodeFromWholeFile, renormalize } from "../src/extractor.ts";

const frame = (id: string, x: number) => ({ id, name: `Page ${id}`, type: "FRAME", absoluteBoundingBox: { x, y: 0, width: 400, height: 300 }, children: [
  { id: `${id}1`, name: "Title", type: "TEXT", absoluteBoundingBox: { x: x + 10, y: 10, width: 100, height: 20 }, characters: "Hi", style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 20 } },
] });
const document = { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Site", type: "CANVAS", children: [frame("1:1", 0), frame("1:2", 500)] }] };

test("one whole-file read lists the frames and serves every node of the build that follows", async () => {
  const root = await mkdtemp(join(tmpdir(), "f2c-whole-"));
  try {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const path = String(input).replace("https://api.figma.com/v1", ""); calls.push(path.split("?")[0]);
      if (path.startsWith("/files/key1?")) return Response.json({ name: "Site", version: "9", lastModified: "2026-09-28T00:00:00Z", document });
      if (path.startsWith("/files/key1/nodes?ids=")) { const ids = decodeURIComponent(path.split("ids=")[1].split("&")[0]).split(","); return Response.json({ name: "Site", version: "9", lastModified: "2026-09-28T00:00:00Z", nodes: Object.fromEntries(ids.map((id) => [id, { document: document.children[0].children.find((node) => node.id === id) }])) }); }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new FigmaRestClient("t", fetcher, join(root, "limit.json"));
    assert.equal((await loadWholeFile({ fileKey: "key1", client, cacheDir: root }))?.cached, false);
    const whole = await loadWholeFile({ fileKey: "key1", client, cacheDir: root, cacheOnly: true });
    assert.equal(whole?.cached, true); assert.deepEqual(calls, ["/files/key1"]);

    const fromWhole = await fetchDesignNodesBatch({ fileKey: "key1", nodeIds: ["1:2", "1:1"], token: "t", client, wholeFile: whole!.body });
    assert.deepEqual(fromWhole.map((page) => page.fingerprint.targets[0].nodeId), ["1:2", "1:1"]);
    const [pageId] = await fetchDesignNodesBatch({ fileKey: "key1", nodeIds: ["0:1"], token: "t", client, wholeFile: whole!.body });
    assert.equal(pageId.fingerprint.targets[0].nodeId, "1:1", "a page link resolves to its first frame");
    assert.deepEqual(calls, ["/files/key1"], "no /nodes request at all");
    assert.throws(() => nodeFromWholeFile(whole!.body, "key1", "9:9"), /did not return node 9:9/);

    const fromNodes = await fetchDesignNodesBatch({ fileKey: "key1", nodeIds: ["1:2"], token: "t", client });
    assert.deepEqual(fromNodes[0].fingerprint.pages, fromWhole[0].fingerprint.pages, "the same fingerprint as a /nodes read");
    assert.equal((await loadWholeFile({ fileKey: "key1", client, cacheDir: root, refresh: true }))?.cached, false);
    assert.deepEqual(calls, ["/files/key1", "/files/key1/nodes", "/files/key1"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saved extraction is re-read by the current normalizer when the same file version is cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "f2c-renorm-"));
  try {
    const fetcher = (async () => Response.json({ name: "Site", version: "9", lastModified: "2026-09-28T00:00:00Z", document })) as unknown as typeof fetch;
    const client = new FigmaRestClient("t", fetcher, join(root, "limit.json"));
    const whole = (await loadWholeFile({ fileKey: "key1", client, cacheDir: root }))!;
    const [page] = await fetchDesignNodesBatch({ fileKey: "key1", nodeIds: ["1:1"], token: "t", client, wholeFile: whole.body });
    const saved = structuredClone(page.fingerprint);
    saved.pages[0].children[0].name = "stale"; saved.targets[0].localPath = "target.png"; saved.targets[0].hash = "abc";
    const fresh = await renormalize(saved, root);
    assert.equal(fresh?.pages[0].children[0].name, "Page 1:1", "re-read from the cached file");
    assert.deepEqual([fresh?.targets[0].localPath, fresh?.targets[0].hash], ["target.png", "abc"], "Figma's render is kept");
    assert.equal(await renormalize({ ...saved, source: { ...saved.source, version: "8" } }, root), undefined, "another design version is never mixed in");
  } finally { await rm(root, { recursive: true, force: true }); }
});

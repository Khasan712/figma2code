import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/figma-file.json" with { type: "json" };
import { FigmaRestClient, parseFigmaReference } from "../src/figma.ts";
import { normalizeFixture } from "../src/extractor.ts";
import { sha256, sha256Bytes } from "../src/hash.ts";
import { sealHashes } from "../src/normalize.ts";
import { loadLocalEnv } from "../src/env.ts";

test("parses a Figma design URL and normalizes hyphenated node IDs", () => {
  assert.deepEqual(parseFigmaReference("https://www.figma.com/design/file-key/Design?node-id=1-2"), { fileKey: "file-key", nodeId: "1:2" });
});

test("normalizes a Figma API fixture into a validated DesignFingerprintV1", () => {
  const fingerprint = normalizeFixture(fixture, "fixture-key", "1:2");
  const frame = fingerprint.pages[0].children[0]; const heading = frame.children?.[0]; const image = frame.children?.[1];
  assert.equal(fingerprint.schema, "design-fingerprint"); assert.equal(fingerprint.document.nodeCount, 4); assert.equal(fingerprint.targets[0].nodeId, "1:2"); assert.equal(frame.layout?.mode, "vertical");
  assert.equal(heading?.typography?.fontFamily, "Inter"); assert.equal(heading?.fills?.[0].color?.hex, "#0D1424"); assert.equal(image?.asset?.imageRef, "abc-image-ref");
  assert.equal(fingerprint.statistics.vectorNodes, 1); assert.equal(fingerprint.hashes.overall.length, 64);
});

test("normalizes a selected-node wrapper without requiring the full file tree", () => {
  const page = fixture.document.children[0];
  const selectedOnly = { name: fixture.name, version: fixture.version, document: { id: "document:fixture-key", name: fixture.name, type: "DOCUMENT", children: [page] } };
  const fingerprint = normalizeFixture(selectedOnly, "fixture-key");
  assert.equal(fingerprint.pages.length, 1);
  assert.equal(fingerprint.statistics.nodes, 4);
  assert.equal(fingerprint.pages[0].name, "Home");
});

test("rejects a requested node id that does not exist in the tree", () => {
  assert.throws(() => normalizeFixture(fixture, "fixture-key", "9999:9999"), /was not found/);
});

test("resolves a page id to its first renderable child frame", () => {
  const fingerprint = normalizeFixture(fixture, "fixture-key", "0:1");
  assert.equal(fingerprint.targets[0].nodeId, "1:2");
});

test("hashes binary content as real SHA-256", () => {
  assert.equal(sha256Bytes(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("keeps section hashes consistent after asset download mutations", () => {
  const fingerprint = normalizeFixture(fixture, "fixture-key", "1:2");
  const before = fingerprint.hashes.overall;
  fingerprint.assets.items[0].localPath = "assets/images/deadbeef.png";
  fingerprint.hashes.assets = sha256(fingerprint.assets.items);
  sealHashes(fingerprint.hashes);
  assert.notEqual(fingerprint.hashes.overall, before);
  assert.equal(fingerprint.hashes.assets, sha256(fingerprint.assets.items));
});

test("stores relativeTransform in CSS matrix order and gradient handles as points", () => {
  const raw = { document: { id: "0:0", name: "D", type: "DOCUMENT", children: [{ id: "0:1", name: "P", type: "CANVAS", children: [
    { id: "1:1", name: "F", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
      relativeTransform: [[1, 2, 3], [4, 5, 6]],
      fills: [{ type: "GRADIENT_LINEAR", gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }], gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }] }] }] }] } };
  const frame = normalizeFixture(raw, "transform-key").pages[0].children[0];
  assert.deepEqual(frame.transform?.matrix, [1, 4, 2, 5, 3, 6]);
  assert.deepEqual(frame.fills?.[0].gradient?.handles, [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }]);
});

test("trims whitespace around .env values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figma2code-env-"));
  try {
    const path = join(dir, ".env");
    await writeFile(path, "FIGMA2CODE_TEST_TOKEN=figd_abc123   \n");
    delete process.env.FIGMA2CODE_TEST_TOKEN;
    await loadLocalEnv(path);
    assert.equal(process.env.FIGMA2CODE_TEST_TOKEN, "figd_abc123");
  } finally {
    delete process.env.FIGMA2CODE_TEST_TOKEN;
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads image-fill URLs from both Figma response shapes", async () => {
  const from = (body: unknown) => new FigmaRestClient("test-token", async () => new Response(JSON.stringify(body), { status: 200 }));
  assert.deepEqual(await from({ images: { legacy: "https://asset.test/legacy" } }).getImageFillUrls("file"), { legacy: "https://asset.test/legacy" });
  assert.deepEqual(await from({ images: {}, meta: { images: { modern: "https://asset.test/modern" } } }).getImageFillUrls("file"), { modern: "https://asset.test/modern" });
});

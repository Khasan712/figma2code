import assert from "node:assert/strict";
import test from "node:test";
import fixture from "./fixtures/figma-file.json" with { type: "json" };
import { normalizeFixture } from "../src/extractor.ts";
import { digestFingerprint } from "../src/digest.ts";

test("digests a fingerprint into tokens, assets, and a compact tree", () => {
  const digest = digestFingerprint(normalizeFixture(fixture, "fixture-key", "1:2"));
  assert.equal(digest.data.target.nodeId, "1:2");
  assert.ok(digest.data.tokens.colors.some((color) => color.hex === "#0D1424" && color.roles.includes("text")));
  assert.ok(digest.data.tokens.textStyles.some((style) => style.fontFamily === "Inter" && style.fontSize === 48 && style.fontWeight === 700));
  assert.ok(digest.data.tokens.spacing.some((entry) => entry.value === 16));
  assert.equal(digest.data.assets.images, 1);
  assert.match(digest.markdown, /Landing \[FRAME 1440×900\]/);
  assert.match(digest.markdown, /"Build from Figma" Inter 48\/700/);
  assert.match(digest.markdown, /img:abc-imag/);
});

test("detects repeated structures as component candidates", () => {
  const card = (id: number, x: number, title: string) => ({
    id: `9:${id}`, name: "Product card", type: "FRAME", layoutMode: "VERTICAL", itemSpacing: 8,
    absoluteBoundingBox: { x, y: 0, width: 200, height: 260 },
    children: [
      { id: `9:${id + 1}`, name: "Cover", type: "RECTANGLE", absoluteBoundingBox: { x, y: 0, width: 200, height: 180 } },
      { id: `9:${id + 2}`, name: "Title", type: "TEXT", characters: title, absoluteBoundingBox: { x, y: 188, width: 200, height: 24 }, style: { fontFamily: "Inter", fontSize: 16 } },
    ],
  });
  const raw = { document: { id: "0:0", name: "D", type: "DOCUMENT", children: [{ id: "0:1", name: "P", type: "CANVAS", children: [
    { id: "1:1", name: "Grid", type: "FRAME", layoutMode: "HORIZONTAL", itemSpacing: 16, absoluteBoundingBox: { x: 0, y: 0, width: 700, height: 260 },
      children: [card(10, 0, "Alpha"), card(20, 216, "Beta"), card(30, 432, "Gamma")] }] }] } };
  const digest = digestFingerprint(normalizeFixture(raw, "cards-key"));
  const group = digest.data.componentCandidates.find((candidate) => candidate.kind === "repeated-structure");
  assert.ok(group, "expected a repeated-structure candidate");
  assert.equal(group.count, 3);
  assert.equal(group.name, "Product card");
  assert.match(digest.markdown, /Product card.*3×/);
});

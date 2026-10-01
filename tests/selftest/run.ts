import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { runCompare } from "../../src/compare.ts";
import type { Color, DesignFingerprintV1, NodeFingerprint } from "../../src/types.ts";

/**
 * End-to-end proof that the compare harness works, without touching the Figma API:
 * a small reference page acts as "the design" (its screenshot becomes target.png and its
 * geometry becomes the fingerprint), then compare runs against an identical page (must PASS)
 * and against a deliberately broken page (must report the exact planted violations).
 */
const dir = "outputs/selftest";
const ZERO_HASH = "0".repeat(64);
const color = (hex: string): Color => { const value = parseInt(hex.slice(1), 16); return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255, a: 1, hex }; };
const solid = (hex: string) => [{ type: "solid" as const, visible: true, color: color(hex) }];
const node = (partial: Partial<NodeFingerprint> & Pick<NodeFingerprint, "id" | "name" | "type" | "bounds">): NodeFingerprint => ({ visible: true, hash: ZERO_HASH, ...partial });

const page = (headingSize: number, badgeX: number, badgeColor: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html, body { margin: 0; padding: 0; } * { box-sizing: border-box; }</style></head>
<body>
<div data-fig="f1" style="position:relative;width:360px;height:200px;background:#FFFFFF">
  <div data-fig="t1" style="position:absolute;left:24px;top:24px;width:200px;height:24px;font:600 ${headingSize}px/24px Arial;color:#0D1424">Hello, figma2code</div>
  <div data-fig="b1" style="position:absolute;left:${badgeX}px;top:64px;width:120px;height:32px;background:${badgeColor};border-radius:8px"></div>
  <div data-fig="c1" style="position:absolute;left:24px;top:112px;width:312px;height:64px;background:#F4F4F5;border-radius:12px"></div>
</div>
</body></html>`;

const root = node({ id: "f1", name: "Card frame", type: "FRAME", bounds: { x: 0, y: 0, width: 360, height: 200 }, fills: solid("#FFFFFF"), children: [
  node({ id: "t1", name: "Heading", type: "TEXT", bounds: { x: 24, y: 24, width: 200, height: 24 }, fills: solid("#0D1424"), typography: { fontFamily: "Arial", fontSize: 16, fontWeight: 600 }, content: { kind: "text", text: "Hello, figma2code", characters: 17 } }),
  node({ id: "b1", name: "Badge", type: "RECTANGLE", bounds: { x: 24, y: 64, width: 120, height: 32 }, fills: solid("#FF4D4F"), cornerRadius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 } }),
  node({ id: "c1", name: "Card", type: "RECTANGLE", bounds: { x: 24, y: 112, width: 312, height: 64 }, fills: solid("#F4F4F5"), cornerRadius: { topLeft: 12, topRight: 12, bottomRight: 12, bottomLeft: 12 } }),
] });

const viewport = { width: 360, height: 200, deviceScaleFactor: 1, mode: "mobile" as const };
const fingerprint: DesignFingerprintV1 = {
  schema: "design-fingerprint", version: "1.0",
  source: { provider: "figma", fileKey: "selftest", fileName: "Compare selftest", sourceType: "rest", extractedAt: "2026-08-14T00:00:00.000Z" },
  document: { id: "0:0", name: "Selftest", pageCount: 1, nodeCount: 4, rootNodeId: "0:0" },
  viewport, pages: [{ id: "0:1", name: "Page", children: [root], bounds: { x: 0, y: 0, width: 360, height: 200 }, hash: ZERO_HASH }],
  assets: { items: [] }, components: { components: [], componentSets: [] }, styles: { fills: [], texts: [], effects: [], grids: [] }, variables: { collections: [], variables: [] },
  targets: [{ id: "figma-target:f1", nodeId: "f1", type: "frame", viewport, format: "png", scale: 1, width: 360, height: 200 }],
  statistics: { pages: 1, frames: 1, nodes: 4, textNodes: 1, imageNodes: 0, vectorNodes: 0, components: 0, instances: 0, uniqueColors: 4, uniqueFonts: 1, assets: 0 },
  hashes: { structure: ZERO_HASH, geometry: ZERO_HASH, typography: ZERO_HASH, colors: ZERO_HASH, assets: ZERO_HASH, styles: ZERO_HASH, overall: ZERO_HASH },
};

await mkdir(dir, { recursive: true });
await writeFile(join(dir, "reference.html"), page(16, 24, "#FF4D4F"));
await writeFile(join(dir, "broken.html"), page(18, 14, "#EF4444"));
await writeFile(join(dir, "fingerprint.json"), JSON.stringify(fingerprint, null, 2));

// The reference page IS the design: its screenshot becomes the Figma-rendered target.png.
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 200 } });
  const referencePage = await context.newPage();
  await referencePage.goto(pathToFileURL(join(dir, "reference.html")).href);
  await writeFile(join(dir, "target.png"), await referencePage.locator('[data-fig="f1"]').screenshot());
} finally {
  await browser.close();
}

const ok = await runCompare({ designDir: dir, url: pathToFileURL(join(dir, "reference.html")).href, outDir: join(dir, "compare-ok") });
console.log(`identical page  → pass=${ok.summary.pass} pixelDiff=${ok.summary.pixelDiffPct}% violations=${ok.summary.violations} coverage=${ok.summary.coveragePct}%`);
assert.equal(ok.summary.pass, true, "identical page must pass");
assert.equal(ok.summary.high, 0);
assert.ok((ok.summary.pixelDiffPct ?? 100) <= 0.5, `identical page pixel diff should be ~0, got ${ok.summary.pixelDiffPct}%`);
assert.equal(ok.summary.coveragePct, 100);

const broken = await runCompare({ designDir: dir, url: pathToFileURL(join(dir, "broken.html")).href, outDir: join(dir, "compare-broken") });
console.log(`broken page     → pass=${broken.summary.pass} pixelDiff=${broken.summary.pixelDiffPct}% violations=${broken.summary.violations}`);
for (const violation of broken.violations) console.log(`  [${violation.severity}] ${violation.name} ${violation.prop}: expected ${violation.expected}, got ${violation.actual}`);
assert.equal(broken.summary.pass, false, "broken page must fail");
const find = (nodeId: string, prop: string) => broken.violations.find((violation) => violation.nodeId === nodeId && violation.prop === prop);
assert.ok(find("b1", "background"), "must catch the wrong badge color");
assert.ok(find("b1", "x"), "must catch the shifted badge");
assert.ok(find("t1", "fontSize"), "must catch the wrong heading size");
assert.ok((broken.summary.pixelDiffPct ?? 0) > 0.5, "broken page must show pixel drift");

console.log("\nSELFTEST PASS — compare harness detects planted violations and passes identical pages.");

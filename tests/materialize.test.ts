import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlatPlan } from "../src/ir.ts";
import { flatsToRender, materialize, reconcile, untint } from "../src/materialize.ts";
import type { IRResult } from "../src/ir.ts";
import sharp from "sharp";

const plan = (rect: FlatPlan["rect"], box: FlatPlan["box"], clipped?: FlatPlan["clipped"]): FlatPlan => ({ id: "1:1", file: "f2c-1-1.png", format: "png", reason: "rotated", nodes: 1, rect, box, hasRenderBounds: true, clipped });
const side = (right: boolean, left = false) => ({ left, top: false, right, bottom: false });

test("an isolated render that is larger than the clipped design rect is anchored on the unclipped side", () => {
  assert.deepEqual(reconcile(plan({ x: 150, y: 20, w: 50, h: 40 }, { x: 150, y: 20, w: 100, h: 40 }, side(true)), { w: 100, h: 40 }), { x: 150, y: 20, w: 100, h: 40 });
  assert.deepEqual(reconcile(plan({ x: 0, y: 20, w: 50, h: 40 }, { x: -50, y: 20, w: 100, h: 40 }, side(false, true)), { w: 100, h: 40 }), { x: -50, y: 20, w: 100, h: 40 });
});

test("sizes that agree keep the design rect; ambiguous ones are refused", () => {
  assert.deepEqual(reconcile(plan({ x: 10, y: 10, w: 24, h: 28 }, { x: 10, y: 10, w: 24, h: 28 }), { w: 24.5, h: 28 }), { x: 10, y: 10, w: 24, h: 28 });
  assert.equal(reconcile(plan({ x: 50, y: 0, w: 50, h: 40 }, { x: 0, y: 0, w: 200, h: 40 }, side(true, true)), { w: 200, h: 40 }), undefined, "clipped on both sides: no way to know the offset");
  assert.equal(reconcile(plan({ x: 10, y: 10, w: 24, h: 28 }, { x: 10, y: 10, w: 24, h: 28 }), { w: 40, h: 28 }), undefined, "unclipped yet larger: the render is not what the design shows");
});

test("a crop fallback is upgraded only on request: rebuilds never spend render quota on their own", async () => {
  const assetsDir = await mkdtemp(join(tmpdir(), "f2c-assets-"));
  try {
    await writeFile(join(assetsDir, "f2c-1-1.png"), "png");
    await writeFile(join(assetsDir, "figma2code-assets.json"), JSON.stringify({ flats: { "1:1": { file: "f2c-1-1.png", source: "crop", image: { x: 150, y: 20, w: 50, h: 40 }, version: "7" } }, images: {} }));
    const cropped = plan({ x: 150, y: 20, w: 50, h: 40 }, { x: 150, y: 20, w: 50, h: 40 });
    const fresh = { ...cropped, id: "2:2" };
    assert.deepEqual((await flatsToRender([cropped, fresh], { assetsDir, mode: "auto", version: "7" })).map((entry) => entry.id), ["2:2"], "only the asset that does not exist yet");
    assert.deepEqual((await flatsToRender([cropped, fresh], { assetsDir, mode: "api", version: "7" })).map((entry) => entry.id), ["1:1", "2:2"], "--mode api upgrades crops");
    assert.deepEqual((await flatsToRender([cropped], { assetsDir, mode: "auto", version: "8" })).map((entry) => entry.id), ["1:1"], "a changed design re-renders");
  } finally { await rm(assetsDir, { recursive: true, force: true }); }
});

test("dividing a dimming backdrop out of a crop restores the pixels under it", () => {
  // Red under a 50% navy backdrop, as target.png shows it; one transparent padding pixel is left alone.
  const alpha = 0.5, navy: [number, number, number] = [0, 0, 51];
  const seen = [255, 0, 0].map((value, channel) => Math.round(alpha * navy[channel] + (1 - alpha) * value));
  const data = Buffer.from([...seen, 255, ...seen, 255, 9, 9, 9, 0]);
  untint(data, 3, 1, 100, 50, [{ x: 100, y: 50, w: 2, h: 1, color: navy, alpha }]);
  assert.deepEqual([...data], [255, 0, 1, 255, 255, 0, 1, 255, 9, 9, 9, 0], "back to red within 8-bit rounding; the page paints the backdrop over it again");
});

test("a crop is cut where the frame sits inside Figma's render when the render also covers its shadow", async () => {
  const root = await mkdtemp(join(tmpdir(), "f2c-shift-"));
  try {
    // A 12×10 render of an 8×6 frame drawn 2px right / 1px down of the render's origin; a red icon at frame (2,2).
    const design = join(root, "design"), assetsDir = join(root, "assets"); await mkdir(design);
    const pixels = Buffer.alloc(12 * 10 * 4); for (const [x, y] of [[4, 3], [5, 3], [4, 4], [5, 4]]) pixels.set([255, 0, 0, 255], (y * 12 + x) * 4);
    await sharp(pixels, { raw: { width: 12, height: 10, channels: 4 } }).png().toFile(join(design, "target.png"));
    const icon = plan({ x: 2, y: 2, w: 2, h: 2 }, { x: 2, y: 2, w: 2, h: 2 });
    const ir = { kind: "overlay", root: { id: "0:1", name: "Panel", figType: "FRAME", kind: "root", x: 0, y: 0, w: 8, h: 6, style: {}, children: [] }, popups: [], behaviors: [], fixes: [], fit: { fluid: false, width: 8, minWidth: 8 }, render: { dx: 2, dy: 1, w: 12, h: 10 }, flats: [icon], images: [], fonts: [], notes: [], stats: { nodes: 1, emitted: 0, flattened: 0, texts: 0, images: 0 } } as IRResult;
    await materialize({ designDir: design, assetsDir, ir, fileKey: "k", mode: "crop" });
    const { data } = await sharp(join(assetsDir, icon.file)).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 4)], [255, 0, 0, 255], "the icon's own pixels, not the render's corner");
  } finally { await rm(root, { recursive: true, force: true }); }
});

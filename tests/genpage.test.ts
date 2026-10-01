import assert from "node:assert/strict";
import test from "node:test";
import fixture from "./fixtures/figma-file.json" with { type: "json" };
import { normalizeFixture } from "../src/extractor.ts";
import { generatePage } from "../src/genpage.ts";
import { buildIR, linearGradientCss } from "../src/ir.ts";
import { emitHtml, emitReact } from "../src/emit.ts";

const page = (children: unknown[], extra: Record<string, unknown> = {}) => ({ document: { id: "0:0", name: "D", type: "DOCUMENT", children: [{ id: "0:1", name: "P", type: "CANVAS", children: [
  { id: "1:1", name: "Root", type: "FRAME", absoluteBoundingBox: { x: 100, y: 50, width: 400, height: 300 }, children, ...extra }] }] } });
const box = (x: number, y: number, width: number, height: number) => ({ absoluteBoundingBox: { x: 100 + x, y: 50 + y, width, height } });

test("generates an absolutely positioned React page with verbatim values and data-fig ids", () => {
  const result = generatePage(normalizeFixture(fixture, "fixture-key", "1:2"), { component: "Landing" });
  assert.match(result.code, /export default function Landing\(\)/);
  // Content hugs the left edge — not a centered column — so the page keeps its width and is scaled below it.
  assert.match(result.code, /<Page id="1:2" w=\{1440\} h=\{900\} minW=\{1440\}>/);
  assert.deepEqual(result.ir.fit, { fluid: false, width: 1440, minWidth: 1440 });
  // Auto-layout is deliberately NOT reproduced: children sit at their design AABBs, so font metrics cannot shift siblings.
  assert.match(result.code, /<Txt id="1:3" x=\{32\} y=\{24\} w=\{500\} h=\{58\} font="Inter" size=\{48\} weight=\{700\} lh=\{58\} color="#0D1424"/);
  assert.match(result.code, /\{"Build from Figma"\}/);
  // A lone vector becomes one flat asset, planned at root-relative coordinates.
  assert.match(result.code, /<Pic id="1:5" flat src=\{asset\("f2c-1-5\.svg"\)\}/);
  assert.deepEqual(result.flats.map((flat) => [flat.id, flat.reason, flat.rect]), [["1:5", "vector", { x: 32, y: 534, w: 24, h: 24 }]]);
  // An image that was never downloaded is reported, never given an invented path.
  assert.ok(result.notes.some((note) => note.includes("abc-image-ref was not downloaded")));
  assert.deepEqual(result.fonts, [{ family: "Inter", weights: [700], italic: false }]);
});

test("maps Figma gradient handles to an exact CSS linear-gradient", () => {
  const paint = { type: "linear-gradient" as const, visible: true, gradient: { stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1, hex: "#FF0000" } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0, hex: "#0000FF00" } }], handles: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }] } };
  assert.equal(linearGradientCss(paint, 300, 60), "linear-gradient(90deg, #FF0000 0%, rgba(0,0,255,0) 100%)");
  // A diagonal ramp that stops short of the corners: CSS stop positions are re-projected onto the CSS gradient line.
  const diagonal = { ...paint, gradient: { ...paint.gradient, handles: [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }] } };
  assert.equal(linearGradientCss(diagonal, 100, 100), "linear-gradient(135deg, #FF0000 25%, rgba(0,0,255,0) 75%)");
});

test("paint opacity, strokes over children, shadows and clipping come out as CSS", () => {
  const raw = page([
    { id: "2:1", name: "Card", type: "FRAME", ...box(10, 10, 200, 100), clipsContent: true, cornerRadius: 12,
      fills: [{ type: "SOLID", opacity: 0.5, color: { r: 0, g: 0, b: 0, a: 1 } }], strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], strokeWeight: 1, strokeAlign: "INSIDE",
      effects: [{ type: "DROP_SHADOW", visible: true, radius: 8, offset: { x: 0, y: 4 }, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
      children: [{ id: "2:2", name: "Label", type: "TEXT", ...box(20, 20, 80, 20), characters: "Hi", style: { fontFamily: "Inter", fontSize: 14, fontWeight: 500, lineHeightPx: 20, textAutoResize: "WIDTH_AND_HEIGHT", letterSpacing: 0.5 } }] },
  ]);
  const { root } = buildIR(normalizeFixture(raw, "k"));
  const card = root.children[0];
  assert.equal(card.style.background, "rgba(0,0,0,0.5)");
  assert.equal(card.style.overflow, "hidden");
  assert.equal(card.style.boxShadow, "0px 4px 8px 0px rgba(0,0,0,0.25)");
  assert.equal(card.style.border, undefined, "a container stroke must not shift absolutely positioned children");
  assert.equal(card.overlay?.border, "1px solid #FFFFFF");
  const label = card.children[0];
  assert.deepEqual([label.x, label.y], [10, 10]);
  assert.equal(label.style.whiteSpace, "pre"); assert.equal(label.style.letterSpacing, "0.5px");
});

test("accumulates flips: a mirrored image inside a mirrored frame renders unmirrored", () => {
  const image = (id: string, relativeTransform: number[][]) => ({ id, name: "Photo", type: "RECTANGLE", ...box(0, 0, 100, 100), relativeTransform, fills: [{ type: "IMAGE", imageRef: "ref", scaleMode: "FILL" }] });
  const flipped = [[-1, 0, 100], [0, 1, 0]];
  const raw = page([
    { id: "3:1", name: "Flipped frame", type: "FRAME", ...box(0, 0, 100, 100), relativeTransform: flipped, children: [image("3:2", flipped)] },
    image("3:3", flipped),
  ]);
  const fingerprint = normalizeFixture(raw, "k");
  for (const item of fingerprint.assets.items) item.localPath = "assets/images/photo.jpg";
  const { root } = buildIR(fingerprint);
  assert.equal(root.children[0].children[0].style.transform, undefined);
  assert.equal(root.children[1].style.transform, "scale(-1, 1)");
});

test("flattens icons, arcs, rotations and scaled artwork — but never real UI", () => {
  const tiny = Array.from({ length: 24 }, (_, index) => ({ id: `7:${index}`, name: "t", type: "TEXT", ...box(index, 0, 20, 6), characters: "x", style: { fontFamily: "Sora", fontSize: 8.7079, fontWeight: 400, lineHeightPx: 11 } }));
  const cells = Array.from({ length: 24 }, (_, index) => ({ id: `8:${index}`, name: "cell", type: "TEXT", ...box(index, 100, 40, 18), characters: "cell", style: { fontFamily: "Inter", fontSize: 14, fontWeight: 400, lineHeightPx: 18 } }));
  const raw = page([
    { id: "4:1", name: "Search icon", type: "FRAME", ...box(0, 0, 40, 40), children: [{ id: "4:2", name: "Glass", type: "ELLIPSE", ...box(5, 5, 20, 20) }, { id: "4:3", name: "Handle", type: "LINE", ...box(24, 24, 8, 8), relativeTransform: [[0.707, -0.707, 0], [0.707, 0.707, 0]] }] },
    { id: "5:1", name: "Ring", type: "ELLIPSE", ...box(60, 0, 80, 80), arcData: { startingAngle: 0, endingAngle: 4.2, innerRadius: 0.9 } },
    { id: "6:1", name: "Tilted card", type: "FRAME", ...box(150, 0, 120, 90), relativeTransform: [[0.97, -0.26, 0], [0.26, 0.97, 0]], children: [] },
    { id: "7:100", name: "Phone mockup", type: "GROUP", ...box(0, 150, 60, 40), children: tiny },
    { id: "8:100", name: "Data table", type: "FRAME", ...box(0, 200, 300, 60), children: cells },
    { id: "9:1", name: "Burger", type: "FRAME", ...box(300, 0, 40, 40), children: [0, 1, 2].map((row) => ({ id: `9:${row + 2}`, name: "bar", type: "LINE", ...box(4, 13 + row * 7, 32, 0), strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }], strokeWeight: 1 })) },
  ]);
  const ir = buildIR(normalizeFixture(raw, "k"));
  assert.deepEqual(ir.flats.map((flat) => [flat.id, flat.reason]), [["4:1", "icon"], ["5:1", "arc"], ["6:1", "rotated"], ["7:100", "illustration"]]);
  const table = ir.root.children.find((node) => node.id === "8:100")!; assert.equal(table.children.length, 24, "a readable table stays real DOM");
  const burger = ir.root.children.find((node) => node.id === "9:1")!; assert.deepEqual(burger.children.map((bar) => bar.kind), ["rule", "rule", "rule"], "axis-aligned lines stay CSS");
});

test("mixed-size text runs carry their own line height", () => {
  const raw = page([{ id: "2:1", name: "Stat", type: "TEXT", ...box(0, 0, 80, 161), characters: "4\nOY", characterStyleOverrides: [0, 0, 1, 1], styleOverrideTable: { 1: { fontSize: 32, fontWeight: 400 } },
    style: { fontFamily: "EuropeExt", fontSize: 92, fontWeight: 700, lineHeightPx: 128.8, lineHeightUnit: "FONT_SIZE_%" } }]);
  const stat = buildIR(normalizeFixture(raw, "k")).root.children[0];
  assert.equal(stat.style.lineHeight, "0px");
  assert.deepEqual(stat.runs, [{ text: "4\n", style: { lineHeight: "128.8px" } }, { text: "OY", style: { fontSize: 32, fontWeight: 400, lineHeight: "44.8px" } }]);
});

test("emits a self-contained HTML page from the same IR", () => {
  const html = generatePage(normalizeFixture(fixture, "fixture-key", "1:2"), { component: "Landing", emit: "html", assetBase: "assets" }).code;
  assert.match(html, /<div data-fig="1:2" class="page" style="width:1440px;height:900px;position:relative;overflow:hidden;margin:0 auto"/);
  assert.match(html, /<script>\(function\(\)\{var page=document.querySelector\('\[data-fig="1:2"\]'\),base=1440,fluid=false;/, "scaled below its width like the React runtime");
  assert.match(html, /<div data-fig="1:3" style="position:absolute;left:32px;top:24px;width:500px;height:58px;font-family:&quot;Inter&quot;, sans-serif;font-size:48px;font-weight:700/);
  assert.match(html, /<img data-fig="1:5" data-fig-flat src="assets\/f2c-1-5\.svg"/);
});

test("lines paint their stroke on one side of the axis, where Figma puts it", () => {
  const stroke = { strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }], strokeWeight: 1, strokeAlign: "CENTER" };
  const raw = page([
    { id: "2:1", name: "Divider", type: "LINE", ...box(0, 100, 300, 0), ...stroke },
    { id: "2:2", name: "Flipped divider", type: "LINE", ...box(0, 200, 300, 0), relativeTransform: [[1, 0, 0], [0, -1, 250]], ...stroke },
    { id: "2:3", name: "Measured divider", type: "LINE", ...box(0, 250, 300, 0), absoluteRenderBounds: { x: 100, y: 50 + 250, width: 300, height: 1 }, ...stroke },
  ]);
  const rules = buildIR(normalizeFixture(raw, "k")).root.children;
  assert.deepEqual(rules.map((rule) => [rule.kind, rule.y, rule.h]), [["rule", 99, 1], ["rule", 200, 1], ["rule", 250, 1]]);
});

test("a glass button stays a CSS backdrop-filter box; artwork that samples the page is taken from the design", () => {
  const blur = { effects: [{ type: "BACKGROUND_BLUR", visible: true, radius: 14 }] };
  const vector = (id: string, x: number, y: number) => ({ id, name: "Arrow", type: "VECTOR", ...box(x, y, 24, 28) });
  const raw = page([
    { id: "3:1", name: "Glass button", type: "FRAME", ...box(10, 10, 120, 120), cornerRadius: 60, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 0.2 } }], ...blur, children: [vector("3:2", 58, 56)] },
    { id: "4:1", name: "Badge", type: "GROUP", ...box(200, 10, 60, 60), children: [{ id: "4:2", name: "Frosted", type: "FRAME", ...box(200, 10, 60, 60), ...blur, children: [vector("4:3", 218, 26)] }] },
  ]);
  const ir = buildIR(normalizeFixture(raw, "k"));
  const glass = ir.root.children[0];
  assert.equal(glass.kind, "box"); assert.equal(glass.style.backdropFilter, "blur(7px)");
  assert.equal(glass.children[0].kind, "flat");
  assert.deepEqual(ir.flats.map((flat) => [flat.id, flat.format, flat.backdrop ?? false]), [["3:2", "svg", false], ["4:1", "png", true]]);
});

test("a flat cut by a clipping ancestor records the clipped side", () => {
  const raw = page([{ id: "5:1", name: "Viewport", type: "FRAME", ...box(0, 0, 200, 100), clipsContent: true, children: [
    { id: "5:2", name: "Tilted card", type: "FRAME", ...box(150, 20, 100, 40), relativeTransform: [[0.99, -0.12, 150], [0.12, 0.99, 20]], absoluteRenderBounds: { x: 250, y: 70, width: 50, height: 40 }, children: [] },
  ] }]);
  const [flat] = buildIR(normalizeFixture(raw, "k")).flats;
  assert.deepEqual([flat.reason, flat.rect, flat.box, flat.clipped], ["rotated", { x: 150, y: 20, w: 50, h: 40 }, { x: 150, y: 20, w: 100, h: 40 }, { left: false, top: false, right: true, bottom: false }]);
});

test("a translucent solid layer over a flattened icon is recorded so a crop can divide it out", () => {
  const icon = (id: string, x: number, y: number) => ({ id, name: "Heart", type: "VECTOR", ...box(x, y, 24, 24), fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }] });
  const raw = page([
    icon("2:1", 10, 10), icon("2:2", 300, 250),
    { id: "3:1", name: "Backdrop", type: "RECTANGLE", ...box(0, 0, 400, 200), opacity: 0.5, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0.2, a: 1 } }] },
    { id: "4:1", name: "Modal", type: "FRAME", ...box(0, 0, 100, 40), fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], children: [] },
    { id: "5:1", name: "Scrim", type: "RECTANGLE", ...box(290, 240, 40, 40), fills: [{ type: "GRADIENT_LINEAR", gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 0 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 0.6 } }] }] },
  ]);
  const { flats } = buildIR(normalizeFixture(raw, "k"));
  const [under, beside] = flats;
  assert.deepEqual(under.tints, [{ x: 10, y: 10, w: 24, h: 24, color: [0, 0, 51], alpha: 0.5 }], "the backdrop, clipped to the icon; the opaque modal needs nothing");
  assert.equal(under.tainted, undefined);
  assert.equal(beside.tints, undefined); assert.equal(beside.tainted, true, "a gradient scrim cannot be divided out");
});

const solid = (r: number, g: number, b: number) => [{ type: "SOLID", color: { r, g, b, a: 1 } }];
const overlayLink = (destinationId: string, x: number, y: number) => [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId, navigation: "OVERLAY", overlayRelativePosition: { x, y }, transition: { type: "DISSOLVE", duration: 0.1 } }] }];

test("a centered-column page becomes fluid: full-width layers stretch, the column keeps its distance from the center", () => {
  const wide = { absoluteBoundingBox: { x: 100, y: 50, width: 1920, height: 1000 } };
  const raw = page([
    { id: "2:1", name: "Navigation", type: "FRAME", ...box(0, 0, 1920, 100), fills: solid(1, 1, 1), children: [
      { id: "2:2", name: "Logo", type: "RECTANGLE", ...box(340, 30, 120, 40), fills: solid(0, 0.5, 0) },
      { id: "2:3", name: "Icons", type: "RECTANGLE", ...box(1460, 30, 120, 40), fills: solid(0, 0, 0) },
    ] },
    { id: "3:1", name: "Hero", type: "RECTANGLE", ...box(340, 140, 1240, 400), fills: solid(1, 0.9, 0.2) },
    { id: "4:1", name: "Chat", type: "RECTANGLE", ...box(1800, 900, 80, 80), fills: solid(0, 0, 1), constraints: { horizontal: "RIGHT", vertical: "TOP" } },
  ], wide);
  const { root, fit } = buildIR(normalizeFixture(raw, "k"));
  assert.deepEqual(fit, { fluid: true, width: 1920, minWidth: 1304 }, "the 1240 column plus 32px gutters");
  const [nav, hero, chat] = root.children;
  assert.equal(nav.style.width, "100%");
  assert.deepEqual(nav.children.map((kid) => kid.style.left), ["calc(50% - 620px)", "calc(50% + 500px)"]);
  assert.equal(hero.style.left, "calc(50% - 620px)");
  assert.equal(chat.style.left, "calc(100% - 120px)", "an explicit right constraint wins and does not bound the column");
  assert.match(emitReact(buildIR(normalizeFixture(raw, "k")), { component: "Home", assetUrl: (file) => file }), /<Page id="1:1" w=\{1920\} h=\{1000\} minW=\{1304\} fluid>\n      <Box id="2:1" x=\{0\} y=\{0\} w=\{1920\} h=\{100\} bg="#FFFFFF" style=\{\{ width: "100%" \}\}>/);
});

test("prototype overlays become accessible popups on the page; an overlay frame compiles as a panel", () => {
  const raw = page([
    { id: "2:1", name: "Catalog button", type: "FRAME", ...box(20, 20, 120, 40), fills: solid(0.9, 0.9, 0.9), interactions: overlayLink("9:1", -10, 50), children: [
      { id: "2:2", name: "Label", type: "TEXT", ...box(30, 30, 60, 20), characters: "Catalog", style: { fontFamily: "Nunito", fontSize: 14, fontWeight: 700, lineHeightPx: 20 } },
    ] },
    { id: "3:1", name: "Search icon", type: "FRAME", ...box(200, 20, 24, 24), interactions: overlayLink("9:2", 0, 30), children: [{ id: "3:2", name: "Glass", type: "VECTOR", ...box(200, 20, 24, 24), fills: solid(0, 0, 0) }] },
  ]);
  const fingerprint = normalizeFixture(raw, "k");
  assert.deepEqual(fingerprint.pages[0].children[0].children?.[0].link, { nodeId: "9:1", navigation: "overlay", offset: { x: -10, y: 50 }, ms: 100 });
  const ir = buildIR(fingerprint, { overlays: { "9:1": { component: "CatalogOverlay", label: "Catalog" } } });
  assert.deepEqual(ir.popups.map((popup) => [popup.trigger, popup.target, popup.component, popup.dx, popup.dy]), [["2:1", "9:1", "CatalogOverlay", -10, 50], ["3:1", "9:2", undefined, 0, 30]], "the icon's action moved to the one element left of it");
  assert.ok(ir.notes.some((note) => note.includes("prototype overlay 9:2 is not built")));
  const code = emitReact(ir, { component: "Home", assetUrl: (file) => file });
  assert.match(code, /^import \{ useState \} from "react";\nimport \{ Box, Page, Popup, Txt, Pic, asset \} from "..\/lib";\nimport CatalogOverlay from ".\/CatalogOverlay";/);
  assert.match(code, /<Box id="2:1" [^>]*on=\{\(\) => toggle\("9:1"\)\} expanded=\{open === "9:1"\}/);
  assert.match(code, /<Popup open=\{open === "9:1"\} trigger="2:1" dx=\{-10\} dy=\{50\} ms=\{100\} label="Catalog" onClose=\{\(\) => setOpen\(null\)\}><CatalogOverlay close=\{\(\) => setOpen\(null\)\} \/><\/Popup>/);
  assert.doesNotMatch(code, /toggle\("9:2"\)/, "an overlay that is not built is not wired");
  const itself = emitReact(ir, { component: "CatalogOverlay", assetUrl: (file) => file });
  assert.doesNotMatch(itself, /import CatalogOverlay|toggle\("9:1"\)|useState/, "an overlay never opens itself");

  // Inside the overlay, its own copy of the trigger (the active "Catalog" button) closes it.
  const withCopy = page([{ id: "2:9", name: "Catalog active", type: "FRAME", ...box(10, -40, 120, 40), fills: solid(0, 0.4, 0.2), interactions: overlayLink("1:1", 0, 0), children: [] }]);
  const selfClosing = emitReact(buildIR(normalizeFixture(withCopy, "k"), { asOverlay: true }), { component: "CatalogOverlay", assetUrl: (file) => file });
  assert.match(selfClosing, /export default function CatalogOverlay\(\{ close \}: \{ close\?: \(\) => void \}\)/);
  assert.match(selfClosing, /<Box id="2:9" [^>]*on=\{close\} label="Close"/);
  const panel = page([], { cornerRadius: 20, fills: solid(1, 1, 1), strokes: [{ type: "SOLID", color: { r: 0.86, g: 0.89, b: 0.92, a: 1 } }], strokeWeight: 1, strokeAlign: "INSIDE", effects: [{ type: "DROP_SHADOW", visible: true, radius: 40, offset: { x: 0, y: 8 }, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.1 } }] });
  const overlay = buildIR(normalizeFixture(panel, "k"), { asOverlay: true });
  assert.equal(overlay.kind, "overlay"); assert.equal(overlay.root.style.borderRadius, 20); assert.equal(overlay.root.style.boxShadow, "0px 8px 40px 0px rgba(0,0,0,0.1)");
  const panelCode = emitReact(overlay, { component: "CatalogOverlay", assetUrl: (file) => file });
  assert.match(panelCode, /<div data-fig="1:1" style=\{\{ width: 400, height: 300, position: "relative"/); assert.doesNotMatch(panelCode, /<Page/);
  assert.match(panelCode, /<div style=\{\{ position: "absolute", inset: 0, border: "1px solid #DBE3EB", borderRadius: "inherit"/, "the frame's own stroke is drawn over its content");
});

test("a color painted above a photo covers it; one below shows through its transparency", () => {
  const photo = (id: string, x: number, fills: unknown[]) => ({ id, name: "Rectangle", type: "RECTANGLE", ...box(x, 0, 100, 100), cornerRadius: 20, fills });
  const image = { type: "IMAGE", imageRef: "shot", scaleMode: "FILL" };
  const wash = { type: "SOLID", opacity: 0.05, color: { r: 0, g: 0, b: 0, a: 1 } };
  const raw = page([photo("8:1", 0, [image, wash]), photo("8:2", 150, [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }, image])]);
  const design = normalizeFixture(raw, "k");
  for (const item of design.assets.items) item.localPath = `outputs/x/assets/${item.imageRef}.png`;
  const code = emitReact(buildIR(design), { component: "Photos", assetUrl: (file) => file });
  // Fills paint bottom to top: the 5% black wash is a layer over the photo (a white product shot turns light grey, as in Figma).
  assert.match(code, /<Box id="8:1" [^>]*clip[^>]*><img src=\{asset\("shot\.png"\)\}[^>]*style=\{\{ position: "absolute", left: 0, top: 0, width: 100, height: 100, objectFit: "cover"[^>]*\/><div style=\{\{ position: "absolute", inset: 0, background: "rgba\(0,0,0,0\.05\)", borderRadius: "inherit", pointerEvents: "none" \}\} \/><\/Box>/);
  assert.match(code, /<Pic id="8:2" src=\{asset\("shot\.png"\)\}[^\n]*style=\{\{ background: "#FFFFFF" \}\}/, "a color under the photo stays a background");
});

test("a learned state fits items drawn at another size, and a control the design cuts is moved inside its box", () => {
  // Section A: 235px photos (one card drawn with "− 1 +"); section B: the same card drawn with a 211px photo.
  const photo = (id: string, x: number, y: number, size: number, inner: unknown[]) => ({ id, name: "Photo", type: "FRAME", ...box(x, y, size, size), clipsContent: true, cornerRadius: 20, fills: solid(1, 1, 1),
    children: [{ id: `${id}i`, name: "Image", type: "RECTANGLE", ...box(x, y, size, size), fills: [{ type: "IMAGE", imageRef: `img-${id}`, scaleMode: "FILL" }] }, ...inner] });
  const basket = (id: string, x: number, y: number) => ({ id, name: "Cart button", type: "FRAME", ...box(x, y, 50, 50), cornerRadius: 25, fills: solid(1, 1, 1), children: [{ id: `${id}v`, name: "Linear / Shopping / Cart 5", type: "VECTOR", ...box(x + 13, y + 13, 24, 24), fills: solid(0, 0.4, 0.2) }] });
  const stepper = (id: string, x: number, y: number) => ({ id, name: "Stepper", type: "FRAME", ...box(x, y, 215, 50), cornerRadius: 25, fills: solid(0, 0.4, 0.2), children: [
    { id: `${id}m`, name: "minus", type: "FRAME", ...box(x + 5, y + 5, 40, 40), cornerRadius: 20, fills: solid(1, 0.9, 0), children: [{ id: `${id}mv`, name: "minus-small", type: "VECTOR", ...box(x + 17, y + 24, 16, 2), fills: solid(0, 0, 0) }] },
    { id: `${id}t`, name: "1", type: "TEXT", ...box(x + 102, y + 13, 11, 25), characters: "1", style: { fontFamily: "Nunito", fontSize: 18, fontWeight: 700, lineHeightPx: 25 } },
    { id: `${id}p`, name: "plus", type: "FRAME", ...box(x + 170, y + 5, 40, 40), cornerRadius: 20, fills: solid(1, 0.9, 0), children: [{ id: `${id}pv`, name: "plus-small", type: "VECTOR", ...box(x + 182, y + 17, 16, 16), fills: solid(0, 0, 0) }] },
  ] });
  const heart = (id: string, x: number, y: number) => ({ id, name: "Like", type: "FRAME", ...box(x, y, 32, 32), cornerRadius: 10, fills: [{ type: "SOLID", opacity: 0.4, color: { r: 0.19, g: 0.24, b: 0.29, a: 1 } }], children: [{ id: `${id}v`, name: "Linear / Like / Heart", type: "VECTOR", ...box(x + 5, y + 5, 22, 22), strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], strokeWeight: 1.5 }] });
  const cardA = (n: number, inCart: boolean) => { const x = n * 250, id = 30 + n; return { id: `${id}:1`, name: "Card", type: "FRAME", ...box(x, 0, 235, 300), children: [
    photo(`${id}:2`, x, 0, 235, [inCart ? stepper(`${id}:4`, x + 10, 175) : basket(`${id}:3`, x + 175, 175), heart(`${id}:5`, x + 193, 10)]),
    { id: `${id}:6`, name: "Title", type: "TEXT", ...box(x, 245, 200, 24), characters: `Item ${n}`, style: { fontFamily: "Nunito", fontSize: 18, fontWeight: 700, lineHeightPx: 24 } }] }; };
  const cardB = (n: number) => { const x = n * 240, id = 40 + n; return { id: `${id}:1`, name: "Card", type: "FRAME", ...box(x, 340, 227, 300), clipsContent: true, fills: solid(1, 1, 1), children: [
    photo(`${id}:2`, x + 8, 348, 211, [basket(`${id}:3`, x + 8 + 151, 348 + 151), heart(`${id}:5`, x + 8 + 169, 348 + 10)]),
    { id: `${id}:6`, name: "Title", type: "TEXT", ...box(x + 8, 570, 200, 24), characters: `Offer ${n}`, style: { fontFamily: "Nunito", fontSize: 18, fontWeight: 700, lineHeightPx: 24 } }] }; };
  // A banner whose button was pasted half outside it; a slide the design hides entirely; a carousel cutting a whole card.
  const pill = (id: string, x: number, y: number, label: string) => ({ id, name: label, type: "FRAME", ...box(x, y, 100, 40), cornerRadius: 12, fills: solid(1, 0.9, 0), children: [{ id: `${id}t`, name: label, type: "TEXT", ...box(x + 20, y + 10, 60, 20), characters: label, style: { fontFamily: "Nunito", fontSize: 16, fontWeight: 700, lineHeightPx: 20 } }] });
  const banner = { id: "50:1", name: "Banner", type: "FRAME", ...box(0, 700, 300, 100), clipsContent: true, fills: solid(0.9, 0.95, 1), children: [pill("50:2", 240, 730, "Shop now"), pill("50:3", 420, 730, "Hidden")] };
  const carousel = { id: "51:1", name: "Carousel", type: "FRAME", ...box(400, 700, 300, 100), clipsContent: true, children: [
    { id: "51:2", name: "Slide", type: "FRAME", ...box(640, 700, 150, 100), fills: solid(1, 1, 1), children: [pill("51:3", 660, 730, "Open")] }] };
  const raw = page([cardA(0, false), cardA(1, false), cardA(2, true), cardA(3, false), cardB(0), cardB(1), cardB(2), banner, carousel], { absoluteBoundingBox: { x: 100, y: 50, width: 1000, height: 820 } });
  const ir = buildIR(normalizeFixture(raw, "k"));
  const counter = ir.behaviors.find((entry) => entry.kind === "counter")!;
  assert.equal(counter.target.id, "30:3", "the representative is drawn at the example's size, so the example's pixels are its oracle");
  assert.deepEqual(counter.alsoAt?.map((entry) => entry.target.id), ["40:3"], "one more instance for the other item size is clicked too");
  const code = emitReact(ir, { component: "Shop", assetUrl: (file) => file });
  // In the 211px photo the 215px bar keeps its 10px insets and narrows to 191px: − stays left, + keeps its right inset, the number stays centered.
  assert.match(code, /<Box id="32:4~40:3" x=\{10\} y=\{151\} w=\{191\} h=\{50\}/);
  assert.match(code, /<Box id="32:4m~40:3" x=\{5\} y=\{5\} w=\{40\}/); assert.match(code, /<Box id="32:4p~40:3" x=\{146\} y=\{5\} w=\{40\}/);
  assert.match(code, /<Txt id="32:4t~40:3" x=\{90\}/);
  // Where the photo is the example's size, the bar is exactly where the design draws it.
  assert.match(code, /<Box id="32:4~30:3" x=\{10\} y=\{175\} w=\{215\} h=\{50\}/);
  // The banner's button: 40% of it was cut, so it moves inside and the verdict reports it; the hidden one and the carousel's are left alone.
  assert.deepEqual(ir.fixes.map((fix) => [fix.id, fix.by.id, fix.cutPct, fix.from.x, fix.to.x]), [["50:2", "50:1", 40, 240, 200]]);
  assert.match(code, /<Box id="50:2" x=\{200\} y=\{30\}/); assert.match(code, /<Box id="50:3" x=\{420\}/); assert.match(code, /<Box id="51:3" x=\{20\}/);
});

test("states drawn once as examples become behaviors: a liked heart toggles, a stepper counts, look-alike buttons get a pointer", () => {
  const heart = (id: string, x: number, liked: boolean) => ({ id, name: "Frame 86", type: "FRAME", ...box(x + 190, 10, 32, 32), cornerRadius: 10, fills: liked ? solid(0.91, 0.12, 0.12) : [{ type: "SOLID", opacity: 0.4, color: { r: 0.19, g: 0.24, b: 0.29, a: 1 } }],
    children: [{ id: `${id}v`, name: liked ? "Bold / Like / Heart" : "Linear / Like / Heart", type: "VECTOR", ...box(x + 195, 15, 22, 22), fills: liked ? solid(1, 1, 1) : [], strokes: liked ? [] : [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }], strokeWeight: 1.5 }] });
  const basket = (id: string, x: number) => ({ id, name: "Cart button", type: "FRAME", ...box(x + 175, 175, 50, 50), cornerRadius: 25, fills: solid(1, 1, 1), children: [{ id: `${id}v`, name: "Linear / Shopping / Cart 5", type: "VECTOR", ...box(x + 188, 188, 24, 24), fills: solid(0, 0.4, 0.2) }] });
  const stepper = (id: string, x: number) => ({ id, name: "Stepper", type: "FRAME", ...box(x + 10, 175, 215, 50), cornerRadius: 25, fills: solid(0, 0.4, 0.2), children: [
    { id: `${id}m`, name: "minus", type: "FRAME", ...box(x + 15, 180, 40, 40), cornerRadius: 20, fills: solid(1, 0.9, 0), children: [{ id: `${id}mv`, name: "minus-small", type: "VECTOR", ...box(x + 27, 199, 16, 2), fills: solid(0, 0, 0) }] },
    { id: `${id}t`, name: "1", type: "TEXT", ...box(x + 112, 188, 11, 25), characters: "1", style: { fontFamily: "Nunito", fontSize: 18, fontWeight: 700, lineHeightPx: 25 } },
    { id: `${id}p`, name: "plus", type: "FRAME", ...box(x + 180, 180, 40, 40), cornerRadius: 20, fills: solid(1, 0.9, 0), children: [{ id: `${id}pv`, name: "plus-small", type: "VECTOR", ...box(x + 192, 192, 16, 16), fills: solid(0, 0, 0) }] },
  ] });
  const card = (n: number, liked: boolean, inCart: boolean) => { const x = n * 250, id = n + 20; return { id: `${id}:1`, name: "Card", type: "FRAME", ...box(x, 0, 235, 235), children: [
    { id: `${id}:2`, name: "Photo", type: "RECTANGLE", ...box(x, 0, 235, 235), fills: [{ type: "IMAGE", imageRef: `photo-${n}`, scaleMode: "FILL" }] },
    inCart ? stepper(`${id}:4`, x) : basket(`${id}:3`, x), heart(`${id}:5`, x, liked),
  ] }; };
  const pill = (id: number, x: number, w: number, label: string) => ({ id: `${id}:1`, name: label, type: "FRAME", ...box(x, 260, w, 32), cornerRadius: 30, fills: solid(0.92, 0.94, 0.96), children: [{ id: `${id}:2`, name: label, type: "TEXT", ...box(x + 14, 266, w - 30, 20), characters: label, style: { fontFamily: "Nunito", fontSize: 16, fontWeight: 500, lineHeightPx: 20 } }] });
  const raw = page([card(0, false, false), card(1, true, false), card(2, false, true), card(3, false, false), pill(6, 0, 105, "See all"), pill(7, 200, 70, "-15%")], { absoluteBoundingBox: { x: 100, y: 50, width: 1000, height: 300 } });
  const ir = buildIR(normalizeFixture(raw, "k"));
  assert.deepEqual(ir.behaviors.map((entry) => [entry.kind, entry.label, entry.instances, entry.target.id, entry.exemplar.id]), [["counter", "Cart", 4, "20:3", "22:4"], ["toggle", "Heart", 4, "20:5", "21:5"]]);
  // Where the design draws the other state, counting down (or a click) brings back a copy of the first state: exercised too.
  assert.deepEqual(ir.behaviors.map((entry) => entry.drawn?.map((instance) => [instance.target.id, instance.other, instance.presses])), [[["22:4", "20:3~22:4", 1]], [["21:5", "20:5~21:5", undefined]]]);
  const code = emitReact(ir, { component: "Shop", assetUrl: (file) => file });
  // The cart button is a white chip around its icon: CSS draws the chip, only the icon is pixels (a crop of the whole
  // button would carry the photo around it to every card its copy appears on).
  assert.match(code, /<Box id="20:3" x=\{175\} y=\{175\} w=\{50\} h=\{50\} bg="#FFFFFF" r=\{25\}[^\n]*label="Cart"/);
  assert.match(code, /<Pic id="20:3v" flat src=\{asset\("f2c-20-3v\.svg"\)\}/);
  assert.match(code, /const \[pressed, setPressed\] = useState<Record<string, boolean>>\(\{"21:5":true\}\);/, "the heart drawn liked starts liked");
  assert.match(code, /const \[counts, setCounts\] = useState<Record<string, number>>\(\{"22:4":1\}\);/, "the card drawn with 1 starts at 1");
  assert.match(code, /\{pressed\["20:5"\] \? \(\n[^]*?id="21:5~20:5"[^]*?on=\{\(\) => press\("20:5"\)\} pressed label="Heart"/);
  assert.match(code, /id="20:5" [^\n]*on=\{\(\) => press\("20:5"\)\} pressed=\{false\}/, "each rendering states its own aria-pressed");
  assert.match(code, /\{\(counts\["20:3"\] \?\? 0\) > 0 \? \(/);
  assert.match(code, /id="22:4t~20:3"[^>]*>\{String\(counts\["20:3"\] \?\? 0\)\}<\/Txt>/, "the number shows the count");
  assert.match(code, /id="22:4m~20:3"[^\n]*on=\{\(\) => count\("20:3", -1\)\}/); assert.match(code, /id="22:4p~20:3"[^\n]*on=\{\(\) => count\("20:3", 1\)\}/);
  assert.match(code, /<Box id="6:1" [^>]*style=\{\{[^}]*cursor: "pointer"/, "a look-alike button gets the hand cursor");
  assert.doesNotMatch(code, /<Box id="7:1" [^\n]*cursor/, "a percentage badge is not a button");
  const html = emitHtml(ir, { assetUrl: (file) => file });
  assert.ok(!html.includes("~"), "static output shows only the designed states");
});

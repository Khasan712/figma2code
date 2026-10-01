import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { DesignFingerprintV1, NodeFingerprint, PaintFingerprint } from "./types.ts";
import type { Page } from "playwright";
import type { Behavior } from "./behaviors.ts";
import type { Fix } from "./visibility.ts";

/**
 * Verifies a rendered implementation against an extracted design:
 *  a) per-node geometry/style assertions, matching DOM elements to fingerprint nodes via data-fig;
 *  b) a pixel diff of a live screenshot vs Figma's target.png, ATTRIBUTED to the design node under
 *     each differing pixel. Glyph rasterization and photo resampling are unavoidable noise; a diff
 *     over a flat box or a rendered asset is a real defect. Splitting the two lets the loop stop the
 *     moment nothing actionable is left instead of chasing a global percentage.
 */
export interface CompareOptions {
  designDir: string; url: string; outDir?: string;
  posTolerance?: number; sizeTolerance?: number; pixelThreshold?: number;
  /** Geometry/style only: no screenshot, no pixel work (≈1–2 s) — for inner fix iterations. */
  fast?: boolean;
  /** "hotspots" (default) writes small crops of unexplained regions; "full" also writes diff.png + side-by-side.png. */
  artifacts?: "none" | "hotspots" | "full";
  /** Pass bounds. `maxPixelDiffPct` is the legacy global cap, kept only as a reported number. */
  maxUnexplainedPct?: number; maxTextPct?: number; maxImagePct?: number; maxFlatPct?: number; maxPixelDiffPct?: number;
  /** Open a prototype overlay first: click this trigger (data-fig); the compared root is then the overlay. dx/dy: its expected offset from the trigger. */
  open?: { trigger: string; dx?: number; dy?: number; };
  /** Viewport to load the url in (default: the design target's size) — an overlay opens on its page at the page's design size. */
  viewport?: { width: number; height: number; };
  /** Fit audit: lay the page out again at these viewport widths — never a horizontal scroll, and at `cropWidth` the design's center crop. */
  fit?: { widths: number[]; cropWidth?: number; };
  /** Inferred interactive states to exercise: click, compare with the design's own example of the other state, click back. */
  behaviors?: Behavior[];
  /** Controls the compiler moved inside the box that cut them in the design: their pixels differ from the design on purpose. */
  fixes?: Fix[];
}
export interface BehaviorResult { kind: Behavior["kind"]; label: string; instances: number; ok: boolean; problems: string[]; asDesignedPct?: number; backPct?: number; /** Why it was not exercised here: something the design paints on top covers it (a modal). */ skipped?: string; /** Item sizes it was clicked in, and in how many of them its other state showed whole. */ sizes?: number; wholeIn?: number; /** Copies of a state shown away from where the design draws it, and how many carried nothing along. */ copies?: number; cleanCopies?: number; }
export interface FitResult { rows: { width: number; overflow: number; zoom: number; }[]; crop?: { width: number; pixelDiffPct?: number; allowedPct?: number; skipped?: string; }; }
export interface InteractionResult { placement?: { dx: number; dy: number; expectedDx: number; expectedDy: number; }; closesOnEscape: boolean; closesOnOutsideClick: boolean; /** Clicking where the trigger is closes it again — checked when the pointer there reaches the trigger or the overlay's own close control. */ closesOnTrigger?: boolean; }
export interface Violation { nodeId: string; name: string; prop: string; expected: string | number; actual: string | number; delta?: number; severity: "high" | "medium" | "low"; }
export interface Hotspot { rect: { x: number; y: number; w: number; h: number; }; pixels: number; owners: { nodeId: string; name: string; type: string; }[]; crop: string | null; }
export interface NodeOutlier { nodeId: string; name: string; type: string; cause: DiffCause; diffRatio: number; note: string; }
export type DiffCause = "text" | "image" | "flat" | "fixed" | "other";
export interface CutControl { id: string; label: string; shown: number; by: string; }
/** A node whose average color over its own pixels differs from the design's (0–255 on the worst channel). */
export interface ColorShift { nodeId: string; name: string; type: string; cause: DiffCause; delta: number; expected: string; actual: string; areaPct: number; /** A known limit that accounts for it; unexplained shifts fail the page. */ explained?: string; }
/**
 * Average-color difference worth reporting, and one that fails the page. Photo resampling stays at 0–2; a missing 5%
 * wash over a product photo measured 8–11, a photo shown at the wrong scale 35; a few large photos sit at 6 unexplained.
 */
const SHIFT = 6, SHIFT_FAIL = 8;
export interface CompareReport {
  summary: {
    pass: boolean; reasons: string[]; mode: "full" | "fast";
    pixelDiffPct: number | null; diffByCause: Record<DiffCause, number> | null; unexplainedPct: number | null; legacyPass: boolean | null;
    violations: number; high: number; medium: number; low: number;
    mappedNodes: number; checkableNodes: number; flattenedNodes: number; coveragePct: number; canvas: string;
    fit?: FitResult; interaction?: InteractionResult; behaviors?: BehaviorResult[];
    /** Controls shown cut by a box they sit in (a clipping container), as measured in the page. */ cutControls?: CutControl[];
    fixes?: Fix[];
  };
  violations: Violation[];
  hotspots: Hotspot[];
  outliers: NodeOutlier[];
  shifts: ColorShift[];
  /** Rendered assets that show a square of the design's background around their artwork (Δ: worst corner, 0–255). */
  seams: { id: string; delta: number; corners: number; }[];
  unmapped: { nodeId: string; name: string; type: string; size: string; }[];
  notes: string[];
  timings: Record<string, number>;
  files: { actual: string | null; diff: string | null; sideBySide: string | null; report: string; };
}

interface DomElement { x: number; y: number; width: number; height: number; text: string; color: string; backgroundColor: string; backgroundImage: string; fontSize: string; fontFamily: string; fontWeight: string; lineHeight: string; letterSpacing: string; textAlign: string; textTransform: string; borderTopLeftRadius: string; opacity: string; duplicates: number; flat: boolean; brokenImage: boolean; display: string; }

const round1 = (value: number): number => Math.round(value * 10) / 10;
const pct = (value: number): number => Math.round(value * 10000) / 100;
function findById(node: NodeFingerprint, id: string): NodeFingerprint | undefined { if (node.id === id) return node; for (const child of node.children || []) { const found = findById(child, id); if (found) return found; } return undefined; }
function topSolid(fills: PaintFingerprint[] | undefined): PaintFingerprint | undefined { return fills ? [...fills].reverse().find((fill) => fill.type === "solid" && fill.color?.hex) : undefined; }

interface Rgba { r: number; g: number; b: number; a: number; }
function hexToRgba(hex: string): Rgba | undefined {
  const match = hex.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i); if (!match) return undefined;
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: match[2] ? parseInt(match[2], 16) / 255 : 1 };
}
function cssToRgba(css: string): Rgba | undefined {
  const match = css.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/); if (!match) return undefined;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}
function sameColor(expected: Rgba, actual: Rgba): boolean { return Math.abs(expected.r - actual.r) <= 1 && Math.abs(expected.g - actual.g) <= 1 && Math.abs(expected.b - actual.b) <= 1 && Math.abs(expected.a - actual.a) <= 0.02; }
function rgbaLabel(value: Rgba): string { const byte = (channel: number) => Math.round(channel).toString(16).padStart(2, "0").toUpperCase(); return value.a === 0 ? "transparent" : `#${byte(value.r)}${byte(value.g)}${byte(value.b)}${value.a < 1 ? Math.round(value.a * 255).toString(16).padStart(2, "0").toUpperCase() : ""}`; }

function cropPng(source: PNG, sx: number, sy: number, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) source.data.copy(out.data, y * width * 4, ((sy + y) * source.width + sx) * 4, ((sy + y) * source.width + sx + width) * 4);
  return out;
}
function sideBySide(images: PNG[], gap = 8): PNG {
  const width = images.reduce((total, image) => total + image.width, 0) + gap * (images.length - 1);
  const height = Math.max(...images.map((image) => image.height));
  const out = new PNG({ width, height }); out.data.fill(255);
  let offsetX = 0;
  for (const image of images) {
    for (let y = 0; y < image.height; y++) image.data.copy(out.data, (y * width + offsetX) * 4, y * image.width * 4, (y + 1) * image.width * 4);
    offsetX += image.width + gap;
  }
  return out;
}

function checkNode(node: NodeFingerprint, rootBounds: NodeFingerprint["bounds"], element: DomElement, tolerances: { pos: number; size: number; }, violations: Violation[]): void {
  const push = (prop: string, expected: string | number, actual: string | number, severity: Violation["severity"], delta?: number) => violations.push({ nodeId: node.id, name: node.name, prop, expected, actual, delta, severity });
  if (element.brokenImage) push("image", "loaded", "failed to load (broken src)", "high");
  if (element.display === "none") { push("display", "visible", "display:none", "high"); return; }
  const geometry: [string, number, number, number][] = [
    ["x", node.bounds.x - rootBounds.x, element.x, tolerances.pos], ["y", node.bounds.y - rootBounds.y, element.y, tolerances.pos],
    ["width", node.bounds.width, element.width, tolerances.size], ["height", node.bounds.height, element.height, tolerances.size],
  ];
  for (const [prop, expected, actual, tolerance] of geometry) {
    const delta = Math.abs(expected - actual);
    if (delta > tolerance) push(prop, round1(expected), round1(actual), delta > 8 ? "high" : "medium", round1(delta));
  }
  // Inside a data-fig-flat container the pixels come from a Figma-rendered image, so CSS
  // style properties can't encode the node's paint — geometry is checked, styles are not.
  if (element.flat) return;
  const fill = topSolid(node.fills);
  // Figma paint-level opacity multiplies the color alpha (e.g. a #727272 fill at 0.5 renders as rgba(114,114,114,0.5)).
  const withPaintOpacity = (color: Rgba | undefined, opacity: number | undefined): Rgba | undefined => color && (opacity === undefined ? color : { ...color, a: color.a * opacity });
  if (node.type === "TEXT") {
    const typography = node.typography;
    const expectedText = (node.content?.text || "").replace(/\s+/g, " ").trim();
    const actualText = element.text.replace(/\s+/g, " ").trim();
    if (expectedText && expectedText !== actualText) push("text", expectedText.slice(0, 80), actualText.slice(0, 80), "high");
    const expectedColor = withPaintOpacity(fill?.color?.hex ? hexToRgba(fill.color.hex) : undefined, fill?.opacity); const actualColor = cssToRgba(element.color);
    const gradientText = node.fills?.some((paint) => paint.gradient);
    if (!gradientText && expectedColor && actualColor && !sameColor(expectedColor, actualColor)) push("color", rgbaLabel(expectedColor), rgbaLabel(actualColor), "high");
    if (typography?.fontSize !== undefined) { const actualSize = parseFloat(element.fontSize); if (Number.isFinite(actualSize) && Math.abs(actualSize - typography.fontSize) > 0.55) push("fontSize", typography.fontSize, round1(actualSize), "medium", round1(Math.abs(actualSize - typography.fontSize))); }
    if (typography?.fontWeight !== undefined) { const actualWeight = parseInt(element.fontWeight, 10); if (Number.isFinite(actualWeight) && actualWeight !== typography.fontWeight) push("fontWeight", typography.fontWeight, actualWeight, "medium"); }
    if (typography?.fontFamily) { const family = typography.fontFamily.toLowerCase(); if (!element.fontFamily.toLowerCase().includes(family)) push("fontFamily", typography.fontFamily, element.fontFamily.slice(0, 60), "medium"); }
    // Mixed-size texts zero the block line-height on purpose (each run carries its own), so only uniform texts are checked.
    const expectedLineHeight = typography?.lineHeightPx ?? typography?.lineHeight?.value; const actualLineHeight = parseFloat(element.lineHeight);
    if (expectedLineHeight !== undefined && !node.content?.segments?.length && Number.isFinite(actualLineHeight) && Math.abs(actualLineHeight - expectedLineHeight) > 0.6) push("lineHeight", round1(expectedLineHeight), round1(actualLineHeight), "medium", round1(Math.abs(actualLineHeight - expectedLineHeight)));
    const actualSpacing = element.letterSpacing === "normal" ? 0 : parseFloat(element.letterSpacing);
    if (typography?.letterSpacing !== undefined && Number.isFinite(actualSpacing) && Math.abs(actualSpacing - typography.letterSpacing) > 0.06) push("letterSpacing", round1(typography.letterSpacing), round1(actualSpacing), "medium");
    if (typography?.textCase === "uppercase" && element.textTransform !== "uppercase" && expectedText !== expectedText.toUpperCase()) push("textTransform", "uppercase", element.textTransform, "medium");
  } else if (fill?.color?.hex && !node.fills?.some((paint) => paint.type === "image" || paint.gradient)) {
    const expectedColor = withPaintOpacity(hexToRgba(fill.color.hex), fill.opacity); const actualColor = cssToRgba(element.backgroundColor);
    // A background-image (generated gradient or asset) legitimately replaces background-color.
    if (expectedColor && actualColor && element.backgroundImage === "none" && !sameColor(expectedColor, actualColor)) push("background", rgbaLabel(expectedColor), rgbaLabel(actualColor), "high");
  }
  if (node.cornerRadius && node.type !== "TEXT") { const actualRadius = parseFloat(element.borderTopLeftRadius); if (Number.isFinite(actualRadius) && Math.abs(actualRadius - node.cornerRadius.topLeft) > 1 && !element.borderTopLeftRadius.includes("%")) push("borderRadius", node.cornerRadius.topLeft, round1(actualRadius), "low", round1(Math.abs(actualRadius - node.cornerRadius.topLeft))); }
  if (node.opacity !== undefined) { const actualOpacity = parseFloat(element.opacity); if (Number.isFinite(actualOpacity) && Math.abs(actualOpacity - node.opacity) > 0.02) push("opacity", node.opacity, actualOpacity, "low"); }
}

function isUniformTint(node: NodeFingerprint): boolean {
  const fills = (node.fills || []).filter((paint) => paint.visible !== false);
  if (!["RECTANGLE", "FRAME", "COMPONENT", "INSTANCE"].includes(node.type) || node.children?.some((child) => child.visible) || fills.length !== 1 || fills[0].type !== "solid") return false;
  if (node.strokes?.some((stroke) => stroke.paints.length) || node.effects?.some((effect) => effect.visible)) return false;
  return (node.opacity ?? 1) * (fills[0].opacity ?? 1) * (fills[0].color?.a ?? 1) < 0.999;
}

export async function runCompare(options: CompareOptions): Promise<CompareReport> {
  const outDir = options.outDir || join(options.designDir, "compare");
  const tolerances = { pos: options.posTolerance ?? 2, size: options.sizeTolerance ?? 2 };
  const artifacts = options.artifacts ?? "hotspots";
  const timings: Record<string, number> = {}; let last = performance.now();
  const mark = (label: string): void => { const now = performance.now(); timings[label] = Math.round(now - last); last = now; };
  const fingerprint = JSON.parse(await readFile(join(options.designDir, "fingerprint.json"), "utf8")) as DesignFingerprintV1;
  const target = fingerprint.targets[0];
  const root = fingerprint.pages.map((page) => page.children.map((child) => findById(child, target.nodeId)).find(Boolean)).find(Boolean);
  if (!root) throw new Error(`Compare: target node ${target.nodeId} is missing from the fingerprint.`);
  const notes: string[] = [];
  await mkdir(outDir, { recursive: true });
  const textFonts: { id: string; spec: string; family: string; }[] = [];
  const collectFonts = (node: NodeFingerprint): void => { if (!node.visible) return; if (node.type === "TEXT" && node.typography?.fontFamily) textFonts.push({ id: node.id, spec: `${node.typography.fontWeight ?? 400} 16px "${node.typography.fontFamily}"`, family: node.typography.fontFamily }); node.children?.forEach(collectFonts); };
  collectFonts(root);
  const fontsUsed = new Map<string, string>();
  mark("load fingerprint");

  const browser = await chromium.launch();
  let screenshot: Buffer | undefined; let dom: Record<string, DomElement>; let missingFonts: string[];
  const interaction: InteractionResult = { closesOnEscape: false, closesOnOutsideClick: false };
  const fitRows: FitResult["rows"] = []; let cropShot: Buffer | undefined; const behaviorResults: BehaviorResult[] = []; let cutControls: CutControl[] = [];
  let flatBoxes: { id: string; x: number; y: number; w: number; h: number; }[] = []; let hiddenShot: Buffer | undefined;
  try {
    const viewport = { width: Math.round(options.viewport?.width ?? target.width), height: Math.round(options.viewport?.height ?? target.height) };
    const context = await browser.newContext({ viewport, deviceScaleFactor: target.scale || 1 });
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: "load" });
    // content-visibility:auto is a scroll-perf optimization with no visual effect once rendered;
    // force it on so offscreen sections paint into the full-height screenshot.
    await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; content-visibility: visible !important; }" });
    // Lazy images report complete=true before they even start loading, so "wait for incomplete
    // images" races. Force eager loading and await every decode, then the fonts.
    const settle = () => page.evaluate(async () => {
      const images = Array.from(document.images);
      for (const image of images) { image.loading = "eager"; }
      await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
      await document.fonts.ready;
      for (const animation of document.getAnimations()) animation.finish();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await settle();
    mark("navigate + settle");

    const rootSelector = `[data-fig="${target.nodeId}"]`;
    const triggerSelector = options.open ? `[data-fig="${options.open.trigger.replace(/"/g, '\\"')}"]` : "";
    if (options.open) {
      // A prototype overlay is verified where users meet it: opened by its trigger, on its page.
      await page.click(triggerSelector);
      await page.waitForSelector(rootSelector, { state: "visible", timeout: 5000 }).catch(() => undefined);
      await settle();
      const offset = await page.evaluate(([trigger, root]) => { const from = document.querySelector(trigger)?.getBoundingClientRect(), to = document.querySelector(root)?.getBoundingClientRect(); return from && to ? { dx: to.left - from.left, dy: to.top - from.top } : null; }, [triggerSelector, rootSelector]);
      if (offset) interaction.placement = { dx: round1(offset.dx), dy: round1(offset.dy), expectedDx: options.open.dx ?? 0, expectedDy: options.open.dy ?? 0 };
      mark("open overlay");
    }
    const hasRoot = (await page.locator(rootSelector).count()) > 0;
    // Every control a user can see must show whole: partly cut by a box it sits in is a layout error, never a design intent.
    cutControls = await page.evaluate(`(() => { const shownOf = ${SHOWN_OF}; const stop = document.querySelector(${JSON.stringify(rootSelector)}); const cut = [];
      for (const element of document.querySelectorAll('[role="button"], a[href]')) { if (stop && !stop.contains(element)) continue; const { shown, by } = shownOf(element, stop);
        if (shown >= 5 && shown < 99) cut.push({ id: element.getAttribute("data-fig") || "", label: element.getAttribute("aria-label") || (element.textContent || "").trim().slice(0, 30), shown, by }); }
      return cut; })()`) as CutControl[];
    if (!hasRoot) notes.push(`No element carries data-fig="${target.nodeId}"; geometry is measured from the page origin and the screenshot covers the viewport.`);
    if (!options.fast) {
      screenshot = hasRoot
        ? await page.locator(rootSelector).first().screenshot()
        : await page.screenshot({ clip: { x: 0, y: 0, width: Math.round(target.width), height: Math.round(target.height) } });
      mark("screenshot");
      // The same page with every rendered asset hidden: what each one covers, for the seam check below.
      flatBoxes = await page.evaluate((selector: string) => {
        const origin = document.querySelector(selector)?.getBoundingClientRect() ?? { x: 0, y: 0 };
        return [...document.querySelectorAll<HTMLElement>("[data-fig-flat]")].map((element) => {
          const image = element instanceof HTMLImageElement ? element : element.querySelector("img"); const rect = (image ?? element).getBoundingClientRect();
          element.style.visibility = "hidden";
          return { id: element.getAttribute("data-fig")!, x: rect.x - origin.x, y: rect.y - origin.y, w: rect.width, h: rect.height };
        });
      }, rootSelector);
      if (flatBoxes.length) {
        hiddenShot = hasRoot ? await page.locator(rootSelector).first().screenshot() : await page.screenshot({ clip: { x: 0, y: 0, width: Math.round(target.width), height: Math.round(target.height) } });
        await page.evaluate(() => { for (const element of document.querySelectorAll<HTMLElement>("[data-fig-flat]")) element.style.visibility = ""; });
      }
      mark("screenshot without assets");
    }

    dom = await page.evaluate((selector: string) => {
      const rootElement = document.querySelector(selector);
      const origin = rootElement ? rootElement.getBoundingClientRect() : { x: 0, y: 0 };
      const elements: Record<string, DomElement> = {};
      for (const element of document.querySelectorAll<HTMLElement>("[data-fig]")) {
        const id = element.getAttribute("data-fig")!;
        if (elements[id]) { elements[id].duplicates++; continue; }
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        const images = element instanceof HTMLImageElement ? [element] : Array.from(element.querySelectorAll(":scope > img")) as HTMLImageElement[];
        // textContent (not innerText): the fingerprint stores source characters, and CSS
        // text-transform must not read as a content mismatch.
        elements[id] = { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height, text: element.textContent || "", color: style.color, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, fontSize: style.fontSize, fontFamily: style.fontFamily, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textAlign: style.textAlign, textTransform: style.textTransform, borderTopLeftRadius: style.borderTopLeftRadius, opacity: style.opacity, duplicates: 1, flat: element.closest("[data-fig-flat]") !== null, brokenImage: images.some((image) => image.complete && image.naturalWidth === 0), display: style.display };
      }
      return elements;
    }, rootSelector);
    mark("collect DOM");

    // Only text the page draws as live DOM needs its font: text inside a rendered-image (flat) element is pixels.
    for (const text of textFonts) { const element = dom[text.id]; if (element && !element.flat) fontsUsed.set(text.spec, text.family); }
    // document.fonts.check() is true for any family WITHOUT an @font-face rule, installed or not, so it
    // cannot see a missing system font. Measuring against two generic fallbacks can: if the family
    // changes neither width, the browser is drawing the fallback.
    missingFonts = await page.evaluate(async (specs: string[]) => {
      await Promise.all(specs.map((spec) => document.fonts.load(spec).catch(() => undefined)));
      const context = document.createElement("canvas").getContext("2d")!; const sample = "mmmmmmmmmmlliWQ@#1234567890";
      const width = (font: string): number => { context.font = font; return context.measureText(sample).width; };
      return specs.filter((spec) => {
        const match = spec.match(/^(\S+) 16px ("[^"]+")$/); if (!match) return false;
        const [, weight, family] = match;
        return width(`${weight} 72px ${family}, monospace`) === width(`${weight} 72px monospace`) && width(`${weight} 72px ${family}, serif`) === width(`${weight} 72px serif`);
      });
    }, [...fontsUsed.keys()]);
    mark("font probe");

    if (options.open) {
      const gone = async (): Promise<boolean> => { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); return (await page.locator(rootSelector).count()) === 0; };
      await page.keyboard.press("Escape"); interaction.closesOnEscape = await gone();
      if (interaction.closesOnEscape) {
        const reopen = async () => { const box = await page.locator(triggerSelector).boundingBox(); if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForSelector(rootSelector, { state: "visible", timeout: 5000 }).catch(() => undefined); };
        // Where the trigger is, the open overlay may draw its own copy of it: clicking there must close it again —
        // unless what is under the pointer is part of the overlay that keeps it open (a search field).
        await reopen();
        const box = await page.locator(triggerSelector).boundingBox();
        const toggles = box ? await page.evaluate(([trigger, x, y]) => { const hit = document.elementFromPoint(Number(x), Number(y)); return !!hit && (!!document.querySelector(String(trigger))?.contains(hit) || !!hit.closest('[aria-label="Close"]')); }, [triggerSelector, box.x + box.width / 2, box.y + box.height / 2]) : false;
        if (box && toggles) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); interaction.closesOnTrigger = await gone(); if (!interaction.closesOnTrigger) await page.keyboard.press("Escape"); }
        else await page.keyboard.press("Escape");
        await gone(); await reopen();
        await page.mouse.click(2, 2); interaction.closesOnOutsideClick = await gone();
      }
      mark("close checks");
    }
    if (options.behaviors?.length && !options.open) {
      // The design drew each other state once: after a click the element must look like that example, and a
      // second click (or counting back to zero) must restore exactly what was there.
      const design = PNG.sync.read(await readFile(join(options.designDir, "target.png")));
      const origin = (await page.locator(rootSelector).first().boundingBox()) ?? { x: 0, y: 0 };
      const at = (id: string) => page.locator(`[data-fig="${id.replace(/"/g, '\\"')}"]`).first();
      const settleFrame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const shoot = async (rect: { x: number; y: number; w: number; h: number; }) => PNG.sync.read(await page.screenshot({ clip: { x: origin.x + rect.x, y: origin.y + rect.y, width: rect.w, height: rect.h } }));
      const differs = (a: PNG, b: PNG): number => a.width === b.width && a.height === b.height ? pct(pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: options.pixelThreshold ?? 0.1 }) / (a.width * a.height)) : 100;
      const coverOf = (id: string) => page.evaluate((id) => {
        const element = document.querySelector(`[data-fig="${id}"]`); if (!element) return "missing";
        const box = element.getBoundingClientRect(); const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top && (top === element || element.contains(top)) ? "" : top?.closest("[data-fig]")?.getAttribute("data-fig") ?? top?.tagName.toLowerCase() ?? "something";
      }, id);
      // The other state must show whole: not cut by the box it sits in (a stepper wider than a smaller card's photo).
      const whole = async (id: string, where: string, fail: (problem: string) => void): Promise<boolean> => {
        const cut = await shownIn(page, id, rootSelector);
        if (cut && cut.shown < 99) { fail(`${where}its other state is cut by ${cut.by} (${cut.shown}% visible)`); return false; }
        return true;
      };
      // A copy of a state shown elsewhere must not bring the pixels that lay around it where the design drew it (a square
      // of another card's photo). Its box corners outside a rounded shape are painted only if it carries them: hide the
      // element and see whether they change, against the same state at home.
      // The element and every rendered asset inside it (an icon cut from the design sits inside a CSS box) are tested alone.
      const paintedCorners = async (id: string): Promise<number> => {
        const parts = await page.evaluate((id) => {
          const element = document.querySelector<HTMLElement>(`[data-fig="${id}"]`); if (!element) return [];
          return [element, ...element.querySelectorAll<HTMLElement>("[data-fig-flat]")].map((part, index) => { part.setAttribute("data-f2c-part", String(index)); const image = part instanceof HTMLImageElement ? part : part.querySelector("img"); const r = (image ?? part).getBoundingClientRect(); return { index, x: r.x, y: r.y, w: r.width, h: r.height }; });
        }, id);
        let painted = 0;
        for (const part of parts) {
          if (part.w < 8 || part.h < 8) continue;
          const clip = { x: Math.floor(part.x), y: Math.floor(part.y), width: Math.ceil(part.w), height: Math.ceil(part.h) };
          const shown = PNG.sync.read(await page.screenshot({ clip }));
          await page.evaluate((index) => { const element = document.querySelector<HTMLElement>(`[data-f2c-part="${index}"]`); if (element) element.style.visibility = "hidden"; }, part.index);
          const hidden = PNG.sync.read(await page.screenshot({ clip }));
          await page.evaluate((index) => { const element = document.querySelector<HTMLElement>(`[data-f2c-part="${index}"]`); if (element) element.style.visibility = ""; }, part.index);
          for (const [cx, cy] of [[2, 2], [shown.width - 3, 2], [2, shown.height - 3], [shown.width - 3, shown.height - 3]]) {
            let delta = 0;
            for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) { const i = (y * shown.width + x) * 4; for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(shown.data[i + c] - hidden.data[i + c])); }
            if (delta > 16) painted++;
          }
        }
        await page.evaluate(() => { for (const element of document.querySelectorAll("[data-f2c-part]")) element.removeAttribute("data-f2c-part"); });
        return painted;
      };
      const square = (where: string, what: string): string => `${where}${what} carries the background of where the design drew it (a square)`;
      for (const behavior of options.behaviors) {
        const result: BehaviorResult = { kind: behavior.kind, label: behavior.label, instances: behavior.instances, ok: true, problems: [] };
        const fail = (problem: string): void => { result.ok = false; result.problems.push(problem); };
        // Only what a user can reach is clicked: a modal drawn over the cards makes them unreachable, as designed.
        const cover = await coverOf(behavior.target.id);
        if (cover === "missing") { fail("its element is not on the page"); behaviorResults.push(result); continue; }
        if (cover) { result.skipped = `covered by ${cover}`; behaviorResults.push(result); continue; }
        const before = await shoot(behavior.target.rect);
        // At home (where the design draws them) neither state carries anything around it.
        const homeFirst = await paintedCorners(behavior.target.id), homeOther = await paintedCorners(behavior.exemplar.id);
        const copy = async (id: string, where: string, home: number, what: string): Promise<void> => {
          result.copies = (result.copies ?? 0) + 1;
          if (home === 0 && await paintedCorners(id) > 0) fail(square(where, what)); else result.cleanCopies = (result.cleanCopies ?? 0) + 1;
        };
        try { await at(behavior.target.id).click({ timeout: 5000 }); } catch { fail("its element cannot be clicked"); behaviorResults.push(result); continue; }
        await settleFrame();
        const swapped = await at(behavior.other).boundingBox();
        if (!swapped) fail("a click does not bring the other state");
        else {
          const shown = PNG.sync.read(await page.screenshot({ clip: swapped }));
          const example = cropPng(design, Math.round(behavior.exemplar.rect.x * (target.scale || 1)), Math.round(behavior.exemplar.rect.y * (target.scale || 1)), shown.width, shown.height);
          result.asDesignedPct = differs(example, shown);
          if (result.asDesignedPct > 15) fail(`after a click it looks unlike the design's example (${result.asDesignedPct}% differs)`);
          result.sizes = 1; result.wholeIn = (await whole(behavior.other, "", fail)) ? 1 : 0;
          await copy(behavior.other, "", homeOther, "its other state");
          if (behavior.kind === "toggle") {
            if (await at(behavior.other).getAttribute("aria-pressed") !== "true") fail("aria-pressed does not turn true");
            await at(behavior.other).click({ timeout: 5000 }); await settleFrame();
          } else {
            if ((await at(behavior.count!).textContent())?.trim() !== "1") fail("the count does not start at 1");
            await at(behavior.plus!).click({ timeout: 5000 }); await settleFrame();
            if ((await at(behavior.count!).textContent())?.trim() !== "2") fail("+ does not count up");
            await at(behavior.minus!).click({ timeout: 5000 }); await settleFrame(); await at(behavior.minus!).click({ timeout: 5000 }); await settleFrame();
          }
          if (!(await at(behavior.target.id).count())) fail("the original state does not come back");
          else { result.backPct = differs(before, await shoot(behavior.target.rect)); if (result.backPct > 1) fail(`the original state comes back changed (${result.backPct}%)`); }
        }
        // Items drawn at other sizes: one of each is clicked too; its other state must appear whole and go away again.
        for (const instance of behavior.alsoAt ?? []) {
          const where = `at ${instance.target.id}: `;
          if (await coverOf(instance.target.id)) continue;
          try { await at(instance.target.id).click({ timeout: 5000 }); } catch { fail(`${where}its element cannot be clicked`); continue; }
          await settleFrame();
          if (!(await at(instance.other).count())) { fail(`${where}a click does not bring the other state`); continue; }
          result.sizes = (result.sizes ?? 0) + 1; if (await whole(instance.other, where, fail)) result.wholeIn = (result.wholeIn ?? 0) + 1;
          await copy(instance.other, where, homeOther, "its other state");
          if (behavior.kind === "counter" && (await at(instance.count!).textContent())?.trim() !== "1") fail(`${where}the count does not start at 1`);
          await at(behavior.kind === "toggle" ? instance.other : instance.minus!).click({ timeout: 5000 }).catch(() => undefined); await settleFrame();
          if (!(await at(instance.target.id).count())) fail(`${where}the original state does not come back`);
        }
        // Where the design draws the other state (a liked heart, a stepper at 1), a click or counting down brings back a
        // copy of the first state: it must show whole and clean there too.
        for (const instance of behavior.drawn ?? []) {
          const where = `at ${instance.target.id}: `;
          if (await coverOf(instance.target.id)) continue;
          try {
            if (behavior.kind === "toggle") await at(instance.target.id).click({ timeout: 5000 });
            else for (let press = 0; press < (instance.presses ?? 1); press++) { await at(instance.minus!).click({ timeout: 5000 }); await settleFrame(); }
          } catch { fail(`${where}its element cannot be clicked`); continue; }
          await settleFrame();
          if (!(await at(instance.other).count())) { fail(`${where}${behavior.kind === "toggle" ? "a click" : "counting down to zero"} does not bring the first state`); continue; }
          await whole(instance.other, where, fail);
          await copy(instance.other, where, homeFirst, `the ${behavior.label.toLowerCase()} it comes back to`);
          await at(instance.other).click({ timeout: 5000 }).catch(() => undefined); await settleFrame();
          if (behavior.kind === "counter") for (let press = 1; press < (instance.presses ?? 1); press++) { await at(instance.plus!).click({ timeout: 5000 }).catch(() => undefined); await settleFrame(); }
          if (!(await at(instance.target.id).count())) fail(`${where}the drawn state does not come back`);
        }
        behaviorResults.push(result);
      }
      mark("behaviors");
    }
    if (options.fit && !options.open) {
      // The same page at other widths: the layout must meet every viewport without a horizontal scroll.
      for (const width of options.fit.widths) {
        await page.setViewportSize({ width, height: viewport.height });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
        const measured = await page.evaluate((selector) => { const rootElement = document.querySelector<HTMLElement>(selector); return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, zoom: rootElement ? parseFloat(getComputedStyle(rootElement).zoom) || 1 : 1 }; }, rootSelector);
        fitRows.push({ width, overflow: Math.max(0, measured.overflow), zoom: Math.round(measured.zoom * 1000) / 1000 });
        if (width === options.fit.cropWidth && measured.zoom >= 0.999 && hasRoot && !options.fast) cropShot = await page.locator(rootSelector).first().screenshot();
      }
      mark("fit audit");
    }
  } finally {
    await browser.close();
  }

  // ── Geometry/style assertions, walking the fingerprint target subtree. A node with no element
  // inside a data-fig-flat container is "flattened": painted by the rendered image, geometry untracked.
  const violations: Violation[] = [];
  const unmappedAll: CompareReport["unmapped"] = [];
  let mappedNodes = 0; let checkableNodes = 0; let flattenedNodes = 0;
  // Paint-order list for pixel attribution: [node, cause].
  const painted: { node: NodeFingerprint; cause: DiffCause; }[] = [];
  // A control the compiler moved inside the box that cut it sits where the design does not draw it, on purpose.
  const fixedIds = new Set((options.fixes ?? []).filter((fix) => !fix.state).map((fix) => fix.id));
  const visit = (node: NodeFingerprint, underFlat: boolean, underFixed = false): void => {
    let childFlat = underFlat; const fixed = underFixed || fixedIds.has(node.id);
    if (node.visible && node.bounds.width > 0 && node.bounds.height > 0) {
      checkableNodes++;
      const element = dom[node.id];
      if (element) {
        mappedNodes++;
        childFlat = underFlat || element.flat;
        if (element.duplicates > 1) notes.push(`data-fig="${node.id}" appears ${element.duplicates} times in the DOM; only the first occurrence was checked.`);
        if (!fixed) checkNode(node, root.bounds, element, tolerances, violations);
      } else if (underFlat) {
        flattenedNodes++;
      } else {
        unmappedAll.push({ nodeId: node.id, name: node.name, type: node.type, size: `${Math.round(node.bounds.width)}×${Math.round(node.bounds.height)}` });
      }
      // A uniform translucent layer (a modal's dimming backdrop) draws no edges of its own: a difference under it comes
      // from what it covers, so attribution looks through it. Its own color and opacity are checked per node above.
      if (!underFlat && !isUniformTint(node)) painted.push({ node, cause: childFlat ? "flat" : node.type === "TEXT" ? "text" : node.fills?.some((paint) => paint.type === "image") ? "image" : "other" });
    }
    if (!node.visible) return;
    node.children?.forEach((child) => visit(child, childFlat, fixed));
  };
  visit(root, false);
  // Where the compiler moved a control the design cut, the page differs from the design on purpose: both places are "fixed".
  for (const fix of options.fixes ?? []) if (!fix.state) for (const rect of [fix.from, fix.to]) painted.push({ node: { id: fix.id, name: fix.label, type: "FIXED", visible: true, bounds: { x: root.bounds.x + rect.x, y: root.bounds.y + rect.y, width: rect.w, height: rect.h } } as unknown as NodeFingerprint, cause: "fixed" });
  for (const spec of missingFonts) violations.push({ nodeId: root.id, name: fontsUsed.get(spec) ?? spec, prop: "font", expected: `font available: ${spec}`, actual: "not loaded — text renders in a fallback face", severity: "high" });
  if (flattenedNodes) notes.push(`${flattenedNodes} design nodes are painted by Figma-rendered images (data-fig-flat) and were checked visually via the pixel diff only.`);
  mark("geometry checks");

  // ── Pixel comparison against Figma's own render, attributed to the node under each differing pixel.
  let pixelDiffPct: number | null = null; let diffByCause: Record<DiffCause, number> | null = null; let unexplainedPct: number | null = null;
  let actualPath: string | null = null; let diffPath: string | null = null; let sideBySidePath: string | null = null; let canvas = "not captured (fast mode)";
  const hotspots: Hotspot[] = []; const outliers: NodeOutlier[] = []; const shifts: ColorShift[] = []; const seamsFound: { id: string; delta: number; corners: number; }[] = [];
  let fitCrop: FitResult["crop"] | undefined;
  if (screenshot) {
    actualPath = join(outDir, "actual.png"); await writeFile(actualPath, screenshot);
    let expectedPng: PNG = PNG.sync.read(await readFile(join(options.designDir, "target.png")));
    const actualPng = PNG.sync.read(screenshot);
    mark("decode PNGs");
    // Figma renders a frame with what it paints outside its box (its own shadow, overflowing layers): cut the box back out.
    const scale = target.scale || 1; const frame = root.renderBounds;
    if (frame && (expectedPng.width > Math.round(target.width * scale) || expectedPng.height > Math.round(target.height * scale))) {
      const left = Math.round((root.bounds.x - frame.x) * scale), top = Math.round((root.bounds.y - frame.y) * scale);
      const width = Math.round(target.width * scale), height = Math.round(target.height * scale);
      if (left >= 0 && top >= 0 && left + width <= expectedPng.width && top + height <= expectedPng.height) {
        notes.push(`Figma's render includes ${expectedPng.width - width}×${expectedPng.height - height}px painted outside the frame (shadow, overflow); compared the frame's own ${width}×${height} box.`);
        expectedPng = cropPng(expectedPng, left, top, width, height);
      }
    }
    // Where the design frame is transparent (an overlay panel's rounded corners, an unfilled frame) the page shows through.
    showThrough(expectedPng, actualPng);
    if (cropShot && options.fit?.cropWidth) fitCrop = cropCheck(expectedPng, PNG.sync.read(cropShot), options.fit.cropWidth, options.pixelThreshold ?? 0.1);
    canvas = `expected ${expectedPng.width}×${expectedPng.height}, actual ${actualPng.width}×${actualPng.height}`;
    const width = Math.min(expectedPng.width, actualPng.width); const height = Math.min(expectedPng.height, actualPng.height);
    if (width > 0 && height > 0) {
      if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) notes.push(`Canvas size mismatch (${canvas}); pixel diff covers the overlapping ${width}×${height} region.`);
      const expectedCrop = expectedPng.width === width && expectedPng.height === height ? expectedPng : cropPng(expectedPng, 0, 0, width, height);
      const actualCrop = actualPng.width === width && actualPng.height === height ? actualPng : cropPng(actualPng, 0, 0, width, height);
      const diff = new PNG({ width, height });
      const changed = pixelmatch(expectedCrop.data, actualCrop.data, diff.data, width, height, { threshold: options.pixelThreshold ?? 0.1 });
      pixelDiffPct = pct(changed / (width * height));
      mark("pixelmatch");

      // Label map: topmost painted node per pixel (paint order = tree order). Text boxes grow 3px for glyph overhang.
      const labels = new Uint16Array(width * height);
      const paintedCapped = painted.slice(0, 65534);
      paintedCapped.forEach(({ node, cause }, index) => {
        const grow = cause === "text" ? 3 : 0;
        const x0 = Math.max(0, Math.floor((node.bounds.x - root.bounds.x - grow) * scale)), y0 = Math.max(0, Math.floor((node.bounds.y - root.bounds.y - grow) * scale));
        const x1 = Math.min(width, Math.ceil((node.bounds.x - root.bounds.x + node.bounds.width + grow) * scale)), y1 = Math.min(height, Math.ceil((node.bounds.y - root.bounds.y + node.bounds.height + grow) * scale));
        for (let y = y0; y < y1; y++) labels.fill(index + 1, y * width + x0, y * width + x1);
      });
      const perNode = new Uint32Array(paintedCapped.length + 1); const byCause: Record<DiffCause, number> = { text: 0, image: 0, flat: 0, fixed: 0, other: 0 };
      const CELL = 32; const cols = Math.ceil(width / CELL), rows = Math.ceil(height / CELL); const otherCells = new Uint32Array(cols * rows);
      const data = diff.data;
      for (let index = 0, pixel = 0; pixel < width * height; pixel++, index += 4) {
        if (data[index] !== 255 || data[index + 1] !== 0 || data[index + 2] !== 0) continue; // pixelmatch paints mismatches pure red
        const label = labels[pixel]; perNode[label]++;
        const cause: DiffCause = label ? paintedCapped[label - 1].cause : "other"; byCause[cause]++;
        if (cause === "other") otherCells[Math.floor(Math.floor(pixel / width) / CELL) * cols + Math.floor((pixel % width) / CELL)]++;
      }
      const total = width * height;
      diffByCause = { text: pct(byCause.text / total), image: pct(byCause.image / total), flat: pct(byCause.flat / total), fixed: pct(byCause.fixed / total), other: pct(byCause.other / total) };
      unexplainedPct = diffByCause.other;

      // A whole area a few percent darker or lighter (a missing 5% wash over a photo, a lost tint) stays under the
      // per-pixel threshold everywhere, yet anyone sees it next to something that has it right. So each node's average
      // color over the pixels it owns is compared too.
      const owned = new Uint32Array(paintedCapped.length + 1); const sumE = new Float64Array(owned.length * 3), sumA = new Float64Array(owned.length * 3);
      const expectedData = expectedCrop.data, actualData = actualCrop.data;
      for (let pixel = 0, index = 0; pixel < total; pixel++, index += 4) {
        const label = labels[pixel]; if (!label) continue; owned[label]++; const k = label * 3;
        sumE[k] += expectedData[index]; sumE[k + 1] += expectedData[index + 1]; sumE[k + 2] += expectedData[index + 2];
        sumA[k] += actualData[index]; sumA[k + 1] += actualData[index + 1]; sumA[k + 2] += actualData[index + 2];
      }
      paintedCapped.forEach(({ node, cause }, index) => {
        // Only what paints itself: text has its own checks and glyph smoothing moves its average; a rendered asset is the
        // design's own pixels; a frame without fills only "owns" what shows through it.
        const label = index + 1, count = owned[label];
        if ((cause !== "image" && cause !== "other") || count < 1500 * scale * scale || !node.fills?.some((paint) => paint.visible !== false)) return;
        const mean = (sum: Float64Array) => [0, 1, 2].map((channel) => Math.round(sum[label * 3 + channel] / count));
        const expected = mean(sumE), actual = mean(sumA); const delta = Math.max(...expected.map((value, channel) => Math.abs(value - actual[channel])));
        const explained = node.fills?.some((paint) => paint.type === "image" && paint.hasFilters) ? "Figma image filters (exposure, contrast…) are not reproduced in CSS"
          : node.effects?.some((effect) => effect.visible !== false && effect.type === "background-blur") ? "a background blur is drawn by the browser, and Figma's differs slightly" : undefined;
        if (delta >= SHIFT) shifts.push({ nodeId: node.id, name: node.name, type: node.type, cause, delta, expected: `rgb(${expected.join(",")})`, actual: `rgb(${actual.join(",")})`, areaPct: pct(count / total), ...(explained ? { explained } : {}) });
      });
      shifts.sort((a, b) => b.delta * b.areaPct - a.delta * a.areaPct);

      // Seams: a rendered asset cut from the design carries the pixels around its artwork. Where the page paints something
      // else behind it (its own blur, another card's photo), a square shows — a few levels along a straight edge, under
      // the diff threshold yet plain to see. At a corner of its box the design has no edge (the artwork is not there),
      // yet hiding the asset changes the page: that corner is a patch of the design's background.
      if (hiddenShot) {
        const hiddenPng = PNG.sync.read(hiddenShot);
        const px = (png: PNG, x: number, y: number): number[] => { const i = (Math.min(png.height - 1, Math.max(0, y)) * png.width + Math.min(png.width - 1, Math.max(0, x))) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
        const far = (a: number[], b: number[]): number => Math.max(...a.map((value, channel) => Math.abs(value - b[channel])));
        for (const box of flatBoxes) {
          if (box.w < 10 || box.h < 10) continue;
          const x0 = Math.round(box.x * scale) + 2, y0 = Math.round(box.y * scale) + 2, x1 = Math.round((box.x + box.w) * scale) - 3, y1 = Math.round((box.y + box.h) * scale) - 3;
          let seams = 0, worst = 0;
          for (const [cx, cy, ox, oy] of [[x0, y0, -5, -5], [x1, y0, 5, -5], [x0, y1, -5, 5], [x1, y1, 5, 5]]) {
            if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
            const page = far(px(actualCrop, cx, cy), px(hiddenPng, cx, cy)); const edge = far(px(expectedCrop, cx, cy), px(expectedCrop, cx + ox, cy + oy));
            if (page > 16 && edge < 12) { seams++; worst = Math.max(worst, page); }
          }
          if (seams >= 2) seamsFound.push({ id: box.id, delta: worst, corners: seams });
        }
        seamsFound.sort((a, b) => b.delta - a.delta);
      }

      // Per-node outliers: a text or photo whose own box is mostly different is not "rendering noise".
      paintedCapped.forEach(({ node, cause }, index) => {
        const area = node.bounds.width * node.bounds.height * scale * scale; const ratio = area ? perNode[index + 1] / area : 0;
        if (area < 400) return;
        if (cause === "image" && ratio > 0.6) outliers.push({ nodeId: node.id, name: node.name, type: node.type, cause, diffRatio: Math.round(ratio * 100) / 100, note: "photo content differs — wrong file, crop, mirror or rotation" });
        if (cause === "flat" && ratio > 0.25) outliers.push({ nodeId: node.id, name: node.name, type: node.type, cause, diffRatio: Math.round(ratio * 100) / 100, note: "rendered asset differs from the design — wrong asset or placement" });
        if (cause === "text" && ratio > 0.55) outliers.push({ nodeId: node.id, name: node.name, type: node.type, cause, diffRatio: Math.round(ratio * 100) / 100, note: "text box mostly differs — wrap, case, alignment or missing font" });
      });
      outliers.sort((a, b) => b.diffRatio - a.diffRatio);

      // Hotspots: connected clusters of unexplained diff cells, biggest first, each with a small triptych crop.
      const seen = new Uint8Array(cols * rows); const clusters: { x0: number; y0: number; x1: number; y1: number; pixels: number; }[] = [];
      for (let cell = 0; cell < otherCells.length; cell++) {
        if (!otherCells[cell] || seen[cell]) continue;
        const cluster = { x0: cols, y0: rows, x1: 0, y1: 0, pixels: 0 }; const stack = [cell]; seen[cell] = 1;
        while (stack.length) {
          const current = stack.pop()!; const cx = current % cols, cy = Math.floor(current / cols);
          cluster.x0 = Math.min(cluster.x0, cx); cluster.y0 = Math.min(cluster.y0, cy); cluster.x1 = Math.max(cluster.x1, cx); cluster.y1 = Math.max(cluster.y1, cy); cluster.pixels += otherCells[current];
          for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) { if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue; const next = ny * cols + nx; if (otherCells[next] && !seen[next]) { seen[next] = 1; stack.push(next); } }
        }
        if (cluster.pixels >= 40) clusters.push(cluster);
      }
      clusters.sort((a, b) => b.pixels - a.pixels);
      for (const [rank, cluster] of clusters.slice(0, 6).entries()) {
        const x = Math.max(0, cluster.x0 * CELL - 16), y = Math.max(0, cluster.y0 * CELL - 16);
        const w = Math.min(width - x, (cluster.x1 - cluster.x0 + 1) * CELL + 32), h = Math.min(height - y, Math.min(900, (cluster.y1 - cluster.y0 + 1) * CELL + 32));
        const ownerIds = new Map<number, number>();
        for (let yy = y; yy < y + h; yy += 4) for (let xx = x; xx < x + w; xx += 4) { const at = (yy * width + xx) * 4; if (data[at] === 255 && data[at + 1] === 0 && data[at + 2] === 0) { const label = labels[yy * width + xx]; if (label && paintedCapped[label - 1].cause === "other") ownerIds.set(label, (ownerIds.get(label) || 0) + 1); } }
        const owners = [...ownerIds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => ({ nodeId: paintedCapped[label - 1].node.id, name: paintedCapped[label - 1].node.name, type: paintedCapped[label - 1].node.type }));
        let cropFile: string | null = null;
        if (artifacts !== "none") { cropFile = join(outDir, `hotspot-${rank + 1}.png`); await writeFile(cropFile, PNG.sync.write(sideBySide([cropPng(expectedCrop, x, y, w, h), cropPng(actualCrop, x, y, w, h), cropPng(diff, x, y, w, h)]))); }
        hotspots.push({ rect: { x: Math.round(x / scale), y: Math.round(y / scale), w: Math.round(w / scale), h: Math.round(h / scale) }, pixels: cluster.pixels, owners, crop: cropFile });
      }
      mark("attribute diff");
      if (artifacts === "full") {
        diffPath = join(outDir, "diff.png"); await writeFile(diffPath, PNG.sync.write(diff));
        sideBySidePath = join(outDir, "side-by-side.png"); await writeFile(sideBySidePath, PNG.sync.write(sideBySide([expectedCrop, actualCrop, diff])));
        mark("write full artifacts");
      }
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  violations.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (b.delta ?? 0) - (a.delta ?? 0));
  const high = violations.filter((violation) => violation.severity === "high").length;
  const medium = violations.filter((violation) => violation.severity === "medium").length;
  const unmapped = unmappedAll.sort((a, b) => { const area = (size: string) => size.split("×").reduce((total, part) => total * Number(part), 1); return area(b.size) - area(a.size); }).slice(0, 20);
  if (unmappedAll.length > unmapped.length) notes.push(`${unmappedAll.length - unmapped.length} smaller unmapped nodes omitted from the list.`);
  const coveragePct = checkableNodes ? Math.round(((mappedNodes + flattenedNodes) / checkableNodes) * 1000) / 10 : 0;

  // Verdict: every failure names something actionable; rendering noise alone never fails a page.
  const reasons: string[] = [];
  if (high) reasons.push(`${high} high-severity violation(s)`);
  if (coveragePct < 95) reasons.push(`coverage ${coveragePct}% < 95% (${unmappedAll.length} unmapped node(s))`);
  if (diffByCause) {
    if (diffByCause.other > (options.maxUnexplainedPct ?? 0.2)) reasons.push(`unexplained pixel diff ${diffByCause.other}% > ${options.maxUnexplainedPct ?? 0.2}% (see hotspots)`);
    if (diffByCause.flat > (options.maxFlatPct ?? 0.5)) reasons.push(`rendered-asset diff ${diffByCause.flat}% > ${options.maxFlatPct ?? 0.5}%`);
    if (diffByCause.image > (options.maxImagePct ?? 4)) reasons.push(`photo diff ${diffByCause.image}% > ${options.maxImagePct ?? 4}%`);
    if (diffByCause.text > (options.maxTextPct ?? 5)) reasons.push(`text diff ${diffByCause.text}% > ${options.maxTextPct ?? 5}%`);
    if (outliers.length) reasons.push(`${outliers.length} node(s) differ far beyond rendering noise (see outliers)`);
  }
  let fit: FitResult | undefined;
  if (fitRows.length) {
    fit = { rows: fitRows, crop: fitCrop };
    const scrolling = fitRows.filter((row) => row.overflow > 1);
    if (scrolling.length) reasons.push(`horizontal scroll at ${scrolling.map((row) => `${row.width}px (+${row.overflow}px)`).join(", ")}`);
    if (fitCrop?.pixelDiffPct !== undefined && pixelDiffPct !== null) {
      fitCrop.allowedPct = Math.round((pixelDiffPct * (target.width / fitCrop.width) + 0.3) * 100) / 100;
      if (fitCrop.pixelDiffPct > fitCrop.allowedPct) reasons.push(`at ${fitCrop.width}px the page differs from the design's center crop: ${fitCrop.pixelDiffPct}% > ${fitCrop.allowedPct}%`);
    }
  }
  for (const result of behaviorResults) if (!result.ok) reasons.push(`${result.label} ${result.kind}: ${result.problems.join("; ")}`);
  for (const shift of shifts.filter((entry) => !entry.explained && entry.delta >= SHIFT_FAIL).slice(0, 3)) reasons.push(`the color of ${shift.name} (${shift.nodeId}) differs over its whole area: design ${shift.expected}, page ${shift.actual} (Δ${shift.delta}) — a missing or extra layer, tint or filter`);
  if (cutControls.length) reasons.push(`${cutControls.length} control(s) shown cut by a box they sit in: ${cutControls.slice(0, 4).map((entry) => `${entry.label || "?"} (${entry.id}) ${entry.shown}% visible, cut by ${entry.by}`).join("; ")}`);
  if (options.open) {
    const placement = interaction.placement;
    if (!placement) reasons.push("the overlay did not open from its trigger");
    else if (Math.abs(placement.dx - placement.expectedDx) > 2 || Math.abs(placement.dy - placement.expectedDy) > 2) reasons.push(`overlay opens at (${placement.dx}, ${placement.dy}) from its trigger, design says (${placement.expectedDx}, ${placement.expectedDy})`);
    if (placement && !interaction.closesOnEscape) reasons.push("Escape does not close the overlay");
    if (placement && interaction.closesOnEscape && !interaction.closesOnOutsideClick) reasons.push("a click outside does not close the overlay");
    if (interaction.closesOnTrigger === false) reasons.push("clicking the trigger again does not close the overlay");
  }

  const report: CompareReport = {
    summary: {
      pass: reasons.length === 0, reasons, mode: options.fast ? "fast" : "full",
      pixelDiffPct, diffByCause, unexplainedPct, legacyPass: pixelDiffPct === null ? null : high === 0 && pixelDiffPct <= (options.maxPixelDiffPct ?? 2),
      violations: violations.length, high, medium, low: violations.length - high - medium,
      mappedNodes, checkableNodes, flattenedNodes, coveragePct, canvas,
      ...(fit ? { fit } : {}), ...(options.open ? { interaction } : {}), ...(behaviorResults.length ? { behaviors: behaviorResults } : {}), ...(cutControls.length ? { cutControls } : {}), ...(options.fixes?.length ? { fixes: options.fixes } : {}),
    },
    violations, hotspots, outliers: outliers.slice(0, 12), shifts: shifts.slice(0, 12), seams: seamsFound.slice(0, 20), unmapped, notes, timings,
    files: { actual: actualPath, diff: diffPath, sideBySide: sideBySidePath, report: join(outDir, "report.json") },
  };
  await writeFile(report.files.report, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * Browser side: how much of an element (in %) the boxes it sits in let through — every ancestor below `stop` that clips
 * its overflow — and the first one that cuts it. `stop` (the page frame) is left out: a frame of fixed height cuts
 * the page on purpose.
 */
const SHOWN_OF = `(element, stop) => {
  const r = element.getBoundingClientRect(); const area = r.width * r.height; if (!area) return { shown: 100, by: "" };
  let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom, by = "";
  for (let at = element.parentElement; at && at !== stop && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at); if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const b = at.getBoundingClientRect(); const nx0 = Math.max(x0, b.left), ny0 = Math.max(y0, b.top), nx1 = Math.max(nx0, Math.min(x1, b.right)), ny1 = Math.max(ny0, Math.min(y1, b.bottom));
    if (!by && (nx1 - nx0) * (ny1 - ny0) < (x1 - x0) * (y1 - y0) - 0.5) by = at.getAttribute("data-fig") || at.tagName.toLowerCase();
    x0 = nx0; y0 = ny0; x1 = nx1; y1 = ny1;
  }
  return { shown: Math.round((x1 - x0) * (y1 - y0) / area * 1000) / 10, by };
}`;
const shownIn = (page: Page, id: string, stop: string): Promise<{ shown: number; by: string; } | null> =>
  page.evaluate(`(() => { const shownOf = ${SHOWN_OF}; const element = document.querySelector(${JSON.stringify(`[data-fig="${id}"]`)}); return element ? shownOf(element, document.querySelector(${JSON.stringify(stop)})) : null; })()`) as Promise<{ shown: number; by: string; } | null>;

/** The verdict a model (or a human) needs — nothing else has to be opened when this says PASS. */
const sizes = (result: BehaviorResult): string => `${(result.sizes ?? 0) > 1 ? `, shown whole in ${result.wholeIn ?? 0}/${result.sizes} item sizes` : ""}${result.copies ? `, copies clean ${result.cleanCopies ?? 0}/${result.copies}` : ""}`;
export function verdictLines(report: CompareReport, limit = 12): string[] {
  const lines: string[] = [];
  const { summary } = report;
  const cause = summary.diffByCause ? ` — pixel ${summary.pixelDiffPct}% = text ${summary.diffByCause.text} + photo ${summary.diffByCause.image} + asset ${summary.diffByCause.flat}${summary.diffByCause.fixed ? ` + fixed ${summary.diffByCause.fixed}` : ""} + UNEXPLAINED ${summary.diffByCause.other}` : " — geometry only (fast)";
  lines.push(`${summary.pass ? "PASS" : "FAIL"}${cause}; ${summary.violations} violations (${summary.high} high / ${summary.medium} medium / ${summary.low} low); coverage ${summary.coveragePct}% (${summary.mappedNodes}+${summary.flattenedNodes} flat / ${summary.checkableNodes})`);
  for (const reason of summary.reasons) lines.push(`  ✗ ${reason}`);
  if (summary.fit) {
    const { rows, crop } = summary.fit; const scaled = rows.filter((row) => row.zoom < 0.999);
    const clean = rows.every((row) => row.overflow <= 1);
    lines.push(`  fit: ${clean ? "no horizontal scroll" : "horizontal scroll"} at ${rows.map((row) => row.width).join("/")}px${scaled.length ? ` (scaled below ${Math.min(...rows.filter((row) => row.zoom >= 0.999).map((row) => row.width))}px: ${scaled.map((row) => `${row.width}→×${row.zoom}`).join(", ")})` : ""}${crop ? crop.skipped ? ` · ${crop.width}px crop check skipped: ${crop.skipped}` : ` · at ${crop.width}px = design center crop, pixel ${crop.pixelDiffPct}% (≤ ${crop.allowedPct}%)` : ""}`);
  }
  if (summary.behaviors) {
    lines.push(`  behaviors: ${summary.behaviors.map((result) => result.skipped ? `${result.label} ${result.kind} ×${result.instances} (not exercised: ${result.skipped})` : result.kind === "toggle"
      ? `${result.label} toggle ×${result.instances} (click → as designed ${result.asDesignedPct ?? "–"}%, again → back ${result.backPct ?? "–"}%${sizes(result)})${result.ok ? "" : " ✗"}`
      : `${result.label} counter ×${result.instances} (add → "− 1 +" as designed ${result.asDesignedPct ?? "–"}%, + → 2, − − → back ${result.backPct ?? "–"}%${sizes(result)})${result.ok ? "" : " ✗"}`).join(" · ")}`);
  }
  for (const fix of summary.fixes ?? []) lines.push(`  fixed: ${fix.label} (${fix.id}) was ${fix.cutPct}% cut by ${fix.by.name} (${fix.by.id})${fix.state ? " after a click" : " in the design"} → moved inside`);
  if (summary.interaction) {
    const { placement, closesOnEscape, closesOnOutsideClick } = summary.interaction;
    const { closesOnTrigger } = summary.interaction;
    lines.push(`  overlay: ${placement ? `opens at (${placement.dx}, ${placement.dy}) from its trigger (design ${placement.expectedDx}, ${placement.expectedDy})` : "did not open"}${closesOnTrigger === undefined ? "" : ` · trigger again ${closesOnTrigger ? "closes" : "does NOT close"}`} · Escape ${closesOnEscape ? "closes" : "does NOT close"} · outside click ${closesOnOutsideClick ? "closes" : "does NOT close"}`);
  }
  for (const violation of report.violations.slice(0, limit)) lines.push(`  [${violation.severity}] ${violation.name.slice(0, 40)} (${violation.nodeId}) ${violation.prop}: expected ${violation.expected}, got ${violation.actual}${violation.delta !== undefined ? ` (Δ${violation.delta})` : ""}`);
  if (report.violations.length > limit) lines.push(`  … +${report.violations.length - limit} more in report.json`);
  for (const outlier of report.outliers.slice(0, 6)) lines.push(`  [outlier] ${outlier.name.slice(0, 40)} (${outlier.nodeId}) ${Math.round(outlier.diffRatio * 100)}% of its box differs — ${outlier.note}`);
  if (report.seams?.length) lines.push(`  [seam] ${report.seams.length} rendered asset(s) show a square of the design's background around their artwork: ${report.seams.slice(0, 6).map((seam) => `${seam.id} (Δ${seam.delta})`).join(", ")}`);
  for (const shift of (report.shifts ?? []).slice(0, 4)) lines.push(`  [color] ${shift.name.slice(0, 40)} (${shift.nodeId}) ${shift.areaPct}% of the page: design ${shift.expected}, page ${shift.actual} (Δ${shift.delta})${shift.explained ? ` — ${shift.explained}` : ""}`);
  for (const hotspot of report.hotspots.slice(0, 4)) lines.push(`  [hotspot] ${hotspot.pixels}px at ${hotspot.rect.x},${hotspot.rect.y} ${hotspot.rect.w}×${hotspot.rect.h} owners: ${hotspot.owners.map((owner) => `${owner.name.slice(0, 24)} (${owner.nodeId})`).join(", ") || "page background"}${hotspot.crop ? ` → ${hotspot.crop}` : ""}`);
  for (const entry of report.unmapped.slice(0, 6)) lines.push(`  [unmapped] ${entry.name.slice(0, 40)} (${entry.nodeId}) ${entry.type} ${entry.size}`);
  for (const note of report.notes.slice(0, 4)) lines.push(`  note: ${note}`);
  lines.push(`  ${Object.values(report.timings).reduce((total, ms) => total + ms, 0)} ms · ${report.files.report}`);
  return lines;
}

/** Where the expected image is transparent, what the implementation draws there is what shows through. */
function showThrough(expected: PNG, actual: PNG): void {
  const width = Math.min(expected.width, actual.width), height = Math.min(expected.height, actual.height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * expected.width + x) * 4, alpha = expected.data[at + 3] / 255; if (alpha >= 1) continue;
    const from = (y * actual.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) expected.data[at + channel] = Math.round(expected.data[at + channel] * alpha + actual.data[from + channel] * (1 - alpha));
    expected.data[at + 3] = 255;
  }
}

/**
 * A fluid page at a narrower width equals the design with both side margins trimmed — as long as those margins are
 * plain background on every row (no bleeding photo or art whose placement a narrower viewport legitimately changes).
 */
function cropCheck(expected: PNG, actual: PNG, width: number, threshold: number): NonNullable<FitResult["crop"]> {
  const trim = Math.round((expected.width - width) / 2);
  if (trim <= 0 || actual.width !== width || actual.height !== expected.height) return { width, skipped: `rendered ${actual.width}×${actual.height}, expected ${width}×${expected.height}` };
  const { data } = expected; let busy = 0;
  const same = (a: number, b: number): boolean => Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) <= 24;
  for (let y = 0; y < expected.height; y++) {
    const row = y * expected.width * 4; let plain = true;
    for (let x = 1; x < trim && plain; x++) plain = same(row + x * 4, row);
    for (let x = expected.width - trim; x < expected.width - 1 && plain; x++) plain = same(row + x * 4, row + (expected.width - 1) * 4);
    if (!plain) busy++;
  }
  if (busy > expected.height * 0.005) return { width, skipped: "the design's side margins carry content, so it has no plain center crop" };
  const reference = cropPng(expected, trim, 0, width, expected.height);
  const changed = pixelmatch(reference.data, actual.data, undefined, width, expected.height, { threshold });
  return { width, pixelDiffPct: pct(changed / (width * expected.height)) };
}

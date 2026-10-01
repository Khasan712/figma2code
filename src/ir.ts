import type { ConstraintFingerprint, DesignFingerprintV1, NodeFingerprint, PaintFingerprint, TypographyFingerprint } from "./types.ts";
import { inferBehaviors, type Behavior } from "./behaviors.ts";
import { keepControlsVisible, type Fix } from "./visibility.ts";

/**
 * Fingerprint → render IR. Every visual decision the pipeline used to delegate to a model
 * (paint opacity, gradient direction, accumulated flips, stroke paint order, text sizing mode,
 * icon/illustration flattening…) is a deterministic rule here, so emitters only serialize.
 * Layout is absolute by construction: every node sits at its design AABB, which keeps geometry
 * exact and stops substituted-font metrics from cascading through flex flows.
 */
export type CssValue = string | number;
export type CssProps = Record<string, CssValue>;
export interface TextRun { text: string; style?: CssProps; }
export interface RNode {
  id: string; name: string; figType: string;
  kind: "root" | "box" | "text" | "img" | "flat" | "rule" | "switch";
  x: number; y: number; w: number; h: number;
  style: CssProps;
  children: RNode[];
  /** text: runs of characters; innerStyle present when an inner block is needed (vertical/overflow alignment). */
  runs?: TextRun[]; innerStyle?: CssProps; paragraphs?: boolean;
  /** img/flat: asset file; imgStyle positions the inner <img> when it differs from the node box (crop mode, render bleed). */
  src?: string; imgStyle?: CssProps;
  /** Stroke drawn as a last-child overlay so it paints above children without shifting them. */
  overlay?: CssProps;
  flat?: boolean; link?: string; notes?: string[];
  /** Clicking this element opens a prototype overlay: the overlay frame's id, its offset from this element, the transition. */
  opens?: { target: string; dx: number; dy: number; ms?: number; };
  /** switch: one piece of interactive state and the renderings it switches between ([off, on] or [zero, some]). */
  cases?: RNode[]; state?: { key: string; kind: "toggle" | "counter"; initial: number; };
  /** What a click does: flip a toggle, count, close the overlay this element is in, go back. */
  act?: { press?: string; on?: boolean; count?: string; delta?: number; close?: boolean; back?: boolean; label?: string; };
  /** A text that shows a counter's value. */
  countOf?: string;
  /** Looks like a button although the design wires no action: a pointer cursor, like on a real site. */
  hint?: "button";
}
export interface FlatPlan {
  id: string; file: string; format: "svg" | "png"; reason: string; nodes: number;
  /** Root-relative rect of the pixels this node shows in the design (already cut by clipping ancestors). */
  rect: { x: number; y: number; w: number; h: number; }; hasRenderBounds: boolean;
  /** Root-relative layout box of the node (its AABB) — the element the image is positioned inside. */
  box: { x: number; y: number; w: number; h: number; };
  /** Sides of `rect` that lie on an ancestor's clip edge. An isolated Figma render is NOT clipped there, so it may be larger on those sides. */
  clipped?: { left: boolean; top: boolean; right: boolean; bottom: boolean; };
  /** The subtree samples what is painted behind it (background blur with nothing opaque of its own underneath): an isolated render cannot be right, only the design's own pixels are. */
  backdrop?: boolean;
  /**
   * Translucent solid layers painted ABOVE this node inside its rect (a modal's dimming backdrop), root-relative,
   * in paint order. A crop of target.png already contains them and the page paints them again, so the crop step
   * divides them out first.
   */
  tints?: Tint[];
  /** Something translucent that cannot be divided out (gradient, image, effect) is painted above part of the rect: only an isolated render is exact there. */
  tainted?: boolean;
}
export interface Tint { x: number; y: number; w: number; h: number; color: [number, number, number]; alpha: number; }
export interface FontUse { family: string; weights: number[]; italic: boolean; }
/** A prototype overlay opened from this page: trigger element, overlay frame, its component, placement, transition. */
export interface Popup { trigger: string; target: string; component?: string; label: string; dx: number; dy: number; ms?: number; }
/**
 * How the page meets the viewport. Fluid: full-width layers stretch and the rest keeps its distance from the center,
 * down to `minWidth`; below that (and at any width below `width` for a fixed page) the page is scaled as a whole.
 */
export interface PageFit { fluid: boolean; width: number; minWidth: number; }
export interface IRResult { kind: "page" | "overlay"; root: RNode; popups: Popup[]; fit: PageFit; /** Interactive states inferred from the design's own examples, one representative each for verification. */ behaviors: Behavior[]; /** Controls the design draws cut by their container, moved inside (reported, and excluded from the pixel verdict). */ fixes: Fix[]; /** Where the frame's box sits inside Figma's render of it, which also covers what the frame paints outside itself (shadow, overflow). */ render: { dx: number; dy: number; w: number; h: number; }; flats: FlatPlan[]; images: { file: string; maxW: number; maxH: number; }[]; fonts: FontUse[]; notes: string[]; stats: { nodes: number; emitted: number; flattened: number; texts: number; images: number; }; }
export interface IROptions {
  /** Figma node id → route, for prototype links. */ routes?: Record<string, string>;
  flattenIllustrations?: boolean;
  /** Prototype overlay frames built as components: frame id → component name and accessible label. */ overlays?: Record<string, { component: string; label: string; }>;
  /** Compile the target as an overlay panel: fixed size, carrying its own frame styles, no page fitting. */ asOverlay?: boolean;
}

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "REGULAR_POLYGON"]);
const SHAPE_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "REGULAR_POLYGON", "ELLIPSE", "LINE", "RECTANGLE"]);
const CONTAINER_TYPES = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET", "SECTION"]);
const BLEND: Record<string, string> = { MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten", COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light", DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity", LINEAR_BURN: "plus-darker", LINEAR_DODGE: "plus-lighter" };

export const r2 = (value: number): number => Math.round(value * 100) / 100;
/** Pipeline-owned asset name. Distinct from the hand-written `figAsset()` convention (fig-<id>.png) so a build never overwrites a file someone else placed. */
export const flatFileName = (id: string, format: string): string => `f2c-${id.replace(/[^A-Za-z0-9]+/g, "-")}.${format}`;

export function cssColor(paint: PaintFingerprint | undefined, extraAlpha = 1): string | undefined {
  const color = paint?.color; if (!color?.hex) return undefined;
  const alpha = (color.a ?? 1) * (paint!.opacity ?? 1) * extraAlpha;
  if (alpha >= 0.999) return color.hex.slice(0, 7);
  const value = parseInt(color.hex.slice(1, 7), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${Math.round(alpha * 1000) / 1000})`;
}
const stopColor = (stop: { color: { hex?: string; a: number; } }, opacity: number): string => cssColor({ type: "solid", visible: true, color: stop.color as PaintFingerprint["color"], opacity }) ?? "transparent";

/**
 * Exact CSS equivalent of a Figma linear gradient. Figma defines the ramp between two handle
 * points; CSS defines it along a line through the box center whose length depends on the angle.
 * Both are linear in the projection onto the same direction, so each stop maps exactly:
 *   p_css = 0.5 + ((S + t·(E−S) − C) · u) / L
 */
export function linearGradientCss(paint: PaintFingerprint, w: number, h: number): string | undefined {
  const gradient = paint.gradient; const handles = gradient?.handles;
  if (!gradient || !handles || handles.length < 2 || !w || !h) return undefined;
  const sx = handles[0].x * w, sy = handles[0].y * h, dx = handles[1].x * w - sx, dy = handles[1].y * h - sy;
  const length = Math.hypot(dx, dy); if (length < 1e-6) return undefined;
  const ux = dx / length, uy = dy / length;
  const angle = Math.atan2(ux, -uy); // CSS: 0deg points up, clockwise
  const line = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle));
  const stops = gradient.stops.map((stop) => {
    const px = sx + stop.position * dx - w / 2, py = sy + stop.position * dy - h / 2;
    return `${stopColor(stop, paint.opacity ?? 1)} ${r2((0.5 + (px * ux + py * uy) / line) * 100)}%`;
  });
  return `linear-gradient(${r2(angle * 180 / Math.PI)}deg, ${stops.join(", ")})`;
}

function radialGradientCss(paint: PaintFingerprint, w: number, h: number): { css: string; exact: boolean; } | undefined {
  const gradient = paint.gradient; const handles = gradient?.handles;
  if (!gradient || !handles || handles.length < 3) return undefined;
  const cx = handles[0].x * w, cy = handles[0].y * h;
  const ax = handles[1].x * w - cx, ay = handles[1].y * h - cy, bx = handles[2].x * w - cx, by = handles[2].y * h - cy;
  const ra = Math.hypot(ax, ay), rb = Math.hypot(bx, by);
  const horizontal = Math.abs(ay) < 0.02 * ra, vertical = Math.abs(ax) < 0.02 * ra;
  const [rx, ry] = vertical ? [rb, ra] : [ra, rb];
  const stops = gradient.stops.map((stop) => `${stopColor(stop, paint.opacity ?? 1)} ${r2(stop.position * 100)}%`).join(", ");
  return { css: `radial-gradient(ellipse ${r2(rx)}px ${r2(ry)}px at ${r2(cx)}px ${r2(cy)}px, ${stops})`, exact: horizontal || vertical };
}

function conicGradientCss(paint: PaintFingerprint, w: number, h: number): string | undefined {
  const gradient = paint.gradient; const handles = gradient?.handles;
  if (!gradient || !handles || handles.length < 2) return undefined;
  const cx = handles[0].x * w, cy = handles[0].y * h, dx = handles[1].x * w - cx, dy = handles[1].y * h - cy;
  const from = Math.atan2(dx, -dy) * 180 / Math.PI + 90;
  const stops = gradient.stops.map((stop) => `${stopColor(stop, paint.opacity ?? 1)} ${r2(stop.position * 360)}deg`).join(", ");
  return `conic-gradient(from ${r2(from)}deg at ${r2(cx)}px ${r2(cy)}px, ${stops})`;
}

/** Absolute-coordinate region the ancestors let through (the target frame, then every clipping frame on the way down). */
interface ClipRect { x0: number; y0: number; x1: number; y1: number; }
const intersect = (clip: ClipRect, node: NodeFingerprint): ClipRect => ({ x0: Math.max(clip.x0, node.bounds.x), y0: Math.max(clip.y0, node.bounds.y), x1: Math.min(clip.x1, node.bounds.x + node.bounds.width), y1: Math.min(clip.y1, node.bounds.y + node.bounds.height) });
interface Net { a: number; b: number; c: number; d: number; }
const IDENTITY: Net = { a: 1, b: 0, c: 0, d: 1 };
// Pre-0.2 extractions stored Figma's row-major [a, c, tx, b, d, ty]. The 2×2 part of a Figma transform is
// a pure rotation/flip (|v| ≤ 1), so any larger value in those slots marks the WHOLE fingerprint as legacy.
let legacyRowMajor = false;
function detectLegacyMatrices(root: NodeFingerprint): void {
  legacyRowMajor = false;
  const scan = (node: NodeFingerprint): void => { if (node.transform?.matrix?.slice(0, 4).some((value) => Math.abs(value) > 1.0001)) legacyRowMajor = true; if (!legacyRowMajor) node.children?.forEach(scan); };
  scan(root);
}
function compose(parent: Net, node: NodeFingerprint): Net {
  const m = node.transform?.matrix; if (!m) return parent;
  // CSS order: x' = a·x + c·y, y' = b·x + d·y
  const [a, b, c, d] = legacyRowMajor ? [m[0], m[3], m[1], m[4]] : m;
  return { a: parent.a * a + parent.c * b, b: parent.b * a + parent.d * b, c: parent.a * c + parent.c * d, d: parent.b * c + parent.d * d };
}
type NetKind = "none" | "flip" | "quarter" | "free";
function netKind(net: Net): NetKind {
  const near = (value: number, target: number) => Math.abs(value - target) < 0.01;
  if (near(net.b, 0) && near(net.c, 0) && near(Math.abs(net.a), 1) && near(Math.abs(net.d), 1)) return near(net.a, 1) && near(net.d, 1) ? "none" : "flip";
  if (near(net.a, 0) && near(net.d, 0) && near(Math.abs(net.b), 1) && near(Math.abs(net.c), 1)) return "quarter";
  return "free";
}
const ownKind = (node: NodeFingerprint): NetKind => netKind(compose(IDENTITY, node));

const visibleChildren = (node: NodeFingerprint): NodeFingerprint[] => (node.children || []).filter((child) => child.visible && (child.bounds.width >= 0.5 || child.bounds.height >= 0.5));
function countNodes(node: NodeFingerprint): number { return 1 + visibleChildren(node).reduce((total, child) => total + countNodes(child), 0); }
function walk(node: NodeFingerprint, visit: (node: NodeFingerprint) => void): void { visit(node); visibleChildren(node).forEach((child) => walk(child, visit)); }
const hasImageFill = (node: NodeFingerprint): boolean => !!node.fills?.some((paint) => paint.type === "image" && paint.imageRef);
const isArrowLine = (node: NodeFingerprint): boolean => node.type === "LINE" && node.strokes?.[0]?.cap === "arrow";
const isAxisLine = (node: NodeFingerprint): boolean => node.type === "LINE" && (node.bounds.width < 0.5 || node.bounds.height < 0.5) && !isArrowLine(node);
const isTrueVector = (node: NodeFingerprint): boolean => VECTOR_TYPES.has(node.type) || (node.type === "ELLIPSE" && !!node.arc) || (node.type === "LINE" && !isAxisLine(node));

const hasBackgroundBlur = (node: NodeFingerprint): boolean => !!node.effects?.some((effect) => effect.visible && effect.type === "background-blur");
const isOpaqueCover = (node: NodeFingerprint): boolean => (node.opacity ?? 1) >= 0.999 && !!node.fills?.some((paint) => paint.visible !== false && (paint.opacity ?? 1) >= 0.999 && ((paint.type === "solid" && (paint.color?.a ?? 1) >= 0.999) || paint.type === "image"));
const contains = (outer: NodeFingerprint, inner: NodeFingerprint): boolean => outer.bounds.x <= inner.bounds.x + 0.5 && outer.bounds.y <= inner.bounds.y + 0.5 && outer.bounds.x + outer.bounds.width >= inner.bounds.x + inner.bounds.width - 0.5 && outer.bounds.y + outer.bounds.height >= inner.bounds.y + inner.bounds.height - 0.5;
/** True when a background blur inside the subtree has nothing opaque of the subtree's own beneath it — it blurs the PAGE, which an isolated render does not have. */
function samplesBackdrop(root: NodeFingerprint): boolean {
  const covers: NodeFingerprint[] = []; let found = false;
  const visit = (node: NodeFingerprint): void => {
    if (found) return;
    if (hasBackgroundBlur(node) && !covers.some((cover) => contains(cover, node))) { found = true; return; }
    if (isOpaqueCover(node) && ownKind(node) !== "free") covers.push(node);
    visibleChildren(node).forEach(visit);
  };
  visit(root);
  return found;
}

/** A small container made only of shapes with at least one real vector — what a developer calls "an icon". */
function isIconLike(node: NodeFingerprint): boolean {
  if (!CONTAINER_TYPES.has(node.type) || Math.max(node.bounds.width, node.bounds.height) > 512) return false;
  let shapesOnly = true, trueVector = false, leaves = 0;
  walk(node, (entry) => {
    if (entry === node) return;
    const leaf = visibleChildren(entry).length === 0 || entry.type === "BOOLEAN_OPERATION";
    if (leaf) { leaves++; if (!SHAPE_TYPES.has(entry.type) || hasImageFill(entry)) shapesOnly = false; }
    if (entry.type === "TEXT") shapesOnly = false;
    if (isTrueVector(entry)) trueVector = true;
  });
  return shapesOnly && trueVector && leaves > 0;
}

/**
 * A button drawn as one opaque chip around its artwork (a white circle with a shadow, a yellow "+" disc): CSS draws
 * the chip exactly, so only the artwork becomes pixels. Flattened whole, a crop of the design would carry what lies
 * around the chip there, and the same button shown elsewhere (a card whose stepper counts back to zero) would bring
 * that square of someone else's photo along.
 */
function drawsOwnChip(node: NodeFingerprint): boolean {
  const fills = (node.fills || []).filter((paint) => paint.visible !== false);
  if (!fills.length || fills.some((paint) => paint.type !== "solid") || !fills.some((paint) => (paint.color?.a ?? 1) * (paint.opacity ?? 1) >= 0.999)) return false;
  if ((node.opacity ?? 1) < 0.999 || (node.effects || []).some((effect) => effect.visible !== false && effect.type !== "drop-shadow")) return false;
  if (node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") return false;
  // Every piece of artwork lies on the chip (inside its rounded shape), so a crop of it shows only the chip around it.
  const { x, y, width, height } = node.bounds; const radius = Math.min(width, height) / 2;
  const corner = typeof node.cornerRadius === "number" ? node.cornerRadius : Math.max(0, ...Object.values(node.cornerRadius ?? {}).map(Number).filter(Number.isFinite));
  const r = Math.min(radius, corner || 0);
  const onChip = (px: number, py: number): boolean => {
    if (px < x - 0.5 || py < y - 0.5 || px > x + width + 0.5 || py > y + height + 0.5) return false;
    const cx = Math.min(Math.max(px, x + r), x + width - r), cy = Math.min(Math.max(py, y + r), y + height - r);
    return Math.hypot(px - cx, py - cy) <= r + 0.5;
  };
  return visibleChildren(node).length > 0 && visibleChildren(node).every((child) => { const b = child.bounds; return onChip(b.x, b.y) && onChip(b.x + b.width, b.y) && onChip(b.x, b.y + b.height) && onChip(b.x + b.width, b.y + b.height); });
}

/**
 * Artwork rebuilt from primitives (scaled-down app mockups, charts): many nodes, and either every
 * text is sub-readable / fractionally scaled, or the subtree is mostly vectors. Real UI keeps
 * integer, readable type sizes, so it never matches.
 */
function isIllustration(node: NodeFingerprint): boolean {
  if (!CONTAINER_TYPES.has(node.type)) return false;
  let total = 0, vectors = 0, freeRotated = 0; const textSizes: number[] = [];
  walk(node, (entry) => { total++; if (isTrueVector(entry)) vectors++; if (ownKind(entry) === "free") freeRotated++; if (entry.type === "TEXT" && entry.typography?.fontSize) textSizes.push(entry.typography.fontSize); });
  if (total < 20) return false;
  const scaled = (size: number) => size < 9 || Math.abs(size * 2 - Math.round(size * 2)) > 0.02;
  if (textSizes.length) return textSizes.every(scaled);
  return vectors / total >= 0.5 || freeRotated >= 3;
}

function legacyClips(node: NodeFingerprint): boolean {
  if (node.clips !== undefined) return node.clips;
  if (node.layout?.overflow === "hidden") return true;
  if (!["FRAME", "INSTANCE", "COMPONENT"].includes(node.type)) return false;
  // Legacy extraction: Figma frames clip by default, so assume it when children actually overflow.
  const b = node.bounds;
  return visibleChildren(node).some((child) => child.bounds.x < b.x - 1 || child.bounds.y < b.y - 1 || child.bounds.x + child.bounds.width > b.x + b.width + 1 || child.bounds.y + child.bounds.height > b.y + b.height + 1);
}

function renderRect(node: NodeFingerprint): { x: number; y: number; w: number; h: number; exact: boolean; } {
  if (node.renderBounds) return { x: node.renderBounds.x, y: node.renderBounds.y, w: node.renderBounds.width, h: node.renderBounds.height, exact: true };
  let x0 = node.bounds.x, y0 = node.bounds.y, x1 = x0 + node.bounds.width, y1 = y0 + node.bounds.height;
  const grow = (entry: NodeFingerprint, clipped: boolean): void => {
    if (clipped) return;
    for (const child of visibleChildren(entry)) { x0 = Math.min(x0, child.bounds.x); y0 = Math.min(y0, child.bounds.y); x1 = Math.max(x1, child.bounds.x + child.bounds.width); y1 = Math.max(y1, child.bounds.y + child.bounds.height); grow(child, legacyClips(child)); }
  };
  grow(node, legacyClips(node));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, exact: false };
}

function radiusCss(node: NodeFingerprint): CssValue | undefined {
  if (node.type === "ELLIPSE") return "50%";
  const radius = node.cornerRadius; if (!radius) return undefined;
  const values = [radius.topLeft, radius.topRight, radius.bottomRight, radius.bottomLeft];
  if (values.every((value) => value === 0)) return undefined;
  return new Set(values).size === 1 ? values[0] : values.map((value) => `${value}px`).join(" ");
}

function effectsCss(node: NodeFingerprint, target: CssProps, isText: boolean): void {
  const shadows: string[] = [];
  for (const effect of node.effects || []) {
    if (!effect.visible) continue;
    const color = effect.color ? cssColor({ type: "solid", visible: true, color: effect.color }) ?? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.25)";
    if (effect.type === "drop-shadow") shadows.push(isText ? `${r2(effect.offset?.x ?? 0)}px ${r2(effect.offset?.y ?? 0)}px ${r2(effect.radius ?? 0)}px ${color}` : `${r2(effect.offset?.x ?? 0)}px ${r2(effect.offset?.y ?? 0)}px ${r2(effect.radius ?? 0)}px ${r2(effect.spread ?? 0)}px ${color}`);
    else if (effect.type === "inner-shadow" && !isText) shadows.push(`inset ${r2(effect.offset?.x ?? 0)}px ${r2(effect.offset?.y ?? 0)}px ${r2(effect.radius ?? 0)}px ${r2(effect.spread ?? 0)}px ${color}`);
    // Figma blur radii are twice the CSS gaussian sigma (Dev Mode exports radius/2).
    else if (effect.type === "layer-blur") target.filter = `blur(${r2((effect.radius ?? 0) / 2)}px)`;
    else if (effect.type === "background-blur") { target.backdropFilter = `blur(${r2((effect.radius ?? 0) / 2)}px)`; target.WebkitBackdropFilter = target.backdropFilter; }
  }
  if (shadows.length) target[isText ? "textShadow" : "boxShadow"] = shadows.join(", ");
}

function typographyCss(typography: TypographyFingerprint | undefined, base: boolean): CssProps {
  const css: CssProps = {}; if (!typography) return css;
  if (typography.fontFamily) css.fontFamily = `"${typography.fontFamily}", sans-serif`;
  if (typography.fontSize !== undefined) css.fontSize = r2(typography.fontSize);
  if (typography.fontWeight !== undefined) css.fontWeight = typography.fontWeight;
  if (typography.italic) css.fontStyle = "italic";
  if (base) { const lineHeight = typography.lineHeightPx ?? typography.lineHeight?.value; if (lineHeight !== undefined) css.lineHeight = `${r2(lineHeight)}px`; }
  if (typography.letterSpacing) css.letterSpacing = `${r2(typography.letterSpacing)}px`;
  if (typography.textCase === "uppercase") css.textTransform = "uppercase"; else if (typography.textCase === "lower") css.textTransform = "lowercase"; else if (typography.textCase === "title") css.textTransform = "capitalize";
  if (typography.textDecoration === "underline") css.textDecoration = "underline"; else if (typography.textDecoration === "strikethrough") css.textDecoration = "line-through";
  return css;
}

/**
 * What target.png shows at a flat's rect besides the flat itself: every layer painted after the flat's subtree
 * (pre-order = paint order) that overlaps it. Opaque layers and text are harmless for a crop — the page paints
 * them again over the same pixels — but a translucent layer would be applied twice.
 */
function markOcclusion(rootNode: NodeFingerprint, rootChildren: NodeFingerprint[], rootClip: ClipRect, flats: FlatPlan[], origin: { x: number; y: number; }): void {
  type Paint = { id: string; end: number; rect: ClipRect; kind: "none" | "opaque" | "tint" | "other"; tint?: Omit<Tint, "x" | "y" | "w" | "h">; };
  const list: Paint[] = [];
  const classify = (node: NodeFingerprint, alpha: number): Pick<Paint, "kind" | "tint"> => {
    const fills = (node.fills || []).filter((paint) => paint.visible !== false);
    const strokes = (node.strokes || []).filter((stroke) => stroke.paints.some((paint) => paint.visible !== false));
    const effects = (node.effects || []).filter((effect) => effect.visible);
    if (node.type === "TEXT") return { kind: "opaque" };
    if (!fills.length && !strokes.length && !effects.length) return { kind: "none" };
    const normal = !node.blendMode || node.blendMode === "NORMAL" || node.blendMode === "PASS_THROUGH";
    const solid = fills.length === 1 && fills[0].type === "solid" && fills[0].color?.hex ? fills[0] : undefined;
    // Only a rectangle-shaped fill covers its whole box, which is what dividing a tint out assumes.
    const rectLike = ["RECTANGLE", "FRAME", "COMPONENT", "INSTANCE"].includes(node.type);
    if (solid && rectLike && !strokes.length && !effects.length && normal && ownKind(node) !== "free") {
      const a = alpha * (solid.opacity ?? 1) * (solid.color!.a ?? 1);
      if (a >= 0.999) return { kind: "opaque" };
      const value = parseInt(solid.color!.hex!.slice(1, 7), 16);
      return a > 0.001 ? { kind: "tint", tint: { color: [(value >> 16) & 255, (value >> 8) & 255, value & 255], alpha: Math.round(a * 1000) / 1000 } } : { kind: "none" };
    }
    const opaqueFill = fills.some((paint) => (paint.type === "solid" && (paint.color?.a ?? 1) * (paint.opacity ?? 1) >= 0.999) || (paint.type === "image" && (paint.opacity ?? 1) >= 0.999));
    return { kind: alpha >= 0.999 && normal && opaqueFill && !effects.some((effect) => effect.type !== "inner-shadow") ? "opaque" : "other" };
  };
  const visit = (node: NodeFingerprint, clip: ClipRect, alpha: number): void => {
    const opacity = alpha * (node.opacity ?? 1);
    const rect = intersect(clip, node);
    const entry: Paint = { id: node.id, end: 0, rect, ...classify(node, opacity) }; list.push(entry);
    const childClip = legacyClips(node) ? rect : clip;
    const children = node.layout?.reverseZ ? [...visibleChildren(node)].reverse() : visibleChildren(node);
    for (const child of children) visit(child, childClip, opacity);
    entry.end = list.length;
  };
  for (const child of rootChildren) visit(child, rootClip, 1);
  const index = new Map(list.map((entry, position) => [entry.id, position]));
  for (const plan of flats) {
    const at = index.get(plan.id); if (at === undefined) continue;
    const area: ClipRect = { x0: plan.rect.x + origin.x, y0: plan.rect.y + origin.y, x1: plan.rect.x + origin.x + plan.rect.w, y1: plan.rect.y + origin.y + plan.rect.h };
    const tints: Tint[] = [];
    for (const entry of list.slice(list[at].end)) {
      const x0 = Math.max(area.x0, entry.rect.x0), y0 = Math.max(area.y0, entry.rect.y0), x1 = Math.min(area.x1, entry.rect.x1), y1 = Math.min(area.y1, entry.rect.y1);
      if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
      if (entry.kind === "tint") tints.push({ x: r2(x0 - origin.x), y: r2(y0 - origin.y), w: r2(x1 - x0), h: r2(y1 - y0), ...entry.tint! });
      else if (entry.kind === "other") plan.tainted = true;
    }
    if (tints.length) plan.tints = tints;
  }
}

/** A rounded, painted pill or box with one short label ("See all", "Continue"): users expect it to be clickable. */
function looksLikeButton(node: NodeFingerprint): boolean {
  if (!CONTAINER_TYPES.has(node.type)) return false;
  const { width, height } = node.bounds; if (height < 28 || height > 72 || width > 480) return false;
  const painted = (node.fills || []).some((paint) => paint.visible !== false) || (node.strokes || []).some((stroke) => stroke.paints.length > 0);
  const rounded = !!node.cornerRadius && Object.values(node.cornerRadius).some((value) => value > 0);
  if (!painted || !rounded) return false;
  const texts: NodeFingerprint[] = []; walk(node, (entry) => { if (entry.type === "TEXT") texts.push(entry); });
  const label = (texts[0]?.content?.text ?? "").trim();
  // A label says what happens ("Continue"); numbers, prices and percentages ("-15%") are badges, not buttons.
  return texts.length === 1 && /\p{L}/u.test(label) && label.split(/\s+/).length <= 3;
}
/** A small painted circle around an icon (carousel arrows, round icon buttons). */
function looksLikeIconButton(node: NodeFingerprint): boolean {
  const { width, height } = node.bounds; if (Math.abs(width - height) > 1 || width > 64 || width < 24) return false;
  const radius = node.type === "ELLIPSE" ? width / 2 : node.cornerRadius ? Math.min(...Object.values(node.cornerRadius)) : 0;
  return (node.fills || []).some((paint) => paint.visible !== false) && radius >= width / 2 - 1;
}

const GUTTER = 32;
/**
 * A web page is not a frame of one width. When the content of the page — and of every full-width layer in it —
 * sits in a centered column, the page becomes fluid: full-width layers stretch with the viewport and everything
 * else keeps its distance from the center (explicit Figma constraints right / scale / left-right win). The column
 * plus a gutter is the narrowest fluid width; below it, and for layouts that are not a centered column, the page
 * is scaled as a whole. Either way it never scrolls sideways, and at the design width nothing moves.
 */
function fitPage(root: RNode, constraintOf: (id: string) => ConstraintFingerprint | undefined): PageFit {
  const width = root.w; const margins: number[] = []; const anchors: (() => void)[] = [];
  const level = (parent: RNode): boolean => {
    const full = (kid: RNode): boolean => kid.x <= 1 && kid.x + kid.w >= width - 1;
    // The column is what the viewport re-centers; layers the designer anchored themselves do not bound it.
    const pinned = (kid: RNode): boolean => ["right", "scale", "left-right"].includes(constraintOf(kid.id)?.horizontal ?? "left");
    const inside = parent.children.filter((kid) => !full(kid) && !pinned(kid) && kid.x >= -0.5 && kid.x + kid.w <= width + 0.5);
    if (inside.length) {
      const left = Math.min(...inside.map((kid) => kid.x)), right = width - Math.max(...inside.map((kid) => kid.x + kid.w));
      if (left < 16 || right < 16 || Math.abs(left - right) > 0.1 * width) return false;
      margins.push(Math.min(left, right));
    }
    for (const kid of parent.children) {
      const horizontal = constraintOf(kid.id)?.horizontal;
      const fromCenter = r2(width / 2 - kid.x);
      if (full(kid)) {
        anchors.push(() => { kid.style.width = Math.abs(width - kid.w) < 0.5 ? "100%" : `calc(100% - ${r2(width - kid.w)}px)`; });
        if (kid.kind === "box" && !kid.flat && kid.children.length && !level(kid)) return false;
      } else if (horizontal === "right") anchors.push(() => { kid.style.left = `calc(100% - ${r2(width - kid.x)}px)`; });
      else if (horizontal === "scale") anchors.push(() => { kid.style.left = `${r2(kid.x / width * 100)}%`; kid.style.width = `${r2(kid.w / width * 100)}%`; });
      else if (horizontal === "left-right") anchors.push(() => { kid.style.width = `calc(100% - ${r2(width - kid.w)}px)`; });
      else anchors.push(() => { kid.style.left = fromCenter >= 0 ? `calc(50% - ${fromCenter}px)` : `calc(50% + ${-fromCenter}px)`; });
    }
    return true;
  };
  if (!level(root)) return { fluid: false, width, minWidth: width };
  anchors.forEach((anchor) => anchor());
  const margin = margins.length ? Math.min(...margins) : 0;
  return { fluid: true, width, minWidth: Math.min(width, Math.round(width - 2 * margin + 2 * Math.min(GUTTER, margin))) };
}

export function buildIR(fingerprint: DesignFingerprintV1, options: IROptions = {}): IRResult {
  const target = fingerprint.targets[0];
  const findById = (node: NodeFingerprint, id: string): NodeFingerprint | undefined => node.id === id ? node : (node.children || []).map((child) => findById(child, id)).find(Boolean);
  const rootNode = fingerprint.pages.map((page) => page.children.map((child) => findById(child, target.nodeId)).find(Boolean)).find(Boolean);
  if (!rootNode) throw new Error(`IR: target node ${target.nodeId} missing from fingerprint.`);
  detectLegacyMatrices(rootNode);
  const files = new Map(fingerprint.assets.items.filter((item) => item.localPath).map((item) => [item.imageRef, item.localPath!.split("/").pop()!]));
  const flats: FlatPlan[] = []; const notes: string[] = []; const popups: Popup[] = [];

  /** Prototype click actions: a route for "navigate" once its frame is built, a popup for "overlay". */
  function applyLink(link: NodeFingerprint["link"], base: RNode, nodeNotes: string[]): void {
    if (!link) return;
    if (link.navigation === "close" || (link.navigation === "overlay" && options.asOverlay && link.nodeId === rootNode!.id)) { base.act = { close: true, label: "Close" }; return; }
    if (link.navigation === "back") { base.act = { back: true, label: "Back" }; return; }
    if (link.navigation === "overlay" && link.nodeId) {
      const built = options.overlays?.[link.nodeId];
      base.opens = { target: link.nodeId, dx: link.offset?.x ?? 0, dy: link.offset?.y ?? 0, ms: link.ms };
      popups.push({ trigger: base.id, target: link.nodeId, component: built?.component, label: built?.label ?? base.name, dx: base.opens.dx, dy: base.opens.dy, ms: link.ms });
      if (!built) nodeNotes.push(`prototype overlay ${link.nodeId} is not built`);
    } else if (link.url) base.link = link.url;
    else if (link.nodeId) { const route = options.routes?.[link.nodeId]; if (route) base.link = route; else nodeNotes.push(`prototype link to ${link.nodeId} (no route registered yet)`); }
  }
  const imageCaps = new Map<string, { maxW: number; maxH: number; }>();
  const fontUse = new Map<string, { weights: Set<number>; italic: boolean; }>();
  const stats = { nodes: countNodes(rootNode), emitted: 0, flattened: 0, texts: 0, images: 0 };
  const origin = rootNode.bounds;

  const useFont = (typography: TypographyFingerprint | undefined): void => {
    if (!typography?.fontFamily) return;
    const entry = fontUse.get(typography.fontFamily) || { weights: new Set<number>(), italic: false };
    entry.weights.add(typography.fontWeight ?? 400); entry.italic ||= !!typography.italic; fontUse.set(typography.fontFamily, entry);
  };

  function backgroundCss(node: NodeFingerprint, w: number, h: number, nodeNotes: string[]): string | undefined {
    const layers: string[] = []; const fills = (node.fills || []).filter((paint) => paint.visible !== false);
    fills.forEach((paint, index) => {
      if (paint.type === "solid") { const color = cssColor(paint); if (color) layers.unshift(index === 0 ? color : `linear-gradient(${color}, ${color})`); }
      else if (paint.type === "linear-gradient") { const css = linearGradientCss(paint, w, h); if (css) layers.unshift(css); else nodeNotes.push("linear gradient without handles (legacy extraction) — direction unknown"); }
      else if (paint.type === "radial-gradient") { const radial = radialGradientCss(paint, w, h); if (radial) { layers.unshift(radial.css); if (!radial.exact) nodeNotes.push("rotated radial gradient approximated with an axis-aligned ellipse"); } }
      else if (paint.type === "angular-gradient") { const css = conicGradientCss(paint, w, h); if (css) { layers.unshift(css); nodeNotes.push("angular gradient mapped to conic-gradient (start angle approximate)"); } }
      else if (paint.type === "diamond-gradient") nodeNotes.push("diamond gradient has no CSS equivalent");
      else if (paint.type === "image" && paint.imageRef) {
        const file = files.get(paint.imageRef);
        if (!file) { nodeNotes.push(`image ${paint.imageRef} was not downloaded`); return; }
        const cap = imageCaps.get(file) || { maxW: 0, maxH: 0 }; imageCaps.set(file, { maxW: Math.max(cap.maxW, w), maxH: Math.max(cap.maxH, h) });
        layers.unshift(`url("{{asset:${file}}}") center / ${paint.scaleMode === "fit" ? "contain" : "cover"} no-repeat`);
      }
    });
    if (!layers.length) return undefined;
    // In the CSS shorthand only the LAST layer may be a bare color; solid layers above it were emitted as gradients.
    return layers.join(", ");
  }

  function strokeCss(node: NodeFingerprint, hasChildren: boolean, style: CssProps, nodeNotes: string[]): CssProps | undefined {
    const stroke = node.strokes?.[0]; if (!stroke) return undefined;
    const color = cssColor(stroke.paints.find((paint) => paint.type === "solid")); if (!color) { if (stroke.paints.length) nodeNotes.push("non-solid stroke not reproduced"); return undefined; }
    const lineStyle = node.strokeDashes?.length ? "dashed" : "solid";
    const weights = node.strokeWeights; const weight = r2(stroke.weight);
    if (weights && new Set(Object.values(weights)).size > 1) {
      const sides: CssProps = { borderStyle: lineStyle, borderColor: color, borderWidth: `${r2(weights.top)}px ${r2(weights.right)}px ${r2(weights.bottom)}px ${r2(weights.left)}px`, boxSizing: "border-box" };
      if (!hasChildren) { Object.assign(style, sides); return undefined; }
      return { position: "absolute", inset: 0, borderRadius: "inherit", pointerEvents: "none", ...sides };
    }
    if (!weight) return undefined;
    if (hasChildren) {
      // Figma paints a frame's stroke above its children; a CSS border would also shift absolutely
      // positioned children inward. A trailing overlay reproduces both exactly.
      const inset = stroke.align === "inside" ? 0 : stroke.align === "center" ? -weight / 2 : -weight;
      return { position: "absolute", inset: inset === 0 ? 0 : `${r2(inset)}px`, border: `${weight}px ${lineStyle} ${color}`, borderRadius: "inherit", boxSizing: "border-box", pointerEvents: "none" };
    }
    if (stroke.align === "inside") { style.border = `${weight}px ${lineStyle} ${color}`; style.boxSizing = "border-box"; }
    else { style.outline = `${weight}px ${lineStyle} ${color}`; style.outlineOffset = `${stroke.align === "center" ? r2(-weight / 2) : 0}px`; }
    return undefined;
  }

  function commonCss(node: NodeFingerprint, style: CssProps): void {
    if (node.opacity !== undefined && node.opacity < 0.999) style.opacity = r2(node.opacity);
    if (node.blendMode && BLEND[node.blendMode]) style.mixBlendMode = BLEND[node.blendMode];
  }

  function flipCss(net: Net): string | undefined {
    return netKind(net) === "flip" ? `scale(${net.a < 0 ? -1 : 1}, ${net.d < 0 ? -1 : 1})` : undefined;
  }

  function flatNode(node: NodeFingerprint, parent: NodeFingerprint, reason: string, clip: ClipRect): RNode {
    const rect = renderRect(node); const count = countNodes(node);
    let rasterOnly = false; walk(node, (entry) => { if (hasImageFill(entry) || entry.effects?.some((effect) => effect.visible && (effect.type === "background-blur" || effect.type === "layer-blur"))) rasterOnly = true; });
    const backdrop = samplesBackdrop(node);
    const format = rasterOnly || backdrop ? "png" : "svg"; const file = flatFileName(node.id, format);
    const onEdge = (a: number, b: number): boolean => Math.abs(a - b) < 0.51;
    const clipped = rect.exact ? { left: onEdge(rect.x, clip.x0), top: onEdge(rect.y, clip.y0), right: onEdge(rect.x + rect.w, clip.x1), bottom: onEdge(rect.y + rect.h, clip.y1) } : undefined;
    flats.push({ id: node.id, file, format, reason, nodes: count, rect: { x: r2(rect.x - origin.x), y: r2(rect.y - origin.y), w: r2(rect.w), h: r2(rect.h) }, hasRenderBounds: rect.exact,
      box: { x: r2(node.bounds.x - origin.x), y: r2(node.bounds.y - origin.y), w: r2(node.bounds.width), h: r2(node.bounds.height) },
      ...(clipped && (clipped.left || clipped.top || clipped.right || clipped.bottom) ? { clipped } : {}), ...(backdrop ? { backdrop } : {}) });
    stats.flattened += count - 1;
    const bleed = Math.abs(rect.x - node.bounds.x) > 0.01 || Math.abs(rect.y - node.bounds.y) > 0.01 || Math.abs(rect.w - node.bounds.width) > 0.01 || Math.abs(rect.h - node.bounds.height) > 0.01;
    // A Figma export already contains the node's own opacity; its blend mode still needs the live page beneath it.
    const style: CssProps = {}; if (!backdrop && node.blendMode && BLEND[node.blendMode]) style.mixBlendMode = BLEND[node.blendMode];
    const result: RNode = { id: node.id, name: node.name, figType: node.type, kind: "flat", flat: true, x: r2(node.bounds.x - parent.bounds.x), y: r2(node.bounds.y - parent.bounds.y), w: r2(node.bounds.width), h: r2(node.bounds.height), style, children: [], src: file,
      imgStyle: bleed ? { position: "absolute", left: r2(rect.x - node.bounds.x), top: r2(rect.y - node.bounds.y), width: r2(rect.w), height: r2(rect.h), maxWidth: "none" } : undefined,
      notes: [`flattened (${reason}${count > 1 ? `, ${count} nodes` : ""})`] };
    // A click action inside the artwork now belongs to the one element that remains of it.
    let link: NodeFingerprint["link"]; walk(node, (entry) => { link ??= entry.link; });
    applyLink(link, result, result.notes!);
    if (!result.link && !result.opens && !result.act && looksLikeIconButton(node)) result.hint = "button";
    return result;
  }

  function textNode(node: NodeFingerprint, base: RNode, net: Net): RNode {
    const typography = node.typography; const text = node.content?.text ?? ""; stats.texts++; useFont(typography);
    const style = base.style; Object.assign(style, typographyCss(typography, true));
    const fills = (node.fills || []).filter((paint) => paint.visible !== false);
    const gradientFill = [...fills].reverse().find((paint) => paint.type === "linear-gradient");
    const solid = [...fills].reverse().find((paint) => paint.type === "solid");
    if (gradientFill && linearGradientCss(gradientFill, base.w, base.h)) { style.background = linearGradientCss(gradientFill, base.w, base.h)!; style.WebkitBackgroundClip = "text"; style.backgroundClip = "text"; style.color = "transparent"; }
    else style.color = cssColor(solid) ?? "#000000";
    effectsCss(node, style, true); commonCss(node, style);
    const flip = flipCss(net); if (flip) style.transform = flip;

    const lineHeight = typography?.lineHeightPx ?? typography?.lineHeight?.value;
    const explicitLines = text.split("\n").length;
    const autoResize = typography?.autoResize ?? (lineHeight && explicitLines === 1 && base.h <= lineHeight * 1.4 ? "width-and-height" : undefined);
    const noWrap = autoResize === "width-and-height";
    style.whiteSpace = noWrap ? "pre" : "pre-wrap";
    if (autoResize === "truncate") { style.overflow = "hidden"; style.textOverflow = "ellipsis"; }
    const align = typography?.textAlignHorizontal;
    if (!noWrap && align && align !== "left") style.textAlign = align === "justified" ? "justify" : align;

    // Runs with their own size carry their own line height (percent/auto line heights scale with the
    // run's font size). CSS takes each line's height from its tallest inline box only when the block's
    // strut is out of the way, so mixed texts zero the block line-height and size every run explicitly.
    const segments = [...(node.content?.segments || [])].sort((a, b) => a.start - b.start);
    const ratio = lineHeight && typography?.fontSize && typography.lineHeight?.unit !== "px" ? lineHeight / typography.fontSize : undefined;
    const runLineHeight = (run: TypographyFingerprint | undefined): number | undefined => run?.lineHeightPx ?? (ratio && run?.fontSize ? ratio * run.fontSize : lineHeight);
    const mixedLineHeights = lineHeight !== undefined && segments.some((segment) => Math.abs((runLineHeight(segment.typography) ?? lineHeight) - lineHeight) > 0.01);

    // Vertical alignment is only observable when the box does not hug its lines.
    const lines = lineHeight ? Math.max(explicitLines, Math.round(base.h / lineHeight)) : explicitLines;
    const hugs = mixedLineHeights || autoResize === "height" || autoResize === "width-and-height" || (!typography?.autoResize && lineHeight !== undefined && Math.abs(base.h - lines * lineHeight) <= 1.5 && lines === Math.round(base.h / lineHeight));
    const vertical = typography?.textAlignVertical;
    const needsVertical = !hugs && (vertical === "center" || vertical === "bottom");
    const needsOverflowAlign = noWrap && (align === "center" || align === "right");
    if (needsVertical || needsOverflowAlign) {
      style.display = "flex"; style.flexDirection = "column";
      if (needsVertical) style.justifyContent = vertical === "center" ? "center" : "flex-end";
      style.alignItems = noWrap ? (align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start") : "stretch";
      base.innerStyle = { flex: "0 0 auto" };
    }

    // Character-level overrides become spans.
    const baseRunStyle = (): CssProps | undefined => mixedLineHeights ? { lineHeight: `${r2(lineHeight!)}px` } : undefined;
    const runs: TextRun[] = []; let cursor = 0;
    for (const segment of segments) {
      if (segment.start > cursor) runs.push({ text: text.slice(cursor, segment.start), style: baseRunStyle() });
      const runStyle = typographyCss(segment.typography, false); useFont({ ...typography, ...segment.typography });
      const runColor = cssColor([...(segment.fills || [])].reverse().find((paint) => paint.type === "solid")); if (runColor && runColor !== style.color) runStyle.color = runColor;
      for (const key of Object.keys(runStyle)) if (runStyle[key] === style[key]) delete runStyle[key];
      if (mixedLineHeights) runStyle.lineHeight = `${r2(runLineHeight(segment.typography) ?? lineHeight!)}px`;
      runs.push({ text: text.slice(Math.max(cursor, segment.start), segment.end), style: Object.keys(runStyle).length ? runStyle : undefined });
      cursor = Math.max(cursor, segment.end);
    }
    if (cursor < text.length || !runs.length) runs.push({ text: text.slice(cursor), style: baseRunStyle() });
    if (mixedLineHeights) style.lineHeight = "0px";
    base.runs = runs.filter((run) => run.text.length > 0 || runs.length === 1);
    if (typography?.paragraphSpacing && text.includes("\n")) { base.paragraphs = true; base.notes = [...(base.notes || []), `paragraph spacing ${typography.paragraphSpacing}px`]; style["--paragraph-spacing"] = `${r2(typography.paragraphSpacing)}px`; }
    base.kind = "text";
    return base;
  }

  function build(node: NodeFingerprint, parent: NodeFingerprint, parentNet: Net, clip: ClipRect): RNode | undefined {
    const net = compose(parentNet, node); const kind = netKind(net); const own = ownKind(node);
    // 1. Things CSS cannot draw faithfully become one rendered asset.
    if (isAxisLine(node) && own !== "free") return ruleNode(node, parent, net);
    if (isTrueVector(node)) return flatNode(node, parent, node.arc ? "arc" : "vector", clip);
    if (own === "free") return flatNode(node, parent, "rotated", clip);
    if (visibleChildren(node).some((child) => child.isMask)) return flatNode(node, parent, "mask", clip);
    // A glass button (background blur on the container itself) stays a real CSS box with backdrop-filter;
    // only its artwork is flattened, one level down.
    if (!hasBackgroundBlur(node)) {
      if (isIconLike(node) && !drawsOwnChip(node)) return flatNode(node, parent, "icon", clip);
      if (options.flattenIllustrations !== false && isIllustration(node)) return flatNode(node, parent, "illustration", clip);
    }
    const leaf = visibleChildren(node).length === 0;
    if (leaf && kind === "quarter" && (node.type === "TEXT" || hasImageFill(node))) return flatNode(node, parent, "rotated", clip);

    stats.emitted++;
    const nodeNotes: string[] = [];
    const w = r2(node.bounds.width), h = r2(node.bounds.height);
    const base: RNode = { id: node.id, name: node.name, figType: node.type, kind: "box", x: r2(node.bounds.x - parent.bounds.x), y: r2(node.bounds.y - parent.bounds.y), w, h, style: {}, children: [] };
    applyLink(node.link, base, nodeNotes);

    if (node.type === "TEXT") { const result = textNode(node, base, net); if (nodeNotes.length) result.notes = [...(result.notes || []), ...nodeNotes]; return result; }

    // 2. Leaf with an image fill → <img> (lazy-loadable), honoring crop mode and accumulated flips.
    const imagePaint = [...(node.fills || [])].reverse().find((paint) => paint.type === "image" && paint.imageRef && paint.visible !== false);
    if (leaf && imagePaint) {
      const file = files.get(imagePaint.imageRef);
      if (!file) nodeNotes.push(`image ${imagePaint.imageRef} was not downloaded`);
      else {
        stats.images++; base.kind = "img"; base.src = file;
        const style = base.style; const radius = radiusCss(node); if (radius !== undefined) style.borderRadius = radius;
        // Fills paint bottom to top: a color under the photo shows through its transparency; one above it (a 5% black
        // wash that greys a white product shot) is painted over it, never behind it.
        const fills = (node.fills || []).filter((paint) => paint.visible !== false); const at = fills.lastIndexOf(imagePaint);
        const under = cssColor(fills.slice(0, at).find((paint) => paint.type === "solid")); if (under) style.background = under;
        const wash = at >= 0 && at < fills.length - 1 ? backgroundCss({ ...node, fills: fills.slice(at + 1) }, w, h, nodeNotes) : undefined;
        if (wash) base.overlay = { position: "absolute", inset: 0, background: wash, borderRadius: "inherit", pointerEvents: "none" };
        if (imagePaint.opacity !== undefined && imagePaint.opacity < 0.999) nodeNotes.push(`image paint opacity ${r2(imagePaint.opacity)}`);
        if (imagePaint.hasFilters) nodeNotes.push("image has Figma filters (exposure/contrast…) not reproduced");
        const flip = flipCss(net);
        if (imagePaint.scaleMode === "stretch" && imagePaint.imageTransform) {
          // Crop mode: the node's unit square maps into image UV space; invert it into an oversized, offset <img>.
          const [[a, , tx], [, d, ty]] = imagePaint.imageTransform;
          const imageW = w / (a || 1), imageH = h / (d || 1);
          base.imgStyle = { position: "absolute", left: r2(-tx * imageW), top: r2(-ty * imageH), width: r2(imageW), height: r2(imageH), maxWidth: "none" };
          if (imagePaint.opacity !== undefined && imagePaint.opacity < 0.999) base.imgStyle.opacity = r2(imagePaint.opacity);
          if (flip) base.imgStyle.transform = flip;
          style.overflow = "hidden";
          const cap = imageCaps.get(file) || { maxW: 0, maxH: 0 }; imageCaps.set(file, { maxW: Math.max(cap.maxW, imageW), maxH: Math.max(cap.maxH, imageH) });
        } else if (wash) {
          // The wash needs an element above the photo: the photo becomes an inner <img>, the wash a layer over it.
          base.imgStyle = { position: "absolute", left: 0, top: 0, width: w, height: h, objectFit: imagePaint.scaleMode === "fit" ? "contain" : "cover", maxWidth: "none" };
          if (imagePaint.opacity !== undefined && imagePaint.opacity < 0.999) base.imgStyle.opacity = r2(imagePaint.opacity);
          if (flip) base.imgStyle.transform = flip;
          style.overflow = "hidden";
          if (imagePaint.scaleMode === "tile") nodeNotes.push("tiled image fill rendered as cover");
          const cap = imageCaps.get(file) || { maxW: 0, maxH: 0 }; imageCaps.set(file, { maxW: Math.max(cap.maxW, w), maxH: Math.max(cap.maxH, h) });
        } else {
          style.objectFit = imagePaint.scaleMode === "fit" ? "contain" : "cover";
          if (imagePaint.opacity !== undefined && imagePaint.opacity < 0.999) style.opacity = r2((node.opacity ?? 1) * imagePaint.opacity);
          if (flip) style.transform = flip;
          if (imagePaint.scaleMode === "tile") nodeNotes.push("tiled image fill rendered as cover");
          const cap = imageCaps.get(file) || { maxW: 0, maxH: 0 }; imageCaps.set(file, { maxW: Math.max(cap.maxW, w), maxH: Math.max(cap.maxH, h) });
        }
        strokeCss(node, false, style, nodeNotes); effectsCss(node, style, false); commonCss(node, style);
        if (nodeNotes.length) base.notes = nodeNotes;
        return base;
      }
    }

    // 3. Boxes: background layers, radius, clip, stroke, effects; children at their own AABBs.
    const style = base.style;
    const background = backgroundCss(node, w, h, nodeNotes); if (background) style.background = background;
    const radius = radiusCss(node); if (radius !== undefined) style.borderRadius = radius;
    if (!leaf && legacyClips(node)) style.overflow = "hidden";
    effectsCss(node, style, false); commonCss(node, style);
    const flip = leaf ? flipCss(net) : undefined; if (flip && node.fills?.some((paint) => paint.gradient)) style.transform = flip;
    const ordered = node.layout?.reverseZ ? [...visibleChildren(node)].reverse() : visibleChildren(node);
    const childClip = style.overflow === "hidden" ? intersect(clip, node) : clip;
    for (const child of ordered) { const built = build(child, node, net, childClip); if (built) base.children.push(built); }
    const overlay = strokeCss(node, base.children.length > 0, style, nodeNotes); if (overlay) base.overlay = overlay;
    if (!base.link && !base.opens && !base.act && looksLikeButton(node)) base.hint = "button";
    if (nodeNotes.length) base.notes = nodeNotes;
    return base;
  }

  function ruleNode(node: NodeFingerprint, parent: NodeFingerprint, net: Net): RNode {
    stats.emitted++;
    const stroke = node.strokes?.[0]; const weight = Math.max(1, r2(stroke?.weight ?? 1));
    const color = cssColor(stroke?.paints.find((paint) => paint.type === "solid")) ?? cssColor((node.fills || [])[0]) ?? "#000000";
    const horizontal = node.bounds.height < 0.5;
    const style: CssProps = node.strokeDashes?.length ? { [horizontal ? "borderTop" : "borderLeft"]: `${weight}px dashed ${color}` } : { background: color };
    commonCss(node, style);
    // Figma paints a line's stroke on ONE side of its axis — the local "up" side, wherever rotation and flips
    // carry it — not centred on it. Render bounds state the painted rect outright; otherwise derive the side.
    const render = node.renderBounds;
    const painted = render && render.width >= 0.5 && render.height >= 0.5 && Math.abs((horizontal ? render.height : render.width) - weight) < 0.51;
    const up = horizontal ? -net.d : -net.c; // image of the local (0,−1) on the axis perpendicular to the line
    const x = painted ? render.x : node.bounds.x - (!horizontal && up < 0 ? weight : 0);
    const y = painted ? render.y : node.bounds.y - (horizontal && up < 0 ? weight : 0);
    return { id: node.id, name: node.name, figType: node.type, kind: "rule", x: r2(x - parent.bounds.x), y: r2(y - parent.bounds.y), w: horizontal ? r2(painted ? render.width : node.bounds.width) : weight, h: horizontal ? weight : r2(painted ? render.height : node.bounds.height), style, children: [] };
  }

  const rootNotes: string[] = [];
  const root: RNode = { id: rootNode.id, name: rootNode.name, figType: rootNode.type, kind: "root", x: 0, y: 0, w: r2(target.width), h: r2(target.height), style: { position: "relative", overflow: "hidden" }, children: [] };
  const rootBackground = backgroundCss(rootNode, root.w, root.h, rootNotes); if (rootBackground) root.style.background = rootBackground;
  if (options.asOverlay) {
    // An overlay panel is seen as a box over the page: its own corners, shadow and clipping are part of it.
    const radius = radiusCss(rootNode); if (radius !== undefined) root.style.borderRadius = radius;
    effectsCss(rootNode, root.style, false);
    if (!legacyClips(rootNode)) delete root.style.overflow;
  }
  const rootNet = IDENTITY; // the target's own transform is its placement on the canvas, not part of the page
  const rootChildren = rootNode.layout?.reverseZ ? [...visibleChildren(rootNode)].reverse() : visibleChildren(rootNode);
  const rootClip: ClipRect = { x0: origin.x, y0: origin.y, x1: origin.x + target.width, y1: origin.y + target.height };
  for (const child of rootChildren) { const built = build(child, rootNode, rootNet, rootClip); if (built) root.children.push(built); }
  // The frame's own stroke, painted over its content like any container's.
  const rootStroke = strokeCss(rootNode, true, root.style, rootNotes); if (rootStroke) root.overlay = rootStroke;
  const collect = (node: RNode): void => { for (const note of node.notes || []) if (!note.startsWith("flattened")) notes.push(`${node.id} ${node.name}: ${note}`); node.children.forEach(collect); };
  collect(root); notes.push(...rootNotes.map((note) => `${root.id}: ${note}`));
  markOcclusion(rootNode, rootChildren, rootClip, flats, origin);
  const byId = new Map<string, NodeFingerprint>(); walk(rootNode, (node) => byId.set(node.id, node));
  const behaviors = inferBehaviors(root, (id) => byId.get(id));
  const fixes = keepControlsVisible(root);
  const constraints = new Map<string, ConstraintFingerprint>(); walk(rootNode, (node) => { if (node.constraints) constraints.set(node.id, node.constraints); });
  const fit = options.asOverlay ? { fluid: false, width: root.w, minWidth: root.w } : fitPage(root, (id) => constraints.get(id));

  return {
    kind: options.asOverlay ? "overlay" : "page", root, popups, fit, behaviors, fixes, flats, notes, stats,
    render: rootNode.renderBounds ? { dx: r2(rootNode.bounds.x - rootNode.renderBounds.x), dy: r2(rootNode.bounds.y - rootNode.renderBounds.y), w: r2(rootNode.renderBounds.width), h: r2(rootNode.renderBounds.height) } : { dx: 0, dy: 0, w: root.w, h: root.h },
    images: [...imageCaps.entries()].map(([file, cap]) => ({ file, maxW: Math.ceil(cap.maxW), maxH: Math.ceil(cap.maxH) })),
    fonts: [...fontUse.entries()].map(([family, use]) => ({ family, weights: [...use.weights].sort((a, b) => a - b), italic: use.italic })),
  };
}

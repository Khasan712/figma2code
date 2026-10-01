import { sha256 } from "./hash.ts";
import type { AssetReference, Bounds, Color, ComponentReference, ComponentRegistry, ConstraintFingerprint, DesignFingerprintV1, EffectFingerprint, ExportSetting, FigmaFileResponse, FigmaNode, FingerprintHashes, FingerprintStatistics, LayoutFingerprint, NodeFingerprint, NodeType, PaintFingerprint, PageFingerprint, StyleRegistry, TextSegment, TypographyFingerprint, VariableRegistry, ViewportInfo } from "./types.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const optionalNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function color(raw: unknown): Color | undefined {
  const value = record(raw);
  if (!["r", "g", "b"].every((key) => typeof value[key] === "number")) return undefined;
  const r = number(value.r), g = number(value.g), b = number(value.b), a = number(value.a, 1);
  const byte = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * 255))).toString(16).padStart(2, "0").toUpperCase();
  return { r, g, b, a, hex: `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a) : ""}` };
}

function bounds(raw: unknown): Bounds {
  const value = record(raw);
  return { x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height), absoluteX: optionalNumber(value.x), absoluteY: optionalNumber(value.y) };
}

function typography(raw: unknown): TypographyFingerprint | undefined {
  const value = record(raw);
  if (Object.keys(value).length === 0) return undefined;
  const lineHeightUnit = string(value.lineHeightUnit);
  const unit = lineHeightUnit === "PIXELS" ? "px" : lineHeightUnit === "FONT_SIZE_%" || lineHeightUnit === "INTRINSIC_%" ? "percent" : "auto";
  const textCase: Record<string, TypographyFingerprint["textCase"]> = { UPPER: "uppercase", LOWER: "lower", TITLE: "title", SMALL_CAPS: "uppercase", SMALL_CAPS_FORCED: "uppercase", ORIGINAL: "original" };
  const decoration: Record<string, TypographyFingerprint["textDecoration"]> = { UNDERLINE: "underline", STRIKETHROUGH: "strikethrough", NONE: "none" };
  const align: Record<string, TypographyFingerprint["textAlignHorizontal"]> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justified" };
  const vertical: Record<string, TypographyFingerprint["textAlignVertical"]> = { TOP: "top", CENTER: "center", BOTTOM: "bottom" };
  const fontStyle = string(record(value.fontName).style);
  const fontWeight = optionalNumber(value.fontWeight) ?? optionalNumber(fontStyle.match(/\d+/)?.[0]);
  const result: TypographyFingerprint = {
    fontFamily: string(value.fontFamily) || string(record(value.fontName).family) || undefined, fontPostScriptName: string(value.fontPostScriptName) || undefined,
    fontSize: optionalNumber(value.fontSize), fontWeight,
    lineHeight: lineHeightUnit || optionalNumber(value.lineHeightPx) ? { unit, value: unit === "auto" ? undefined : optionalNumber(value.lineHeightPx) ?? optionalNumber(value.lineHeightPercentFontSize) } : undefined,
    lineHeightPx: optionalNumber(value.lineHeightPx),
    autoResize: ({ NONE: "none", HEIGHT: "height", WIDTH_AND_HEIGHT: "width-and-height", TRUNCATE: "truncate" } as Record<string, TypographyFingerprint["autoResize"]>)[string(value.textAutoResize)],
    italic: value.italic === true || /italic|oblique/i.test(string(value.fontStyle)) || undefined,
    letterSpacing: optionalNumber(value.letterSpacing), textAlignHorizontal: align[string(value.textAlignHorizontal)], textAlignVertical: vertical[string(value.textAlignVertical)],
    textCase: textCase[string(value.textCase)], textDecoration: decoration[string(value.textDecoration)], paragraphSpacing: optionalNumber(value.paragraphSpacing), maxLines: optionalNumber(value.maxLines),
  };
  return Object.values(result).some((entry) => entry !== undefined) ? result : undefined;
}

function paint(raw: unknown): PaintFingerprint | undefined {
  const value = record(raw); if (value.visible === false) return undefined;
  const paintType: Record<string, PaintFingerprint["type"]> = { SOLID: "solid", GRADIENT_LINEAR: "linear-gradient", GRADIENT_RADIAL: "radial-gradient", GRADIENT_ANGULAR: "angular-gradient", GRADIENT_DIAMOND: "diamond-gradient", IMAGE: "image", EMOJI: "pattern" };
  const type = paintType[string(value.type)]; if (!type) return undefined;
  const stops = list(value.gradientStops).flatMap((stop) => { const item = record(stop); const stopColor = color(item.color); return stopColor ? [{ position: number(item.position), color: stopColor }] : []; });
  // Figma describes gradient geometry as handle points (start, end, width), not an affine matrix.
  const handles = list(value.gradientHandlePositions).map((point) => { const item = record(point); return { x: number(item.x), y: number(item.y) }; });
  const scaleMode = ({ FILL: "fill", FIT: "fit", TILE: "tile", STRETCH: "stretch" } as Record<string, PaintFingerprint["scaleMode"]>)[string(value.scaleMode)];
  const transformRows = list(value.imageTransform).map((row) => list(row).map((entry) => number(entry)));
  const imageTransform = transformRows.length === 2 && transformRows.every((row) => row.length === 3) ? transformRows as [[number, number, number], [number, number, number]] : undefined;
  const blendMode = string(value.blendMode); const filters = record(value.filters);
  return { type, opacity: optionalNumber(value.opacity), color: color(value.color), visible: value.visible !== false, imageRef: string(value.imageRef) || undefined,
    gradient: stops.length ? { stops, handles: handles.length ? handles : undefined } : undefined,
    scaleMode: type === "image" ? scaleMode : undefined, imageTransform: type === "image" ? imageTransform : undefined, scalingFactor: type === "image" ? optionalNumber(value.scalingFactor) : undefined,
    blendMode: blendMode && blendMode !== "NORMAL" ? blendMode : undefined, hasFilters: Object.values(filters).some((entry) => typeof entry === "number" && entry !== 0) || undefined };
}

function paints(raw: unknown): PaintFingerprint[] {
  return list(raw).map(paint).filter((entry): entry is PaintFingerprint => entry !== undefined);
}

function layout(raw: FigmaNode): LayoutFingerprint | undefined {
  const mode: Record<string, LayoutFingerprint["mode"]> = { HORIZONTAL: "horizontal", VERTICAL: "vertical", GRID: "grid", NONE: "none" };
  const rawMode = string(raw.layoutMode);
  // clipsContent matters even without auto-layout: a plain frame that clips must carry overflow info.
  const hasLayout = rawMode || raw.paddingLeft !== undefined || raw.itemSpacing !== undefined || raw.clipsContent === true || (raw.overflowDirection && raw.overflowDirection !== "NONE");
  if (!hasLayout) return undefined;
  const sizing = (value: unknown): "fixed" | "fill" | "hug" => value === "FILL" ? "fill" : value === "HUG" ? "hug" : "fixed";
  const overflow = raw.clipsContent === true ? "hidden" : raw.overflowDirection && raw.overflowDirection !== "NONE" ? "scroll" : "visible";
  return { mode: mode[rawMode] || "none", primaryAxisAlign: string(raw.primaryAxisAlignItems) || undefined, counterAxisAlign: string(raw.counterAxisAlignItems) || undefined,
    padding: { top: number(raw.paddingTop), right: number(raw.paddingRight), bottom: number(raw.paddingBottom), left: number(raw.paddingLeft) }, itemSpacing: optionalNumber(raw.itemSpacing), counterAxisSpacing: optionalNumber(raw.counterAxisSpacing), layoutWrap: raw.layoutWrap === "WRAP", reverseZ: raw.itemReverseZIndex === true || undefined,
    sizing: { width: sizing(raw.layoutSizingHorizontal), height: sizing(raw.layoutSizingVertical) }, minWidth: optionalNumber(raw.minWidth), maxWidth: optionalNumber(raw.maxWidth), minHeight: optionalNumber(raw.minHeight), maxHeight: optionalNumber(raw.maxHeight), overflow };
}

function constraints(raw: unknown): ConstraintFingerprint | undefined {
  const value = record(raw); if (!value.horizontal && !value.vertical) return undefined;
  const horizontal: Record<string, ConstraintFingerprint["horizontal"]> = { LEFT: "left", RIGHT: "right", CENTER: "center", LEFT_RIGHT: "left-right", SCALE: "scale" };
  const vertical: Record<string, ConstraintFingerprint["vertical"]> = { TOP: "top", BOTTOM: "bottom", CENTER: "center", TOP_BOTTOM: "top-bottom", SCALE: "scale" };
  return { horizontal: horizontal[string(value.horizontal)] || "left", vertical: vertical[string(value.vertical)] || "top" };
}

function textSegments(raw: FigmaNode): TextSegment[] | undefined {
  const overrides = list(raw.characterStyleOverrides); const table = record(raw.styleOverrideTable); if (!overrides.length || !Object.keys(table).length) return undefined;
  const segments: TextSegment[] = []; let start = 0;
  while (start < overrides.length) { const override = number(overrides[start]); let end = start + 1; while (end < overrides.length && number(overrides[end]) === override) end++;
    if (override !== 0) { const value = record(table[String(override)]); segments.push({ start, end, typography: typography(value), fills: paints(value.fills) }); }
    start = end;
  } return segments.length ? segments : undefined;
}

function nodeAsset(raw: FigmaNode, nodeBounds: Bounds): AssetReference | undefined {
  const fills = paints(raw.fills); const image = fills.find((fill) => fill.type === "image"); const type = string(raw.type);
  if (image?.imageRef) return { id: image.imageRef, type: "image", name: string(raw.name), sourceNodeId: string(raw.id), imageRef: image.imageRef, dimensions: { width: nodeBounds.width, height: nodeBounds.height } };
  if (["VECTOR", "LINE", "BOOLEAN_OPERATION", "STAR", "POLYGON", "ELLIPSE"].includes(type)) return { id: `vector:${string(raw.id)}`, type: "vector", name: string(raw.name), sourceNodeId: string(raw.id), dimensions: { width: nodeBounds.width, height: nodeBounds.height } };
  return undefined;
}

/** Arc data only when the ellipse is not a full disc: a ring or pie cannot be drawn with border-radius. */
function arcData(raw: FigmaNode): NodeFingerprint["arc"] {
  const value = record(raw.arcData); if (!Object.keys(value).length) return undefined;
  const start = number(value.startingAngle), end = number(value.endingAngle), inner = number(value.innerRadius);
  const fullSweep = Math.abs(Math.abs(end - start) - Math.PI * 2) < 0.001;
  return fullSweep && inner === 0 ? undefined : { start, end, inner };
}

function nodeLink(raw: FigmaNode): NodeFingerprint["link"] {
  for (const interaction of list(raw.interactions).map(record)) {
    if (string(record(interaction.trigger).type) !== "ON_CLICK") continue;
    for (const action of list(interaction.actions).map(record)) {
      if (string(action.type) === "URL" && string(action.url)) return { url: string(action.url) };
      if (string(action.type) === "BACK") return { navigation: "back" };
      if (string(action.type) === "CLOSE") return { navigation: "close" };
      if (string(action.type) !== "NODE" || !string(action.destinationId)) continue;
      const ms = Math.round(number(record(action.transition).duration) * 1000) || undefined;
      const navigation = string(action.navigation);
      if (["NAVIGATE", ""].includes(navigation)) return { nodeId: string(action.destinationId), navigation: "navigate", ms };
      if (navigation === "OVERLAY") {
        const position = record(action.overlayRelativePosition);
        return { nodeId: string(action.destinationId), navigation: "overlay", offset: action.overlayRelativePosition ? { x: Math.round(number(position.x) * 100) / 100, y: Math.round(number(position.y) * 100) / 100 } : undefined, ms };
      }
    }
  }
  return string(raw.transitionNodeID) ? { nodeId: string(raw.transitionNodeID) } : undefined;
}

function normalizeNode(raw: FigmaNode): NodeFingerprint {
  const nodeBounds = bounds(raw.absoluteBoundingBox); const rawType = string(raw.type); const type = (rawType || "UNKNOWN") as NodeType;
  const fills = paints(raw.fills); const strokePaints = paints(raw.strokes);
  const effects: EffectFingerprint[] = list(raw.effects).flatMap((effect) => { const value = record(effect); const effectType: Record<string, EffectFingerprint["type"]> = { DROP_SHADOW: "drop-shadow", INNER_SHADOW: "inner-shadow", LAYER_BLUR: "layer-blur", BACKGROUND_BLUR: "background-blur" }; const mapped = effectType[string(value.type)]; return mapped ? [{ type: mapped, visible: value.visible !== false, radius: optionalNumber(value.radius), offset: value.offset ? { x: number(record(value.offset).x), y: number(record(value.offset).y) } : undefined, spread: optionalNumber(value.spread), color: color(value.color) }] : []; });
  const radius = raw.rectangleCornerRadii ? list(raw.rectangleCornerRadii).map((entry) => number(entry)) : [number(raw.cornerRadius)];
  // Figma relativeTransform rows are [[m00, m01, tx], [m10, m11, ty]]; reorder into CSS matrix(a, b, c, d, tx, ty).
  const transformRows = list(raw.relativeTransform); const row0 = list(transformRows[0]); const row1 = list(transformRows[1]);
  const transform = transformRows.length === 2 && row0.length === 3 && row1.length === 3 ? { matrix: [number(row0[0]), number(row1[0]), number(row0[1]), number(row1[1]), number(row0[2]), number(row1[2])] as [number, number, number, number, number, number], rotation: optionalNumber(raw.rotation) } : optionalNumber(raw.rotation) !== undefined ? { rotation: optionalNumber(raw.rotation) } : undefined;
  const componentType: ComponentReference["type"] | undefined = rawType === "INSTANCE" ? "instance" : rawType === "COMPONENT" ? "component" : rawType === "COMPONENT_SET" ? "component-set" : undefined;
  const component: ComponentReference | undefined = componentType ? { type: componentType, componentId: string(raw.componentId) || undefined, componentKey: string(raw.componentKey) || undefined, name: string(raw.name), variant: Object.keys(record(raw.variantProperties)).length ? record(raw.variantProperties) as Record<string, string> : undefined, properties: Object.keys(record(raw.componentProperties)).length ? Object.fromEntries(Object.entries(record(raw.componentProperties)).flatMap(([key, value]) => { const item = record(value); const propertyValue = item.value; return ["string", "boolean", "number"].includes(typeof propertyValue) ? [[key, propertyValue as string | boolean | number]] : []; })) : undefined } : undefined;
  const fingerprint: NodeFingerprint = { id: string(raw.id), name: string(raw.name), type, visible: raw.visible !== false, locked: raw.locked === true || undefined, bounds: nodeBounds, transform, layout: layout(raw), typography: rawType === "TEXT" ? typography(raw.style) : undefined, fills: fills.length ? fills : undefined,
    strokes: strokePaints.length ? [{ paints: strokePaints, weight: number(raw.strokeWeight, 1), align: ({ INSIDE: "inside", OUTSIDE: "outside", CENTER: "center" } as Record<string, "inside" | "outside" | "center">)[string(raw.strokeAlign)] || "inside", join: ({ MITER: "miter", BEVEL: "bevel", ROUND: "round" } as Record<string, "miter" | "bevel" | "round">)[string(raw.strokeJoin)] || "miter", cap: ({ NONE: "none", ROUND: "round", SQUARE: "square", ARROW_LINES: "arrow", ARROW_EQUILATERAL: "arrow" } as Record<string, "none" | "round" | "square" | "arrow">)[string(raw.strokeCap)] || "none" }] : undefined,
    effects: effects.length ? effects : undefined, cornerRadius: radius.length === 4 ? { topLeft: radius[0], topRight: radius[1], bottomRight: radius[2], bottomLeft: radius[3] } : raw.cornerRadius !== undefined ? { topLeft: radius[0], topRight: radius[0], bottomRight: radius[0], bottomLeft: radius[0] } : undefined,
    opacity: optionalNumber(raw.opacity), content: rawType === "TEXT" ? { kind: "text", text: string(raw.characters), characters: string(raw.characters).length, segments: textSegments(raw) } : undefined, asset: nodeAsset(raw, nodeBounds), component,
    renderBounds: Object.keys(record(raw.absoluteRenderBounds)).length ? { x: number(record(raw.absoluteRenderBounds).x), y: number(record(raw.absoluteRenderBounds).y), width: number(record(raw.absoluteRenderBounds).width), height: number(record(raw.absoluteRenderBounds).height) } : undefined,
    size: Object.keys(record(raw.size)).length ? { width: number(record(raw.size).x), height: number(record(raw.size).y) } : undefined,
    clips: typeof raw.clipsContent === "boolean" ? raw.clipsContent : undefined,
    arc: arcData(raw), isMask: raw.isMask === true || undefined,
    blendMode: string(raw.blendMode) && !["PASS_THROUGH", "NORMAL"].includes(string(raw.blendMode)) ? string(raw.blendMode) : undefined,
    absolute: raw.layoutPositioning === "ABSOLUTE" || undefined,
    strokeWeights: Object.keys(record(raw.individualStrokeWeights)).length ? { top: number(record(raw.individualStrokeWeights).top), right: number(record(raw.individualStrokeWeights).right), bottom: number(record(raw.individualStrokeWeights).bottom), left: number(record(raw.individualStrokeWeights).left) } : undefined,
    strokeDashes: list(raw.strokeDashes).length ? list(raw.strokeDashes).map((entry) => number(entry)) : undefined,
    link: nodeLink(raw), children: list(raw.children).map(record).map(normalizeNode), constraints: constraints(raw.constraints), exportSettings: list(raw.exportSettings).flatMap((setting) => { const value = record(setting); const format = string(value.format).toLowerCase(); return ["png", "jpg", "svg", "pdf"].includes(format) ? [{ format: format as ExportSetting["format"], constraint: value.constraint ? { type: string(record(value.constraint).type), value: number(record(value.constraint).value) } : undefined }] : []; }), style: Object.keys(record(raw.styles)).length || Object.keys(record(raw.boundVariables)).length ? { fillStyleId: string(record(raw.styles).fill) || undefined, textStyleId: string(record(raw.styles).text) || undefined, effectStyleId: string(record(raw.styles).effect) || undefined, gridStyleId: string(record(raw.styles).grid) || undefined, boundVariables: Object.keys(record(raw.boundVariables)).length ? record(raw.boundVariables) : undefined } : undefined, hash: "" };
  fingerprint.hash = sha256({ ...fingerprint, hash: undefined, children: fingerprint.children?.map((child) => child.hash) }); return fingerprint;
}

function findById(node: NodeFingerprint, id: string): NodeFingerprint | undefined { if (node.id === id) return node; for (const child of node.children || []) { const found = findById(child, id); if (found) return found; } return undefined; }
function findRawById(node: FigmaNode, id: string): FigmaNode | undefined { if (string(node.id) === id) return node; for (const child of list(node.children).map(record)) { const found = findRawById(child, id); if (found) return found; } return undefined; }
function targetCandidate(page: PageFingerprint): NodeFingerprint | undefined { return page.children.find((node) => ["FRAME", "COMPONENT", "SECTION", "GROUP"].includes(node.type)) || page.children[0]; }
function viewportFor(target: NodeFingerprint): ViewportInfo { const width = target.bounds.width || 1440, height = target.bounds.height || 900; return { width, height, deviceScaleFactor: 1, mode: width <= 480 ? "mobile" : width <= 1024 ? "tablet" : "desktop" }; }

function styles(raw: FigmaFileResponse): StyleRegistry { const result: StyleRegistry = { fills: [], texts: [], effects: [], grids: [] }; for (const [id, item] of Object.entries(raw.styles || {})) { const value = record(item); const type = string(value.styleType); const style = { id, key: string(value.key) || undefined, name: string(value.name), type: type as "FILL" | "TEXT" | "EFFECT" | "GRID", description: string(value.description) || undefined, remote: value.remote === true }; if (type === "FILL") result.fills.push(style); if (type === "TEXT") result.texts.push(style); if (type === "EFFECT") result.effects.push(style); if (type === "GRID") result.grids.push(style); } return result; }
function components(raw: FigmaFileResponse): ComponentRegistry { return { components: Object.entries(raw.components || {}).map(([id, item]) => { const value = record(item); return { id, key: string(value.key) || undefined, name: string(value.name), description: string(value.description) || undefined, nodeId: string(value.node_id) || id, setId: string(record(value.containing_frame).nodeId) || undefined, thumbnailUrl: string(value.thumbnail_url) || undefined }; }), componentSets: Object.entries(raw.componentSets || {}).map(([id, item]) => { const value = record(item); return { id, key: string(value.key) || undefined, name: string(value.name), description: string(value.description) || undefined, nodeId: string(value.node_id) || id }; }) }; }

function statistics(pages: PageFingerprint[], assets: AssetReference[]): FingerprintStatistics { const nodes: NodeFingerprint[] = []; const visit = (node: NodeFingerprint) => { nodes.push(node); node.children?.forEach(visit); }; pages.forEach((page) => page.children.forEach(visit)); const colors = new Set(nodes.flatMap((node) => node.fills || []).map((fill) => fill.color?.hex).filter(Boolean)); const fonts = new Set(nodes.map((node) => node.typography?.fontFamily).filter(Boolean)); return { pages: pages.length, frames: nodes.filter((node) => node.type === "FRAME").length, nodes: nodes.length, textNodes: nodes.filter((node) => node.type === "TEXT").length, imageNodes: nodes.filter((node) => node.asset?.type === "image").length, vectorNodes: nodes.filter((node) => node.asset?.type === "vector").length, components: nodes.filter((node) => node.type === "COMPONENT").length, instances: nodes.filter((node) => node.type === "INSTANCE").length, uniqueColors: colors.size, uniqueFonts: fonts.size, assets: assets.length }; }

export interface NormalizeOptions { fileKey: string; selectedNodeId?: string; extractedAt?: string; }
export function normalizeFigmaFile(raw: FigmaFileResponse, options: NormalizeOptions): DesignFingerprintV1 {
  const root = record(raw.document); const rawPages = list(root.children).map(record); const pages: PageFingerprint[] = rawPages.map((page) => { const children = list(page.children).map(record).map(normalizeNode); const fingerprint: PageFingerprint = { id: string(page.id), name: string(page.name), children, bounds: bounds(page.absoluteBoundingBox), hash: "" }; fingerprint.hash = sha256({ ...fingerprint, hash: undefined, children: children.map((child) => child.hash) }); return fingerprint; });
  const normalizedRoots = pages.flatMap((page) => page.children);
  let target: NodeFingerprint | undefined;
  if (options.selectedNodeId) {
    target = normalizedRoots.map((rootNode) => findById(rootNode, options.selectedNodeId!)).find(Boolean);
    if (!target) {
      // A page/CANVAS id is legitimately absent from the node roots; resolve its first renderable child.
      // Anything else is a caller error and must fail loudly instead of extracting a different node.
      const selectedPage = pages.find((page) => page.id === options.selectedNodeId);
      if (!selectedPage) throw new Error(`Requested node ${options.selectedNodeId} was not found in the extracted Figma tree.`);
      target = targetCandidate(selectedPage);
      if (!target) throw new Error(`Figma page ${options.selectedNodeId} ("${selectedPage.name}") has no renderable child frame.`);
    }
  } else {
    target = pages.map(targetCandidate).find(Boolean);
  }
  if (!target) throw new Error("The Figma document has no renderable page/frame target.");
  const containingPage = pages.find((page) => page.children.some((child) => findById(child, target.id))); if (containingPage) containingPage.targetId = target.id;
  const assets = normalizedRoots.flatMap(function collect(node): AssetReference[] { return [...(node.asset ? [node.asset] : []), ...(node.children || []).flatMap(collect)]; }); const dedupedAssets = [...new Map(assets.map((asset) => [asset.id, asset])).values()];
  const viewport = viewportFor(target); const stylesRegistry = styles(raw); const componentRegistry = components(raw); const stats = statistics(pages, dedupedAssets); const variables: VariableRegistry = { collections: [], variables: [] };
  const hashes = { structure: sha256(pages.map((page) => ({ id: page.id, tree: page.children.map((child) => child.hash) }))), geometry: sha256(normalizedRoots.map(function geometry(node): unknown { return { id: node.id, bounds: node.bounds, transform: node.transform, children: node.children?.map(geometry) }; })), typography: sha256(normalizedRoots.map(function type(node): unknown { return { id: node.id, typography: node.typography, content: node.content?.text, children: node.children?.map(type) }; })), colors: sha256(normalizedRoots.map(function paints(node): unknown { return { id: node.id, fills: node.fills, strokes: node.strokes, effects: node.effects, children: node.children?.map(paints) }; })), assets: sha256(dedupedAssets), styles: sha256({ styles: stylesRegistry, variables }), overall: "" }; sealHashes(hashes);
  return { schema: "design-fingerprint", version: "1.0", source: { provider: "figma", fileKey: options.fileKey, fileName: string(raw.name, string(root.name, "Untitled Figma file")), sourceType: "rest", version: raw.version, lastModified: raw.lastModified, extractedAt: options.extractedAt || new Date().toISOString() }, document: { id: string(root.id), name: string(root.name), pageCount: pages.length, nodeCount: stats.nodes, rootNodeId: string(root.id) }, viewport, pages, assets: { items: dedupedAssets }, components: componentRegistry, styles: stylesRegistry, variables, targets: [{ id: `figma-target:${target.id}`, nodeId: target.id, type: target.type === "COMPONENT" ? "component" : target.type === "SECTION" ? "section" : target.type === "PAGE" ? "page" : "frame", viewport, format: "png", scale: 1, width: target.bounds.width, height: target.bounds.height }], statistics: stats, hashes };
}

export function targetRawNode(raw: FigmaFileResponse, nodeId: string): FigmaNode | undefined { return findRawById(record(raw.document), nodeId); }

/** Recomputes `overall` from the section hashes. Call after any section hash is refreshed post-normalization. */
export function sealHashes(hashes: FingerprintHashes): void { hashes.overall = ""; hashes.overall = sha256(hashes); }

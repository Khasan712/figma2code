import { sha256 } from "./hash.ts";
import type { DesignFingerprintV1, NodeFingerprint, PaintFingerprint } from "./types.ts";

/**
 * Distills a DesignFingerprintV1 into a compact, model-facing brief: token palette,
 * component candidates, and an indented layout tree. A multi-megabyte fingerprint stays
 * on disk as the source of truth; the digest is what a planning/generation agent reads.
 */
export interface DigestData {
  target: { nodeId: string; name: string; width: number; height: number; mode: string; scale: number; };
  tokens: {
    colors: { hex: string; count: number; roles: string[]; }[];
    textStyles: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeight?: string; count: number; sample?: string; }[];
    spacing: { value: number; count: number; }[];
    radii: { value: number; count: number; }[];
    shadows: { signature: string; count: number; }[];
  };
  componentCandidates: { kind: "instance-group" | "repeated-structure"; name: string; componentId?: string; count: number; size: string; nodeIds: string[]; }[];
  assets: { images: number; downloadedImages: number; vectors: number; };
  hiddenNodes: number;
}
export interface DigestResult { markdown: string; data: DigestData; }

const TYPE_SHORT: Record<string, string> = { RECTANGLE: "RECT", COMPONENT: "COMP", COMPONENT_SET: "COMP_SET", INSTANCE: "INST", BOOLEAN_OPERATION: "BOOL", ELLIPSE: "ELLIPSE" };
const round = (value: number): number => Math.round(value * 10) / 10;
const clip = (text: string, max: number): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

function findById(node: NodeFingerprint, id: string): NodeFingerprint | undefined { if (node.id === id) return node; for (const child of node.children || []) { const found = findById(child, id); if (found) return found; } return undefined; }
function topSolid(fills: PaintFingerprint[] | undefined): string | undefined { return fills ? [...fills].reverse().find((fill) => fill.type === "solid" && fill.color?.hex)?.color?.hex : undefined; }

interface Walked { node: NodeFingerprint; parent?: NodeFingerprint; }
function walk(root: NodeFingerprint): { nodes: Walked[]; hidden: number; } {
  const nodes: Walked[] = []; let hidden = 0;
  const visit = (node: NodeFingerprint, parent?: NodeFingerprint): void => {
    if (!node.visible) { hidden++; return; } // hidden layers are not part of the implementable design
    nodes.push({ node, parent }); node.children?.forEach((child) => visit(child, node));
  };
  visit(root); return { nodes, hidden };
}

function count<T>(entries: T[], key: (entry: T) => string | number | undefined): Map<string | number, { count: number; entries: T[]; }> {
  const map = new Map<string | number, { count: number; entries: T[]; }>();
  for (const entry of entries) { const k = key(entry); if (k === undefined || k === "" ) continue; const bucket = map.get(k) || { count: 0, entries: [] }; bucket.count++; bucket.entries.push(entry); map.set(k, bucket); }
  return map;
}

function collectTokens(nodes: Walked[]): DigestData["tokens"] {
  const colorRoles = new Map<string, { count: number; roles: Set<string>; }>();
  const addColor = (hex: string | undefined, role: string) => { if (!hex) return; const bucket = colorRoles.get(hex) || { count: 0, roles: new Set<string>() }; bucket.count++; bucket.roles.add(role); colorRoles.set(hex, bucket); };
  const textStyles = new Map<string, { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeight?: string; count: number; sample?: string; }>();
  const spacing = new Map<number, number>(); const radii = new Map<number, number>(); const shadows = new Map<string, number>();
  const bumpNumber = (map: Map<number, number>, value: number | undefined) => { if (value === undefined || value <= 0) return; map.set(value, (map.get(value) || 0) + 1); };
  for (const { node } of nodes) {
    for (const fill of node.fills || []) if (fill.type === "solid") addColor(fill.color?.hex, node.type === "TEXT" ? "text" : "bg");
    for (const stroke of node.strokes || []) for (const paint of stroke.paints) if (paint.type === "solid") addColor(paint.color?.hex, "stroke");
    if (node.type === "TEXT" && node.typography) {
      const typography = node.typography;
      const lineHeight = typography.lineHeight ? typography.lineHeight.unit === "auto" ? "auto" : `${round(typography.lineHeight.value || 0)}${typography.lineHeight.unit === "px" ? "px" : "%"}` : undefined;
      const key = [typography.fontFamily, typography.fontSize, typography.fontWeight, lineHeight].join("|");
      const bucket = textStyles.get(key) || { fontFamily: typography.fontFamily, fontSize: typography.fontSize, fontWeight: typography.fontWeight, lineHeight, count: 0, sample: node.content?.text ? clip(node.content.text, 28) : undefined };
      bucket.count++; textStyles.set(key, bucket);
    }
    if (node.layout) { bumpNumber(spacing, node.layout.itemSpacing); for (const value of Object.values(node.layout.padding || {})) bumpNumber(spacing, value); }
    if (node.cornerRadius) for (const value of new Set(Object.values(node.cornerRadius))) bumpNumber(radii, value);
    for (const effect of node.effects || []) if (effect.visible && (effect.type === "drop-shadow" || effect.type === "inner-shadow")) { const signature = `${effect.type} ${effect.offset?.x ?? 0},${effect.offset?.y ?? 0} blur=${effect.radius ?? 0}${effect.spread ? ` spread=${effect.spread}` : ""} ${effect.color?.hex ?? ""}`.trim(); shadows.set(signature, (shadows.get(signature) || 0) + 1); }
  }
  const byCount = <T extends { count: number; }>(items: T[]): T[] => items.sort((a, b) => b.count - a.count);
  return {
    colors: byCount([...colorRoles.entries()].map(([hex, entry]) => ({ hex, count: entry.count, roles: [...entry.roles].sort() }))).slice(0, 32),
    textStyles: byCount([...textStyles.values()]).slice(0, 20),
    spacing: byCount([...spacing.entries()].map(([value, cnt]) => ({ value, count: cnt }))).slice(0, 16),
    radii: byCount([...radii.entries()].map(([value, cnt]) => ({ value, count: cnt }))).slice(0, 12),
    shadows: byCount([...shadows.entries()].map(([signature, cnt]) => ({ signature, count: cnt }))).slice(0, 8),
  };
}

/** Structure hash: node type + layout mode + child shapes. Ignores ids, text, and geometry so repeated cards collapse into one shape. */
function shapeOf(node: NodeFingerprint, shapes: Map<string, string>, sizes: Map<string, number>): { hash: string; size: number; } {
  const children = (node.children || []).filter((child) => child.visible).map((child) => shapeOf(child, shapes, sizes));
  const hash = sha256({ t: node.type, l: node.layout?.mode, c: children.map((child) => child.hash) });
  const size = 1 + children.reduce((total, child) => total + child.size, 0);
  shapes.set(node.id, hash); sizes.set(node.id, size);
  return { hash, size };
}

function componentCandidates(root: NodeFingerprint, nodes: Walked[], fingerprint: DesignFingerprintV1): DigestData["componentCandidates"] {
  const candidates: DigestData["componentCandidates"] = [];
  const dimensions = (node: NodeFingerprint) => `${Math.round(node.bounds.width)}×${Math.round(node.bounds.height)}`;
  // 1. Instances grouped by their master component — the design system already answered "what is a component" here.
  const instances = nodes.filter(({ node }) => node.component?.type === "instance");
  const registryNames = new Map(fingerprint.components.components.map((component) => [component.id, component.name]));
  for (const [componentId, group] of count(instances, ({ node }) => node.component?.componentId)) {
    if (group.count < 2) continue;
    const sample = group.entries[0].node;
    candidates.push({ kind: "instance-group", name: registryNames.get(String(componentId)) || sample.component?.name || sample.name, componentId: String(componentId), count: group.count, size: dimensions(sample), nodeIds: group.entries.slice(0, 10).map(({ node }) => node.id) });
  }
  // 2. Repeated identical structures that are not instances — hand-copied cards, rows, list items.
  const shapes = new Map<string, string>(); const sizes = new Map<string, number>();
  shapeOf(root, shapes, sizes);
  const containers = nodes.filter(({ node }) => ["FRAME", "GROUP"].includes(node.type) && !node.component && (sizes.get(node.id) || 0) >= 3);
  const groups = [...count(containers, ({ node }) => shapes.get(node.id)).values()].filter((group) => group.count >= 2)
    .sort((a, b) => (sizes.get(b.entries[0].node.id) || 0) * b.count - (sizes.get(a.entries[0].node.id) || 0) * a.count);
  const covered = new Set<string>();
  for (const group of groups) {
    if (group.entries.some(({ node }) => covered.has(node.id))) continue; // nested repetition inside an already-reported candidate
    const sample = group.entries[0].node;
    const names = count(group.entries, ({ node }) => node.name);
    const name = [...names.entries()].sort((a, b) => b[1].count - a[1].count)[0]?.[0];
    candidates.push({ kind: "repeated-structure", name: String(name || sample.name), count: group.count, size: dimensions(sample), nodeIds: group.entries.slice(0, 10).map(({ node }) => node.id) });
    for (const { node } of group.entries) { const visit = (entry: NodeFingerprint): void => { covered.add(entry.id); entry.children?.forEach(visit); }; visit(node); }
    if (candidates.length >= 12) break;
  }
  return candidates.slice(0, 12);
}

/** One tree line per node, id-first — the digest doubles as the implementation spec (data-fig ids, exact values). */
function describe(node: NodeFingerprint, parent: NodeFingerprint | undefined, files: Map<string | undefined, string>): string {
  const type = TYPE_SHORT[node.type] || node.type;
  const position = parent && (!parent.layout || parent.layout.mode === "none") ? ` @${round(node.bounds.x - parent.bounds.x)},${round(node.bounds.y - parent.bounds.y)}` : "";
  const parts: string[] = [`${node.id} ${node.name || "(unnamed)"} [${type} ${round(node.bounds.width)}×${round(node.bounds.height)}${position}]`];
  if (node.layout && node.layout.mode !== "none") {
    const padding = node.layout.padding || { top: 0, right: 0, bottom: 0, left: 0 };
    const pad = padding.top === padding.bottom && padding.left === padding.right ? padding.top === padding.left ? `${padding.top}` : `${padding.top}/${padding.left}` : `${padding.top},${padding.right},${padding.bottom},${padding.left}`;
    parts.push(`${node.layout.mode === "vertical" ? "col" : node.layout.mode === "horizontal" ? "row" : node.layout.mode}${node.layout.itemSpacing ? ` gap=${node.layout.itemSpacing}` : ""}${pad !== "0" ? ` pad=${pad}` : ""}`);
  }
  if (node.layout?.overflow === "hidden") parts.push("clip");
  const withOpacity = (paint: PaintFingerprint | undefined): string | undefined => paint?.color?.hex ? `${paint.color.hex}${paint.opacity !== undefined && paint.opacity < 1 ? `@${round(paint.opacity)}` : ""}` : undefined;
  const background = withOpacity(node.fills ? [...node.fills].reverse().find((fill) => fill.type === "solid" && fill.color?.hex) : undefined);
  const imageFill = node.fills?.find((fill) => fill.type === "image");
  const gradient = node.fills?.find((fill) => fill.gradient);
  if (node.type === "TEXT") {
    const typography = node.typography;
    const text = (node.content?.text || "").replace(/\n/g, "\\n");
    parts.push(`"${clip(text, 60)}"${typography?.fontFamily ? ` ${typography.fontFamily}` : ""}${typography?.fontSize ? ` ${typography.fontSize}/${typography.fontWeight ?? "?"}` : ""} lh=${round(typography?.lineHeight?.value ?? 0)}${typography?.textCase === "uppercase" ? " CAPS" : ""}${typography?.textAlignHorizontal && typography.textAlignHorizontal !== "left" ? ` ${typography.textAlignHorizontal}` : ""}${background ? ` ${background}` : ""}`);
  } else {
    if (background) parts.push(`bg=${background}`);
    if (imageFill?.imageRef) parts.push(files.get(imageFill.imageRef) ? `img=${files.get(imageFill.imageRef)}` : `img:${imageFill.imageRef.slice(0, 8)}`);
    if (gradient) parts.push(`grad(${gradient.gradient?.stops.map((stop) => `${stop.color.hex}@${round(stop.position)}`).join("→")})`);
  }
  if (node.strokes?.length) parts.push(`stroke=${withOpacity(node.strokes[0].paints[0]) ?? "?"}/${round(node.strokes[0].weight)}`);
  if (node.cornerRadius) { const values = [...new Set(Object.values(node.cornerRadius))]; if (values.some((value) => value > 0)) parts.push(`r=${values.length === 1 ? values[0] : Object.values(node.cornerRadius).join("/")}`); }
  for (const effect of node.effects || []) if (effect.visible) parts.push(`fx=${effect.type}(${effect.radius ?? 0})`);
  if (node.transform?.rotation && Math.abs(node.transform.rotation) > 0.001) {
    const matrix = node.transform.matrix;
    const mirror = matrix && matrix[0] === -1 && matrix[3] === 1 ? " mirrorX" : matrix && matrix[0] === 1 && matrix[3] === -1 ? " mirrorY" : "";
    parts.push(`rot=${round(node.transform.rotation * 180 / Math.PI)}°${mirror}`);
  }
  if (node.component?.type === "instance") parts.push(`inst=${node.component.name || node.component.componentId}`);
  if (node.asset?.type === "vector") parts.push("vector");
  if (node.opacity !== undefined && node.opacity < 1) parts.push(`op=${round(node.opacity)}`);
  return parts.join(" ");
}

function renderTree(root: NodeFingerprint, files: Map<string | undefined, string>, maxDepth = 12, maxChildren = 40, maxLines = 2000, flattenOver = 40): string {
  const lines: string[] = [];
  const count = (node: NodeFingerprint): number => 1 + (node.children || []).filter((child) => child.visible).reduce((total, child) => total + count(child), 0);
  const visit = (node: NodeFingerprint, parent: NodeFingerprint | undefined, depth: number): void => {
    if (lines.length >= maxLines) return;
    lines.push(`${"  ".repeat(depth)}- ${describe(node, parent, files)}`);
    // Deep decorative subtrees (vector mockups etc.) collapse to one line — genpage flattens them
    // to a single Figma render/crop anyway, so their internals are never implemented node-by-node.
    const size = count(node);
    if (depth > 0 && size > flattenOver) { lines.push(`${"  ".repeat(depth + 1)}- … ${size - 1} inner nodes collapsed (flatten candidate: render/crop this node as one image)`); return; }
    if (depth >= maxDepth) { if (node.children?.some((child) => child.visible)) lines.push(`${"  ".repeat(depth + 1)}- … depth limit (${node.children.length} children omitted)`); return; }
    const visible = (node.children || []).filter((child) => child.visible);
    visible.slice(0, maxChildren).forEach((child) => visit(child, node, depth + 1));
    if (visible.length > maxChildren) lines.push(`${"  ".repeat(depth + 1)}- … +${visible.length - maxChildren} more siblings`);
  };
  visit(root, undefined, 0);
  if (lines.length >= maxLines) lines.push("- … tree truncated (raw fingerprint.json has the full tree)");
  return lines.join("\n");
}

export function digestFingerprint(fingerprint: DesignFingerprintV1): DigestResult {
  const target = fingerprint.targets[0];
  const root = fingerprint.pages.map((page) => page.children.map((child) => findById(child, target.nodeId)).find(Boolean)).find(Boolean);
  if (!root) throw new Error(`Digest: target node ${target.nodeId} is missing from the fingerprint pages.`);
  const { nodes, hidden } = walk(root);
  const tokens = collectTokens(nodes);
  const candidates = componentCandidates(root, nodes, fingerprint);
  const images = fingerprint.assets.items.filter((asset) => asset.type === "image");
  const data: DigestData = {
    target: { nodeId: target.nodeId, name: root.name, width: Math.round(target.width), height: Math.round(target.height), mode: target.viewport.mode, scale: target.scale },
    tokens, componentCandidates: candidates,
    assets: { images: images.length, downloadedImages: images.filter((asset) => asset.localPath).length, vectors: fingerprint.assets.items.filter((asset) => asset.type === "vector").length },
    hiddenNodes: hidden,
  };
  const files = new Map(fingerprint.assets.items.filter((item) => item.localPath).map((item) => [item.imageRef, item.localPath!.split("/").pop()!]));
  const markdown = [
    `# Design digest v1.1: ${root.name} (${target.nodeId})`,
    ``,
    `Source: Figma file \`${fingerprint.source.fileKey}\`${fingerprint.source.fileName ? ` — ${fingerprint.source.fileName}` : ""}, extracted ${fingerprint.source.extractedAt}.`,
    `Target: ${data.target.width}×${data.target.height} (${data.target.mode}), rendered to target.png at scale ${target.scale}. ${nodes.length} visible nodes${hidden ? `, ${hidden} hidden nodes skipped` : ""}.`,
    ``,
    `Values below are exact — use them verbatim, never estimate from the screenshot.`,
    `Tree lines start with the node id (= the data-fig attribute). \\n inside quotes is a literal newline in the design text.`,
    ``,
    `## Colors`,
    ``,
    `| hex | uses | roles |`,
    `| --- | ---: | --- |`,
    ...tokens.colors.map((color) => `| \`${color.hex}\` | ${color.count} | ${color.roles.join(", ")} |`),
    ``,
    `## Text styles`,
    ``,
    `| font | size/weight | line-height | uses | sample |`,
    `| --- | --- | --- | ---: | --- |`,
    ...tokens.textStyles.map((style) => `| ${style.fontFamily || "?"} | ${style.fontSize ?? "?"}/${style.fontWeight ?? "?"} | ${style.lineHeight || "—"} | ${style.count} | ${style.sample || ""} |`),
    ``,
    `## Spacing scale`,
    ``,
    tokens.spacing.length ? tokens.spacing.map((entry) => `${entry.value} (×${entry.count})`).join(", ") : "(no auto-layout spacing found)",
    ``,
    `## Corner radii`,
    ``,
    tokens.radii.length ? tokens.radii.map((entry) => `${entry.value} (×${entry.count})`).join(", ") : "(none)",
    ``,
    ...(tokens.shadows.length ? [`## Shadows`, ``, ...tokens.shadows.map((shadow) => `- ${shadow.signature} (×${shadow.count})`), ``] : []),
    `## Component candidates`,
    ``,
    candidates.length ? `Implement each candidate ONCE as a reusable component and render every occurrence through it — do not restyle occurrences individually.` : `(no repeated structures detected)`,
    ``,
    ...candidates.map((candidate, index) => `${index + 1}. **${candidate.name}** — ${candidate.count}× ${candidate.kind === "instance-group" ? `instance of \`${candidate.componentId}\`` : "repeated structure"} (${candidate.size}). Nodes: ${candidate.nodeIds.map((id) => `\`${id}\``).join(", ")}`),
    ``,
    `## Assets`,
    ``,
    `${data.assets.downloadedImages}/${data.assets.images} image fills downloaded to \`assets/images/\` (localPath per item in fingerprint assets.items); ${data.assets.vectors} vector nodes retained as metadata (SVG export deferred in v1).`,
    ``,
    `## Layout tree`,
    ``,
    `Format: id name [TYPE w×h @x,y] layout gap/pad clip | "text" family size/weight lh CAPS align color | bg/img/grad/stroke | r=radius fx=effect rot/mirror. Coordinates are relative to the parent and only shown when the parent has no auto-layout. bg=#HEX@0.5 means paint opacity 0.5.`,
    ``,
    "```",
    renderTree(root, files),
    "```",
    ``,
  ].join("\n");
  return { markdown, data };
}

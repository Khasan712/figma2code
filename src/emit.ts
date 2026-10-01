import type { CssProps, IRResult, RNode, TextRun } from "./ir.ts";

/** Serializers for the render IR. No visual decisions live here — only syntax. */
const UNITLESS = new Set(["opacity", "fontWeight", "zIndex", "flex", "flexGrow", "flexShrink", "order"]);
const kebab = (key: string): string => key.startsWith("--") ? key : key.replace(/^Webkit/, "-webkit").replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
const cssValue = (key: string, value: string | number): string => typeof value === "number" && !UNITLESS.has(key) ? `${value}px` : String(value);
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, "&quot;");

export interface EmitOptions { /** URL for a copied image-fill or flat asset file. */ assetUrl: (file: string) => string; }
const resolveAssets = (value: string | number, options: EmitOptions): string | number => typeof value === "string" ? value.replace(/\{\{asset:([^}]+)\}\}/g, (_, file: string) => options.assetUrl(file)) : value;

function box(node: RNode): CssProps { return node.kind === "root" ? { width: node.w, height: node.h } : { position: "absolute", left: node.x, top: node.y, width: node.w, height: node.h }; }

// ───────────────────────────── HTML ─────────────────────────────

function cssText(style: CssProps, options: EmitOptions): string {
  return Object.entries(style).map(([key, value]) => `${kebab(key)}:${cssValue(key, resolveAssets(value, options))}`).join(";");
}
function runsHtml(runs: TextRun[], options: EmitOptions): string {
  return runs.map((run) => run.style ? `<span style="${escapeAttr(cssText(run.style, options))}">${escapeHtml(run.text)}</span>` : escapeHtml(run.text)).join("");
}
function nodeHtml(node: RNode, options: EmitOptions, depth: number, rootStyle: CssProps = {}): string {
  if (node.kind === "switch") return nodeHtml(node.cases![node.state!.initial ? 1 : 0], options, depth);
  const pad = "  ".repeat(depth);
  const attrs = `data-fig="${escapeAttr(node.id)}"${node.flat ? " data-fig-flat" : ""}${node.kind === "root" ? ' class="page"' : ""}`;
  const style = (extra: CssProps = {}) => escapeAttr(cssText({ ...box(node), ...node.style, ...(node.kind === "root" ? rootStyle : {}), ...extra }, options));
  if (node.kind === "text") {
    const content = runsHtml(node.runs || [], options);
    const inner = node.innerStyle ? `<div style="${escapeAttr(cssText(node.innerStyle, options))}">${content}</div>` : content;
    return `${pad}<div ${attrs} style="${style()}">${inner}</div>`;
  }
  if (node.kind === "img" || node.kind === "flat") {
    const src = escapeAttr(options.assetUrl(node.src!));
    if (!node.imgStyle) return `${pad}<img ${attrs} src="${src}" alt="" loading="lazy" decoding="async" style="${style()}">`;
    const wash = node.overlay ? `<div style="${escapeAttr(cssText(node.overlay, options))}"></div>` : "";
    return `${pad}<div ${attrs} style="${style()}"><img src="${src}" alt="" loading="lazy" decoding="async" style="${escapeAttr(cssText(node.imgStyle, options))}">${wash}</div>`;
  }
  const tag = node.link ? "a" : "div"; const href = node.link ? ` href="${escapeAttr(node.link)}"` : "";
  const linkStyle: CssProps = node.link ? { display: "block", color: "inherit", textDecoration: "none" } : {};
  const children = node.children.map((child) => nodeHtml(child, options, depth + 1));
  if (node.overlay) children.push(`${pad}  <div style="${escapeAttr(cssText(node.overlay, options))}"></div>`);
  if (!children.length) return `${pad}<${tag} ${attrs}${href} style="${style(linkStyle)}"></${tag}>`;
  return `${pad}<${tag} ${attrs}${href} style="${style(linkStyle)}">\n${children.join("\n")}\n${pad}</${tag}>`;
}

/** A self-contained static page: opens from file://, needs no dev server — used by the bench and as a stack-neutral output. */
export function emitHtml(ir: IRResult, options: EmitOptions & { title?: string; headHtml?: string; }): string {
  const { fluid, width, minWidth } = ir.fit; const page = ir.kind === "page";
  const rootStyle: CssProps = !page ? {} : fluid ? { width: "100%", minWidth, margin: "0 auto" } : { margin: "0 auto" };
  // Same rule as the React runtime's Page: below the narrowest width it fits, the page is scaled as a whole.
  const fitScript = `<script>(function(){var page=document.querySelector('[data-fig="${ir.root.id.replace(/["'\\<>]/g, "")}"]'),base=${fluid ? minWidth : width},fluid=${fluid};function fit(){var z=Math.min(1,document.documentElement.clientWidth/base),s=z<0.999;page.style.zoom=s?String(z):"";page.style.width=s||!fluid?base+"px":"100%";page.style.minWidth=!s&&fluid?base+"px":"";}fit();addEventListener("resize",fit);})();</script>`;
  return [
    `<!doctype html>`, `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title ?? ir.root.name)}</title>`,
    `<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{margin:0}img{display:block}</style>`,
    options.headHtml ?? "", `</head><body>`,
    nodeHtml(ir.root, options, 0, rootStyle),
    ...(page ? [fitScript] : []),
    `</body></html>`, ``,
  ].join("\n");
}

// ───────────────────────────── React (lib primitives) ─────────────────────────────

const num = (value: number): string => String(Math.round(value * 100) / 100);
const jsValue = (value: string | number): string => typeof value === "number" ? num(value) : JSON.stringify(value);
function styleObject(style: CssProps, options: EmitOptions): string {
  const entries = Object.entries(style).map(([key, value]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${jsValue(resolveAssets(value, options))}`);
  return `{{ ${entries.join(", ")} }}`;
}
const isPlainColor = (value: unknown): value is string => typeof value === "string" && /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/.test(value);
const geometry = (node: RNode): string => `x={${num(node.x)}} y={${num(node.y)}} w={${num(node.w)}} h={${num(node.h)}}`;

function runsJsx(runs: TextRun[], options: EmitOptions): string {
  return runs.map((run) => run.style ? `<span style=${styleObject(run.style, options)}>{${JSON.stringify(run.text)}}</span>` : `{${JSON.stringify(run.text)}}`).join("");
}

interface JsxContext { openers: Set<string>; overlay: boolean; }
function nodeJsx(node: RNode, options: EmitOptions, depth: number, used: Set<string>, context: JsxContext): string {
  const pad = "  ".repeat(depth);
  if (node.kind === "switch") {
    // One piece of state, two renderings — the design drew both.
    const { key, kind } = node.state!; const quoted = JSON.stringify(key); used.add(kind === "toggle" ? "state:press" : "state:count");
    const condition = kind === "toggle" ? `pressed[${quoted}]` : `(counts[${quoted}] ?? 0) > 0`;
    return `${pad}{${condition} ? (\n${nodeJsx(node.cases![1], options, depth + 1, used, context)}\n${pad}) : (\n${nodeJsx(node.cases![0], options, depth + 1, used, context)}\n${pad})}`;
  }
  const id = `id=${JSON.stringify(node.id)}`;
  // What a click does: a prototype overlay trigger toggles the page's open overlay; inferred states flip or count.
  const { act } = node;
  const acts = act?.press ? ` on={() => press(${JSON.stringify(act.press)})} pressed${act.on ? "" : "={false}"}`
    : act?.count ? ` on={() => count(${JSON.stringify(act.count)}, ${act.delta ?? 1})}`
    : act?.close && context.overlay ? ` on={close}`
    : act?.back ? ` on={() => window.history.back()}`
    : node.opens && context.openers.has(node.opens.target) ? ` on={() => toggle(${JSON.stringify(node.opens.target)})} expanded={open === ${JSON.stringify(node.opens.target)}}` : "";
  const opens = `${acts}${acts && act?.label ? ` label=${JSON.stringify(act.label)}` : ""}`;
  const rest: CssProps = { ...node.style };
  const take = (key: string): string | number | undefined => { const value = rest[key]; delete rest[key]; return value; };
  if (node.hint === "button" && !acts && !node.link) rest.cursor = "pointer";
  const styleProp = (): string => Object.keys(rest).length ? ` style=${styleObject(rest, options)}` : "";
  const to = node.link?.startsWith("/") ? ` to=${JSON.stringify(node.link)}` : "";

  if (node.kind === "text") {
    used.add("Txt");
    const props: string[] = [id, geometry(node)];
    const family = take("fontFamily"); if (typeof family === "string") props.push(`font=${JSON.stringify(family.replace(/^"([^"]+)".*$/, "$1"))}`);
    const size = take("fontSize"); if (size !== undefined) props.push(`size={${jsValue(size)}}`);
    const weight = take("fontWeight"); if (weight !== undefined) props.push(`weight={${jsValue(weight)}}`);
    const lineHeight = take("lineHeight"); if (typeof lineHeight === "string" && lineHeight.endsWith("px")) props.push(`lh={${num(parseFloat(lineHeight))}}`); else if (lineHeight !== undefined) rest.lineHeight = lineHeight;
    const color = take("color"); if (color !== undefined) props.push(`color=${JSON.stringify(color)}`);
    if (rest.textTransform === "uppercase") { delete rest.textTransform; props.push("caps"); }
    if (rest.whiteSpace === "pre") { delete rest.whiteSpace; props.push("nowrap"); } else if (rest.whiteSpace === "pre-wrap") { delete rest.whiteSpace; props.push("wrap"); }
    if (node.innerStyle) {
      // The runtime's Txt builds the flex column + inner block itself from these props.
      if (rest.alignItems === "center") props.push("center"); else if (rest.alignItems === "flex-end") props.push("right");
      if (rest.justifyContent === "center") props.push('valign="center"'); else if (rest.justifyContent === "flex-end") props.push('valign="bottom"');
      for (const key of ["display", "flexDirection", "justifyContent", "alignItems"]) delete rest[key];
    }
    if (rest.textAlign === "center") { delete rest.textAlign; if (!props.includes("center")) props.push("center"); } else if (rest.textAlign === "right") { delete rest.textAlign; if (!props.includes("right")) props.push("right"); }
    const content = node.countOf ? `{String(counts[${JSON.stringify(node.countOf)}] ?? 0)}` : runsJsx(node.runs || [], options);
    return `${pad}<Txt ${props.join(" ")}${to}${opens}${styleProp()}>${content}</Txt>`;
  }

  if (node.kind === "img" || node.kind === "flat") {
    used.add("asset");
    const radius = take("borderRadius"); const flat = node.flat ? " flat" : "";
    const radiusProp = radius === undefined ? "" : ` r=${typeof radius === "number" ? `{${num(radius)}}` : JSON.stringify(radius)}`;
    if (!node.imgStyle) {
      used.add("Pic");
      const fit = take("objectFit"); const contain = node.kind === "flat" || fit === "contain" ? " contain" : "";
      return `${pad}<Pic ${id}${flat} src={asset(${JSON.stringify(node.src)})} ${geometry(node)}${radiusProp}${contain}${opens}${styleProp()} />`;
    }
    used.add("Box"); delete rest.overflow;
    const clip = node.kind === "img" ? " clip" : "";
    const wash = node.overlay ? `<div style=${styleObject(node.overlay, options)} />` : "";
    return `${pad}<Box ${id}${flat} ${geometry(node)}${radiusProp}${clip}${opens}${styleProp()}><img src={asset(${JSON.stringify(node.src)})} alt="" loading="lazy" decoding="async" style=${styleObject(node.imgStyle, options)} />${wash}</Box>`;
  }

  used.add("Box");
  const props: string[] = [id, geometry(node)];
  if (isPlainColor(rest.background)) props.push(`bg=${JSON.stringify(take("background"))}`);
  const radius = take("borderRadius"); if (radius !== undefined) props.push(`r=${typeof radius === "number" ? `{${num(radius)}}` : JSON.stringify(radius)}`);
  if (rest.overflow === "hidden") { delete rest.overflow; props.push("clip"); }
  const children = node.children.map((child) => nodeJsx(child, options, depth + 1, used, context));
  if (node.overlay) children.push(`${pad}  <div style=${styleObject(node.overlay, options)} />`);
  const tag = `${pad}<Box ${props.join(" ")}${to}${opens}${styleProp()}`;
  return children.length ? `${tag}>\n${children.join("\n")}\n${pad}</Box>` : `${tag} />`;
}

export interface ReactEmitOptions extends EmitOptions { component: string; libPath?: string; source?: string; }
export function emitReact(ir: IRResult, options: ReactEmitOptions): string {
  const used = new Set<string>();
  // An overlay's own copy of the trigger that opens it (a menu button drawn in its active state) closes it instead.
  const popups = ir.popups.filter((popup, index) => popup.component && popup.component !== options.component && ir.popups.findIndex((other) => other.trigger === popup.trigger) === index);
  const context: JsxContext = { openers: new Set(popups.map((popup) => popup.target)), overlay: ir.kind === "overlay" };
  const children = ir.root.children.map((child) => nodeJsx(child, options, 3, used, context));
  // Initial state is what the design shows: the example drawn liked starts liked, the one drawn with "1" starts at 1.
  const pressedAtStart: Record<string, boolean> = {}, countsAtStart: Record<string, number> = {}; let closes = false;
  const scan = (node: RNode): void => {
    if (node.state?.kind === "toggle" && node.state.initial) pressedAtStart[node.state.key] = true;
    if (node.state?.kind === "counter" && node.state.initial) countsAtStart[node.state.key] = node.state.initial;
    if (node.act?.close) closes = true;
    node.cases?.forEach(scan); node.children.forEach(scan);
  };
  scan(ir.root);
  const presses = used.has("state:press"), counting = used.has("state:count");
  const page = ir.kind === "page"; if (page) used.add("Page"); if (popups.length) used.add("Popup");
  const { position: _position, overflow: _overflow, ...pageStyle } = ir.root.style;
  const pageStyleProp = Object.keys(pageStyle).length ? ` style=${styleObject(pageStyle, options)}` : "";
  const components = [...new Set(popups.map((popup) => popup.component!))];
  const imports = ["Box", "Page", "Popup", "Txt", "Pic", "asset"].filter((name) => used.has(name));
  const { fluid, width, minWidth } = ir.fit;
  return [
    ...(popups.length || presses || counting ? [`import { useState } from "react";`] : []),
    `import { ${imports.join(", ")} } from ${JSON.stringify(options.libPath ?? "../lib")};`,
    ...components.map((component) => `import ${component} from ${JSON.stringify(`./${component}`)};`),
    ``,
    `// GENERATED by figma2code from ${options.source ?? `node ${ir.root.id}`} (${num(ir.root.w)}×${num(ir.root.h)}) — do not hand-transcribe; re-run the generator.`,
    `// Values are verbatim design data; every element carries its Figma node id as data-fig for verification.`,
    ...(ir.notes.length ? [`// Generator notes:`, ...ir.notes.slice(0, 12).map((note) => `//  - ${note}`)] : []),
    page ? `export default function ${options.component}() {` : closes ? `export default function ${options.component}({ close }: { close?: () => void }) {` : `export default function ${options.component}(_props: { close?: () => void }) {`,
    ...(presses ? [
      `  const [pressed, setPressed] = useState<Record<string, boolean>>(${JSON.stringify(pressedAtStart)});`,
      `  const press = (key: string) => setPressed((all) => ({ ...all, [key]: !all[key] }));`,
    ] : []),
    ...(counting ? [
      `  const [counts, setCounts] = useState<Record<string, number>>(${JSON.stringify(countsAtStart)});`,
      `  const count = (key: string, delta: number) => setCounts((all) => ({ ...all, [key]: Math.max(0, (all[key] ?? 0) + delta) }));`,
    ] : []),
    ...(popups.length ? [
      `  const [open, setOpen] = useState<string | null>(null);`,
      `  const toggle = (target: string) => setOpen((current) => (current === target ? null : target));`,
    ] : []),
    `  return (`,
    page
      ? `    <Page id=${JSON.stringify(ir.root.id)} w={${num(width)}} h={${num(ir.root.h)}} minW={${num(minWidth)}}${fluid ? " fluid" : ""}${pageStyleProp}>`
      : `    <div data-fig=${JSON.stringify(ir.root.id)} style=${styleObject({ width: ir.root.w, height: ir.root.h, ...ir.root.style }, options)}>`,
    ...children,
    ...(ir.root.overlay ? [`      <div style=${styleObject(ir.root.overlay, options)} />`] : []),
    ...popups.map((popup) => `      <Popup open={open === ${JSON.stringify(popup.target)}} trigger=${JSON.stringify(popup.trigger)} dx={${num(popup.dx)}} dy={${num(popup.dy)}}${popup.ms ? ` ms={${popup.ms}}` : ""} label=${JSON.stringify(popup.label)} onClose={() => setOpen(null)}><${popup.component} close={() => setOpen(null)} /></Popup>`),
    page ? `    </Page>` : `    </div>`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

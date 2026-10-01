import { loadLocalEnv } from "./env.ts";
import { loadWholeFile } from "./extractor.ts";
import { FigmaRestClient, parseFigmaReference } from "./figma.ts";
import type { FigmaNode } from "./types.ts";

/**
 * What can be built from a Figma link that names no frame: every top-level frame with its size and a ready
 * `--page` line for build-page. One Tier-1 request reads the whole file; build-page then takes its node trees
 * from that same read, so listing first costs nothing extra.
 */
function usage(message?: string): never { if (message) console.error(`Error: ${message}\n`); console.error("Usage: npm run frames -- --figma-url URL [--refresh]"); process.exit(1); }
const args = process.argv.slice(2);
const url = args[args.indexOf("--figma-url") + 1]; if (!args.includes("--figma-url") || !url) usage("--figma-url is required");
await loadLocalEnv();
const { fileKey } = parseFigmaReference(url);
const token = process.env.FIGMA_ACCESS_TOKEN;
const cached = args.includes("--refresh") ? undefined : await loadWholeFile({ fileKey, cacheOnly: true });
if (!cached && !token) usage("FIGMA_ACCESS_TOKEN is not set");
const file = cached ?? await loadWholeFile({ fileKey, client: new FigmaRestClient(token!), refresh: true });
const { body, fetchedAt } = file!;

const FRAMES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"]);
const box = (node: FigmaNode): { width: number; height: number; } => (node.absoluteBoundingBox as { width: number; height: number; } | undefined) ?? { width: 0, height: 0 };
const kind = (width: number): string => width >= 1024 ? "desktop" : width >= 600 ? "tablet" : "mobile";
const taken = new Set<string>();
function pascal(name: string, id: string): string {
  const words = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let result = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  if (!/^[A-Z]/.test(result)) result = `Frame${id.replace(/\D+/g, "x")}${result}`;
  let unique = result; for (let index = 2; taken.has(unique); index++) unique = `${result}${index}`;
  taken.add(unique); return unique;
}
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const frameUrl = (id: string): string => `https://www.figma.com/design/${fileKey}/f?node-id=${id.replace(":", "-")}`;
const line = (node: FigmaNode, indent: string): string => {
  const { width, height } = box(node); const id = String(node.id); const name = pascal(String(node.name ?? ""), id);
  return `${indent}${id.padEnd(10)} ${`${Math.round(width)}×${Math.round(height)}`.padEnd(11)} ${kind(width).padEnd(8)} ${String(node.name).slice(0, 40).padEnd(40)} --page "${name}|/${kebab(name)}|${frameUrl(id)}"`;
};

const minutes = Math.round((Date.now() - fetchedAt) / 60000);
console.log(`${body.name} · file ${fileKey} · version ${body.version} · last modified ${body.lastModified} · ${file!.cached ? `from the cached read (${minutes} min old, 0 requests)` : "read now (1 Figma request)"}`);
let total = 0;
for (const page of (body.document.children ?? []) as FigmaNode[]) {
  const children = ((page.children ?? []) as FigmaNode[]).filter((child) => child.visible !== false);
  console.log(`\npage "${page.name}" (${page.id})`);
  for (const child of children) {
    if (child.type === "SECTION") {
      const inner = ((child.children ?? []) as FigmaNode[]).filter((node) => node.visible !== false && FRAMES.has(String(node.type)));
      console.log(`  section "${child.name}" (${child.id}) — ${inner.length} frame(s)`);
      for (const node of inner) { console.log(line(node, "    ")); total++; }
    } else if (FRAMES.has(String(child.type))) { console.log(line(child, "  ")); total++; }
  }
}
console.log(`\n${total} frame(s). Pass the --page lines of the ones to build to build-page in ONE run; it takes the node trees from this read (no /nodes request) for the next 12 h.`);

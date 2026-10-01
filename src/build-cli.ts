import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLocalEnv } from "./env.ts";
import { completeExtraction, fetchDesignNodes, fetchDesignNodesBatch, loadWholeFile, renderTargetUrls, renormalize, type FetchedDesign } from "./extractor.ts";
import { FigmaRestClient, mapPool, parseFigmaReference, type FigmaReference } from "./figma.ts";
import { buildIR, type FlatPlan, type IRResult } from "./ir.ts";
import { emitPage } from "./genpage.ts";
import { emitHtml } from "./emit.ts";
import { flatsToRender, materialize, renderFlats, type MaterializeResult } from "./materialize.ts";
import { runCompare, verdictLines, type CompareReport } from "./compare.ts";
import { missingRuntime, ownership, signGenerated } from "./ownership.ts";
import type { DesignFingerprintV1, NodeFingerprint } from "./types.ts";

/**
 * One command per page (or per site): extract → compile → assets → code → route → verify → verdict.
 * A model runs this once and reads ~15 lines per page; only what a verdict names needs attention.
 * Figma's server-side render of a target dominates wall-clock (minutes), so everything else is
 * arranged around that wait: pages extract side by side, icons/vectors of ALL pages are rendered in
 * one batched request per format while the targets are still rendering, and one dev server verifies
 * every page. Prototype overlays the pages open are built alongside them as components.
 * Everything that could stop a build is checked before anything is written, and a file in the project is
 * only ever replaced when it is this tool's own, unedited output.
 */
interface ProjectConfig { pagesDir: string; assetsDir: string; assetBase: string; lib: string; routesFile: string; dev: { command: string; }; }
interface PageEntry { name: string; route: string; nodeId: string; design: string; file: string; /** A prototype overlay component: no route of its own. */ overlay?: boolean; }
interface PageSpec { name: string; route?: string; figmaUrl?: string; design?: string; slug: string; overlay?: boolean; }
interface Prepared { spec: PageSpec; designDir: string; reference?: FigmaReference; fetched?: FetchedDesign; fingerprint: DesignFingerprintV1; targetUrl?: Promise<string>; ms: number; }
interface BuiltPage { spec: PageSpec; designDir: string; route: string; fingerprint: DesignFingerprintV1; ir: IRResult; assets: MaterializeResult; pageFile: string; nodeId: string; report?: CompareReport; healed: string[]; timings: Record<string, number>; openedFrom?: { page: string; trigger: string; }; }
// Unless figma2code.json says otherwise, everything the tool writes lives in folders of its own.
const DEFAULT_CONFIG: Omit<ProjectConfig, "dev"> = { pagesDir: "src/figma2code", assetsDir: "public/figma2code", assetBase: "/figma2code", lib: "./lib", routesFile: "src/figma2code/routes.tsx" };
// The project's own dev server binary — not `npx`, which would download a missing tool by itself.
const DEV_COMMANDS: [tool: string, command: string][] = [["vite", "./node_modules/.bin/vite --port {port} --strictPort"], ["next", "./node_modules/.bin/next dev -p {port}"], ["react-scripts", "PORT={port} BROWSER=none ./node_modules/.bin/react-scripts start"]];
const OUTPUTS = fileURLToPath(new URL("../outputs/", import.meta.url));
const RUNTIME = new URL("../runtime/react/lib.tsx", import.meta.url);
// Phones, tablets, laptops, desktops, wide screens: a page must meet each without a horizontal scroll.
const FIT_WIDTHS = [360, 768, 1024, 1280, 1366, 1440, 1536, 1920, 2560];

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error([
    "Usage:",
    "  one page : npm run build-page -- --project DIR --name PageName (--figma-url URL | --design outputs/slug) [--route /path]",
    "  many     : npm run build-page -- --project DIR --page \"Home|/|URL\" --page \"News|/news|URL\" …",
    "Options: [--mode auto|api|crop] [--base-url http://localhost:PORT] [--refresh] [--no-verify]",
  ].join("\n"));
  process.exit(1);
}
function refuse(problems: string[]): never {
  console.error(`Refusing to build — nothing in the project was changed:\n${problems.map((problem) => `  ✗ ${problem}`).join("\n")}`);
  process.exit(1);
}
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const values = (flag: string): string[] => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
const pascal = (name: string): string => name.normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join("");
const validName = (name: string | undefined): name is string => !!name && /^[A-Z][A-Za-z0-9]*$/.test(name);
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => { const groups = new Map<string, T[]>(); for (const item of items) { const group = groups.get(key(item)) ?? []; group.push(item); groups.set(key(item), group); } return groups; };
const reachable = async (url: string): Promise<boolean> => fetch(url, { signal: AbortSignal.timeout(1500) }).then((response) => response.ok, () => false);
const findNode = (node: NodeFingerprint, id: string): NodeFingerprint | undefined => node.id === id ? node : node.children?.map((child) => findNode(child, id)).find(Boolean);
const targetNode = (fingerprint: DesignFingerprintV1): NodeFingerprint | undefined => fingerprint.pages.flatMap((page) => page.children).map((child) => findNode(child, fingerprint.targets[0].nodeId)).find(Boolean);
/** A saved extraction, brought up to what the current normalizer reads whenever the same file version is at hand. */
async function readExtraction(designDir: string, label: string): Promise<DesignFingerprintV1> {
  const saved = JSON.parse(await readFile(join(designDir, "fingerprint.json"), "utf8")) as DesignFingerprintV1;
  const fresh = await renormalize(saved);
  if (!fresh || JSON.stringify(fresh.pages) === JSON.stringify(saved.pages)) return saved;
  await writeFile(join(designDir, "fingerprint.json"), `${JSON.stringify(fresh, null, 2)}\n`);
  console.log(`${label}: extraction re-read by the current normalizer from the cached file (same version, no request)`);
  return fresh;
}

const projectArg = value("--project"); if (!projectArg) usage("--project is required");
const project = resolve(projectArg);
const specs: PageSpec[] = values("--page").map((raw) => { const [name, route, source] = raw.split("|").map((part) => part.trim()); if (!validName(name) || !source) usage(`bad --page "${raw}" — expected "PascalName|/route|figma-url-or-design-dir"`); return { name, route: route || undefined, slug: kebab(name), ...(source.startsWith("http") ? { figmaUrl: source } : { design: source }) }; });
if (!specs.length) { const name = value("--name"); if (!validName(name)) usage("a PascalCase --name is required"); if (!value("--figma-url") && !value("--design")) usage("pass --figma-url or --design"); specs.push({ name, route: value("--route"), figmaUrl: value("--figma-url"), design: value("--design"), slug: value("--slug") ?? kebab(name) }); }
const mode = (value("--mode") ?? "auto") as "auto" | "api" | "crop"; if (!["auto", "api", "crop"].includes(mode)) usage("--mode must be auto, api or crop");
const refresh = args.includes("--refresh");
const verify = !args.includes("--no-verify");
const baseUrlArg = value("--base-url");
await loadLocalEnv();
const token = process.env.FIGMA_ACCESS_TOKEN;
const started = performance.now();

// ── preflight: everything that could stop the build is checked before anything is written ──
const packageJson = await readFile(join(project, "package.json"), "utf8").then((text) => JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; }, () => undefined);
if (!packageJson) usage(`${project} has no package.json — create the project first (for example: npm create vite@latest <dir> -- --template react-ts)`);
const configPath = join(project, "figma2code.json");
const configText = await readFile(configPath, "utf8").catch(() => undefined);
let userConfig: Partial<ProjectConfig> = {};
if (configText !== undefined) { try { userConfig = JSON.parse(configText) as Partial<ProjectConfig>; } catch { usage(`${configPath} is not valid JSON`); } }
const installed = { ...packageJson.dependencies, ...packageJson.devDependencies };
const config: ProjectConfig = { ...DEFAULT_CONFIG, dev: { command: DEV_COMMANDS.find(([tool]) => tool in installed)?.[1] ?? "" }, ...userConfig };
const assetsDir = resolve(project, config.assetsDir);
const libFile = resolve(project, config.pagesDir, `${config.lib}.tsx`);
const routesFile = resolve(project, config.routesFile);
const pageFileOf = (name: string): string => resolve(project, config.pagesDir, `${name}.tsx`);
const pagesPath = join(project, "figma2code.pages.json");
let pages: PageEntry[] = await readFile(pagesPath, "utf8").then((text) => JSON.parse(text) as PageEntry[], () => []);
const registered = new Map(pages.map((entry) => [entry.name, entry]));
const routeFor = (spec: PageSpec): string => spec.route ?? registered.get(spec.name)?.route ?? `/${spec.slug}`;
// A registered page keeps its extraction; a new one gets a folder per project, so pages of different projects never share one.
const designDirFor = (spec: PageSpec): string => spec.design ? resolve(spec.design) : registered.has(spec.name) ? resolve(project, registered.get(spec.name)!.design) : join(OUTPUTS, basename(project), spec.slug);

const problems: string[] = [];
if (new Set(specs.map((spec) => spec.name)).size !== specs.length) problems.push("the same page name is given twice");
const why = { edited: "was generated by figma2code and edited afterwards — move it elsewhere to keep the edits, or delete it to regenerate", foreign: "already exists and was not generated by figma2code — pick another page name, or other folders in figma2code.json" };
const checkOwnership = async (files: string[]): Promise<string[]> => {
  const found: string[] = [];
  for (const file of new Set(files)) {
    const existing = await readFile(file, "utf8").catch(() => undefined);
    if (existing === undefined) continue;
    const owner = ownership(existing); if (owner !== "generated") found.push(`${relative(project, file)} ${why[owner]}`);
  }
  return found;
};
problems.push(...await checkOwnership([...specs.map((spec) => pageFileOf(spec.name)), routesFile]));
// The runtime the pages import: re-created while it is our unedited copy; a customized one must already have what pages use.
const libSource = await readFile(libFile, "utf8").catch(() => undefined);
const runtime = signGenerated((await readFile(RUNTIME, "utf8")).replace(/export const ASSET_BASE = "[^"]*";/, `export const ASSET_BASE = ${JSON.stringify(config.assetBase)};`));
if (libSource !== undefined && ownership(libSource) !== "generated") {
  const missing = missingRuntime(libSource);
  if (missing.includes("Box") || missing.includes("Txt")) problems.push(`${relative(project, libFile)} already exists and is not the figma2code runtime the pages import — point "lib" in figma2code.json to a free path`);
  else if (missing.length) problems.push(`${relative(project, libFile)} is a customized figma2code runtime without ${missing.join(", ")}, which pages of this version use — copy them from ${fileURLToPath(RUNTIME)}, or delete the file to have it re-created`);
}
for (const spec of specs) {
  if (!routeFor(spec).startsWith("/")) problems.push(`route "${routeFor(spec)}" of ${spec.name} must start with /`);
  if (spec.design && !await exists(join(resolve(spec.design), "fingerprint.json"))) problems.push(`${spec.design} holds no extraction (fingerprint.json)`);
}
const claims = [...pages.filter((entry) => !entry.overlay && !specs.some((spec) => spec.name === entry.name)), ...specs.map((spec) => ({ name: spec.name, route: routeFor(spec) }))];
for (const [route, group] of groupBy(claims, (claim) => claim.route)) if (group.length > 1) problems.push(`route ${route} would be served by ${group.map((claim) => claim.name).join(" and ")} — give each page its own --route`);
if (verify) {
  if (baseUrlArg) { if (!await reachable(baseUrlArg)) problems.push(`--base-url ${baseUrlArg} is not reachable`); }
  else if (!config.dev.command) problems.push(`no dev server to verify with: package.json lists none of ${DEV_COMMANDS.map(([tool]) => tool).join(", ")} — set dev.command (with {port}) in figma2code.json, or pass --base-url or --no-verify`);
  else { const binary = config.dev.command.match(/\.\/node_modules\/\.bin\/[\w.-]+/)?.[0]; if (binary && !await exists(join(project, binary))) problems.push(`${binary} is missing — run npm install in the project first`); }
}

if (problems.length) refuse(problems);

// Which pages need Figma at all: an unchanged node reuses its extraction without touching the API.
const pending = await mapPool(specs, 6, async (spec) => {
  const designDir = designDirFor(spec);
  const fromDisk = async (): Promise<Prepared> => ({ spec, designDir, fingerprint: await readExtraction(designDir, spec.name), ms: 0 });
  if (!spec.figmaUrl) return fromDisk();
  const reference = parseFigmaReference(spec.figmaUrl);
  const manifest = await readFile(join(designDir, "manifest.json"), "utf8").then((text) => JSON.parse(text) as { targetSelection?: { requestedNodeId?: string | null; resolvedTargetNodeId?: string; }; source?: { fileKey?: string; }; }, () => undefined);
  const sameNode = manifest?.source?.fileKey === reference.fileKey && (manifest.targetSelection?.requestedNodeId === (reference.nodeId ?? null) || manifest.targetSelection?.resolvedTargetNodeId === reference.nodeId);
  if (sameNode && !refresh) { console.log(`${spec.name}: reusing extraction ${relative(process.cwd(), designDir)} (--refresh to re-extract)`); return fromDisk(); }
  return { spec, designDir, reference };
});
const toExtract = pending.filter((page): page is { spec: PageSpec; designDir: string; reference: FigmaReference; } => "reference" in page && !!page.reference);
if (toExtract.length && !token) refuse(["FIGMA_ACCESS_TOKEN is not set — it is needed to extract new designs"]);
const client = token ? new FigmaRestClient(token) : undefined;
// Every new page needs Figma's render of its frame: while that endpoint is known to be closed, even the node request would be wasted quota.
const renderClosed = async (fileKeys: Iterable<string>): Promise<string[]> => {
  const closed: string[] = [];
  for (const fileKey of new Set(fileKeys)) {
    const until = await client!.blockedUntil(fileKey, "render");
    if (until) closed.push(`Figma will not render file ${fileKey} for this token until ${until.toISOString().replace("T", " ").slice(0, 16)} UTC (remembered 429) — new frames cannot be extracted before then, so no request was sent`);
  }
  return closed;
};
const closedFiles = await renderClosed(toExtract.map((page) => page.reference.fileKey));
if (closedFiles.length) refuse(closedFiles);

// ── 1a. node trees — ONE /nodes request per Figma file for every page that needs it, none after a recent `npm run frames` ──
const fetchNodes = async (fileKey: string, nodeIds: string[]): Promise<FetchedDesign[]> => {
  const whole = refresh ? undefined : await loadWholeFile({ fileKey, cacheOnly: true });
  if (whole) console.log(`${fileKey}: node trees from the whole-file read of ${new Date(whole.fetchedAt).toLocaleTimeString()} — no /nodes request`);
  return fetchDesignNodesBatch({ fileKey, nodeIds, token: token!, client, wholeFile: whole?.body });
};
const fetchedPages = new Map<(typeof toExtract)[number], FetchedDesign>();
await Promise.all([...groupBy(toExtract, (page) => page.reference.fileKey)].map(async ([fileKey, group]) => {
  const withNode = group.filter((page) => page.reference.nodeId);
  if (withNode.length) (await fetchNodes(fileKey, withNode.map((page) => page.reference.nodeId!))).forEach((fetched, index) => fetchedPages.set(withNode[index], fetched));
  for (const page of group.filter((entry) => !entry.reference.nodeId)) fetchedPages.set(page, await fetchDesignNodes({ fileKey, token: token! }));
}));
const extractStarted = performance.now();
const prepared: Prepared[] = pending.map((page) => {
  if ("fingerprint" in page) return page as Prepared;
  const fetched = fetchedPages.get(page as (typeof toExtract)[number])!;
  return { spec: page.spec, designDir: page.designDir, reference: (page as (typeof toExtract)[number]).reference, fetched, fingerprint: fetched.fingerprint, ms: 0 };
});

// ── 1a'. prototype overlays the pages open ("open overlay" actions): components built in the same batch ──
const opened = new Map<string, string>(); // overlay frame id → file key
for (const page of prepared) {
  const visit = (node: NodeFingerprint): void => { if (!node.visible) return; if (node.link?.navigation === "overlay" && node.link.nodeId) opened.set(node.link.nodeId, page.fingerprint.source.fileKey); node.children?.forEach(visit); };
  const root = targetNode(page.fingerprint); if (root) visit(root);
}
for (const page of prepared) opened.delete(page.fingerprint.targets[0].nodeId);
const overlaysByNode = new Map(pages.filter((entry) => entry.overlay).map((entry) => [entry.nodeId, entry]));
const taken = new Set([...specs.map((spec) => spec.name), ...pages.map((entry) => entry.name)]);
const overlayNames = new Map<string, string>(); // overlay frame id → accessible label (the frame's name)
const toFetchOverlays: { id: string; fileKey: string; }[] = [];
for (const [id, fileKey] of opened) {
  const entry = overlaysByNode.get(id); const designDir = entry ? resolve(project, entry.design) : undefined;
  const fingerprint = entry && !refresh ? await readExtraction(designDir!, entry.name).catch(() => undefined) : undefined;
  if (entry && fingerprint?.targets[0].nodeId === id) { prepared.push({ spec: { name: entry.name, slug: kebab(entry.name), overlay: true }, designDir: designDir!, fingerprint, ms: 0 }); continue; }
  toFetchOverlays.push({ id, fileKey });
}
if (toFetchOverlays.length) {
  if (!token) refuse(["FIGMA_ACCESS_TOKEN is not set — it is needed to extract the overlays these pages open"]);
  const closed = await renderClosed(toFetchOverlays.map((overlay) => overlay.fileKey)); if (closed.length) refuse(closed);
  for (const [fileKey, group] of groupBy(toFetchOverlays, (overlay) => overlay.fileKey)) {
    (await fetchNodes(fileKey, group.map((overlay) => overlay.id))).forEach((fetched, index) => {
      const existing = overlaysByNode.get(group[index].id);
      let name = existing?.name ?? `${pascal(targetNode(fetched.fingerprint)?.name ?? "") || `Frame${group[index].id.replace(/\D+/g, "x")}`}Overlay`;
      for (let suffix = 2; !existing && taken.has(name); suffix++) name = name.replace(/\d*Overlay$/, `${suffix}Overlay`);
      taken.add(name);
      prepared.push({ spec: { name, slug: kebab(name), overlay: true }, designDir: existing ? resolve(project, existing.design) : join(OUTPUTS, basename(project), kebab(name)), reference: { fileKey, nodeId: group[index].id }, fetched, fingerprint: fetched.fingerprint, ms: 0 });
    });
  }
}
for (const page of prepared) if (page.spec.overlay) overlayNames.set(page.fingerprint.targets[0].nodeId, targetNode(page.fingerprint)?.name ?? page.spec.name);
const overlayProblems = await checkOwnership(prepared.filter((page) => page.spec.overlay).map((page) => pageFileOf(page.spec.name)));
if (overlayProblems.length) refuse(overlayProblems);

// ── setup: the first build in a project writes its config; the runtime primitives are (re)created while they are ours ──
if (configText === undefined) await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
if (libSource === undefined || (ownership(libSource) === "generated" && libSource !== runtime)) {
  await mkdir(dirname(libFile), { recursive: true }); await writeFile(libFile, runtime);
  console.log(`${libSource === undefined ? "scaffolded" : "upgraded"} runtime primitives → ${relative(project, libFile)}`);
}

// ── 1b. side by side: ONE Figma render request per file for all targets (minutes) ∥ one batched render of every icon/vector ──
for (const [fileKey, group] of groupBy(prepared.filter((page) => page.fetched), (page) => page.fingerprint.source.fileKey)) {
  const targetOf = (page: Prepared) => { const target = page.fingerprint.targets[0]; return { nodeId: target.nodeId, width: target.width, height: target.height, scale: target.scale || 1 }; };
  const urls = renderTargetUrls(client!, fileKey, group.map(targetOf));
  for (const page of group) { const target = targetOf(page); page.targetUrl = urls.get(`${target.nodeId}@${target.scale}`); }
}
const earlyFlats = (async (): Promise<{ rendered: number; ms: number; }> => {
  const from = performance.now(); let rendered = 0;
  if (mode === "crop" || !token) return { rendered, ms: 0 };
  const byFile = new Map<string, { version?: string; plans: FlatPlan[]; }>();
  for (const page of prepared) {
    const version = page.fingerprint.source.version;
    const wanted = await flatsToRender(buildIR(page.fingerprint, { asOverlay: page.spec.overlay }).flats, { assetsDir, mode, version, refresh });
    const group = byFile.get(page.fingerprint.source.fileKey) ?? { version, plans: [] }; group.plans.push(...wanted); byFile.set(page.fingerprint.source.fileKey, group);
  }
  for (const [fileKey, group] of byFile) if (group.plans.length) rendered += (await renderFlats({ assetsDir, fileKey, token, plans: group.plans, version: group.version })).rendered;
  return { rendered, ms: Math.round(performance.now() - from) };
})();
await mapPool(prepared, 4, async (page) => {
  if (!page.fetched) return;
  const result = await completeExtraction(page.fetched, { fileKey: page.reference!.fileKey, nodeId: page.reference!.nodeId, token: token!, outputDir: page.designDir }, { targetUrl: page.targetUrl });
  page.fingerprint = result.fingerprint; page.ms = Math.round(performance.now() - extractStarted) + (page.fetched.timings.nodes ?? 0);
});
const early = await earlyFlats;

// Prototype links between pages resolve to the routes the pages are served at; overlays to their components.
const routeOf = new Map<string, string>(pages.filter((page) => !page.overlay).map((page) => [page.nodeId, page.route]));
for (const { spec, fingerprint } of prepared) if (!spec.overlay) routeOf.set(fingerprint.targets[0].nodeId, routeFor(spec));
const overlays = Object.fromEntries(prepared.filter((page) => page.spec.overlay).map((page) => [page.fingerprint.targets[0].nodeId, { component: page.spec.name, label: overlayNames.get(page.fingerprint.targets[0].nodeId) ?? page.spec.name }]));

// ── 2–4. compile → assets → code ──
const built: BuiltPage[] = [];
async function writePage(page: Pick<BuiltPage, "spec" | "fingerprint" | "ir" | "pageFile" | "nodeId">): Promise<void> {
  await mkdir(dirname(page.pageFile), { recursive: true });
  await writeFile(page.pageFile, signGenerated(emitPage(page.ir, { component: page.spec.name, emit: "react", libPath: config.lib, assetBase: config.assetBase, source: `${page.fingerprint.source.fileName} · node ${page.nodeId}` })));
}
for (const { spec, designDir, fingerprint, ms } of prepared) {
  const timings: Record<string, number> = { extract: ms }; let last = performance.now();
  const mark = (label: string): void => { const now = performance.now(); timings[label] = Math.round(now - last); last = now; };
  const target = fingerprint.targets[0]; const route = spec.overlay ? "" : routeFor(spec);
  const ir = buildIR(fingerprint, { routes: Object.fromEntries(routeOf), overlays, asOverlay: spec.overlay }); mark("compile");
  // Assets before emit: where an asset's pixels sit (and whether it is an .svg or a .png crop) is only known once it exists.
  const assets = await materialize({ designDir, assetsDir, ir, fileKey: fingerprint.source.fileKey, mode, token, version: fingerprint.source.version, refresh }); mark("assets");
  const page: BuiltPage = { spec, designDir, route, fingerprint, ir, assets, pageFile: pageFileOf(spec.name), nodeId: target.nodeId, healed: [], timings };
  await writePage(page); mark("emit");
  const previous = registered.get(spec.name);
  if (previous && previous.nodeId !== target.nodeId) console.log(`${spec.name}: now built from node ${target.nodeId} (was ${previous.nodeId})`);
  pages = [...pages.filter((entry) => entry.name !== spec.name), { name: spec.name, route, nodeId: target.nodeId, design: relative(project, designDir), file: relative(project, page.pageFile), ...(spec.overlay ? { overlay: true } : {}) }];
  built.push(page);
}
// Each overlay is verified where users meet it: opened by its first trigger, on the page it belongs to.
for (const overlay of built.filter((page) => page.spec.overlay)) {
  for (const page of built) {
    const popup = page.ir.popups.find((entry) => entry.target === overlay.nodeId && entry.component);
    if (popup) { overlay.openedFrom = { page: page.spec.name, trigger: popup.trigger }; overlay.route = page.route; break; }
  }
}
pages.sort((a, b) => a.route.localeCompare(b.route) || a.name.localeCompare(b.name));
await writeFile(pagesPath, `${JSON.stringify(pages, null, 2)}\n`);
const routed = pages.filter((page) => !page.overlay);
const importPath = (file: string): string => { const path = relative(dirname(routesFile), resolve(project, file)).replace(/\.tsx$/, ""); return path.startsWith(".") ? path : `./${path}`; };
await mkdir(dirname(routesFile), { recursive: true });
await writeFile(routesFile, signGenerated([
  `// GENERATED by figma2code build-page — do not edit. Render these once in your router:`,
  `//   {figmaRoutes.map(({ path, Component }) => <Route key={path} path={path} element={<Component />} />)}`,
  ...routed.map((page) => `import ${page.name} from ${JSON.stringify(importPath(page.file))};`),
  ``, `export const figmaRoutes = [`,
  ...routed.map((page) => `  { path: ${JSON.stringify(page.route)}, nodeId: ${JSON.stringify(page.nodeId)}, Component: ${page.name} },`),
  `];`, ``,
].join("\n")));

// ── 5. verify against the running project (its dev server is spawned on a free port when none is given) ──
let server: ChildProcess | undefined;
const freePort = (): Promise<number> => new Promise((resolvePort, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(0, () => { const address = probe.address(); const port = typeof address === "object" && address ? address.port : 0; probe.close(() => resolvePort(port)); }); });
try {
  if (verify) {
    const serverFrom = performance.now();
    let baseUrl = baseUrlArg;
    if (!baseUrl) {
      const port = await freePort(); baseUrl = `http://localhost:${port}`;
      server = spawn("sh", ["-c", config.dev.command.replaceAll("{port}", String(port))], { cwd: project, stdio: "ignore", detached: true });
      const deadline = Date.now() + 40000; while (Date.now() < deadline && !await reachable(baseUrl)) await new Promise((wait) => setTimeout(wait, 250));
      if (!await reachable(baseUrl)) throw new Error(`dev server did not start with: ${config.dev.command}`);
    }
    const serverMs = Math.round(performance.now() - serverFrom);
    for (const page of built) {
      if (page.spec.overlay && !page.openedFrom) continue;
      const opener = page.openedFrom && built.find((entry) => entry.spec.name === page.openedFrom!.page)!;
      const popup = opener?.ir.popups.find((entry) => entry.trigger === page.openedFrom!.trigger);
      const fit = page.ir.fit;
      const cropWidth = fit.fluid ? [1440, 1366, 1280, 1024].find((width) => width < fit.width && width >= fit.minWidth) : undefined;
      const from = performance.now();
      const compare = (): Promise<CompareReport> => runCompare({
        designDir: page.designDir, url: `${baseUrl}${page.route}`, outDir: join(page.designDir, "compare"), fixes: page.ir.fixes,
        ...(opener && popup ? { open: { trigger: popup.trigger, dx: popup.dx, dy: popup.dy }, viewport: { width: Math.round(opener.fingerprint.targets[0].width), height: Math.round(Math.min(opener.fingerprint.targets[0].height, 2000)) } } : { fit: { widths: FIT_WIDTHS, cropWidth }, behaviors: page.ir.behaviors }),
      });
      page.report = await compare();
      // Self-healing: an isolated Figma render that the compare proves wrong (backdrop effects, blend modes, unusual
      // clipping) is replaced by the design's own pixels — exact by construction — and the page is verified again.
      const wrong = page.report.outliers.filter((outlier) => outlier.cause === "flat" && page.ir.flats.some((plan) => plan.id === outlier.nodeId)).map((outlier) => outlier.nodeId);
      if (wrong.length) {
        const again = await materialize({ designDir: page.designDir, assetsDir, ir: page.ir, fileKey: page.fingerprint.source.fileKey, mode: "crop", version: page.fingerprint.source.version, forceCrop: wrong });
        page.assets.flats.crop += again.flats.crop; page.assets.flats.api = Math.max(0, page.assets.flats.api - again.flats.crop); page.healed = wrong;
        await writePage(page); page.report = await compare();
      }
      page.timings["dev server"] = serverMs; page.timings.verify = Math.round(performance.now() - from);
      if (!page.report.summary.pass) {
        // Same IR as a static page: if THIS passes, the compiler output is right and the project is interfering.
        const selfDir = join(page.designDir, "selfcheck"); await mkdir(selfDir, { recursive: true });
        await writeFile(join(selfDir, "index.html"), emitHtml(page.ir, { assetUrl: (file) => pathToFileURL(resolve(assetsDir, file)).href }));
        const self = await runCompare({ designDir: page.designDir, url: pathToFileURL(join(selfDir, "index.html")).href, outDir: join(selfDir, "compare"), artifacts: "none" });
        const geometry = (report: CompareReport): number => report.violations.filter((violation) => ["x", "y", "width", "height"].includes(violation.prop)).length;
        const projectWorse = geometry(self) < geometry(page.report) || (self.summary.unexplainedPct ?? 0) < (page.report.summary.unexplainedPct ?? 0) - 0.05;
        page.report.notes.unshift(`selfcheck (same output as static HTML, no project CSS/fonts): ${geometry(self)} geometry violation(s), unexplained ${self.summary.unexplainedPct}% vs project ${geometry(page.report)} / ${page.report.summary.unexplainedPct}% — ${projectWorse ? "the PROJECT is interfering (global CSS, route not rendered, assets not served)" : "the difference comes from the design data/compiler, not the project"}`);
      }
    }
  }
} finally {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ } }
}

// ── verdicts ──
for (const page of built) {
  const where = page.spec.overlay ? page.openedFrom ? `overlay opened from ${page.openedFrom.page}` : "overlay — no built page opens it, not verified" : `route ${page.route}${page.ir.fit.fluid ? `, fluid ≥ ${page.ir.fit.minWidth}px` : ", scaled below its width"}`;
  console.log(`\n${page.spec.name} → ${relative(process.cwd(), page.pageFile)}  (${where}, ${page.ir.stats.emitted} elements, ${page.ir.flats.length} flats: ${page.assets.flats.api} rendered / ${page.assets.flats.crop} cropped / ${page.assets.flats.cached} cached, ${page.ir.images.length} images${page.ir.popups.some((popup) => popup.component !== page.spec.name) ? `, opens ${[...new Set(page.ir.popups.filter((popup) => popup.component !== page.spec.name).map((popup) => popup.component ?? popup.target))].join(", ")}` : ""})`);
  if (page.report) for (const line of verdictLines(page.report)) console.log(line);
  if (page.healed.length) console.log(`  healed: ${page.healed.length} isolated Figma render(s) did not match the design and were replaced by design crops (1×, exact): ${page.healed.join(", ")}`);
  for (const warning of page.assets.warnings) console.log(`  warning: ${warning}`);
  if (page.ir.notes.length) console.log(`  generator notes (${page.ir.notes.length}): ${page.ir.notes.slice(0, 6).join(" | ")}`);
  console.log(`  fonts: ${page.ir.fonts.map((font) => `${font.family} ${font.weights.join("/")}${font.italic ? " +italic" : ""}`).join(", ") || "none"} · stages ${Object.entries(page.timings).map(([label, ms]) => `${label} ${seconds(ms)}`).join(" · ")}`);
  await writeFile(join(page.designDir, "build-report.json"), `${JSON.stringify({ name: page.spec.name, route: page.route, overlay: page.spec.overlay ?? false, openedFrom: page.openedFrom, nodeId: page.nodeId, pageFile: page.pageFile, pass: page.report?.summary.pass ?? null, fit: page.ir.fit, healed: page.healed, timings: page.timings, runApiCalls: FigmaRestClient.sent, flats: page.assets.flats, images: page.assets.images, notes: page.ir.notes, fonts: page.ir.fonts }, null, 2)}\n`);
}
const failed = built.filter((page) => page.report && !page.report.summary.pass);
const overlayCount = built.filter((page) => page.spec.overlay).length;
const sent = Object.entries(FigmaRestClient.sent); const totalCalls = sent.reduce((total, [, count]) => total + count, 0);
console.log(`\n${built.length - overlayCount} page(s)${overlayCount ? ` + ${overlayCount} overlay(s)` : ""} in ${seconds(performance.now() - started)} — ${verify ? `${built.length - failed.length} PASS` : "not verified (--no-verify)"}${failed.length ? `, ${failed.length} FAIL (${failed.map((page) => page.spec.name).join(", ")})` : ""} · Figma API requests ${totalCalls}${totalCalls ? ` (${sent.map(([family, count]) => `${family} ${count}`).join(", ")})` : ""}${early.rendered ? ` · ${early.rendered} asset(s) rendered in ${seconds(early.ms)}, overlapped with the page renders` : ""}`);
if (failed.length) process.exitCode = 2;

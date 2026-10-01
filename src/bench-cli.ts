import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildIR } from "./ir.ts";
import { emitHtml } from "./emit.ts";
import { materialize } from "./materialize.ts";
import { runCompare, verdictLines } from "./compare.ts";
import type { DesignFingerprintV1 } from "./types.ts";

/**
 * Compiler conformance bench: for each extraction, generate a static page with ZERO model
 * involvement, verify it against the design, and report fidelity + machine time. This is the
 * number that decides how much work is left for a model per page.
 */
function usage(): never { console.error("Usage: npm run bench -- --design outputs/a,outputs/b [--out outputs/bench] [--fonts-css file.css] [--mode crop|auto]"); process.exit(1); }
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const designs = value("--design")?.split(",").filter(Boolean); if (!designs?.length) usage();
const outRoot = value("--out") ?? "outputs/bench"; const mode = (value("--mode") ?? "crop") as "crop" | "auto";
const fontsCss = value("--fonts-css") ? await readFile(value("--fonts-css")!, "utf8") : "";

const rows: string[] = [];
for (const designDir of designs) {
  const slug = basename(designDir); const outDir = join(outRoot, slug); await mkdir(outDir, { recursive: true });
  const timings: Record<string, number> = {}; let last = performance.now();
  const mark = (label: string): void => { const now = performance.now(); timings[label] = Math.round(now - last); last = now; };
  const fingerprint = JSON.parse(await readFile(join(designDir, "fingerprint.json"), "utf8")) as DesignFingerprintV1;
  const ir = buildIR(fingerprint); mark("ir");
  const assets = await materialize({ designDir, assetsDir: join(outDir, "assets"), ir, fileKey: fingerprint.source.fileKey, mode, token: mode === "auto" ? process.env.FIGMA_ACCESS_TOKEN : undefined }); mark("materialize");
  const html = emitHtml(ir, { assetUrl: (file) => `assets/${file}`, headHtml: fontsCss ? `<style>${fontsCss}</style>` : "" });
  await writeFile(join(outDir, "index.html"), html); mark("emit");
  const report = await runCompare({ designDir, url: pathToFileURL(resolve(outDir, "index.html")).href, outDir: join(outDir, "compare") }); mark("verify");
  const total = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
  console.log(`\n══ ${slug} — ${ir.stats.nodes} nodes → ${ir.stats.emitted} elements + ${ir.flats.length} flats (${ir.stats.flattened} nodes), ${ir.images.length} images; html ${(html.length / 1024).toFixed(0)}KB`);
  console.log(`   machine time ${total} ms (ir ${timings.ir} · assets ${timings.materialize} · emit ${timings.emit} · verify ${timings.verify}); flats api/crop/cached ${assets.flats.api}/${assets.flats.crop}/${assets.flats.cached}`);
  for (const line of verdictLines(report, 10)) console.log(`   ${line}`);
  if (ir.notes.length) console.log(`   generator notes (${ir.notes.length}): ${ir.notes.slice(0, 5).join(" | ")}`);
  const s = report.summary;
  rows.push(`| ${slug} | ${s.pass ? "PASS" : "FAIL"} | ${s.pixelDiffPct}% | ${s.diffByCause?.text}/${s.diffByCause?.image}/${s.diffByCause?.flat}/**${s.diffByCause?.other}** | ${s.high}/${s.medium}/${s.low} | ${s.coveragePct}% | ${(total / 1000).toFixed(1)}s |`);
}
console.log(`\n| page | verdict | pixel | text/photo/asset/**unexplained** | viol h/m/l | coverage | machine |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}`);

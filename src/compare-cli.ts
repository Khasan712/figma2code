import { runCompare, verdictLines } from "./compare.ts";

function usage(): never { console.error("Usage: npm run compare -- --design outputs/my-design --url http://localhost:3000/page [--out DIR] [--fast] [--artifacts none|hotspots|full] [--pos-tol 2] [--size-tol 2] [--strict]"); process.exit(1); }
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const numeric = (flag: string): number | undefined => { const raw = value(flag); if (raw === undefined) return undefined; const parsed = Number(raw); if (!Number.isFinite(parsed)) usage(); return parsed; };
const designDir = value("--design"); const url = value("--url");
if (!designDir || !url || args.includes("--help") || args.includes("-h")) usage();
const artifacts = value("--artifacts"); if (artifacts && !["none", "hotspots", "full"].includes(artifacts)) usage();

const report = await runCompare({ designDir, url, outDir: value("--out"), fast: args.includes("--fast"), artifacts: artifacts as "none" | "hotspots" | "full" | undefined, posTolerance: numeric("--pos-tol"), sizeTolerance: numeric("--size-tol") });
for (const line of verdictLines(report)) console.log(line);
if (args.includes("--strict") && !report.summary.pass) process.exit(1);

import { parseFigmaReference } from "./figma.ts";
import { extractFigmaDesign } from "./extractor.ts";
import { loadLocalEnv } from "./env.ts";

function usage(): never { console.error("Usage: npm run extract -- (--figma-url URL | --file-key KEY) [--node-id ID] [--out DIRECTORY] [--scale 1]"); process.exit(1); }
const args = process.argv.slice(2); const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
if (args.includes("--help") || args.includes("-h")) usage();
await loadLocalEnv();
const url = value("--figma-url"); const fromUrl = url ? parseFigmaReference(url) : undefined; const fileKey = value("--file-key") || fromUrl?.fileKey; const nodeId = value("--node-id")?.replace(/-/g, ":") || fromUrl?.nodeId;
if (!fileKey) usage();
const token = process.env.FIGMA_ACCESS_TOKEN; if (!token) { console.error("FIGMA_ACCESS_TOKEN is not set. Copy .env.example and export a token before live extraction."); process.exit(1); }
const scaleFlag = value("--scale"); const scale = scaleFlag === undefined ? undefined : Number(scaleFlag);
if (scale !== undefined && (!Number.isFinite(scale) || scale < 0.01 || scale > 4)) { console.error(`Invalid --scale value "${scaleFlag}": expected a number between 0.01 and 4.`); process.exit(1); }
const result = await extractFigmaDesign({ fileKey, nodeId, token, outputDir: value("--out") || "outputs/figma-extraction", scale });
console.log(JSON.stringify({ status: "ok", fingerprint: result.fingerprintPath, target: result.targetPath, digest: result.digestPath, manifest: result.manifestPath, targetNodeId: result.fingerprint.targets[0].nodeId, warnings: result.warnings }, null, 2));

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestFingerprint } from "./digest.ts";
import type { DesignFingerprintV1 } from "./types.ts";

function usage(): never { console.error("Usage: npm run digest -- --in outputs/my-design"); process.exit(1); }
const args = process.argv.slice(2); const index = args.indexOf("--in"); const dir = index >= 0 ? args[index + 1] : undefined;
if (!dir) usage();
const fingerprint = JSON.parse(await readFile(join(dir, "fingerprint.json"), "utf8")) as DesignFingerprintV1;
const digest = digestFingerprint(fingerprint);
await writeFile(join(dir, "digest.md"), digest.markdown);
await writeFile(join(dir, "digest.json"), `${JSON.stringify(digest.data, null, 2)}\n`);
console.log(JSON.stringify({ status: "ok", digest: join(dir, "digest.md"), digestData: join(dir, "digest.json"), markdownBytes: Buffer.byteLength(digest.markdown) }, null, 2));

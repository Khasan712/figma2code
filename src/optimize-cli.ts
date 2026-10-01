import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import sharp from "sharp";
import type { DesignFingerprintV1 } from "./types.ts";

/**
 * Display-size-aware asset optimizer. Every downloaded Figma image fill is capped at
 * dpr × its largest displayed size across the given fingerprints (assets.items[].dimensions
 * is the bounds of the node the fill paints), then re-encoded in place, same format.
 * Files not referenced by any fingerprint (e.g. fig-* node renders) are left untouched
 * unless --all is passed, in which case they are only re-encoded, never resized.
 */
function usage(): never { console.error("Usage: npm run optimize -- --assets <dir> --design <out1,out2,…> [--dpr 2] [--quality 82] [--all]"); process.exit(1); }
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const assetsDir = value("--assets"); const designs = value("--design")?.split(",").filter(Boolean);
if (!assetsDir || !designs?.length) usage();
const dpr = Number(value("--dpr") ?? 2); const quality = Number(value("--quality") ?? 82);
if (!Number.isFinite(dpr) || dpr <= 0 || !Number.isFinite(quality) || quality < 1 || quality > 100) usage();

// Max displayed size per file name across all fingerprints.
const displayCap = new Map<string, { w: number; h: number }>();
for (const dir of designs) {
  const fingerprint = JSON.parse(await readFile(join(dir, "fingerprint.json"), "utf8")) as DesignFingerprintV1;
  for (const item of fingerprint.assets.items) {
    if (!item.localPath || !item.dimensions) continue;
    const file = basename(item.localPath);
    const cap = displayCap.get(file) || { w: 0, h: 0 };
    displayCap.set(file, { w: Math.max(cap.w, item.dimensions.width), h: Math.max(cap.h, item.dimensions.height) });
  }
}

let before = 0; let after = 0; let resized = 0; let skipped = 0;
for (const file of await readdir(assetsDir)) {
  if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
  const path = join(assetsDir, file);
  const size = (await stat(path)).size;
  const cap = displayCap.get(file);
  if (!cap && !args.includes("--all")) { skipped++; continue; }
  before += size;
  const image = sharp(path, { limitInputPixels: 1e9 });
  const meta = await image.metadata();
  const isPng = /\.png$/i.test(file);
  const maxW = cap ? Math.ceil(cap.w * dpr) : meta.width!; const maxH = cap ? Math.ceil(cap.h * dpr) : meta.height!;
  let pipeline = image.rotate(); // bake EXIF orientation
  // "outside", not "inside": images are displayed with object-fit: cover, so after the resize they must
  // still cover the largest box in BOTH dimensions ("inside" under-samples the cropped axis).
  if (meta.width! > maxW && meta.height! > maxH) { pipeline = pipeline.resize(maxW, maxH, { fit: "outside", withoutEnlargement: true }); resized++; }
  const buffer = isPng
    ? await pipeline.png({ compressionLevel: 9, effort: 8 }).toBuffer()
    : await pipeline.jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
  // Never let "optimization" grow a file.
  if (buffer.length < size) { await writeFile(path, buffer); after += buffer.length; } else { after += size; }
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
console.log(JSON.stringify({ status: "ok", files: displayCap.size, resized, untouched: skipped, before: mb(before), after: mb(after), saved: mb(before - after) }, null, 2));

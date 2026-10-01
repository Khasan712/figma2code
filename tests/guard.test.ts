import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import fixture from "./fixtures/figma-file.json" with { type: "json" };
import { normalizeFixture } from "../src/extractor.ts";
import { isRuntime, ownership, signGenerated } from "../src/ownership.ts";

const toolkit = fileURLToPath(new URL("..", import.meta.url));

test("a signature tells untouched output from edited and foreign files", async () => {
  const code = `import { Box } from "./lib";\nexport default function Home() { return null; }\n`;
  const signed = signGenerated(code);
  assert.equal(ownership(signed), "generated");
  assert.equal(ownership(`${signed}// my fix\n`), "edited");
  assert.equal(ownership(signed.replace(/\n/g, "\r\n")), "edited", "an editor that rewrites line endings has edited the file");
  assert.equal(ownership(code), "foreign");
  assert.equal(ownership(`// figma2code-signature: 0123456789abcdef\n${code}`), "edited", "a copied signature line does not make a file ours");
  const html = signGenerated("<!doctype html>\n<html></html>\n");
  assert.match(html, /^<!-- figma2code-signature: [0-9a-f]{16} -->\n<!doctype html>/);
  assert.equal(ownership(html), "generated");
  assert.equal(isRuntime(await readFile(join(toolkit, "runtime/react/lib.tsx"), "utf8")), true);
  assert.equal(isRuntime(`export function cn(...inputs) { return inputs.join(" "); }\n`), false);
});

/** A throwaway React project plus an extraction of the fixture design, built with no network. */
async function sandbox(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "f2c-guard-"));
  const project = join(root, "site"); const design = join(root, "design");
  await mkdir(project, { recursive: true }); await mkdir(design, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "site", devDependencies: { vite: "^8.0.0" } }));
  for (const [path, content] of Object.entries(files)) { await mkdir(join(project, path, ".."), { recursive: true }); await writeFile(join(project, path), content); }
  await writeFile(join(design, "fingerprint.json"), JSON.stringify(normalizeFixture(fixture, "fixture-key", "1:2")));
  await sharp({ create: { width: 1440, height: 900, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toFile(join(design, "target.png"));
  const build = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(toolkit, "src/build-cli.ts"), "--project", project, "--mode", "crop", "--no-verify", ...args], { cwd: toolkit, encoding: "utf8" });
  /** Every file in the project with its content, to prove a refused run changed nothing. */
  const snapshot = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else out[path.slice(project.length + 1)] = (await readFile(path)).toString("base64"); } };
    await walk(project); return out;
  };
  return { project, design, build, snapshot, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a first build writes only into its own folders, signed; a rebuild may replace its own output", async () => {
  const box = await sandbox({ "src/pages/Landing.tsx": "export default function Landing() { return <main>mine</main>; }\n" });
  try {
    const first = box.build("--name", "Landing", "--route", "/landing", "--design", box.design);
    assert.equal(first.status, 0, first.stderr);
    const files = Object.keys(await box.snapshot()).sort();
    assert.deepEqual(files, ["figma2code.json", "figma2code.pages.json", "package.json", "public/figma2code/f2c-1-5.png", "public/figma2code/figma2code-assets.json", "src/figma2code/Landing.tsx", "src/figma2code/lib.tsx", "src/figma2code/routes.tsx", "src/pages/Landing.tsx"]);
    assert.equal(await readFile(join(box.project, "src/pages/Landing.tsx"), "utf8"), "export default function Landing() { return <main>mine</main>; }\n", "the project's own page with the same name is untouched");
    assert.equal(ownership(await readFile(join(box.project, "src/figma2code/Landing.tsx"), "utf8")), "generated");
    assert.equal(ownership(await readFile(join(box.project, "src/figma2code/routes.tsx"), "utf8")), "generated");
    assert.match(await readFile(join(box.project, "src/figma2code/lib.tsx"), "utf8"), /export const ASSET_BASE = "\/figma2code";/);
    const config = JSON.parse(await readFile(join(box.project, "figma2code.json"), "utf8")) as { dev: { command: string; }; };
    assert.equal(config.dev.command, "./node_modules/.bin/vite --port {port} --strictPort", "the project's own vite, never npx");
    const again = box.build("--name", "Landing", "--route", "/landing", "--design", box.design);
    assert.equal(again.status, 0, again.stderr);
  } finally { await box.cleanup(); }
});

test("an edited page, a foreign file, a clashing route or a foreign runtime stop the build before anything is written", async () => {
  const box = await sandbox();
  try {
    assert.equal(box.build("--name", "Landing", "--route", "/landing", "--design", box.design).status, 0);
    const page = join(box.project, "src/figma2code/Landing.tsx");
    await writeFile(page, `${await readFile(page, "utf8")}// hand fix\n`);
    const before = await box.snapshot();
    const edited = box.build("--name", "Landing", "--route", "/landing", "--design", box.design);
    assert.equal(edited.status, 1); assert.match(edited.stderr, /Landing\.tsx was generated by figma2code and edited afterwards/);
    const clash = box.build("--page", `About|/landing|${box.design}`);
    assert.equal(clash.status, 1); assert.match(clash.stderr, /route \/landing would be served by Landing and About/);
    const twice = box.build("--page", `A|/a|${box.design}`, "--page", `B|/a|${box.design}`);
    assert.equal(twice.status, 1); assert.match(twice.stderr, /route \/a would be served by A and B/);
    assert.deepEqual(await box.snapshot(), before, "refused runs changed nothing");
  } finally { await box.cleanup(); }

  const fresh = await sandbox({ "src/figma2code/About.tsx": "export default function About() { return null; }\n" });
  try {
    const before = await fresh.snapshot();
    const foreign = fresh.build("--name", "About", "--design", fresh.design);
    assert.equal(foreign.status, 1); assert.match(foreign.stderr, /About\.tsx already exists and was not generated by figma2code/);
    assert.deepEqual(await fresh.snapshot(), before, "not even the config or the runtime were scaffolded");
  } finally { await fresh.cleanup(); }

  const shadcn = await sandbox({ "figma2code.json": JSON.stringify({ pagesDir: "src/pages", lib: "../lib" }), "src/lib.tsx": "export function cn(...inputs: string[]) { return inputs.join(\" \"); }\n" });
  try {
    const before = await shadcn.snapshot();
    const runtime = shadcn.build("--name", "Landing", "--design", shadcn.design);
    assert.equal(runtime.status, 1); assert.match(runtime.stderr, /src\/lib\.tsx already exists and is not the figma2code runtime/);
    assert.deepEqual(await shadcn.snapshot(), before);
  } finally { await shadcn.cleanup(); }
});

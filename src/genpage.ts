import { buildIR, type FlatPlan, type FontUse, type IROptions, type IRResult } from "./ir.ts";
import { emitHtml, emitReact } from "./emit.ts";
import type { DesignFingerprintV1 } from "./types.ts";

/**
 * Deterministic fingerprint → page code. All visual decisions live in the IR (src/ir.ts); this is
 * the thin public entry that picks an emitter. Callers that also need the assets on disk run
 * `materialize` between buildIR and emit (see build-cli) because a crop fallback can rename a flat.
 */
export interface GenOptions extends IROptions {
  component: string;
  emit?: "react" | "html";
  libPath?: string;
  /** URL prefix the project serves copied assets from. */
  assetBase?: string;
  source?: string;
}
export interface GenResult { code: string; ir: IRResult; flats: FlatPlan[]; fonts: FontUse[]; images: string[]; notes: string[]; }

export function emitPage(ir: IRResult, options: GenOptions): string {
  const assetUrl = (file: string): string => `${options.assetBase ?? "/assets"}/${file}`;
  return options.emit === "html" ? emitHtml(ir, { assetUrl, title: options.component }) : emitReact(ir, { assetUrl, component: options.component, libPath: options.libPath, source: options.source });
}

export function generatePage(fingerprint: DesignFingerprintV1, options: GenOptions): GenResult {
  const ir = buildIR(fingerprint, options);
  return { code: emitPage(ir, options), ir, flats: ir.flats, fonts: ir.fonts, images: ir.images.map((image) => image.file), notes: ir.notes };
}

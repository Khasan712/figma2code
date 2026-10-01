import { createHash } from "node:crypto";

/**
 * Files the toolkit writes into a project carry a signature over their own content, so a later run can
 * tell its untouched output from everything else: a file without a valid signature — hand-written, or
 * generated and then edited — is never overwritten.
 */
const SIGNATURE = /^(?:\/\/ figma2code-signature: ([0-9a-f]{16})|<!-- figma2code-signature: ([0-9a-f]{16}) -->)\r?\n/;
const digest = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 16);

export function signGenerated(code: string): string {
  const hash = digest(code);
  return /^\s*</.test(code) ? `<!-- figma2code-signature: ${hash} -->\n${code}` : `// figma2code-signature: ${hash}\n${code}`;
}

export type Ownership = "generated" | "edited" | "foreign";
export function ownership(existing: string): Ownership {
  const match = existing.match(SIGNATURE);
  if (!match) return "foreign";
  return digest(existing.slice(match[0].length)) === (match[1] ?? match[2]) ? "generated" : "edited";
}

/** What generated pages import from the runtime file; anything else at that path would break them. */
export const RUNTIME_EXPORTS = ["Box", "Txt", "Pic", "asset", "Page", "Popup"];
/** The runtime exports a file lacks — generated pages of this compiler version import all of them. */
export const missingRuntime = (source: string): string[] => RUNTIME_EXPORTS.filter((name) => !new RegExp(`export\\s+(?:function|const)\\s+${name}\\b`).test(source));
export const isRuntime = (source: string): boolean => missingRuntime(source).length === 0;

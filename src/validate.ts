import type { DesignFingerprintV1, NodeFingerprint } from "./types.ts";

export class FingerprintValidationError extends Error {
  public readonly issues: string[];
  constructor(issues: string[]) { super(`Invalid DesignFingerprintV1:\n${issues.map((issue) => `- ${issue}`).join("\n")}`); this.issues = issues; }
}

function validBounds(value: NodeFingerprint["bounds"]): boolean { return [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.width >= 0 && value.height >= 0; }

/** A small dependency-free runtime guard for files handed to downstream agents. */
export function validateFingerprint(fingerprint: DesignFingerprintV1): void {
  const issues: string[] = [];
  if (fingerprint.schema !== "design-fingerprint" || fingerprint.version !== "1.0") issues.push("schema must be design-fingerprint version 1.0");
  if (!fingerprint.source.fileKey) issues.push("source.fileKey is required");
  if (!fingerprint.document.rootNodeId) issues.push("document.rootNodeId is required");
  if (!fingerprint.pages.length) issues.push("at least one page is required");
  if (!fingerprint.targets.length) issues.push("at least one visual target is required");
  const ids = new Set<string>();
  const visit = (node: NodeFingerprint, path: string): void => {
    if (!node.id) issues.push(`${path}: node id is required`); else if (ids.has(node.id)) issues.push(`${path}: duplicate node id ${node.id}`); else ids.add(node.id);
    // Unnamed nodes are legal in Figma, so a missing name is not a validation failure.
    if (!validBounds(node.bounds)) issues.push(`${path}: bounds must be finite and non-negative`);
    if (!node.hash || node.hash.length !== 64) issues.push(`${path}: node hash must be SHA-256`);
    node.children?.forEach((child, index) => visit(child, `${path}.children[${index}]`));
  };
  fingerprint.pages.forEach((page, index) => { if (!page.hash || page.hash.length !== 64) issues.push(`pages[${index}]: page hash must be SHA-256`); page.children.forEach((child, childIndex) => visit(child, `pages[${index}].children[${childIndex}]`)); });
  for (const target of fingerprint.targets) {
    if (!ids.has(target.nodeId)) issues.push(`target ${target.id} references missing node ${target.nodeId}`);
    if (target.width < 0 || target.height < 0) issues.push(`target ${target.id} has invalid dimensions`);
  }
  if (!fingerprint.hashes.overall || fingerprint.hashes.overall.length !== 64) issues.push("overall hash must be SHA-256");
  if (issues.length) throw new FingerprintValidationError(issues);
}

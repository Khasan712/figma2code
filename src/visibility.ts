import type { RNode } from "./ir.ts";

/**
 * A control a user must click is never shown cut by the box it sits in. Two ways it happens:
 *  - a state learned from one item is swapped into another item drawn at another size (the stepper of a 235px
 *    product photo shown on a 211px one): `fitInto` places it from how the design places it in ITS container;
 *  - the design itself draws a button half outside its clipping frame (a copy-paste that was never adjusted):
 *    `keepControlsVisible` moves it inside and reports it, so the page is right and the designer hears about it.
 * Hidden by design (nothing of it visible) and cut together with its whole item (a carousel edge) are left alone.
 */
export interface Rect { x: number; y: number; w: number; h: number; }
/** A control the design draws cut by its container, moved inside: root-relative boxes before and after. */
export interface Fix { id: string; label: string; by: { id: string; name: string; }; cutPct: number; from: Rect; to: Rect; /** A learned state (shown only after a click), not something the design draws. */ state?: boolean; }
/** How the design places a box in its own container: its box there and the container's size. */
export interface Placement { x: number; y: number; w: number; h: number; spanW: number; spanH: number; }

const clips = (node: RNode): boolean => node.style.overflow === "hidden";

/** The area a parent shows, in its own coordinates: the nearest clipping box at or above it, below the page itself. */
export function visibleArea(parent: RNode, parentOf: (node: RNode) => RNode | undefined): Rect | undefined {
  let dx = 0, dy = 0;
  for (let at: RNode | undefined = parent; at && at.kind !== "root"; at = parentOf(at)) {
    if (clips(at)) return { x: -dx, y: -dy, w: at.w, h: at.h };
    dx += at.x; dy += at.y;
  }
  return undefined;
}

/** Lays a box out at another size: each part keeps its nearest edge, or stays centered (− left, N centered, + right). */
export function resize(node: RNode, w: number, h: number): void {
  const dw = w - node.w, dh = h - node.h; if (Math.abs(dw) < 0.01 && Math.abs(dh) < 0.01) return;
  for (const child of [...node.children, ...(node.cases ?? [])]) {
    const cx = child.x + child.w / 2, cy = child.y + child.h / 2;
    child.x += cx < node.w / 3 ? 0 : cx > node.w * 2 / 3 ? dw : dw / 2;
    child.y += cy < node.h / 3 ? 0 : cy > node.h * 2 / 3 ? dh : dh / 2;
  }
  node.w = w; node.h = h;
}

function axis(pos: number, size: number, lo: number, hi: number, design?: { start: number; end: number; span: number; }): [number, number] {
  if (pos >= lo - 0.5 && pos + size <= hi + 0.5) return [pos, size];
  const room = hi - lo;
  if (!design) { const fitted = Math.min(size, room); return [Math.min(Math.max(pos, lo), hi - fitted), fitted]; }
  const start = Math.max(0, design.start), end = Math.max(0, design.end);
  // A bar spanning its container (small insets on both sides) stretches with it.
  if (start + end < design.span * 0.25) return [lo + start, Math.max(1, room - start - end)];
  // Otherwise it hugs its nearer edge at the designed inset and shrinks only when it cannot fit at all.
  const fitted = Math.max(1, Math.min(size, room - 2 * Math.min(start, end)));
  const at = design.start <= design.end ? lo + start : hi - end - fitted;
  return [Math.min(Math.max(at, lo), hi - fitted), fitted];
}

/** Moves (and if it must, resizes) a box into an area of its parent. Returns whether anything changed. */
export function fitInto(node: RNode, area: Rect, design?: Placement): boolean {
  const [x, w] = axis(node.x, node.w, area.x, area.x + area.w, design && { start: design.x, end: design.spanW - design.x - design.w, span: design.spanW });
  const [y, h] = axis(node.y, node.h, area.y, area.y + area.h, design && { start: design.y, end: design.spanH - design.y - design.h, span: design.spanH });
  if (Math.abs(x - node.x) < 0.01 && Math.abs(y - node.y) < 0.01 && Math.abs(w - node.w) < 0.01 && Math.abs(h - node.h) < 0.01) return false;
  resize(node, w, h); node.x = Math.round(x * 100) / 100; node.y = Math.round(y * 100) / 100;
  return true;
}

const isControl = (node: RNode): boolean => !!(node.act || node.link || node.opens || node.hint);

/** Every control and every learned state stays whole inside the box that clips it (see the module comment). */
export function keepControlsVisible(root: RNode): Fix[] {
  const fixes: Fix[] = [];
  // `chain`: the DOM ancestors from the root down to the parent. A switch is not an element: its cases sit in its parent.
  const visit = (node: RNode, chain: RNode[], isState: boolean): void => {
    if (node.kind === "switch") { for (const entry of node.cases ?? []) visit(entry, chain, true); return; }
    if ((isState || isControl(node)) && chain.length > 1) check(node, chain, isState);
    for (const child of node.children) visit(child, [...chain, node], false);
  };
  const check = (node: RNode, chain: RNode[], isState: boolean): void => {
    let clipAt = -1; for (let index = chain.length - 1; index >= 1; index--) if (clips(chain[index])) { clipAt = index; break; }
    if (clipAt < 0) return;
    const clip = chain[clipAt];
    // The parent's offset inside the clipping box.
    let px = 0, py = 0; for (const entry of chain.slice(clipAt + 1)) { px += entry.x; py += entry.y; }
    const x0 = Math.max(0, px + node.x), y0 = Math.max(0, py + node.y), x1 = Math.min(clip.w, px + node.x + node.w), y1 = Math.min(clip.h, py + node.y + node.h);
    const shown = Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / Math.max(1e-6, node.w * node.h);
    if (shown >= 0.995 || shown < 0.05) return;
    const parent = chain[chain.length - 1];
    if (parent !== clip) { const pShown = px >= -0.5 && py >= -0.5 && px + parent.w <= clip.w + 0.5 && py + parent.h <= clip.h + 0.5; if (!pShown) return; }
    let ax = 0, ay = 0; for (const entry of chain.slice(1)) { ax += entry.x; ay += entry.y; }
    const from = { x: ax + node.x, y: ay + node.y, w: node.w, h: node.h };
    if (!fitInto(node, { x: -px, y: -py, w: clip.w, h: clip.h })) return;
    fixes.push({ id: node.id, label: node.act?.label ?? node.name, by: { id: clip.id, name: clip.name }, cutPct: Math.round((1 - shown) * 1000) / 10, from, to: { x: ax + node.x, y: ay + node.y, w: node.w, h: node.h }, ...(isState ? { state: true } : {}) });
  };
  visit(root, [], false);
  return fixes;
}

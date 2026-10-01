import type { NodeFingerprint, PaintFingerprint } from "./types.ts";
import type { RNode } from "./ir.ts";
import { fitInto, visibleArea, type Placement, type Rect } from "./visibility.ts";

/**
 * Designers draw states as examples: in a row of product cards one heart is drawn red, one card shows the
 * quantity stepper instead of the cart button. Among repeated items (siblings of one structure), a small slot
 * that looks different in a minority of them is such an example, and it defines a behavior:
 *  - toggle  — same place, same size, another look (favorite, bookmark, checkbox): a click flips it;
 *  - counter — the add button replaced by "− N +" (a number between two buttons): a click adds one, the buttons
 *              count, and at zero the add button comes back.
 * What is learned from one group applies to every slot on the page that looks like either state, placed from how
 * the design places the example in its own container, so it fits items drawn at another size (see visibility.ts).
 * The design's own example is also the test oracle: after a click the slot must look like the example (see compare).
 * Behaviors are data on the IR (switch nodes with cases), so every emitter — React today — can express them.
 */
export type { Rect };
/** One place a behavior works: the element clicked first and the DOM ids of its other state (swapped-in element; − / + / number). */
export interface Instance { target: { id: string; rect: Rect; }; other: string; minus?: string; plus?: string; count?: string; }
export interface Behavior {
  key: string; kind: "toggle" | "counter"; label: string; /** How many places on the page share this behavior. */ instances: number;
  /** The element a user clicks first, as designed, and where its other state must then appear. */
  target: { id: string; rect: Rect; };
  /** Where the design itself draws the other state: the expected pixels after the click. */
  exemplar: { id: string; rect: Rect; };
  /** DOM ids of this target's other state: the swapped-in element and, for a counter, − / + / the number. */
  other: string; minus?: string; plus?: string; count?: string;
  /** One more instance for every other size the items are drawn at: clicked too, its other state must show whole. */
  alsoAt?: Instance[];
  /**
   * Places where the design draws the other state already (a liked heart, a stepper at 1). A click, or counting down
   * (`presses` times −), brings back a copy of the first state there, which must look as it does at home.
   */
  drawn?: (Instance & { presses?: number; })[];
}

const CONTAINERS = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT"]);
const visible = <T extends { visible?: boolean; }>(items: T[] | undefined): T[] => (items ?? []).filter((item) => item.visible !== false);
const paints = (list: PaintFingerprint[] | undefined): string => visible(list).map((paint) => paint.type === "image" ? "image" : `${paint.type}:${paint.color?.hex ?? ""}:${Math.round((paint.opacity ?? 1) * 100)}`).join("+");
/** What a node looks like, not what it says or shows: text characters and photo contents are data, not state. */
function look(node: NodeFingerprint): string {
  const typography = node.type === "TEXT" ? `${node.typography?.fontSize}/${node.typography?.fontWeight}` : "";
  return [node.type, Math.round(node.bounds.width), Math.round(node.bounds.height), paints(node.fills), paints(node.strokes?.flatMap((stroke) => stroke.paints)), Math.round((node.opacity ?? 1) * 100), typography,
    `[${visible(node.children).map(look).join(",")}]`].join("|");
}
const hasText = (node: NodeFingerprint): boolean => node.type === "TEXT" || visible(node.children).some(hasText);
/** The last meaningful segment of an icon-library name ("Linear / Like / Heart" → "Heart"), for accessible labels. */
function labelOf(node: NodeFingerprint, fallback: string): string {
  let found: string | undefined;
  const visit = (entry: NodeFingerprint): void => { if (!found && entry.name.includes("/")) found = entry.name.split("/").pop()!.replace(/\d+$/, "").trim(); visible(entry.children).forEach(visit); };
  visit(node); return found || fallback;
}

interface Slot { node: RNode; parent: RNode; path: string; }
interface Toggle { off: string; on: string; offSample: Slot; onSample: Slot; label: string; }
interface Counter { add: string; addSample: Slot; stepper: Slot; dx: number; dy: number; text: RNode; minus: RNode; plus: RNode; label: string; }

export function inferBehaviors(root: RNode, fingerprintOf: (id: string) => NodeFingerprint | undefined): Behavior[] {
  const parentOf = new Map<RNode, RNode>();
  const index = (node: RNode): void => { for (const child of node.children) { parentOf.set(child, node); index(child); } };
  index(root);
  const toggles = new Map<string, Toggle>(); const counters = new Map<string, Counter>();

  // ── learn from repeated items ──
  // Items are "the same" by their large regions (photo, text block); the small places are where states differ.
  const signature = (node: RNode): string => `${node.figType}|${Math.round(node.w)}|${node.children.filter((child) => child.w > 96 && child.h > 96).map((child) => `${child.kind}:${Math.round(child.w)}`).join(",")}`;
  const slotsOf = (member: RNode): Map<string, Slot> => {
    const slots = new Map<string, Slot>();
    const visit = (parent: RNode, path: string, depth: number): void => {
      for (const node of parent.children) {
        const key = `${path}/${node.name}@${Math.round(node.x)},${Math.round(node.y)},${Math.round(node.w)}x${Math.round(node.h)}`;
        slots.set(key, { node, parent, path });
        if (depth < 3 && node.kind === "box") visit(node, `${path}/${node.name}`, depth + 1);
      }
    };
    visit(member, "", 0); return slots;
  };
  const learn = (container: RNode): void => {
    const groups = new Map<string, RNode[]>();
    for (const child of container.children) if (child.kind === "box" && child.children.length) { const group = groups.get(signature(child)) ?? []; group.push(child); groups.set(signature(child), group); }
    for (const members of groups.values()) {
      if (members.length < 3) continue;
      const slots = members.map(slotsOf); const keys = new Set(slots.flatMap((map) => [...map.keys()]));
      for (const key of keys) {
        const present = slots.map((map) => map.get(key)); const found = present.filter((slot): slot is Slot => !!slot);
        const fingerprints = found.map((slot) => fingerprintOf(slot.node.id));
        if (fingerprints.some((node) => !node)) continue;
        if (found.length === members.length) {
          // toggle: the same small, textless place looks different in a minority of the items
          // …and is something one clicks: a container of button size, not a bare decorative shape (a tag's star).
          const node = found[0].node; if (node.w > 96 || node.h > 96 || node.w < 20 || node.h < 20 || !CONTAINERS.has(node.figType) || hasText(fingerprints[0]!)) continue;
          const looks = fingerprints.map((fingerprint) => look(fingerprint!)); const counts = new Map<string, number>(); looks.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
          if (counts.size !== 2) continue;
          const [[off, many], [on, few]] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
          if (few > Math.floor(members.length / 2) || many === few || toggles.has(off)) continue;
          const offSample = found[looks.indexOf(off)], onSample = found[looks.indexOf(on)];
          toggles.set(off, { off, on, offSample, onSample, label: labelOf(fingerprintOf(onSample.node.id)!, onSample.node.name) });
        } else if (found.length >= 2 && found.length < members.length) {
          // counter: where most items have this button, the others draw "− N +" over the same place
          const add = found[0]; if (add.node.w > 96 || add.node.h > 96 || counters.has(look(fingerprints[0]!))) continue;
          for (const [index, map] of slots.entries()) {
            if (present[index]) continue;
            for (const candidate of map.values()) {
              if (candidate.path !== add.path || slots.filter((other) => [...other.values()].some((slot) => slot.node.name === candidate.node.name && slot.path === candidate.path)).length > members.length / 2) continue;
              const overlaps = candidate.node.x < add.node.x + add.node.w && add.node.x < candidate.node.x + candidate.node.w && candidate.node.y < add.node.y + add.node.h && add.node.y < candidate.node.y + candidate.node.h;
              const number = candidate.node.children.find((child) => child.kind === "text" && /^\d+$/.test((child.runs ?? []).map((run) => run.text).join("").trim()));
              if (!overlaps || !number) continue;
              const others = candidate.node.children.filter((child) => child !== number);
              const minus = others.filter((child) => child.x + child.w <= number.x).sort((a, b) => b.x - a.x)[0], plus = others.filter((child) => child.x >= number.x + number.w).sort((a, b) => a.x - b.x)[0];
              if (!minus || !plus) continue;
              counters.set(look(fingerprints[0]!), { add: look(fingerprints[0]!), addSample: add, stepper: candidate, dx: candidate.node.x - add.node.x, dy: candidate.node.y - add.node.y, text: number, minus, plus, label: labelOf(fingerprintOf(add.node.id)!, add.node.name) });
            }
          }
        }
      }
    }
  };
  const walkContainers = (node: RNode): void => { if (node.kind === "box" || node.kind === "root") { learn(node); node.children.forEach(walkContainers); } };
  walkContainers(root);
  if (!toggles.size && !counters.size) return [];
  const instances = new Map<string, number>(); const tally = (key: string): void => { instances.set(key, (instances.get(key) ?? 0) + 1); };

  // ── apply to every slot on the page that looks like a learned state ──
  const absolute = (node: RNode): Rect => { let x = node.x, y = node.y; for (let parent = parentOf.get(node); parent && parent !== root; parent = parentOf.get(parent)) { x += parent.x; y += parent.y; } return { x, y, w: node.w, h: node.h }; };
  const clone = (node: RNode, suffix: string, x: number, y: number): RNode => {
    const copy = (entry: RNode): RNode => ({ ...entry, id: `${entry.id}~${suffix}`, style: { ...entry.style }, children: entry.children.map(copy), ...(entry.cases ? { cases: entry.cases.map(copy) } : {}) });
    return { ...copy(node), x, y };
  };
  // A state swapped into another item keeps its offset from what it replaces while that fits the item's visible area;
  // where the item is drawn smaller, it is placed from how the design places the example in its own container.
  const settle = (state: RNode, example: Slot, target: RNode): void => {
    const area = visibleArea(parentOf.get(target)!, (node) => parentOf.get(node));
    const design: Placement = { x: example.node.x, y: example.node.y, w: example.node.w, h: example.node.h, spanW: example.parent.w, spanH: example.parent.h };
    if (area) fitInto(state, area, design);
  };
  const find = (node: RNode, id: string): RNode | undefined => node.id === id ? node : node.children.map((child) => find(child, id)).find(Boolean);
  const replace = (node: RNode, by: RNode): void => { const parent = parentOf.get(node)!; parent.children[parent.children.indexOf(node)] = by; parentOf.set(by, parent); };
  // Every place a behavior works, by template; its context is the size its item's container and its other state have.
  interface Seen { instance: Instance; context: string; asExample: boolean; }
  const seen = new Map<string, Seen[]>(); const drawnAt = new Map<string, Map<string, Instance & { presses?: number; }>>(); const templates = new Map<string, { kind: Behavior["kind"]; label: string; exemplar: Slot; }>();
  const record = (template: string, entry: Seen): void => { const list = seen.get(template) ?? []; list.push(entry); seen.set(template, list); };
  const recordDrawn = (template: string, context: string, instance: Instance & { presses?: number; }): void => { const byContext = drawnAt.get(template) ?? new Map(); if (!byContext.has(context)) byContext.set(context, instance); drawnAt.set(template, byContext); };
  const contextOf = (target: RNode, other: RNode): string => { const parent = parentOf.get(target)!; return `${Math.round(parent.w)}x${Math.round(parent.h)}|${Math.round(other.w)}x${Math.round(other.h)}`; };
  const sameAs = (target: RNode, other: RNode, example: Slot): boolean => { const parent = parentOf.get(target)!; return Math.abs(parent.w - example.parent.w) < 1 && Math.abs(parent.h - example.parent.h) < 1 && Math.abs(other.w - example.node.w) < 1 && Math.abs(other.h - example.node.h) < 1; };
  const candidates: RNode[] = []; const collect = (node: RNode): void => { for (const child of node.children) { candidates.push(child); collect(child); } }; collect(root);
  for (const node of candidates) {
    if (!parentOf.has(node) || node.kind === "switch") continue;
    const fingerprint = fingerprintOf(node.id); if (!fingerprint) continue;
    const appearance = look(fingerprint);
    const toggle = toggles.get(appearance) ?? [...toggles.values()].find((entry) => entry.on === appearance);
    if (toggle) {
      const isOn = appearance === toggle.on; const other = isOn ? toggle.offSample : toggle.onSample;
      const swapped = clone(other.node, node.id, node.x, node.y); settle(swapped, other, node);
      const off = isOn ? swapped : node, on = isOn ? node : swapped;
      off.act = { press: node.id, on: false, label: toggle.label }; on.act = { press: node.id, on: true, label: toggle.label };
      const template = `t:${toggle.off}`; tally(template); templates.set(template, { kind: "toggle", label: toggle.label, exemplar: toggle.onSample });
      if (!isOn) record(template, { instance: { target: { id: node.id, rect: absolute(node) }, other: swapped.id }, context: contextOf(node, swapped), asExample: sameAs(node, swapped, toggle.onSample) });
      else recordDrawn(template, contextOf(node, swapped), { target: { id: node.id, rect: absolute(node) }, other: swapped.id });
      replace(node, { id: `${node.id}~state`, name: node.name, figType: "SWITCH", kind: "switch", x: node.x, y: node.y, w: node.w, h: node.h, style: {}, children: [], cases: [off, on], state: { key: node.id, kind: "toggle", initial: isOn ? 1 : 0 } });
      continue;
    }
    const counter = counters.get(appearance);
    const stepperOf = [...counters.values()].find((entry) => entry.stepper.node === node);
    if (counter || stepperOf) {
      const entry = (counter ?? stepperOf)!;
      const zero = counter ? node : clone(entry.addSample.node, node.id, node.x - entry.dx, node.y - entry.dy);
      const many = counter ? clone(entry.stepper.node, node.id, node.x + entry.dx, node.y + entry.dy) : node;
      if (counter) settle(many, entry.stepper, node); else settle(zero, entry.addSample, node);
      zero.act = { count: node.id, delta: 1, label: entry.label };
      const suffix = counter ? `~${node.id}` : "";
      const minus = find(many, `${entry.minus.id}${suffix}`)!, plus = find(many, `${entry.plus.id}${suffix}`)!, number = find(many, `${entry.text.id}${suffix}`)!;
      minus.act = { count: node.id, delta: -1, label: "−" }; plus.act = { count: node.id, delta: 1, label: "+" }; number.countOf = node.id;
      const initial = counter ? 0 : Number((entry.text.runs ?? []).map((run) => run.text).join("").trim()) || 1;
      const template = `c:${entry.add}`; tally(template); templates.set(template, { kind: "counter", label: entry.label, exemplar: entry.stepper });
      if (counter) record(template, { instance: { target: { id: node.id, rect: absolute(node) }, other: many.id, minus: minus.id, plus: plus.id, count: number.id }, context: contextOf(node, many), asExample: sameAs(node, many, entry.stepper) });
      else recordDrawn(template, contextOf(node, zero), { target: { id: node.id, rect: absolute(node) }, other: zero.id, minus: minus.id, plus: plus.id, count: number.id, presses: initial });
      replace(node, { id: `${node.id}~state`, name: node.name, figType: "SWITCH", kind: "switch", x: node.x, y: node.y, w: node.w, h: node.h, style: {}, children: [], cases: [zero, many], state: { key: node.id, kind: "counter", initial } });
    }
  }
  // One representative per behavior is held to the design's example (so one drawn at the example's size); one more
  // instance per other size the items come in is clicked too, and must show its other state whole.
  const behaviors: Behavior[] = [];
  for (const [template, list] of seen) {
    const { kind, label, exemplar } = templates.get(template)!;
    const representative = list.find((entry) => entry.asExample) ?? list[0];
    const contexts = new Set([representative.context]); const alsoAt: Instance[] = [];
    for (const entry of list) if (!contexts.has(entry.context)) { contexts.add(entry.context); alsoAt.push(entry.instance); }
    const drawn = [...(drawnAt.get(template)?.values() ?? [])];
    behaviors.push({ key: representative.instance.target.id, kind, label, instances: instances.get(template) ?? 1, ...representative.instance, exemplar: { id: exemplar.node.id, rect: absolute(exemplar.node) }, ...(alsoAt.length ? { alsoAt } : {}), ...(drawn.length ? { drawn } : {}) });
  }
  return behaviors;
}

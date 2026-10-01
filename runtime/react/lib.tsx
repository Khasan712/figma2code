// figma2code React runtime — the primitives generated pages are written in. Every element carries its
// Figma node id as data-fig so the compare harness can verify geometry and styles per node.
// Navigation uses plain anchors so this file has no router dependency; swap in your router's component if you use one.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

/** URL prefix the project serves these assets from; build-page fills it in from figma2code.json. */
export const ASSET_BASE = "/assets";
/** Files placed by build-page: image fills (<hash>.<ext>) and rendered nodes (f2c-<id>.svg|png). */
export const asset = (file: string) => `${ASSET_BASE}/${file}`;
/** Hand-written pages' convention for Figma-rendered nodes (fig-<id>.png). */
export const figAsset = (id: string) => `${ASSET_BASE}/fig-${id.replace(":", "-")}.png`;

/**
 * An element with a click action — opening an overlay (`expanded`), flipping a state (`pressed`), counting — is a
 * real button: focusable, Enter/Space, announced with its state, and its click does not reach the elements around it.
 */
interface Opener { on?: () => void; expanded?: boolean; pressed?: boolean; label?: string; }
function opener(on: (() => void) | undefined, expanded?: boolean, pressed?: boolean, label?: string) {
  if (!on) return {};
  return {
    role: "button", tabIndex: 0, "aria-label": label,
    ...(expanded !== undefined ? { "aria-haspopup": "dialog" as const, "aria-expanded": expanded } : {}),
    ...(pressed !== undefined ? { "aria-pressed": pressed } : {}),
    onClick: (event: ReactMouseEvent) => { event.stopPropagation(); on(); },
    onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); on(); } },
  };
}

interface BoxProps extends Opener {
  id: string; x?: number; y?: number; w?: number; h?: number;
  bg?: string; r?: number | string; border?: string; clip?: boolean;
  col?: boolean; row?: boolean; gap?: number; pad?: string;
  blur?: number; z?: number; flat?: boolean; to?: string; anchor?: string;
  style?: CSSProperties; children?: ReactNode;
}
/** A Figma FRAME/GROUP: absolutely placed when x/y given, flex when col/row given.
 *  `to` renders it as a router link; `anchor` gives it a DOM id for /#hash navigation. */
export function Box({ id, x, y, w, h, bg, r, border, clip, col, row, gap, pad, blur, z, flat, to, anchor, on, expanded, pressed, label, style, children }: BoxProps) {
  const css: CSSProperties = {
    position: x !== undefined || y !== undefined ? "absolute" : "relative",
    left: x, top: y, width: w, height: h, background: bg,
    borderRadius: r, border, overflow: clip ? "hidden" : undefined,
    display: col || row ? "flex" : "block", flexDirection: col ? "column" : undefined,
    alignItems: col || row ? "flex-start" : undefined,
    gap, padding: pad, backdropFilter: blur ? `blur(${blur}px)` : undefined,
    zIndex: z, flex: "0 0 auto", color: "inherit", textDecoration: "none", cursor: on ? "pointer" : undefined, ...style,
  };
  if (to) return <a href={to} data-fig={id} data-fig-flat={flat ? "" : undefined} id={anchor} style={css}>{children}</a>;
  return <div data-fig={id} data-fig-flat={flat ? "" : undefined} id={anchor} style={css} {...opener(on, expanded, pressed, label)}>{children}</div>;
}

interface TxtProps extends Opener {
  id: string; x?: number; y?: number; w?: number; h?: number;
  size: number; weight: number; lh?: number; color: string;
  /** Design font family, verbatim (the project maps it with @font-face). Overrides the ee/sw classes. */
  font?: string;
  ee?: boolean; center?: boolean; right?: boolean; caps?: boolean; z?: number;
  /** Figma auto-width text never wraps (`nowrap`); fixed-width text wraps and keeps its spaces/newlines (`wrap`). */
  nowrap?: boolean; wrap?: boolean;
  /** Vertical alignment inside a fixed-height text box. */
  valign?: "center" | "bottom";
  to?: string; anchor?: string; style?: CSSProperties; children: ReactNode;
}
/** A Figma TEXT node; lh is the exact pixel line-height from the fingerprint. */
export function Txt({ id, x, y, w, h, size, weight, lh, color, font, ee, center, right, caps, z, nowrap, wrap, valign, to, anchor, on, expanded, pressed, label, style, children }: TxtProps) {
  // An overflowing single line must overflow around its alignment point, and a fixed box may align its lines
  // vertically — both need the text in an inner block of a flex column.
  const flexed = valign !== undefined || (nowrap === true && (center === true || right === true));
  const content = flexed ? <div style={{ flex: "0 0 auto" }}>{children}</div> : children;
  const css: CSSProperties = {
    position: x !== undefined || y !== undefined ? "absolute" : "relative",
    left: x, top: y, width: w, height: h, display: flexed ? "flex" : "block",
    flexDirection: flexed ? "column" : undefined,
    justifyContent: valign === "center" ? "center" : valign === "bottom" ? "flex-end" : undefined,
    alignItems: flexed ? (nowrap ? (center ? "center" : right ? "flex-end" : "flex-start") : "stretch") : undefined,
    whiteSpace: nowrap ? "pre" : wrap ? "pre-wrap" : undefined,
    fontFamily: font ? `"${font}", sans-serif` : undefined,
    fontSize: size, fontWeight: weight, lineHeight: lh !== undefined ? `${lh}px` : undefined,
    color, textAlign: center ? "center" : right ? "right" : undefined,
    textTransform: caps ? "uppercase" : undefined, textDecoration: "none",
    zIndex: z, flex: "0 0 auto", cursor: on ? "pointer" : undefined, ...style,
  };
  if (to) return <a href={to} data-fig={id} id={anchor} className={font ? undefined : ee ? "ee" : "sw"} style={css}>{content}</a>;
  return <div data-fig={id} id={anchor} className={font ? undefined : ee ? "ee" : "sw"} style={css} {...opener(on, expanded, pressed, label)}>{content}</div>;
}

interface PicProps extends Opener { id: string; src: string; x?: number; y?: number; w: number; h: number; r?: number | string; z?: number; contain?: boolean; flat?: boolean; style?: CSSProperties; }
/** A Figma node rendered as an image (image fill or exported vector render). */
export function Pic({ id, src, x, y, w, h, r, z, contain, flat, on, expanded, pressed, label, style }: PicProps) {
  return <img data-fig={id} data-fig-flat={flat ? "" : undefined} src={src} alt={label ?? ""} loading="lazy" decoding="async" {...opener(on, expanded, pressed, label)} style={{
    position: x !== undefined || y !== undefined ? "absolute" : "relative",
    left: x, top: y, width: w, height: h, borderRadius: r,
    objectFit: contain ? "contain" : "cover", zIndex: z, flex: "0 0 auto", cursor: on ? "pointer" : undefined, ...style,
  }} />;
}

/** A Figma LINE node (0-thickness in the design, drawn 1px). */
export function Rule({ id, x, y, w, h, color }: { id: string; x: number; y: number; w: number; h: number; color: string; }) {
  return <div data-fig={id} style={{ position: "absolute", left: x, top: y, width: Math.max(w, 1), height: Math.max(h, 1), background: color }} />;
}

/** Invisible geometry marker for a node whose pixels live inside a Figma-rendered parent PNG. */
export function Marker({ id, x, y, w, h }: { id: string; x: number; y: number; w: number; h: number; }) {
  return <div data-fig={id} style={{ position: "absolute", left: x, top: y, width: w, height: h, pointerEvents: "none" }} />;
}

interface PageProps { id: string; w: number; h: number; minW: number; fluid?: boolean; style?: CSSProperties; children?: ReactNode; }
/**
 * The page root. A fluid page fills the viewport width while its layers keep their anchoring (full-width layers
 * stretch, the content column stays centered); below `minW` — or below `w` for a fixed page — the whole page is
 * scaled down, so it never scrolls sideways. At the design width nothing moves.
 */
export function Page({ id, w, h, minW, fluid, style, children }: PageProps) {
  const base = fluid ? minW : w;
  const fit = (): number => typeof document === "undefined" ? 1 : Math.min(1, document.documentElement.clientWidth / base);
  const [zoom, setZoom] = useState(fit);
  useEffect(() => {
    const update = () => setZoom(fit());
    update(); window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  const scaled = zoom < 0.999;
  return <div data-fig={id} className="page" style={{
    position: "relative", width: fluid && !scaled ? "100%" : base, minWidth: fluid && !scaled ? minW : undefined,
    height: h, margin: "0 auto", overflow: "hidden", zoom: scaled ? zoom : undefined, ...style,
  }}>{children}</div>;
}

interface PopupProps { open: boolean; trigger: string; dx: number; dy: number; ms?: number; label?: string; onClose: () => void; children: ReactNode; }
/**
 * A Figma prototype overlay (manual position): opened by its trigger, placed at the design's offset from it, and
 * closed by the trigger again, by Escape (focus returns to the trigger) or by a click anywhere outside.
 */
export function Popup({ open, trigger, dx, dy, ms, label, onClose, children }: PopupProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [at, setAt] = useState<{ x: number; y: number; } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const place = () => {
      const panel = ref.current; const page = panel?.closest<HTMLElement>(".page");
      const opener = document.querySelector(`[data-fig="${CSS.escape(trigger)}"]`);
      if (!panel || !page || !opener) return;
      // Rects are in zoomed pixels; the panel is positioned inside the (possibly zoomed) page in its own units.
      const zoom = parseFloat(getComputedStyle(page).zoom) || 1;
      const from = opener.getBoundingClientRect(), origin = page.getBoundingClientRect();
      setAt({ x: (from.left - origin.left) / zoom + dx, y: (from.top - origin.top) / zoom + dy });
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, trigger, dx, dy]);
  useEffect(() => {
    if (!open) return;
    const opener = document.querySelector<HTMLElement>(`[data-fig="${CSS.escape(trigger)}"]`);
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { close.current(); opener?.focus({ preventScroll: true }); } };
    const onDown = (event: PointerEvent) => { const target = event.target as Node; if (!ref.current?.contains(target) && !opener?.contains(target)) close.current(); };
    document.addEventListener("keydown", onKey); document.addEventListener("pointerdown", onDown);
    ref.current?.focus({ preventScroll: true });
    if (ms) ref.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "linear" });
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, trigger, ms]);
  if (!open) return null;
  return <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} style={{ position: "absolute", left: at?.x ?? 0, top: at?.y ?? 0, zIndex: 1000, outline: "none", visibility: at ? "visible" : "hidden" }}>{children}</div>;
}

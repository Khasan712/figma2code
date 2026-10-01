export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NodeType =
  | "DOCUMENT" | "PAGE" | "FRAME" | "GROUP" | "SECTION" | "SLICE"
  | "COMPONENT" | "COMPONENT_SET" | "INSTANCE" | "TEXT" | "RECTANGLE"
  | "ELLIPSE" | "POLYGON" | "STAR" | "LINE" | "VECTOR" | "BOOLEAN_OPERATION"
  | "STAMP" | "WIDGET" | "EMBED" | "LINK_UNFURL" | "SHAPE_WITH_TEXT" | "UNKNOWN";

export interface Color { r: number; g: number; b: number; a: number; hex?: string; }
export interface Bounds { x: number; y: number; width: number; height: number; absoluteX?: number; absoluteY?: number; }
/** Ink/effect extent of the rendered node (Figma absoluteRenderBounds) — larger than bounds for shadows, strokes, unclipped overflow. */
export interface RenderBounds { x: number; y: number; width: number; height: number; }
/** matrix follows CSS matrix(a, b, c, d, tx, ty) column order, not Figma's row-major layout. */
export interface Transform { rotation?: number; matrix?: [number, number, number, number, number, number]; }
export interface ViewportInfo { width: number; height: number; deviceScaleFactor: number; mode: "desktop" | "tablet" | "mobile" | "custom"; }
export interface SourceInfo { provider: "figma"; fileKey: string; fileName: string; sourceType: "rest" | "mcp" | "mcp+rest"; version?: string; lastModified?: string; extractedAt: string; }
export interface DocumentInfo { id: string; name: string; pageCount: number; nodeCount: number; rootNodeId: string; }
export interface LayoutFingerprint {
  mode: "none" | "horizontal" | "vertical" | "grid" | "absolute";
  primaryAxisAlign?: string; counterAxisAlign?: string;
  padding?: { top: number; right: number; bottom: number; left: number; };
  itemSpacing?: number; counterAxisSpacing?: number; layoutWrap?: boolean;
  /** Auto-layout "first on top": children paint in reverse array order. */
  reverseZ?: boolean;
  sizing?: { width: "fixed" | "fill" | "hug"; height: "fixed" | "fill" | "hug"; };
  minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number;
  overflow?: "visible" | "hidden" | "scroll";
}
export interface TypographyFingerprint {
  fontFamily?: string; fontPostScriptName?: string; fontSize?: number; fontWeight?: number;
  lineHeight?: { unit: "px" | "percent" | "auto"; value?: number; };
  /** Computed line height in px — always present in REST data, including for AUTO line heights. */
  lineHeightPx?: number;
  /** How the text box sizes itself: decides nowrap vs wrap and whether vertical alignment is observable. */
  autoResize?: "none" | "height" | "width-and-height" | "truncate";
  italic?: boolean;
  letterSpacing?: number; textAlignHorizontal?: "left" | "center" | "right" | "justified";
  textAlignVertical?: "top" | "center" | "bottom";
  textCase?: "original" | "uppercase" | "lower" | "title";
  textDecoration?: "none" | "underline" | "strikethrough";
  paragraphSpacing?: number; maxLines?: number;
}
export interface PaintFingerprint {
  type: "solid" | "linear-gradient" | "radial-gradient" | "angular-gradient" | "diamond-gradient" | "image" | "pattern";
  opacity?: number; color?: Color; gradient?: { stops: { position: number; color: Color; }[]; handles?: { x: number; y: number; }[]; };
  imageRef?: string; visible: boolean;
  /** Image paints: "stretch" is the UI's Crop mode and carries imageTransform (node unit square → image UV). */
  scaleMode?: "fill" | "fit" | "tile" | "stretch";
  imageTransform?: [[number, number, number], [number, number, number]];
  scalingFactor?: number; blendMode?: string; hasFilters?: boolean;
}
export interface StrokeFingerprint { paints: PaintFingerprint[]; weight: number; align: "inside" | "outside" | "center"; join: "miter" | "bevel" | "round"; cap: "none" | "round" | "square" | "arrow"; }
export interface EffectFingerprint { type: "drop-shadow" | "inner-shadow" | "layer-blur" | "background-blur"; visible: boolean; radius?: number; offset?: { x: number; y: number; }; spread?: number; color?: Color; }
export interface CornerRadius { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number; }
export interface AssetReference { id: string; type: "image" | "svg" | "vector" | "icon" | "unknown"; name?: string; sourceNodeId?: string; imageRef?: string; componentKey?: string; hash?: string; localPath?: string; dimensions?: { width: number; height: number; }; export?: { format: "png" | "jpg" | "svg"; scale?: number; }; }
export interface ComponentReference { type: "component" | "instance" | "component-set"; componentId?: string; componentKey?: string; name?: string; variant?: Record<string, string>; properties?: Record<string, string | boolean | number>; }
export interface ConstraintFingerprint { horizontal: "left" | "right" | "center" | "left-right" | "scale"; vertical: "top" | "bottom" | "center" | "top-bottom" | "scale"; }
export interface ExportSetting { format: "png" | "jpg" | "svg" | "pdf"; constraint?: { type: string; value: number; }; }
export interface ContentFingerprint { kind: "text"; text: string; characters: number; segments?: TextSegment[]; }
export interface TextSegment { start: number; end: number; typography?: TypographyFingerprint; fills?: PaintFingerprint[]; }
export interface NodeFingerprint {
  id: string; name: string; type: NodeType; visible: boolean; locked?: boolean; bounds: Bounds; transform?: Transform;
  layout?: LayoutFingerprint; typography?: TypographyFingerprint; fills?: PaintFingerprint[]; strokes?: StrokeFingerprint[];
  effects?: EffectFingerprint[]; cornerRadius?: CornerRadius; opacity?: number; content?: ContentFingerprint;
  asset?: AssetReference; component?: ComponentReference; children?: NodeFingerprint[]; constraints?: ConstraintFingerprint;
  renderBounds?: RenderBounds;
  /** Unrotated width/height (bounds is the axis-aligned box after transforms). */
  size?: { width: number; height: number; };
  /** clipsContent as authored: true/false when Figma reports it, undefined for legacy extractions. */
  clips?: boolean;
  /** Ellipse arc data when the shape is not a full disc (ring/pie) — not expressible as border-radius. */
  arc?: { start: number; end: number; inner: number; };
  isMask?: boolean; blendMode?: string;
  /** Absolutely positioned child inside an auto-layout parent. */
  absolute?: boolean;
  strokeWeights?: { top: number; right: number; bottom: number; left: number; };
  strokeDashes?: number[];
  /** Prototype ON_CLICK navigation or URL — lets the generator wire links without guessing. */
  /**
   * Prototype click action: go to another frame ("navigate", a route once that frame is built) or open it as an
   * overlay ("overlay", placed at `offset` from this node — Figma's manual position). `ms`: transition duration.
   */
  link?: { nodeId?: string; url?: string; navigation?: "navigate" | "overlay" | "back" | "close"; offset?: { x: number; y: number; }; ms?: number; };
  exportSettings?: ExportSetting[]; style?: { fillStyleId?: string; textStyleId?: string; effectStyleId?: string; gridStyleId?: string; boundVariables?: Record<string, unknown>; };
  hash: string;
}
export interface PageFingerprint { id: string; name: string; children: NodeFingerprint[]; bounds: Bounds; targetId?: string; hash: string; }
export interface StyleDefinition { id: string; key?: string; name: string; type: "FILL" | "TEXT" | "EFFECT" | "GRID"; description?: string; remote?: boolean; }
export interface StyleRegistry { fills: StyleDefinition[]; texts: StyleDefinition[]; effects: StyleDefinition[]; grids: StyleDefinition[]; }
export interface ComponentDefinition { id: string; key?: string; name: string; description?: string; nodeId: string; setId?: string; thumbnailUrl?: string; }
export interface ComponentSetDefinition { id: string; key?: string; name: string; description?: string; nodeId: string; }
export interface ComponentRegistry { components: ComponentDefinition[]; componentSets: ComponentSetDefinition[]; }
export interface VariableRegistry { collections: { id: string; name: string; modes?: { id: string; name: string; }[]; }[]; variables: { id: string; name: string; type: "color" | "number" | "string" | "boolean"; collectionId: string; scopes?: string[]; values: Record<string, unknown>; resolvedValue?: unknown; }[]; }
export interface AssetRegistry { items: AssetReference[]; }
export interface VisualTarget { id: string; nodeId: string; type: "page" | "frame" | "component" | "section"; viewport: ViewportInfo; format: "png"; scale: number; imageUrl?: string; localPath?: string; width: number; height: number; hash?: string; }
export interface FingerprintStatistics { pages: number; frames: number; nodes: number; textNodes: number; imageNodes: number; vectorNodes: number; components: number; instances: number; uniqueColors: number; uniqueFonts: number; assets: number; }
export interface FingerprintHashes { structure: string; geometry: string; typography: string; colors: string; assets: string; styles: string; overall: string; }
export interface DesignFingerprintV1 {
  schema: "design-fingerprint"; version: "1.0"; source: SourceInfo; document: DocumentInfo; viewport: ViewportInfo;
  pages: PageFingerprint[]; assets: AssetRegistry; components: ComponentRegistry; styles: StyleRegistry; variables: VariableRegistry;
  targets: VisualTarget[]; statistics: FingerprintStatistics; hashes: FingerprintHashes;
}
export type FigmaNode = Record<string, unknown>;
export interface FigmaFileResponse { name?: string; version?: string; lastModified?: string; document: FigmaNode; components?: Record<string, FigmaNode>; componentSets?: Record<string, FigmaNode>; styles?: Record<string, FigmaNode>; }

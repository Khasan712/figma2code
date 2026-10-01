---
name: figma-implement
description: Implement or fix a page/screen from a Figma design with automated pixel + geometry verification. Use when the user provides a figma.com URL and asks to implement/build/code a design, or asks to fix/verify an existing implementation against Figma. One command compiles the design into a verified page (code, assets, route, verdict); the model only acts on what the verdict names.
---

# Figma Implement — compiled, verified design-to-code

The toolkit is a **compiler**, not a reference you transcribe from. `build-page` does extract → compile → assets → code → route → verify by itself and prints a ~15-line verdict. Your job is to run it, read the verdict, and handle the exceptions it names. A page that takes more than ~5 tool calls means you left the fast path — stop and re-read this file.

Toolkit root (`$TOOLKIT` below): `$FIGMA2CODE_ROOT`, the folder the figma2code repository was cloned into. If it is not set, resolve it from this skill's own location — the skill lives at `<toolkit>/.claude/skills/figma-implement/SKILL.md` (follow the symlink when it was installed by link). Live extraction needs `FIGMA_ACCESS_TOKEN` (the toolkit loads its own `.env`; never print it).

## Budget rules (non-negotiable)

1. **Do not transcribe, do not pre-read.** No reading `digest.md` / `fingerprint.json` / `target.png` before building. No opening the generated `.tsx` to "review" it. The compare is the review.
2. **Never estimate a visual value** from a screenshot. Every value comes from the extraction; if one is genuinely missing, say so.
3. **Never hand-edit a generated page to fix fidelity.** A rebuild overwrites it. Fidelity problems are fixed in the project (fonts, global CSS, router) or in the compiler rule (`$TOOLKIT/src/ir.ts` + a test) so every page benefits.
4. **Figma API calls are scarce.** View/Collab seats get only a few file/render requests per *month*. Never retry a 429, never loop on the API. `build-page` remembers a 429 (`outputs/.cache/figma-rate-limit.json`), stops asking, and falls back to pixel-identical crops of the design render. A 429 that says limit type `low` is a seat problem, not a speed problem — tell the user (see the verdict table).
5. **Report honestly.** Quote the verdict numbers. Never claim pixel-perfection the verdict does not show.
6. **Never force past the guard.** `build-page` checks everything before writing and, if anything is off, refuses and changes nothing: a target file that it did not generate, or generated and someone edited since (every generated file starts with a `figma2code-signature` line), a route claimed by two pages, an unrelated file where the runtime goes, a missing `package.json`/`npm install`, or a Figma render it knows is rate-limited. Tell the user exactly what it printed — never delete, move or rename their files to get past it; that is their call.

## 1. Build — one command for ALL requested pages

```bash
npm --prefix "$TOOLKIT" run build-page -- --project <ABS_PROJECT_DIR> \
  --page "Home|/|<figma url of the home FRAME>" \
  --page "News|/news|<figma url of the news FRAME>"
```

- One `--page "PascalName|/route|figma-url"` per page. Single page form: `--name Home --route / --figma-url <URL>`. A URL must carry the `node-id` of the frame to build.
- **Link without a `node-id`** (a whole file, a page, a Dev Mode link)? List the frames first:
  `npm --prefix "$TOOLKIT" run frames -- --figma-url '<URL>'` — ONE request reads the whole file and prints every top-level frame with its size and a ready `--page` line; `build-page` then takes the node trees from that read (no `/nodes` request) for 12 h. Build the page frames only — skip component strips (Navigation, Footer, dropdowns), design-system boards, Trash and near-empty drafts — and say which you skipped and why.
- **Always pass every page of the request in ONE run.** Per Figma file the run sends one `/nodes` request for all pages, one render request for all page targets, one render request per asset format (SVG, PNG@2x) for every icon/vector of every page — started while the targets are still rendering — and one image-fill lookup: a whole site costs ~4–5 Tier-1 requests instead of ~4 per page.
- A fresh page takes **2–5 minutes, almost all of it Figma's server-side render** of the frame. Run with a 10-minute timeout (or in the background) and wait — do not poll, do not start a second run.
- Re-runs reuse the extraction under `$TOOLKIT/outputs/` (a new page gets `outputs/<project-folder>/<kebab-name>/`; 0 API calls, ~5 s). `--refresh` re-extracts after the design changed. `--design <dir>` builds from an existing extraction. `--mode crop` never asks Figma for asset renders; `--mode api` upgrades earlier crop fallbacks to real renders (spends render quota — only when the user wants it).
- Everything the tool writes goes into folders of its own unless `figma2code.json` says otherwise: pages and the runtime primitives in `src/figma2code/` (`Box/Txt/Pic`, every element tagged `data-fig="<nodeId>"`), the route list in `src/figma2code/routes.tsx`, assets in `public/figma2code/` (`f2c-<nodeId>.<ext>`, tracked in `figma2code-assets.json`). It never edits the project's router, `package.json`, styles or components.
- Frames that the pages open as prototype overlays (dropdowns, popups) are found in the pages' click actions and built in the same run, from the same Figma requests; their verdicts come after the pages'.
- The runtime file is signed like every generated file: an untouched copy is upgraded automatically when the compiler needs more of it; a customized one that lacks what pages now use (`Page`, `Popup`, …) stops the build with the exact exports to add.
- The first run writes `figma2code.json` (those folders + the project's own dev server, detected from `package.json`: vite, next or react-scripts) and the runtime. Mount the routes **once**:

```tsx
import { figmaRoutes } from "./figma2code/routes";
// inside <Routes>:
{figmaRoutes.map(({ path, Component }) => <Route key={path} path={path} element={<Component />} />)}
```

  The project must exist with its dependencies installed (`package.json`, `npm install`) and use React with any router; a dev server other than vite/next/react-scripts goes in `figma2code.json` → `dev.command` (with `{port}`). No project yet → scaffold a Vite React-TS app first, add `body { margin: 0 }`.

## 2. Read the verdict — that IS the review

```
Home → src/pages/Home.tsx (route /, 325 elements, 19 flats: 18 rendered / 1 cropped / 0 cached, 27 images)
PASS — pixel 0.88% = text 0.59 + photo 0.08 + asset 0.19 + UNEXPLAINED 0.02; 0 violations; coverage 100%
```

**PASS → the page is done.** Report the line to the user and move on. Residual `text` % is font rasterization/substitution, `photo` % is image resampling; `UNEXPLAINED` is the number that must stay ≈0.

**FAIL → act only on the named reasons, in this order:**

| Verdict line | Meaning | Action |
|---|---|---|
| `font … not loaded — text renders in a fallback face` (high violation) | the page renders in a fallback font; every text number is unreliable | project-level, once: add `@font-face` for the design's family (see Fonts). Rebuild. |
| `selfcheck … the PROJECT is interfering` | the same output passes as static HTML | fix the project: global CSS touching `div/img/a`, route not mounted, assets dir not served, `body` margin. Not the page. |
| `note: Canvas size mismatch (expected W×H, actual …)` | page renders at the wrong size | something wraps/constrains the page root — fix that first, other numbers are unreliable. |
| `[outlier] Name (id) N% of its box differs` / `[hotspot] … → …/hotspot-K.png` | one concrete region differs beyond rendering noise | open **that one** triptych (design \| actual \| diff). If it is a compiler gap (a Figma feature drawn wrong), fix the rule in `$TOOLKIT/src/ir.ts`, add a test in `tests/genpage.test.ts`, rebuild. If it is a design-data limit (e.g. `generator notes: image has Figma filters`), accept it and report it. |
| `N violations (high…)` | a node's geometry/typography/color differs | each names nodeId, property, expected, actual. In generated pages this means project CSS is overriding inline styles — find the rule, don't patch the page. |
| `fit: horizontal scroll at …` / `at 1440px … differs from the design's center crop` | the page does not meet some viewport width, or its fluid layout moved something | a layer broke the centered-column rule the compiler inferred (e.g. content hugging a frame edge with no Figma constraint). Fix the anchoring rule in `$TOOLKIT/src/ir.ts` (`fitPage`) + test — never patch widths in the page. |
| `overlay: … does NOT close` / `opens at (x, y) … design says …` / `clicking the trigger again does not close the overlay` | a prototype overlay misbehaves | runtime `Popup` or trigger wiring issue — fix `$TOOLKIT/runtime/react/lib.tsx` / `src/emit.ts`, rebuild. |
| `behaviors: Heart toggle ×15 (click → as designed 1.46%, again → back 0%)` | a state the designer drew as an example was learned and clicked through | informational — report it. `(not exercised: covered by <id>)` means a modal the design draws over the page hides those items; that is correct. |
| `<Label> toggle/counter: after a click it looks unlike the design's example` / `does not count up` / `original state comes back changed` / `at <id>: its other state is cut by <box>` | a learned behavior does not reproduce the design's own example, or does not fit an item drawn at another size | a wrong inference, placement or wiring: fix the rule in `$TOOLKIT/src/behaviors.ts` / `src/visibility.ts` (or the switch emit in `src/emit.ts`) + a test, rebuild. Never hand-edit the page. |
| `… carries the background of where the design drew it (a square)` / `copies clean 2/3` | a copy of a state shown away from where the design draws it (a card whose stepper counts back to zero, a heart un-liked) brings a patch of the design's pixels from around it | an asset cut from the design holds more than its artwork: the part CSS can draw (a chip, a disc) must stay CSS — fix the flattening rule in `$TOOLKIT/src/ir.ts` (`drawsOwnChip`) + a test, rebuild. |
| `[seam] N rendered asset(s) show a square of the design's background around their artwork` | a design crop sits on a background the page paints slightly differently (a browser blur vs Figma's) | reported; `--mode api` renders assets with transparency (spends quota — ask first). Large Δ means a compiler gap. |
| `N control(s) shown cut by a box they sit in` | a button or link is partly hidden by a clipping container on the page | the compiler should have moved it inside (`fixed:`): a gap in `$TOOLKIT/src/visibility.ts` or project CSS clipping it. Fix the rule + test, never the page. |
| `fixed: <label> (<id>) was N% cut by <box> in the design → moved inside` | the design itself draws a control half outside the box that clips it (a paste never adjusted); the page shows it whole | informational — tell the user, so the designer can fix the file. Those pixels count as `fixed`, not as unexplained. |
| `the color of <node> differs over its whole area: design rgb(…), page rgb(…) (Δn)` | a whole area is a few percent off although no single pixel crosses the diff threshold: a layer missing or extra, a tint, a blend, an image shown at the wrong scale | find the compiler rule (fill order, blend, scale mode) in `$TOOLKIT/src/ir.ts` + a test, rebuild. `[color]` lines without ✗ are reported only; `— Figma image filters…` / `— a background blur…` are known limits: accept and report. |
| `healed: …` | an isolated Figma render did not match and was auto-replaced by the design's own pixels | informational. |
| `warning: Figma render unavailable (429 …)` | assets came from design crops (exact at 1×, softer on retina) | informational; `--mode api` upgrades them once the API opens (spends render quota — ask the user first). If it says limit type `low`, tell the user: the token's user has a View/Collab seat on the plan that owns the file — use a token of a user with a Dev or Full seat there, or work from a copy of the file in a team where they have one (then take the new frame links). |

Inner iterations while fixing: `npm --prefix "$TOOLKIT" run compare -- --design "$TOOLKIT/outputs/<slug>" --url http://localhost:PORT/route --fast` (geometry only, <1 s). Run the full `build-page` once at the end. Stop after 2 rounds without improvement and report what remains and why.

## 3. Project-level work (once per project, after pages pass)

- **Fonts.** The verdict's `fonts:` line lists every family/weight the design uses. Load them under the design's exact family names (`font-display: block`). Licensed font missing → never eyeball a substitute: measure candidates against the design's single-line text boxes (width ratio → `size-adjust`), ship the substitute *under the design's family name* with the real file first in `src:` so dropping the licensed file in later needs no code change. Say clearly that a substitute is in use.
- **Navigation.** Prototype links between built pages become router links automatically (rebuild after all pages are registered). Anything else: wire with `to=` on the primitives; keep `color: inherit; text-decoration: none`; instant `window.scrollTo` on route change (smooth scrolling silently no-ops in some embedded Chromium contexts).
- **Responsive.** Every page already fits every screen (verified at 360–2560px): a centered-column design becomes fluid — full-width layers stretch, the column stays centered — and below the column plus a gutter (or for any other layout below its width) the whole page scales; there is never a horizontal scroll. A breakpoint the designer drew separately (a mobile frame) is still its own page (`HomeMobile`) switched by media query; only build breakpoints that exist in the design.
- **Interactivity the design shows.** Designers draw states as examples: among repeated items (a row of product cards) one heart is red, one card shows "− 1 +" instead of its cart button. The compiler learns these (`src/behaviors.ts`) and applies them to every matching item on the page — a slot that looks different in a minority of items is a **toggle** (click flips it, `aria-pressed`), an add button replaced by a number between two buttons is a **counter** (click → 1, +/−, at 0 the add button returns). Items keep the states the design draws. The compare clicks one instance of each and checks it against the design's own example pixels, then one item of every other size the items come in (`shown whole in 2/2 item sizes`). Nothing is keyed to names or texts, so it works for any design; a state that has no example in the design is not invented — ask the user, or wire it after ejecting.
- **Real components / more interactivity.** Beyond prototype actions and learned behaviors, generated pages are verified static views with absolute layout (deliberate: substituted-font metrics cannot cascade). When the user asks for stateful components, forms or shared partials (header/footer), *eject*: copy the generated page to a hand-owned file, remove its entry from `figma2code.pages.json`, refactor in small steps keeping every `data-fig` id, and run `compare --fast` after each step — geometry must stay identical.
- **Performance** is built in: image fills are capped at 2× their displayed size, images are lazy + async-decoded, icons are SVG. Large offscreen sections may add `content-visibility: auto` (the compare forces it visible).

## 4. Fix-only mode (existing hand-written page vs Figma)

Extract (or reuse `outputs/<slug>`), make sure elements carry `data-fig="<nodeId>"` (add by matching structure; `digest.md` lists ids with geometry — targeted lookups only), then run `compare` and fix exactly what it names, severity high → low. `unmapped` = missing or untagged element. Same stop rule: 2 rounds without improvement → report.

## What the compiler already decides (do not redo by hand)

Pages fit the viewport (fluid centered column or scale-to-fit; explicit Figma constraints right/scale/left-right win) · Figma prototype actions become behaviour: "navigate" → router links, "back" → history back, "open overlay" → the overlay frame is built automatically as `<Name>Overlay` and opens as an accessible popup at the designer's offset from its trigger (button role, aria-expanded, Escape/outside-click/trigger-again close, focus return), the overlay's own copy of its trigger and "close overlay" actions close it, verified on its page · states the designer drew as examples become behaviour (see below), placed in every item from how the design places the example in its own container, so they fit items drawn at other sizes · controls the design draws cut by the box that clips them are moved inside and reported (`fixed:`) · a button drawn as an opaque chip around its artwork (a white circle with a shadow, a yellow "+" disc) stays CSS and only the artwork becomes an asset, so its copies carry nothing from around it · button-like elements (a painted rounded pill with one short label, a painted icon button) get a pointer cursor · fills paint bottom to top: a color layer above a photo (a 5% black wash) is painted over it, not behind it · 
Paint opacity → rgba · exact CSS gradients from Figma handles · accumulated flips/rotations · strokes painted above children (overlay, no layout shift) · one-sided line strokes (hairlines land on the design's pixel row) · shadows/blur (Figma radius = 2σ) · text sizing modes, vertical alignment, mixed-size runs · image crop mode · icons/vectors/arcs/masks/rotated/illustration subtrees → one Figma-rendered asset (`data-fig-flat`, SVG or PNG@2x) placed by render bounds, re-anchored when an ancestor clips it · a crop under a translucent solid layer (a modal's dimming backdrop) has that layer divided out, since the page paints it again · glass (background-blur) containers stay real CSS `backdrop-filter` boxes · design quirks (typos, odd font-name variants) are reproduced verbatim — the design is the spec.

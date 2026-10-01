# figma2code

Turn Figma frames into verified React + TypeScript pages with one command.

figma2code is a [Claude Code](https://claude.com/claude-code) skill backed by a deterministic compiler. It reads the design through the Figma REST API, compiles it into code and assets, and mounts the routes in your project. Then it opens every page in a real browser and checks it, pixel by pixel, against Figma's own render of the frame. The model does not transcribe the design: it runs one command, reads a short verdict and acts only on what the verdict names.

## How it works

1. **Extract.** The frame is read through the Figma REST API: geometry, paints, text, effects, prototype links, Figma's render of the frame and the image fills.
2. **Compile.** Compiler rules turn the design into React components:
   - layout is absolute, from the design's exact boxes;
   - icons and vectors become SVG or PNG assets;
   - the page fits every screen width;
   - prototype overlays (dropdowns, popups) become working components;
   - states the design draws as examples (a liked heart, a cart counter) become interactions.
3. **Write.** Pages, assets and a route list go into folders of their own in your project.
4. **Verify.** The project's dev server is started and every page is compared with Figma's render, both per element and per pixel. Overlays and interactions are clicked for real, and the page is checked at 9 screen widths.

## Requirements

- Node.js 22.6 or newer.
- A Figma personal access token with the `file_content:read` scope and access to the file.
- A React project. React Router is recommended for the generated route list.
  - Vite, Next.js and Create React App dev servers are detected for verification.
  - Any other dev command can be set in `figma2code.json`.
- [Claude Code](https://claude.com/claude-code), to use it as a skill. This is optional: the command line works on its own.

## Installation

```bash
git clone https://github.com/Khasan712/figma2code.git
cd figma2code
npm install
npx playwright install chromium
cp .env.example .env   # then set FIGMA_ACCESS_TOKEN in .env
```

To use the skill from any project, link it into your Claude Code skills and tell it where figma2code lives:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/.claude/skills/figma-implement" ~/.claude/skills/figma-implement
echo "export FIGMA2CODE_ROOT=\"$PWD\"" >> ~/.zshrc   # or your shell's profile
```

**About the Figma token.** Figma limits "Tier 1" requests (file nodes and renders) by the seat that the token's user holds on the plan that owns the file.
- A View or Collab seat gets only a handful of requests per month.
- A Dev or Full seat gets per-minute limits.

If you hold only a View seat in the file's team, duplicate the file into a team where you hold an editor seat and use the new links.

## Usage

### With Claude Code

Open your project in Claude Code and ask:

```text
/figma-implement Build the home page from https://www.figma.com/design/FILE_KEY/Site?node-id=12-34
```

A plain request that contains a Figma link also triggers the skill. The skill then works in this order:
1. If the link has no `node-id`, it lists the file's frames first.
2. It builds every requested page in one run.
3. It reports the verdict.

A fresh page takes 2–5 minutes, almost all of it Figma rendering the frame on its servers.

### From the command line

```bash
# List the frames of a file: one request, cached for 12 h
npm run frames -- --figma-url 'https://www.figma.com/design/FILE_KEY/Site'

# Build one page
npm run build-page -- --project ../my-site --name Home --route / \
  --figma-url 'https://www.figma.com/design/FILE_KEY/Site?node-id=12-34'

# Build several pages in one run (recommended: they share every Figma request)
npm run build-page -- --project ../my-site \
  --page "Home|/|https://www.figma.com/design/FILE_KEY/Site?node-id=12-34" \
  --page "News|/news|https://www.figma.com/design/FILE_KEY/Site?node-id=56-78"
```

| Option | Meaning |
| --- | --- |
| `--page "Name\|/route\|url"` | A page to build; repeat it for more pages. `Name` is PascalCase. |
| `--name`, `--route`, `--figma-url` | The single-page form of the same. |
| `--mode auto\|api\|crop` | How assets are made. `auto` (the default) renders icons through the Figma API and falls back to crops of the frame render. `crop` never asks Figma for asset renders. `api` also upgrades earlier crops, which spends render quota. |
| `--refresh` | Re-extract after the design changed. Without it, the cached extraction is reused with no requests. |
| `--no-verify` | Skip the browser verification. |
| `--base-url http://localhost:PORT` | Verify against a server that is already running. |

Mount the generated routes once:

```tsx
import { figmaRoutes } from "./figma2code/routes";
// inside <Routes>:
{figmaRoutes.map(({ path, Component }) => <Route key={path} path={path} element={<Component />} />)}
```

### What gets written

| Path | Content |
| --- | --- |
| `src/figma2code/<Name>.tsx` | The page. Every element is tagged `data-fig="<nodeId>"`. |
| `src/figma2code/<Name>Overlay.tsx` | The prototype overlays the pages open. |
| `src/figma2code/lib.tsx` | The runtime primitives the pages use: `Box`, `Txt`, `Pic`, `Page`, `Popup`. |
| `src/figma2code/routes.tsx` | The route list, `figmaRoutes`. |
| `public/figma2code/` | Assets: icons and vectors as SVG, artwork as PNG@2x, photos capped at 2× their displayed size. |
| `figma2code.json` | The folders and the dev command. It is written on the first run and can be edited. |

The build never edits your router, `package.json`, styles or components. Every file it writes carries a signature, and it never overwrites a file that it did not write or that was edited after it was written.

### Reading the verdict

```text
Home → src/figma2code/Home.tsx  (route /, 337 elements, 77 flats, 38 images)
PASS — pixel 0.49% = text 0.27 + photo 0.22 + asset 0 + UNEXPLAINED 0; 0 violations; coverage 100%
  fit: no horizontal scroll at 360/768/1024/1280/1366/1440/1536/1920/2560px
```

- **`pixel`** is the difference from Figma's render, split by cause. `text` is font rasterization, `photo` is image resampling and `asset` is rendered icons. **`UNEXPLAINED`** is the part a fix can remove; it must stay ≈ 0.
- **`violations`** are per-element differences in geometry, typography or color.
- **`coverage`** is the share of design nodes present on the page.
- **A FAIL** names the node, the property, and the expected and actual values. For each hotspot it saves a crop showing the design, the page and the diff.

## Configuration

`figma2code.json` in your project:

| Key | Default | Meaning |
| --- | --- | --- |
| `pagesDir` | `src/figma2code` | Where pages and overlays are written. |
| `assetsDir` | `public/figma2code` | Where assets are written. |
| `assetBase` | `/figma2code` | The URL the assets are served from. |
| `lib` | `./lib` | The runtime module the pages import, relative to `pagesDir`. |
| `routesFile` | `src/figma2code/routes.tsx` | The generated route list. |
| `dev.command` | detected from `package.json` | The dev server command, with `{port}` in it. |

## Good to know

- **Build all pages of a file in one run.** A run sends about 3–5 requests per Figma file, and rebuilds from cache send none.
- **Rate limits.** A rate-limited response (429) is remembered and never retried blindly. Assets then come from crops of the frame render.
- **Fonts are not shipped.** Load the design's fonts in your project. The verdict lists every family and weight the design uses.
- **Interactions come from the design.** Prototype actions and states drawn as examples become interactions. Text inputs and hover states are not made interactive.
- **A breakpoint is a frame.** A mobile design is built as its own page.
- **Lower-level commands:** `npm run extract`, `genpage`, `compare`, `digest`, `optimize` and `bench`. Run one without arguments to see its usage.

## Development

```bash
npm test                  # unit tests (offline: fixtures and a fake Figma API)
npm run typecheck         # strict TypeScript check
npm run compare:selftest  # proves the verifier catches planted differences
```

## License

[MIT](LICENSE)

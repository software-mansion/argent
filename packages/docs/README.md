# Argent documentation

The Argent documentation site, published at [docs.swmansion.com/argent](https://docs.swmansion.com/argent).

Built with [Docusaurus](https://docusaurus.io/) and the shared Software Mansion docs theme, [@swmansion/t-rex-ui](https://www.npmjs.com/package/@swmansion/t-rex-ui).

The site has no landing page of its own. That is [argent.swmansion.com](https://argent.swmansion.com); the root route here redirects to the getting started page.

## Development

This site lives at `packages/docs` but is a standalone npm project with its own lockfile, excluded from the root `packages/*` workspace glob so its dependencies stay out of the toolkit's lockfile. ESLint still runs from the repo root (`npm run lint`) with the shared `eslint.config.mjs`; install this package's dependencies first so the type-aware rules can load `tsconfig.json`.

```bash
cd packages/docs
npm install
npm start        # dev server on http://localhost:3000/argent/
npm run build    # production build into packages/docs/build
npm run serve    # serve the production build
```

## Layout

| Path              | Contents                                                              |
| ----------------- | --------------------------------------------------------------------- |
| `docs/`           | Documentation pages (MDX), grouped into sidebar categories            |
| `src/pages/`      | The root route, which redirects into the docs                         |
| `src/css/`        | Argent color palette, typography and theme overrides                  |
| `src/components/` | Components used from MDX, registered in `src/theme/MDXComponents.tsx` |
| `static/img/`     | Logos, favicon and other static assets                                |
| `static/video/`   | Encoded screen recordings, see [Videos](#videos)                      |

Colors in `src/css/colors.css` are derived from the Argent brand palette used on
[argent.swmansion.com](https://argent.swmansion.com).

## Videos

Screen recordings go through `scripts/encode-video.sh`, which produces a
web-sized MP4 and a poster frame in `static/video/`:

```bash
npm run encode:video -- ~/Desktop/tap-flow.mov
```

Record in the simulator or with QuickTime, then encode. Never commit a GIF: the
same ten second capture is around thirty times larger as a GIF than as H.264.

Embed the result with the `<Video>` component, which is global in MDX and needs
no import:

```mdx
<Video src="/video/tap-flow.mp4" portrait caption="Tapping through the sign-in flow" />
```

| Prop               | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `src`              | Site-relative path to the MP4                                         |
| `portrait`         | Caps the height at 480px, for simulator and emulator captures         |
| `poster`           | Poster frame; defaults to the sibling `.jpg` the encode script writes |
| `caption`          | Optional caption rendered below the clip                              |
| `width` / `height` | Intrinsic pixel size, reserves space so the page does not reflow      |

Clips are muted and loop on their own. Nothing downloads until the player nears
the viewport, playback pauses while it is off screen, and readers who ask for
reduced motion get a paused player with controls instead of a loop.

Once `static/video/` grows past a few tens of megabytes, move the files behind a
CDN and pass absolute URLs to `src` rather than growing the git history.

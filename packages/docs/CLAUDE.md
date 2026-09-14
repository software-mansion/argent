# Docs site

Docusaurus site for docs.swmansion.com/argent. Content lives in `docs/`, grouped into
`fundamentals/`, `features/` and `reference/` (each with a `_category_.json` for label
and position).

- `features/` is a **conceptual overview**: what the agent can do and why it matters, in
  a few sentences per section, with videos. No tool tables, parameter names, enum values
  or selector rules. End each page with a link to the tools reference.
- `reference/` holds the **hard technical details**: tool names, parameters, values,
  limits and exact behaviour.

## Writing style

All prose in `docs/` is written in **Simplified Technical English (ASD-STE100)**:

- One idea per sentence. Keep descriptive sentences under 25 words, instructions under 20.
- Active voice, simple present tense. "Argent records the requests", not "the requests are
  recorded".
- One term for one concept, reused everywhere. Do not vary the wording for style.
- No contractions, idioms, metaphors or humor. No implied subjects: name the actor in every
  sentence ("Argent removes...", "The agent reads...").
- Instructions are imperatives: "Run the app again after the agent connects."
- Put parallel items in a list or a table instead of a sentence with subordinate clauses.

`docs/features/network.mdx` is the reference for the target style.

## Adding a page

Every doc page needs front matter with a **lucide sidebar icon**:

```yaml
---
sidebar_position: 3
sidebar_label: Tools
title: Tools reference
sidebar_custom_props:
  icon: wrench
---
```

The icon name must also be **registered in `src/theme/SidebarIcon/index.tsx`** - import the
component from `lucide-react` and add it to the `ICONS` map under its kebab-case name. Icons
are imported one by one on purpose so the bundle only carries the ones the sidebar uses. An
unregistered name renders nothing, silently, with no build error.

When inserting a page in the middle of a section, bump the `sidebar_position` of the pages
that follow it.

## Open Graph images

`plugins/og-image/` renders one social card per page in the `postBuild` step and rewrites the
`og:image` and `twitter:image` tags of every built HTML file to point at it. The cards land in
`build/img/og/` and are named after the route.

The card is `static/img/og-background.png` with a frosted glass panel in the middle, the white
Argent logo centred on the panel, and the page title centred underneath. The title comes from
the `<title>` of the built page, with the ` | Argent` suffix removed.

Satori lays out the logo and the title and embeds every glyph as a path. resvg rasterises the
result. The font is vendored in `scripts/og-assets/`, so the cards do not depend on the fonts
installed on the machine. Layout, colours and blur live as constants at the top of
`plugins/og-image/index.js`.

## Checks

Run `npx docusaurus build` after editing docs. It fails on broken internal links, which is
the main thing to catch after moving or renaming a page (also update any `/docs/...` links
that pointed at the old path).

Run `npm run format` and `npm run lint` from the repo root after editing docs or `src/`.
Prettier and ESLint both run from the root. The root `.prettierrc` and `.prettierignore` cover
this site together with the packages. The root `eslint.config.mjs` lints `packages/docs/` with
the same type-aware rules as the packages plus the React hooks rules for `src/`. The root lint
needs the dependencies of this package installed (`npm install` in this directory) because
`tsconfig.json` extends `@docusaurus/tsconfig`.

The `Docs build` workflow runs `typecheck` and `build` on every pull request that touches
`packages/docs/`. The `Format` and `Lint` workflows run the root Prettier and ESLint, which
include this package.

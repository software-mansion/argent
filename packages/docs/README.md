# Argent documentation

The Argent documentation site, published at [docs.swmansion.com/argent](https://docs.swmansion.com/argent).

Built with [Docusaurus](https://docusaurus.io/) and the shared Software Mansion docs theme, [@swmansion/t-rex-ui](https://www.npmjs.com/package/@swmansion/t-rex-ui).

The site has no landing page of its own. That is [argent.swmansion.com](https://argent.swmansion.com); the root route here redirects to the getting started page.

## Development

This site lives at `packages/docs` but is a standalone npm project with its own lockfile, excluded from the root `packages/*` workspace glob so its dependencies stay out of the toolkit's lockfile.

```bash
cd packages/docs
npm install
npm start        # dev server on http://localhost:3000/argent/
npm run build    # production build into packages/docs/build
npm run serve    # serve the production build
```

## Layout

| Path          | Contents                                                   |
| ------------- | ---------------------------------------------------------- |
| `docs/`       | Documentation pages (MDX), grouped into sidebar categories |
| `src/pages/`  | The root route, which redirects into the docs              |
| `src/css/`    | Argent color palette, typography and theme overrides       |
| `static/img/` | Logos, favicon and other static assets                     |

Colors in `src/css/colors.css` are derived from the Argent brand palette used on
[argent.swmansion.com](https://argent.swmansion.com).

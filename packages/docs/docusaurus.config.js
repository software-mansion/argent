// @ts-check

const path = require("path");

const lightCodeTheme = require("prism-react-renderer").themes.github;
const darkCodeTheme = require("prism-react-renderer").themes.vsDark;

// DocSearch credentials. Argent has no Algolia application of its own yet, so
// an ordinary build has none and the block is left out of themeConfig
// altogether: the classic preset loads the search theme only when it is there,
// and a search UI without credentials answers every query with "no results".
const algoliaAppId = process.env.ALGOLIA_APP_ID;
const algoliaApiKey = process.env.ALGOLIA_API_KEY;
if (Boolean(algoliaAppId) !== Boolean(algoliaApiKey)) {
  console.warn(
    "ALGOLIA_APP_ID and ALGOLIA_API_KEY must be set together — only one of them " +
      "is set, so DocSearch stays disabled for this build."
  );
}
const algolia =
  algoliaAppId && algoliaApiKey
    ? {
        appId: algoliaAppId,
        apiKey: algoliaApiKey,
        indexName: process.env.ALGOLIA_INDEX_NAME ?? "argent",
        // The site is unversioned, so there are no version facets to filter by.
        contextualSearch: false,
      }
    : undefined;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Argent",
  tagline:
    "An agentic toolkit that gives your AI assistant direct access to simulators, emulators, devices, TVs and desktop apps.",
  favicon: "img/favicon.png",

  url: "https://docs.swmansion.com",
  baseUrl: "/argent/",

  // GitHub Pages deployment.
  organizationName: "software-mansion",
  projectName: "argent",

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
    mermaid: true,
  },

  themes: ["@docusaurus/theme-mermaid"],

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  headTags: [
    {
      tagName: "meta",
      attributes: {
        name: "google-site-verification",
        content: "U0xic78Z5DjD9r0wrxOYQrLZPuSF_DZidnZeXPR4D0k",
      },
    },
  ],

  stylesheets: [
    "https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap",
  ],

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          breadcrumbs: false,
          sidebarPath: require.resolve("./sidebars.js"),
          sidebarCollapsible: false,
          editUrl: "https://github.com/software-mansion/argent/edit/main/packages/docs",
        },
        theme: {
          customCss: require.resolve("./src/css/index.css"),
        },
        blog: false,
      }),
    ],
    require.resolve("@swmansion/t-rex-ui/preset"),
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/logo-icon.png",
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "Argent",
        hideOnScroll: true,
        logo: {
          alt: "Argent",
          src: "img/logo.svg",
          srcDark: "img/logo-dark.svg",
        },
        items: [
          {
            "href": "https://github.com/software-mansion/argent",
            "position": "right",
            "className": "header-github",
            "aria-label": "GitHub repository",
          },
        ],
      },
      footer: {
        style: "light",
        links: [],
        copyright: "All trademarks and copyrights belong to their respective owners.",
      },
      ...(algolia ? { algolia } : {}),
      prism: {
        additionalLanguages: ["bash", "diff", "json", "toml", "yaml"],
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
    }),
  plugins: [
    process.env.NODE_ENV !== "production" && "@docusaurus/plugin-debug",
    // Supplies @theme/SearchTranslations, which the search theme owns and the
    // shared theme's navbar pulls into the bundle either way.
    !algolia && require.resolve("./plugins/search-translations-fallback"),
    // Renders one Open Graph card per page after the build and rewrites the
    // social image tags of every built HTML file to point at it.
    require.resolve("./plugins/og-image"),
    // Parts of the shared theme ship as untranspiled JSX, so they need the same
    // JS loader Docusaurus applies to the site's own sources.
    /** @type {() => import('@docusaurus/types').Plugin} */
    function tRexUiJsxPlugin() {
      return {
        name: "argent/t-rex-ui-jsx",
        configureWebpack(_config, isServer, utils) {
          return {
            module: {
              rules: [
                {
                  test: /\.jsx?$/,
                  include: [path.resolve(__dirname, "node_modules/@swmansion/t-rex-ui")],
                  use: [utils.getJSLoader({ isServer })],
                },
              ],
            },
          };
        },
      };
    },
  ].filter(Boolean),
};

module.exports = config;

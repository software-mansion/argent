// @ts-check

const path = require("path");

const lightCodeTheme = require("prism-react-renderer").themes.github;
const darkCodeTheme = require("prism-react-renderer").themes.vsDark;

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
      // Algolia DocSearch, see https://docusaurus.io/docs/search. The search API key
      // is public and only allows read access to the index.
      algolia: {
        appId: "N28DSA2NIP",
        apiKey: "e9212e51c8bec13db36c7ba303a4139b",
        indexName: "argent",
        // Unversioned site: no version facets to filter by.
        contextualSearch: false,
      },
      prism: {
        additionalLanguages: ["bash", "diff", "json", "toml", "yaml"],
        theme: lightCodeTheme,
        darkTheme: darkCodeTheme,
      },
    }),
  plugins: [
    process.env.NODE_ENV !== "production" && "@docusaurus/plugin-debug",
    // Renders one Open Graph card per page after the build and repoints the social image tags.
    require.resolve("./plugins/og-image"),
    // The shared theme ships untranspiled JSX, so it needs the site's own JS loader.
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

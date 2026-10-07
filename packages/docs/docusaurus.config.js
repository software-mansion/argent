// @ts-check

const path = require("path");

const lightCodeTheme = require("prism-react-renderer").themes.github;
const darkCodeTheme = require("prism-react-renderer").themes.vsDark;

const products = require("./products");

const defaultProduct = products.find((product) => product.id === "default");
const otherProducts = products.filter((product) => product.id !== "default");
if (!defaultProduct) {
  throw new Error('products.js must contain a product with id "default"');
}

/** Mirrors `GlobExcludeDefault` from @docusaurus/utils, which setting `exclude` replaces. */
const DOCS_EXCLUDE_DEFAULT = [
  "**/_*.{js,jsx,ts,tsx,md,mdx}",
  "**/_*/**",
  "**/*.test.{js,jsx,ts,tsx}",
  "**/__tests__/**",
];

/** Options every docs instance shares, so the products look and behave the same. */
const docsOptions = {
  breadcrumbs: false,
  sidebarPath: require.resolve("./sidebars.js"),
  sidebarCollapsible: false,
  editUrl: "https://github.com/software-mansion/argent/edit/main/packages/docs",
};

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
  // GitHub Pages redirects `<route>` to `<route>/`, so the canonical URLs must carry the slash.
  trailingSlash: true,

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
          ...docsOptions,
          path: defaultProduct.dir,
          routeBasePath: defaultProduct.routeBasePath,
          // The other products live in folders under docs/, which this instance must skip.
          exclude: [
            ...DOCS_EXCLUDE_DEFAULT,
            ...otherProducts.map(
              (product) => `${path.relative(defaultProduct.dir, product.dir)}/**`
            ),
          ],
        },
        theme: {
          customCss: require.resolve("./src/css/index.css"),
        },
        blog: false,
        sitemap: {
          // The search page carries `noindex`, so listing it only adds a warning in Search Console.
          ignorePatterns: ["/argent/search/"],
        },
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
  customFields: {
    products: products.map(({ id, label }) => ({ id, label })),
  },
  plugins: [
    // One docs instance per product beyond the default one the classic preset owns.
    ...otherProducts.map((product) => [
      "@docusaurus/plugin-content-docs",
      { ...docsOptions, id: product.id, path: product.dir, routeBasePath: product.routeBasePath },
    ]),
    // Renders one Open Graph card per page after the build and repoints the social image tags.
    require.resolve("./plugins/og-image"),
    // The default docs instance owns docs/, and its MDX webpack rule matches every file
    // under it by path prefix, other products included. The `exclude` option above only
    // filters content discovery, so without this the pages of the other products would run
    // through two MDX loaders and fail to compile.
    /** @type {() => import('@docusaurus/types').Plugin} */
    function productDocsWebpackPlugin() {
      return {
        name: "argent/product-docs-webpack",
        configureWebpack(config) {
          // Docusaurus lists content directories with a trailing separator.
          const defaultDir = path.resolve(__dirname, defaultProduct.dir) + path.sep;
          const otherDirs = otherProducts.map(
            (product) => path.resolve(__dirname, product.dir) + path.sep
          );
          for (const rule of config.module?.rules ?? []) {
            if (typeof rule !== "object" || rule === null) {
              continue;
            }
            const include = Array.isArray(rule.include) ? rule.include : [rule.include];
            if (!include.includes(defaultDir)) {
              continue;
            }
            const exclude = Array.isArray(rule.exclude)
              ? rule.exclude
              : rule.exclude
                ? [rule.exclude]
                : [];
            rule.exclude = [...exclude, ...otherDirs];
          }
          return {};
        },
      };
    },
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

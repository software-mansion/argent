// @ts-check
/**
 * Registers `@theme/SearchTranslations` for builds that have no DocSearch.
 *
 * The shared theme's navbar imports `@docusaurus/theme-search-algolia/client`
 * whether or not search is on, and that module imports the alias. The alias
 * normally comes from the search theme, which the classic preset loads only
 * when `themeConfig.algolia` is set — so without this the bundle does not
 * resolve. Nothing renders the strings in that state; see the theme component.
 */

const path = require("node:path");

/** @type {() => import('@docusaurus/types').Plugin} */
module.exports = function searchTranslationsFallback() {
  return {
    name: "argent/search-translations-fallback",
    getThemePath: () => path.resolve(__dirname, "theme"),
  };
};

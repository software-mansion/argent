// @ts-check

/**
 * Every product the site documents. The sidebar switcher lists them in this order.
 *
 * The `default` product is the classic preset's docs instance and lives at the root of
 * `docs/`. Every other product is its own docs plugin instance in a folder under `docs/`,
 * so the shared theme's llms.txt plugin, which walks `docs/`, still sees every page.
 *
 * To add a product: add an entry here and create `docs/<id>/` with its categories.
 */
const products = [
  { id: "default", label: "Argent", dir: "docs", routeBasePath: "docs" },
  {
    id: "cloud",
    label: "Argent Cloud",
    dir: "docs/cloud",
    routeBasePath: "docs/cloud",
  },
];

module.exports = products;

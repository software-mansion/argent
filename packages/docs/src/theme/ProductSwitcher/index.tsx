import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { useActivePlugin, useAllDocsData } from "@docusaurus/plugin-content-docs/client";
import type { PropSidebarItemHtml } from "@docusaurus/plugin-content-docs";

type Product = { id: string; label: string };

/** A chevron matching lucide's `chevron-down` at the sidebar icon size. */
const CHEVRON =
  '<svg class="product-switcher__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*
 * The product switcher at the top of the docs sidebar. Each product is one docs plugin
 * instance (see products.js); the switch links to the first page of that product's sidebar.
 *
 * The shared theme (@swmansion/t-rex-ui) renders sidebar items from its own bundle and
 * accepts an `html` item as a string only, so the dropdown is a native <details> element,
 * which needs no script of its own, instead of a React component.
 */
export default function useProductSwitcherItem(): PropSidebarItemHtml {
  const { siteConfig } = useDocusaurusContext();
  const products = siteConfig.customFields?.products as Product[];
  const activeId = useActivePlugin({ failfast: false })?.pluginId ?? "default";
  const docsData = useAllDocsData();
  const baseUrl = useBaseUrl("/");

  const active = products.find((product) => product.id === activeId) ?? products[0];

  const links = products
    .map((product) => {
      const version = docsData[product.id]?.versions.find((candidate) => candidate.isLast);
      const mainDoc = version?.docs.find((doc) => doc.id === version.mainDocId);
      if (!mainDoc) {
        return "";
      }
      // `path` is already prefixed with the site's baseUrl.
      const href = mainDoc.path.startsWith(baseUrl) ? mainDoc.path : `${baseUrl}${mainDoc.path}`;
      // "true" and not "page": the link points at the main page of the product, and the
      // reader may be on another page of the same product.
      const current = product.id === active.id ? ' aria-current="true"' : "";
      return `<li><a href="${escapeHtml(href)}"${current}>${escapeHtml(product.label)}</a></li>`;
    })
    .join("");

  return {
    type: "html",
    className: "product-switcher",
    defaultStyle: false,
    value: `<details class="product-switcher__menu"><summary aria-label="Switch product"><span class="product-switcher__label">${escapeHtml(active.label)}</span>${CHEVRON}</summary><ul>${links}</ul></details>`,
  };
}

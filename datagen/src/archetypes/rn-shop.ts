// React Native e-commerce app (iOS + Android). Drives debugger-component-tree
// discovery, tab navigation, scroll-to-reveal, network requests, and is the
// primary archetype for profiling/flow tasks.

import type { AppArchetype } from "../types.ts";
import { makeScreen } from "./helpers.ts";

const tabs = [
  { key: "tab-home", label: "Home", identifier: "tab-home", navigatesTo: "home" },
  { key: "tab-search", label: "Search", identifier: "tab-search", navigatesTo: "search" },
  { key: "tab-cart", label: "Cart", identifier: "tab-cart", navigatesTo: "cart" },
  { key: "tab-profile", label: "Profile", identifier: "tab-profile", navigatesTo: "profile" },
];

const archetype: AppArchetype = {
  id: "rn-shop",
  name: "ShopMart",
  platforms: ["ios", "android"],
  bundleId: "com.shopmart.app",
  isReactNative: true,
  metroPort: 8081,
  entryScreen: "home",
  urls: { "shopmart://home": "home", "shopmart://cart": "cart" },
  screens: {
    home: makeScreen({
      key: "home",
      title: "Home",
      heading: "ShopMart",
      rows: [
        { key: "promo", label: "Summer Sale -40%", role: "image", component: "PromoBanner", identifier: "promo-banner" },
        { key: "prod-101", label: "Wireless Headphones", component: "ProductCard", identifier: "product-101", navigatesTo: "product", firesRequest: req("GET", "/api/products/101", 200, 3120) },
        { key: "prod-102", label: "Mechanical Keyboard", component: "ProductCard", identifier: "product-102", navigatesTo: "product", firesRequest: req("GET", "/api/products/102", 200, 2890) },
        { key: "prod-103", label: "USB-C Hub", component: "ProductCard", identifier: "product-103", navigatesTo: "product", firesRequest: req("GET", "/api/products/103", 200, 1740) },
        { key: "prod-104", label: "4K Webcam", component: "ProductCard", identifier: "product-104", navigatesTo: "product", revealedByScroll: true, firesRequest: req("GET", "/api/products/104", 200, 4010) },
        { key: "prod-105", label: "Laptop Stand", component: "ProductCard", identifier: "product-105", navigatesTo: "product", revealedByScroll: true, firesRequest: req("GET", "/api/products/105", 200, 2210) },
      ],
      tabs,
    }),
    search: makeScreen({
      key: "search",
      title: "Search",
      heading: "Search",
      rows: [
        { key: "search-field", label: "Search products", role: "field", component: "SearchInput", identifier: "search-input", textField: "search" },
        { key: "result-keyboard", label: "Mechanical Keyboard", component: "ProductCard", identifier: "result-102", navigatesTo: "product", firesRequest: req("GET", "/api/search?q=keyboard", 200, 980) },
      ],
      tabs,
    }),
    product: makeScreen({
      key: "product",
      title: "Product",
      heading: "Wireless Headphones",
      rows: [
        { key: "prod-image", label: "Wireless Headphones", role: "image", component: "ProductImage", identifier: "product-image" },
        { key: "prod-price", label: "$129.00", role: "text", component: "PriceLabel", identifier: "product-price" },
        { key: "add-to-cart", label: "Add to Cart", component: "AddToCartButton", identifier: "add-to-cart", navigatesTo: "cart", firesRequest: req("POST", "/api/cart/add", 201, 640, '{"productId":101,"qty":1}') },
        { key: "reviews", label: "Reviews (214)", component: "ReviewsLink", identifier: "reviews-link", navigatesTo: "product", revealedByScroll: true },
      ],
      tabs,
    }),
    cart: makeScreen({
      key: "cart",
      title: "Cart",
      heading: "Your Cart",
      rows: [
        { key: "cart-item", label: "Wireless Headphones — $129.00", role: "text", component: "CartItem", identifier: "cart-item-101" },
        { key: "checkout", label: "Checkout", component: "CheckoutButton", identifier: "checkout-button", navigatesTo: "checkout", firesRequest: req("POST", "/api/checkout", 200, 1200) },
      ],
      tabs,
    }),
    checkout: makeScreen({
      key: "checkout",
      title: "Checkout",
      heading: "Checkout",
      rows: [
        { key: "card-field", label: "Card number", role: "field", component: "CardInput", identifier: "card-input", textField: "card" },
        { key: "pay", label: "Pay $129.00", component: "PayButton", identifier: "pay-button", navigatesTo: "confirmation", firesRequest: req("POST", "/api/payments", 200, 2400) },
      ],
      tabs,
    }),
    confirmation: makeScreen({
      key: "confirmation",
      title: "Confirmation",
      heading: "Order Confirmed",
      rows: [
        { key: "order-id", label: "Order #SM-48213", role: "text", component: "OrderId", identifier: "order-id" },
        { key: "continue", label: "Continue Shopping", component: "ContinueButton", identifier: "continue-button", navigatesTo: "home" },
      ],
      tabs,
    }),
    profile: makeScreen({
      key: "profile",
      title: "Profile",
      heading: "Profile",
      rows: [
        { key: "name", label: "Alex Johnson", role: "text", component: "UserName", identifier: "user-name" },
        { key: "orders", label: "My Orders", component: "MenuRow", identifier: "menu-orders", navigatesTo: "profile" },
        { key: "notifications", label: "Push Notifications", role: "switch", component: "NotifToggle", identifier: "notif-toggle", togglesState: "notifications" },
      ],
      tabs,
    }),
  },
};

function req(method: string, path: string, status: number, durationMs: number, reqBody?: string) {
  return {
    method,
    url: `https://api.shopmart.com${path}`,
    status,
    statusText: status === 200 ? "OK" : status === 201 ? "Created" : "OK",
    resourceType: "fetch",
    bytes: 1024 + (durationMs % 4096),
    durationMs,
    reqBody,
    resBody: '{"ok":true}',
  };
}

export default archetype;

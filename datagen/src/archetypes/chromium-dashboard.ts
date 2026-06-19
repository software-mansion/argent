// Chromium (Electron/CDP) analytics dashboard. Drives `describe` (cdp-dom),
// gesture-scroll (wheel-based, not swipe), and chromium-specific tabs.

import type { AppArchetype } from "../types.ts";
import { makeScreen } from "./helpers.ts";

const archetype: AppArchetype = {
  id: "chromium-dashboard",
  name: "Metrico",
  platforms: ["chromium"],
  bundleId: "com.metrico.desktop",
  isReactNative: false,
  entryScreen: "overview",
  urls: {
    "https://app.metrico.io/overview": "overview",
    "https://app.metrico.io/reports": "reports",
  },
  screens: {
    overview: makeScreen({
      key: "overview",
      title: "Overview",
      heading: "Overview",
      rows: [
        { key: "kpi-revenue", label: "Revenue $48,210", role: "text", identifier: "kpi-revenue" },
        { key: "kpi-users", label: "Active Users 12,884", role: "text", identifier: "kpi-users" },
        {
          key: "reports-link",
          label: "View Reports",
          role: "link",
          identifier: "nav-reports",
          navigatesTo: "reports",
        },
        {
          key: "settings-link",
          label: "Settings",
          role: "link",
          identifier: "nav-settings",
          navigatesTo: "settings",
        },
        {
          key: "export",
          label: "Export CSV",
          role: "button",
          identifier: "export-btn",
          revealedByScroll: true,
        },
      ],
    }),
    reports: makeScreen({
      key: "reports",
      title: "Reports",
      heading: "Reports",
      rows: [
        {
          key: "report-traffic",
          label: "Traffic Sources",
          role: "link",
          identifier: "report-traffic",
          navigatesTo: "reportDetail",
        },
        {
          key: "report-funnel",
          label: "Conversion Funnel",
          role: "link",
          identifier: "report-funnel",
          navigatesTo: "reportDetail",
        },
        { key: "date-range", label: "Last 30 days", role: "button", identifier: "date-range" },
      ],
    }),
    reportDetail: makeScreen({
      key: "reportDetail",
      title: "Traffic Sources",
      heading: "Traffic Sources",
      rows: [
        { key: "chart", label: "Traffic chart", role: "image", identifier: "traffic-chart" },
        { key: "row-organic", label: "Organic 6,420", role: "text", identifier: "src-organic" },
        { key: "row-direct", label: "Direct 3,110", role: "text", identifier: "src-direct" },
        {
          key: "back-reports",
          label: "Back to Reports",
          role: "link",
          identifier: "back-reports",
          navigatesTo: "reports",
        },
      ],
    }),
    settings: makeScreen({
      key: "settings",
      title: "Settings",
      heading: "Settings",
      rows: [
        {
          key: "theme",
          label: "Dark theme",
          role: "switch",
          identifier: "theme-toggle",
          togglesState: "darkTheme",
        },
        {
          key: "email-field",
          label: "Notification email",
          role: "field",
          identifier: "email-input",
          textField: "email",
        },
        { key: "save", label: "Save changes", role: "button", identifier: "save-settings" },
      ],
    }),
  },
};

export default archetype;

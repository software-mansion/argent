// Native iOS Settings-like app. Drives `describe` (ax-service) discovery, deep
// navigation, and toggle interactions. Not React Native.

import type { AppArchetype } from "../types.ts";
import { makeScreen } from "./helpers.ts";

const archetype: AppArchetype = {
  id: "ios-settings",
  name: "Settings",
  platforms: ["ios"],
  bundleId: "com.apple.Preferences",
  isReactNative: false,
  entryScreen: "root",
  urls: { "settings://": "root" },
  screens: {
    root: makeScreen({
      key: "root",
      title: "Settings",
      heading: "Settings",
      rows: [
        { key: "wifi", label: "Wi-Fi", identifier: "com.apple.settings.wifi", navigatesTo: "wifi" },
        { key: "general", label: "General", identifier: "com.apple.settings.general", navigatesTo: "general" },
        { key: "display", label: "Display & Brightness", identifier: "com.apple.settings.display", navigatesTo: "display" },
        { key: "privacy", label: "Privacy & Security", identifier: "com.apple.settings.privacy", navigatesTo: "privacy" },
        { key: "battery", label: "Battery", identifier: "com.apple.settings.battery", navigatesTo: "battery", revealedByScroll: true },
        { key: "developer", label: "Developer", identifier: "com.apple.settings.developer", navigatesTo: "developer", revealedByScroll: true },
      ],
    }),
    general: makeScreen({
      key: "general",
      title: "General",
      heading: "General",
      rows: [
        { key: "about", label: "About", identifier: "general.about", navigatesTo: "about" },
        { key: "software-update", label: "Software Update", identifier: "general.update", navigatesTo: "about" },
        { key: "storage", label: "iPhone Storage", identifier: "general.storage", navigatesTo: "about" },
      ],
    }),
    about: makeScreen({
      key: "about",
      title: "About",
      heading: "About",
      rows: [
        { key: "name", label: "Name", role: "text", identifier: "about.name" },
        { key: "ios-version", label: "iOS Version 18.5", role: "text", identifier: "about.version" },
        { key: "model", label: "Model Name iPhone 16 Pro", role: "text", identifier: "about.model" },
      ],
    }),
    display: makeScreen({
      key: "display",
      title: "Display & Brightness",
      heading: "Display & Brightness",
      rows: [
        { key: "dark-mode", label: "Dark Mode", role: "switch", identifier: "display.dark", togglesState: "darkMode" },
        { key: "true-tone", label: "True Tone", role: "switch", identifier: "display.truetone", togglesState: "trueTone" },
        { key: "auto-lock", label: "Auto-Lock", identifier: "display.autolock", navigatesTo: "display" },
      ],
    }),
    wifi: makeScreen({
      key: "wifi",
      title: "Wi-Fi",
      heading: "Wi-Fi",
      rows: [
        { key: "wifi-toggle", label: "Wi-Fi", role: "switch", identifier: "wifi.toggle", togglesState: "wifi" },
        { key: "net-office", label: "Office-5G", identifier: "wifi.office" },
        { key: "net-home", label: "Home", identifier: "wifi.home" },
      ],
    }),
    privacy: makeScreen({
      key: "privacy",
      title: "Privacy & Security",
      heading: "Privacy & Security",
      rows: [
        { key: "location", label: "Location Services", identifier: "privacy.location", navigatesTo: "privacy" },
        { key: "tracking", label: "Tracking", role: "switch", identifier: "privacy.tracking", togglesState: "tracking" },
      ],
    }),
    battery: makeScreen({
      key: "battery",
      title: "Battery",
      heading: "Battery",
      rows: [
        { key: "low-power", label: "Low Power Mode", role: "switch", identifier: "battery.lowpower", togglesState: "lowPower" },
        { key: "battery-health", label: "Battery Health & Charging", identifier: "battery.health", navigatesTo: "battery" },
      ],
    }),
    developer: makeScreen({
      key: "developer",
      title: "Developer",
      heading: "Developer",
      rows: [
        { key: "fast-refresh", label: "Fast Refresh", role: "switch", identifier: "dev.fastrefresh", togglesState: "fastRefresh" },
        { key: "show-perf", label: "Show Perf Monitor", role: "switch", identifier: "dev.perf", togglesState: "perfMon" },
      ],
    }),
  },
};

export default archetype;

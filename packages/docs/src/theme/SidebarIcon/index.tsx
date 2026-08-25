import React from "react";
import {
  Bug,
  Download,
  FileCode,
  Gauge,
  Images,
  Layers,
  MousePointerClick,
  Network,
  Repeat2,
  Rocket,
  ScrollText,
  Settings2,
  ShieldCheck,
  SwatchBook,
  Terminal,
  Video,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import styles from "./styles.module.css";

/*
 * Explicit map so the bundle pulls only these icons from lucide.
 * Keys come from a page's `sidebar_custom_props: { icon: "rocket" }`.
 */
const ICONS: Record<string, LucideIcon> = {
  "bug": Bug,
  "download": Download,
  "file-code": FileCode,
  "gauge": Gauge,
  "images": Images,
  "layers": Layers,
  "mouse-pointer-click": MousePointerClick,
  "network": Network,
  "repeat-2": Repeat2,
  "rocket": Rocket,
  "scroll-text": ScrollText,
  "settings-2": Settings2,
  "shield-check": ShieldCheck,
  "swatch-book": SwatchBook,
  "terminal": Terminal,
  "video": Video,
  "wrench": Wrench,
};

type Props = {
  name?: unknown;
};

export default function SidebarIcon({ name }: Props): React.ReactElement | null {
  if (typeof name !== "string") {
    return null;
  }

  const Icon = ICONS[name];
  if (!Icon) {
    return null;
  }

  return <Icon className={styles.icon} size={16} strokeWidth={2} aria-hidden="true" />;
}

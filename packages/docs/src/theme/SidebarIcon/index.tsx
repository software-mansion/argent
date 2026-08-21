import React from "react";
import {
  Bug,
  Download,
  FileCode,
  Gauge,
  Images,
  Layers,
  MousePointerClick,
  Repeat2,
  Rocket,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";

import styles from "./styles.module.css";

/*
 * Only the icons the sidebar actually uses are imported, so the bundle carries
 * this map and nothing else from lucide. Pages opt in through
 * `sidebar_custom_props: { icon: "rocket" }`; category headings carry no icon.
 */
const ICONS: Record<string, LucideIcon> = {
  bug: Bug,
  download: Download,
  "file-code": FileCode,
  gauge: Gauge,
  images: Images,
  layers: Layers,
  "mouse-pointer-click": MousePointerClick,
  "repeat-2": Repeat2,
  rocket: Rocket,
  "shield-check": ShieldCheck,
  terminal: Terminal,
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

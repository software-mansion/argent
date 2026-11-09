import React from "react";
import {
  ArrowLeftRight,
  Bot,
  Bug,
  Download,
  FileCode,
  FlaskConical,
  Gauge,
  Images,
  KeyRound,
  Layers,
  LifeBuoy,
  MousePointerClick,
  Network,
  Plug,
  Repeat2,
  Rocket,
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  SwatchBook,
  Terminal,
  Timer,
  Video,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { Appium, Argent, GitHub, Maestro, type BrandIcon } from "./brands";
import styles from "./styles.module.css";

/*
 * Explicit map so the bundle pulls only these icons from lucide.
 * Keys come from a page's `sidebar_custom_props: { icon: "rocket" }`. The
 * Card component reads the same map, so a card and the sidebar entry of the
 * page it links to share one icon. The `brand-*` keys are the marks of the
 * external tools on the integration pages, drawn in `./brands.tsx`.
 */
export const ICONS: Record<string, LucideIcon | BrandIcon> = {
  "arrow-left-right": ArrowLeftRight,
  "bot": Bot,
  "bug": Bug,
  "download": Download,
  "file-code": FileCode,
  "flask-conical": FlaskConical,
  "gauge": Gauge,
  "images": Images,
  "key-round": KeyRound,
  "layers": Layers,
  "life-buoy": LifeBuoy,
  "mouse-pointer-click": MousePointerClick,
  "network": Network,
  "plug": Plug,
  "repeat-2": Repeat2,
  "rocket": Rocket,
  "scroll-text": ScrollText,
  "server": Server,
  "settings-2": Settings2,
  "shield-check": ShieldCheck,
  "smartphone": Smartphone,
  "square-terminal": SquareTerminal,
  "swatch-book": SwatchBook,
  "terminal": Terminal,
  "timer": Timer,
  "video": Video,
  "workflow": Workflow,
  "wrench": Wrench,
  "brand-appium": Appium,
  "brand-argent": Argent,
  "brand-github": GitHub,
  "brand-maestro": Maestro,
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

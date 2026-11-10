import React from "react";
import Link from "@docusaurus/Link";
import { ArrowRight } from "lucide-react";

import { ICONS } from "@site/src/theme/SidebarIcon";

import styles from "./styles.module.css";

type CardsProps = {
  children: React.ReactNode;
};

/* A responsive grid of cards. */
export function Cards({ children }: CardsProps): React.ReactElement {
  return <div className={styles.grid}>{children}</div>;
}

type CardProps = {
  /* The page the card opens. Absolute from the site root, for example `/docs/cloud/reference/cli`. */
  href: string;
  /* The card heading. */
  title: string;
  /* A lucide icon name registered in `src/theme/SidebarIcon`, usually the icon of the linked page. */
  icon?: string;
  /* One or two sentences under the heading. */
  children: React.ReactNode;
};

/*
 * A link card. The card takes the shape language of the code blocks and the
 * Prompt panel: a flat surface on the secondary background with the large
 * radius, no border and no shadow. The icon carries the highlight color the
 * way the sidebar icons do, and the whole surface is the link.
 */
export function Card({ href, title, icon, children }: CardProps): React.ReactElement {
  const Icon = icon ? ICONS[icon] : undefined;

  return (
    <Link to={href} className={styles.card}>
      <span className={styles.title}>
        {Icon ? (
          <Icon className={styles.icon} size={18} strokeWidth={2} aria-hidden="true" />
        ) : null}
        {title}
        <ArrowRight className={styles.arrow} size={16} strokeWidth={2.25} aria-hidden="true" />
      </span>
      <span className={styles.description}>{children}</span>
    </Link>
  );
}

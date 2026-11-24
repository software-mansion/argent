import React from "react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, Copy, Sparkles, X } from "lucide-react";

import styles from "./styles.module.css";

const COPY_LABELS = { idle: "Copy", copied: "Copied", failed: "Copy failed" } as const;

type Props = {
  /* The prompt text. Leading and trailing blank lines are removed. */
  children: string;
  /* The label in the header. */
  label?: string;
  /* Height of the collapsed panel in pixels. */
  collapsedHeight?: number;
};

/*
 * A prompt the reader pastes into an AI assistant. The panel opens collapsed
 * with a fade at the bottom so a long prompt does not push the page down, and
 * the copy button always copies the full text.
 */
export default function Prompt({
  children,
  label = "Quick start with an AI agent",
  collapsedHeight = 160,
}: Props): React.ReactElement {
  const text = children.replace(/^\n+|\n+$/g, "");
  const [expanded, setExpanded] = React.useState(false);
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  /* Short prompts fit in the collapsed panel, so they get no toggle. */
  const [overflows, setOverflows] = React.useState(true);
  const bodyRef = React.useRef<HTMLPreElement>(null);

  React.useEffect(() => {
    const element = bodyRef.current;
    if (!element) {
      return;
    }
    setOverflows(element.scrollHeight > collapsedHeight);
  }, [collapsedHeight, text]);

  React.useEffect(() => {
    if (copyState === "idle") {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  /* The Clipboard API is missing on an insecure origin and rejects without permission. */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const collapsed = overflows && !expanded;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.label}>
          <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
          {label}
        </span>
        <button type="button" className={styles.button} onClick={() => void copy()}>
          {copyState === "copied" ? (
            <Check size={14} strokeWidth={2.25} aria-hidden="true" />
          ) : copyState === "failed" ? (
            <X size={14} strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Copy size={14} strokeWidth={2.25} aria-hidden="true" />
          )}
          {COPY_LABELS[copyState]}
        </button>
      </div>
      <div
        className={clsx(styles.bodyWrapper, collapsed && styles.collapsed)}
        style={collapsed ? { maxHeight: collapsedHeight } : undefined}>
        <pre ref={bodyRef} className={styles.body}>
          {text}
        </pre>
      </div>
      {overflows ? (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.button}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}>
            {expanded ? (
              <ChevronUp size={14} strokeWidth={2.25} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} strokeWidth={2.25} aria-hidden="true" />
            )}
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

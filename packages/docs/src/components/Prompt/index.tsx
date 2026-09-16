import React from "react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, Copy, Sparkles } from "lucide-react";

import styles from "./styles.module.css";

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
  const [copied, setCopied] = React.useState(false);
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
    if (!copied) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => setCopied(true));
  };

  const collapsed = overflows && !expanded;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.label}>
          <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
          {label}
        </span>
        <button type="button" className={styles.button} onClick={copy}>
          {copied ? (
            <Check size={14} strokeWidth={2.25} aria-hidden="true" />
          ) : (
            <Copy size={14} strokeWidth={2.25} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
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

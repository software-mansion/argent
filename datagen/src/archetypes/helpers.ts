// Builders for authoring app archetypes as screen graphs. Keeping layout math
// in one place means every archetype produces consistent, non-overlapping,
// normalized frames — so a tap at an element's centre is always grounded.

import type { ElementDef, Frame, ScreenDef } from "../types.ts";

/** A vertical list row at the given 0-based index (below a header band). */
export function rowFrame(index: number): Frame {
  return { x: 0.06, y: round(0.14 + index * 0.085), w: 0.88, h: 0.07 };
}

export function headingFrame(): Frame {
  return { x: 0.06, y: 0.06, w: 0.6, h: 0.05 };
}

export function tabFrame(index: number, total: number): Frame {
  const w = round(1 / total);
  return { x: round(index * w), y: 0.93, w, h: 0.07 };
}

export function fieldFrame(index: number): Frame {
  return { x: 0.08, y: round(0.2 + index * 0.1), w: 0.84, h: 0.065 };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface RowSpec {
  key: string;
  label: string;
  role?: ElementDef["role"];
  identifier?: string;
  component?: string;
  navigatesTo?: string;
  togglesState?: string;
  textField?: string;
  firesRequest?: ElementDef["firesRequest"];
  revealedByScroll?: boolean;
}

/**
 * Build a screen from an ordered list of rows plus optional heading and tabs.
 * Rows are laid out top-to-bottom; tabs pinned to the bottom bar.
 */
export function makeScreen(opts: {
  key: string;
  title: string;
  heading?: string;
  rows: RowSpec[];
  tabs?: RowSpec[];
}): ScreenDef {
  const elements: ElementDef[] = [];
  if (opts.heading) {
    elements.push({ key: `${opts.key}-h`, role: "heading", label: opts.heading, frame: headingFrame() });
  }
  opts.rows.forEach((r, i) => {
    elements.push({
      key: r.key,
      role: r.role ?? "button",
      label: r.label,
      identifier: r.identifier,
      component: r.component,
      frame: rowFrame(i),
      navigatesTo: r.navigatesTo,
      togglesState: r.togglesState,
      textField: r.textField,
      firesRequest: r.firesRequest,
      revealedByScroll: r.revealedByScroll,
    });
  });
  if (opts.tabs) {
    opts.tabs.forEach((t, i) => {
      elements.push({
        key: t.key,
        role: "tab",
        label: t.label,
        identifier: t.identifier,
        component: t.component,
        frame: tabFrame(i, opts.tabs!.length),
        navigatesTo: t.navigatesTo,
        isTab: true,
      });
    });
  }
  return { key: opts.key, title: opts.title, elements };
}

/** Build login-style screens where rows are fields then a submit button. */
export function makeFormScreen(opts: {
  key: string;
  title: string;
  heading?: string;
  fields: { key: string; label: string; field: string; identifier?: string }[];
  submit: { key: string; label: string; navigatesTo: string; identifier?: string };
}): ScreenDef {
  const elements: ElementDef[] = [];
  if (opts.heading) {
    elements.push({ key: `${opts.key}-h`, role: "heading", label: opts.heading, frame: headingFrame() });
  }
  opts.fields.forEach((f, i) => {
    elements.push({
      key: f.key,
      role: "field",
      label: f.label,
      identifier: f.identifier,
      frame: fieldFrame(i),
      textField: f.field,
    });
  });
  elements.push({
    key: opts.submit.key,
    role: "button",
    label: opts.submit.label,
    identifier: opts.submit.identifier,
    frame: fieldFrame(opts.fields.length + 0.5),
    navigatesTo: opts.submit.navigatesTo,
  });
  return { key: opts.key, title: opts.title, elements };
}

// Screen-graph routing: shortest sequence of element taps from the entry screen
// to a target screen, following navigatesTo edges. Used by the task generator
// and the expert so navigation is always a real, walkable path.

import type { AppArchetype, ElementDef } from "./types.ts";

export interface Hop {
  screen: string;
  elementKey: string;
}

/** Ordered element keys to tap to walk from entry screen to `target`. */
export function routeToScreen(app: AppArchetype, target: string): Hop[] | null {
  if (target === app.entryScreen) return [];
  const visited = new Set<string>([app.entryScreen]);
  const queue: { screen: string; hops: Hop[] }[] = [{ screen: app.entryScreen, hops: [] }];
  while (queue.length) {
    const { screen, hops } = queue.shift()!;
    const def = app.screens[screen];
    if (!def) continue;
    for (const el of def.elements) {
      if (!el.navigatesTo || el.navigatesTo === screen) continue;
      if (visited.has(el.navigatesTo)) continue;
      const next = hops.concat({ screen, elementKey: el.key });
      if (el.navigatesTo === target) return next;
      visited.add(el.navigatesTo);
      queue.push({ screen: el.navigatesTo, hops: next });
    }
  }
  return null;
}

/** Every screen reachable from entry (including entry). */
export function reachableScreens(app: AppArchetype): string[] {
  const out = new Set<string>([app.entryScreen]);
  const queue = [app.entryScreen];
  while (queue.length) {
    const s = queue.shift()!;
    const def = app.screens[s];
    if (!def) continue;
    for (const el of def.elements) {
      if (el.navigatesTo && !out.has(el.navigatesTo)) {
        out.add(el.navigatesTo);
        queue.push(el.navigatesTo);
      }
    }
  }
  return [...out];
}

export function elementByKey(app: AppArchetype, screen: string, key: string): ElementDef | undefined {
  return app.screens[screen]?.elements.find((e) => e.key === key);
}

export function screenLabel(app: AppArchetype, screen: string): string {
  return app.screens[screen]?.title ?? screen;
}

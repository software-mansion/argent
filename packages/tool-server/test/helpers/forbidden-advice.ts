import { expect } from "vitest";

/**
 * The instructions the Chromium recovery exists to prevent. A pin counts what a
 * surface SAYS; nothing in one stops the opposite being appended after it, and
 * the appended sentence is the one a reader acts on last. Shared so the runtime
 * guidance strings and the prose surfaces are held to one list rather than two
 * that can drift apart.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/relaunch (it |the app )?anyway/i, "relaunching without the exit confirmed"],
  [/keep using (it|the old|that)\b/i, "reusing an id across a relaunch"],
  [/boot it again/i, "booting an app that is still up"],
  [/does mean the app exited/i, "reading an exit off a missing list-devices entry"],
  // Lookbehind, like the last row: the surfaces that state this correctly all
  // negate it ("cannot be relaunched with restart-app").
  [/(?<!cannot be |not be |never )relaunched with `?restart-app/i, "restart-app on Chromium"],
  // boot-electron raises the pre-CDP exit string for a lock quit AND for a launch
  // that really failed, so neither reading may be stated as the meaning - hence
  // both directions are barred.
  [/not that it failed to launch/i, "reading a live app off the pre-CDP exit string"],
  [
    /means (?:the launch failed|it failed to launch|the app failed to launch)/i,
    "reading a failed launch off the pre-CDP exit string",
  ],
  // The windowless arm's remedy is a window, and every surface that names the
  // state sits next to a block whose standing instruction is a relaunch. The
  // lookbehind keeps the surfaces that FORBID it ("Do not relaunch there").
  [/(?<!do not |never )relaunch there\b/i, "relaunching an app that only lacks a window"],
];

export function expectNoForbiddenAdvice(text: string | undefined, label: string) {
  for (const [pattern, what] of FORBIDDEN)
    expect(text ?? "", `${label} must not advise ${what}`).not.toMatch(pattern);
}

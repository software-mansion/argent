// Natural-language surface forms. The grounded backbone (tool calls +
// observations) is fixed by the gym; this layer only varies *how* the user
// asks and how the assistant narrates, so the dataset has linguistic diversity
// without ever risking the correctness of the actions.

import type { RNG } from "./rng.ts";
import type { Persona } from "./types.ts";
export type { Persona };

export function pick(rng: RNG, options: string[]): string {
  return options[rng.int(options.length)]!;
}

const DEVICE_WORD: Record<string, string> = {
  ios: "simulator",
  android: "emulator",
  chromium: "app window",
};

export function deviceWord(platform: string): string {
  return DEVICE_WORD[platform] ?? "device";
}

// ---- assistant narration banks ----

export const narr = {
  checkDevices: (rng: RNG) =>
    pick(rng, [
      "First, let me see what devices are available.",
      "Let me list the devices so I target the right one.",
      "I'll check which simulators/emulators are running before doing anything.",
      "Starting by listing available devices.",
    ]),
  bootDevice: (rng: RNG, name: string) =>
    pick(rng, [
      `No device is booted, so I'll boot ${name}.`,
      `Nothing is running yet — booting ${name}.`,
      `I need a running device first; booting ${name}.`,
    ]),
  bootRetry: (rng: RNG) =>
    pick(rng, [
      "The boot timed out. That can happen on a cold emulator — I'll retry the boot.",
      "Boot didn't complete in time; retrying once.",
    ]),
  launch: (rng: RNG, name: string) =>
    pick(rng, [
      `Now I'll launch ${name}.`,
      `Opening ${name} on the device.`,
      `Let me launch the app (${name}).`,
    ]),
  connectDebugger: (rng: RNG) =>
    pick(rng, [
      "This is a React Native app, so I'll connect to the Metro debugger to use the component tree.",
      "For an RN app I'll check the debugger status first — the component tree needs a CDP connection.",
      "Connecting to the JS debugger so I can read the React component tree.",
    ]),
  discover: (rng: RNG, tool: string) =>
    tool === "debugger-component-tree"
      ? pick(rng, [
          "Let me read the component tree to find the element and its tap coordinates.",
          "I'll pull the React component tree to locate the target.",
          "Getting the component tree so I tap the right coordinates rather than guessing.",
        ])
      : pick(rng, [
          "Let me describe the screen to get exact, grounded coordinates.",
          "I'll run describe to find the element before tapping.",
          "Reading the accessibility tree so I don't guess coordinates.",
        ]),
  tap: (rng: RNG, label: string) =>
    pick(rng, [
      `Tapping "${label}".`,
      `Now I'll tap "${label}" at its centre.`,
      `"${label}" is there — tapping its centre.`,
    ]),
  tapMissRecover: (rng: RNG) =>
    pick(rng, [
      "That tap didn't change the screen. Per the discovery-on-failure rule I'll re-run discovery rather than blindly retry.",
      "The screen looks unchanged after the tap — re-running discovery to get fresh coordinates instead of tapping the same spot again.",
    ]),
  describeFailRecover: (rng: RNG) =>
    pick(rng, [
      "describe failed because the accessibility runtime wasn't ready. I'll retry it now that the app has settled.",
      "The describe call errored (ax-service not ready) — retrying after the launch settles.",
    ]),
  typeInto: (rng: RNG, label: string) =>
    pick(rng, [`Typing into "${label}".`, `Entering text in the "${label}" field.`]),
  scroll: (rng: RNG) =>
    pick(rng, [
      "The target isn't visible yet — scrolling down to reveal more.",
      "I need to scroll; the element is below the fold.",
    ]),
  batch: (rng: RNG) =>
    pick(rng, [
      "These steps don't need me to look between them, so I'll batch them with run-sequence.",
      "I'll run this known sequence in one run-sequence call since nothing depends on the intermediate screens.",
    ]),
  verify: (rng: RNG) =>
    pick(rng, [
      "Let me verify the result structurally with a discovery call.",
      "I'll confirm we reached the expected screen.",
    ]),
  done: (rng: RNG, summary: string) => summary,
};

// ---- personas: who is asking, and in what voice ----

export interface PromptCtx {
  app: string;
  platform: string;
  target?: string;
  path?: string[];
  field?: string;
}

// Per-kind persona weights. Every kind admits all three voices (a non-technical
// user can still want a profile run — "my app is slow"), but the mix is biased
// toward the natural asker for that task.
const PERSONA_WEIGHTS: Record<string, [Persona, number][]> = {
  "profile": [
    ["technical", 6],
    ["nontechnical", 3],
    ["seeker", 1],
  ],
  "debug-inspect": [
    ["technical", 7],
    ["seeker", 2],
    ["nontechnical", 1],
  ],
  "console-check": [
    ["technical", 8],
    ["nontechnical", 2],
  ],
  "network-inspect": [
    ["technical", 7],
    ["nontechnical", 3],
  ],
  "native-inspect": [
    ["technical", 8],
    ["seeker", 2],
  ],
  "run-sequence": [
    ["technical", 5],
    ["nontechnical", 5],
  ],
  "visual-regression": [
    ["nontechnical", 5],
    ["technical", 5],
  ],
  "toggle": [
    ["nontechnical", 6],
    ["seeker", 3],
    ["technical", 1],
  ],
  "login": [
    ["nontechnical", 7],
    ["technical", 3],
  ],
  "navigate-tap": [
    ["nontechnical", 5],
    ["seeker", 3],
    ["technical", 2],
  ],
  "deep-link": [
    ["technical", 5],
    ["nontechnical", 5],
  ],
  "pinch-zoom": [
    ["nontechnical", 6],
    ["technical", 4],
  ],
  "scroll-find": [
    ["seeker", 6],
    ["nontechnical", 4],
  ],
  "chromium-tabs": [
    ["nontechnical", 5],
    ["technical", 5],
  ],
  "android-setup": [
    ["technical", 5],
    ["nontechnical", 5],
  ],
  "hide-and-seek": [
    ["seeker", 9],
    ["nontechnical", 1],
  ],
};

export function pickPersona(rng: RNG, kind: string): Persona {
  const table =
    PERSONA_WEIGHTS[kind] ??
    ([
      ["nontechnical", 5],
      ["technical", 3],
      ["seeker", 2],
    ] as [Persona, number][]);
  const total = table.reduce((a, [, w]) => a + w, 0);
  let r = rng.int(total);
  for (const [p, w] of table) {
    if (r < w) return p;
    r -= w;
  }
  return "nontechnical";
}

export function userTaskPhrase(rng: RNG, kind: string, persona: Persona, ctx: PromptCtx): string {
  if (persona === "technical") return technicalPhrase(rng, kind, ctx);
  if (persona === "seeker") return seekerPhrase(rng, kind, ctx);
  return nontechnicalPhrase(rng, kind, ctx);
}

// ---- seeker voice: navigation / find-it framing (trains app navigation) ----

function seekerPhrase(rng: RNG, kind: string, ctx: PromptCtx): string {
  const t = ctx.target ?? "it";
  const generic = [
    `Somewhere in ${ctx.app} there's "${t}" — find it and open it. I don't remember the path.`,
    `I can't find "${t}" in ${ctx.app}. Can you hunt around and get to it?`,
    `Navigate ${ctx.app} and find the screen with "${t}", then tap it.`,
    `Dig through ${ctx.app} until you reach "${t}" and select it.`,
    `Where is "${t}" in ${ctx.app}? Explore and take me there.`,
  ];
  switch (kind) {
    case "toggle":
      return pick(rng, [
        `There's a "${t}" setting somewhere in ${ctx.app} — find it and turn it on.`,
        `I want to enable "${t}" in ${ctx.app} but I don't know where it lives. Find it.`,
      ]);
    case "scroll-find":
      return pick(rng, [
        `"${t}" is further down somewhere in ${ctx.app} — scroll and find it.`,
        ...generic,
      ]);
    default:
      return pick(rng, generic);
  }
}

// ---- technical voice: developer digging deeper ----

function technicalPhrase(rng: RNG, kind: string, ctx: PromptCtx): string {
  switch (kind) {
    case "profile":
      return pick(rng, [
        `Profile the ${ctx.path?.[0] ?? "list"} in ${ctx.app} while scrolling — I think a row component re-renders every frame. Find the hot commit and root-cause it.`,
        `${ctx.app} drops frames on ${ctx.path?.[0] ?? "the list"}. Run the React + native profilers, correlate, and tell me the dominant cost.`,
      ]);
    case "debug-inspect":
      return pick(rng, [
        `Which component/source file renders "${ctx.target}" in ${ctx.app}? Inspect the element and give me file:line.`,
        `Map "${ctx.target}" in ${ctx.app} back to its source via the component tree + inspect-element.`,
      ]);
    case "console-check":
      return pick(rng, [
        `Check ${ctx.app}'s console log registry for errors/warnings and confirm the RN version at runtime.`,
        `Pull ${ctx.app}'s logs — any errors? Also eval the RN version in the runtime.`,
      ]);
    case "network-inspect":
      return pick(rng, [
        `Capture the HTTP request ${ctx.app} fires when you open "${ctx.target}" and dump the request/response details.`,
        `Inspect the API call behind "${ctx.target}" in ${ctx.app} — method, status, timing, body.`,
      ]);
    case "native-inspect":
      return pick(rng, [
        `Give me the accessibilityIdentifier and view class of "${ctx.target}" in ${ctx.app} via native-describe-screen.`,
      ]);
    case "navigate-tap":
      return pick(rng, [
        `Drive ${ctx.app} to ${ctx.path?.join(" > ")} and tap "${ctx.target}" — I'm verifying the nav stack.`,
        `Walk ${ctx.app} through ${ctx.path?.join(" → ")} to "${ctx.target}" using grounded discovery at each step.`,
      ]);
    case "visual-regression":
      return pick(rng, [
        `Baseline ${ctx.app}'s ${ctx.path?.[0] ?? "screen"} at full res, reach the after-state, then screenshot-diff for unintended regressions.`,
      ]);
    case "run-sequence":
      return pick(rng, [
        `Batch the ${ctx.app} search (focus field, type, submit) into one run-sequence, then open the result.`,
      ]);
    default:
      return nontechnicalPhrase(rng, kind, ctx);
  }
}

// ---- non-technical voice: app builder, natural language, UI-by-appearance ----

function nontechnicalPhrase(rng: RNG, kind: string, ctx: PromptCtx): string {
  const dev = deviceWord(ctx.platform);
  switch (kind) {
    case "navigate-tap":
      return pick(rng, [
        `In the ${ctx.app} ${dev}, navigate to ${ctx.path?.join(" > ")} and tap "${ctx.target}".`,
        `Open ${ctx.app} and get to "${ctx.target}" (it's under ${ctx.path?.join(" > ")}).`,
        `Can you tap "${ctx.target}" in ${ctx.app}? Path is ${ctx.path?.join(" → ")}.`,
        `Go into ${ctx.app}, drill into ${ctx.path?.join(" / ")}, and tap ${ctx.target}.`,
      ]);
    case "toggle":
      return pick(rng, [
        `Turn ${ctx.target ? `"${ctx.target}"` : "the setting"} on in ${ctx.app}.`,
        `In ${ctx.app}, flip the "${ctx.target}" switch.`,
        `Enable "${ctx.target}" in ${ctx.app} (${ctx.path?.join(" > ")}).`,
      ]);
    case "login":
      return pick(rng, [
        `Log into ${ctx.app} with a test account and confirm we land on the home screen.`,
        `Fill in the ${ctx.app} sign-in form and submit, then verify login worked.`,
        `Sign in to ${ctx.app} (email + password) and check we reach the dashboard.`,
      ]);
    case "scroll-find":
      return pick(rng, [
        `Find "${ctx.target}" in ${ctx.app} — it may be further down the list — and open it.`,
        `Scroll the ${ctx.app} list until you can tap "${ctx.target}".`,
      ]);
    case "run-sequence":
      return pick(rng, [
        `Quickly run through the ${ctx.app} checkout steps without stopping to look between each tap.`,
        `Replay this known ${ctx.app} flow in one go: ${ctx.path?.join(" → ")}.`,
      ]);
    case "visual-regression":
      return pick(rng, [
        `Capture a baseline of the ${ctx.app} ${ctx.path?.[0] ?? "screen"}, navigate to it after a change, and run a screenshot diff.`,
        `I want a visual regression check on ${ctx.app}: baseline now, then diff after the change.`,
      ]);
    case "profile":
      return pick(rng, [
        `${ctx.app} feels janky when scrolling the ${ctx.path?.[0] ?? "list"}. Profile it and tell me the bottleneck.`,
        `Profile re-renders in ${ctx.app} while scrolling and report the worst offender.`,
        `Find out why ${ctx.app} drops frames on the ${ctx.path?.[0] ?? "home"} screen.`,
      ]);
    case "flow-record":
      return pick(rng, [
        `Record a reusable flow for navigating ${ctx.app} to "${ctx.target}", then replay it.`,
        `Save the steps to reach "${ctx.target}" in ${ctx.app} as a flow so we can re-run it later.`,
      ]);
    case "network-inspect":
      return pick(rng, [
        `Trigger the ${ctx.app} request for "${ctx.target}" and show me the network call details.`,
        `Inspect the API call ${ctx.app} makes when you open "${ctx.target}".`,
      ]);
    case "android-setup":
      return pick(rng, [
        `Boot the Android emulator, launch ${ctx.app}, and tap "${ctx.target}".`,
        `Nothing's running — get ${ctx.app} up on Android and open "${ctx.target}".`,
      ]);
    case "debug-inspect":
      return pick(rng, [
        `Which source file renders "${ctx.target}" in ${ctx.app}? Inspect it.`,
        `Find the component behind "${ctx.target}" in ${ctx.app}.`,
      ]);
    case "deep-link":
      return pick(rng, [
        `Deep-link straight into ${ctx.app}'s ${ctx.path?.[0] ?? "screen"} and tap "${ctx.target}".`,
        `Use ${ctx.app}'s URL scheme to jump to ${ctx.path?.[0]} and open "${ctx.target}".`,
      ]);
    case "console-check":
      return pick(rng, [
        `Check ${ctx.app}'s console logs for errors and confirm the React Native version.`,
        `Are there any errors in ${ctx.app}'s logs? Also tell me the RN version.`,
      ]);
    case "pinch-zoom":
      return pick(rng, [
        `Pinch-zoom the "${ctx.target}" in ${ctx.app} and check it scales across rotations.`,
        `Zoom into the image on the ${ctx.app} product screen and rotate to verify it scales.`,
      ]);
    case "chromium-tabs":
      return pick(rng, [
        `In ${ctx.app}, open ${ctx.path?.[0]} in a new tab and tap "${ctx.target}".`,
        `Open a new tab for ${ctx.path?.[0]} in ${ctx.app} and click "${ctx.target}".`,
      ]);
    case "native-inspect":
      return pick(rng, [
        `What's the accessibilityIdentifier and view class of "${ctx.target}" in ${ctx.app}?`,
        `Inspect the native UIKit properties of "${ctx.target}" in ${ctx.app} (${ctx.path?.join(" > ")}).`,
      ]);
    default:
      return `Help me with ${ctx.app}.`;
  }
}

import { describe, it, expect } from "vitest";
import { expectNoForbiddenAdvice } from "./forbidden-advice";
import { pinsOnce } from "./pins";
import { CHROMIUM_WORDS, expectNoPlatformBeyondTag, platformTag } from "./platform-tag";

/**
 * The doc-pinning helpers only ever fail under a mutation, so nothing in a green
 * suite tells a weakened one from the real thing — a widened `FORBIDDEN` pattern
 * or a `CHROMIUM_WORDS` that lost a synonym leaves every caller passing. Their
 * contracts are asserted here directly.
 */
describe("pinsOnce", () => {
  it("requires exactly one occurrence", () => {
    pinsOnce("restart-app is not supported on chromium", "not supported on chromium");
    expect(() => pinsOnce("nothing here", "not supported on chromium")).toThrow();
    expect(() => pinsOnce("chromium chromium", "chromium")).toThrow();
  });
});

describe("CHROMIUM_WORDS", () => {
  it("matches every word this repo names a Chromium runtime with", () => {
    for (const cell of [
      "not supported on Chromium",
      "boot-device with electronAppPath relaunches an Electron app",
      "and on any CDP browser",
    ]) {
      expect(cell, cell).toMatch(CHROMIUM_WORDS);
    }
  });

  it("does not match a row that names no Chromium runtime", () => {
    expect("Relaunch by bundleId (iOS / Android / Vega)").not.toMatch(CHROMIUM_WORDS);
  });
});

describe("expectNoPlatformBeyondTag", () => {
  const tag = platformTag({ apple: { simulator: true }, android: { emulator: true } });

  it("accepts prose that claims only its tag", () => {
    expect(tag).toBe("iOS / Android");
    expectNoPlatformBeyondTag(`Full React fiber tree on ${tag} (names, depth)`, tag, "row");
  });

  it("rejects a platform claimed after the tag, however it is separated", () => {
    // `row()` hands this helper the whole markdown line, so a platform in a LATER
    // CELL is inside its reach and must fail — the separator is not the contract,
    // the cell's whole text is.
    for (const cell of [
      `Full React fiber tree on ${tag} (names), and on Vega.`,
      `| Reload | \`x\` (${tag}) | also on Vega |`,
      `(${tag}); plus Vega`,
      `(${tag}): also Vega`,
    ]) {
      expect(() => expectNoPlatformBeyondTag(cell, tag, "row"), cell).toThrow();
    }
  });
});

describe("expectNoForbiddenAdvice", () => {
  it("accepts prose that carries none of the barred instructions", () => {
    expectNoForbiddenAdvice(
      "Ask the user to quit it, then relaunch once it has exited. Do not relaunch there. " +
        "A Chromium app cannot be relaunched with `restart-app`.",
      "surface"
    );
    expectNoForbiddenAdvice(undefined, "absent surface");
  });

  it("accepts every ordinary way correct prose negates one", () => {
    // A pattern keyed on one deleted negation turns correct prose red with a
    // message accusing the author of the opposite. English has more than three
    // ways to say no, and the surfaces use them.
    for (const text of [
      "Don't relaunch there.",
      "You should not relaunch there.",
      "A Chromium app is not relaunched with restart-app.",
      "Never relaunch there.",
      "You cannot relaunch it with restart-app on Chromium.",
      "A missing entry does not mean the app exited.",
      "A missing entry never proves the app exited.",
      "An absent entry never confirms the app is gone.",
      "Do not keep using the old id.",
      "Do not relaunch it anyway.",
      "Do not just relaunch it.",
      "It is not enough to just relaunch it.",
      "It is never safe to simply relaunch a live app.",
      "Follow the guidance on its result.",
      "The guidance names the relaunch that works.",
      "Do not ignore the guidance debugger-status returns.",
      "Never ignore the guidance on the result.",
      "You cannot skip the guidance here.",
      // The negation is a clause away from the act, or spelled a way the
      // surfaces spell it.
      "Do not ever relaunch it there.",
      "A Chromium app isn't relaunched with restart-app.",
      "You won't reuse the old id.",
      "It is no longer relaunched with restart-app on Chromium.",
      // The refusal and the instruction are two clauses, so the platform named
      // in one is not the platform instructed in the other. Every restart-app
      // surface has to carry a sentence of this shape.
      "use restart-app — not supported on Chromium",
      "On iOS / Android / Vega, use `restart-app`; on Chromium it is refused.",
      "Use `restart-app` (not on Chromium) to relaunch it.",
      // All three dashes, because the repo writes clause breaks with each.
      "use `restart-app` - on Chromium it is refused.",
      "use `restart-app` – on Chromium it is refused.",
      // `use` unanchored matches the tail of "because", and the negation the
      // lookbehind would need is on the other side of the verb.
      "This is because `restart-app` is refused on Chromium.",
      "The refusal exists because restart-app cannot stop a Chromium app.",
      "Never boot the app again while it is up.",
      // The two steps the recovery itself prescribes, which the bars are worded
      // one qualifier away from catching: the boot AFTER a confirmed exit, and
      // the id of an app that never relaunched.
      "Once the user confirms the exit, boot the app again with boot-device and electronAppPath.",
      "After it has exited, launch the app again.",
      "Reuse the id you already have: the app is still on that port and only lacks a window.",
      "Keep using the same chromium-cdp-<port> id — the app never exited.",
      "A missing entry does not show the app exited.",
      // Every contraction and long form of the negation, because a list that
      // spells one of them wrong turns the correct prose using it red.
      "The agent didn't just relaunch the app.",
      "The agent doesn't just relaunch the app.",
      "The agent did not just relaunch the app.",
      "Do not ignore that guidance.",
      // A refusal standing between the tool and the platform is how every
      // surface states the rule, in each of the shapes they write it.
      "use restart-app, which is refused on Chromium.",
      "Keep the id boot-device returned.",
      // The refusal after the platform, which neither guard can see from where it
      // stands - so the span between the two has to be what keeps this clean.
      "Use restart-app on iOS / Android / Vega, but on Chromium it is refused.",
      // The rule with the refusal first and the platform it does apply to
      // second, which is the order a shortening rewrite reaches for, in each of
      // the separators - including the newline and the table cell - that the
      // surfaces carrying it are written in.
      "`restart-app` is not supported on Chromium; on iOS / Android / Vega it is only hung, " +
        "so use `restart-app`.",
      "`restart-app` is not supported on Chromium — on iOS / Android / Vega it is only hung, " +
        "so use `restart-app`.",
      "| Relaunch | refused on Chromium | iOS / Android hang, so use restart-app |",
      // The same two boundaries with no platform word in them, so nothing but the
      // cell and the line can be what keeps them clean - the pair above is
      // excused by the platform first and says nothing about either.
      "| Chromium | the window is the user's | it is only hung, so use restart-app |",
      "refused on Chromium\n\nWhen the runtime is only hung, so use restart-app.",
      // The shape the recovery tables are actually written in: the tool in one
      // cell and the platform it is refused on in the next. A cell boundary is a
      // column boundary, so nothing carries across it.
      "| Restart an app | use `restart-app` | not supported on Chromium |",
      "| Relaunch | use restart-app | refused on Chromium, the quit is the user's |",
      "not supported on Chromium\n\nOn iOS / Android / Vega it is hung, so use restart-app.",
      "On Chromium it is not relaunched with restart-app, so do not call restart-app.",
    ])
      expectNoForbiddenAdvice(text, `correct: ${text}`);
  });

  it("rejects each barred instruction, in the shapes a rewrite actually produces", () => {
    for (const text of [
      "It may still be up — relaunch it anyway.",
      "Keep using the old chromium-cdp-<port> id.",
      "Reuse the chromium-cdp-<port> id you already have.",
      "If nothing is listed, boot it again.",
      "If nothing is listed, call boot-device again.",
      "A missing entry does mean the app exited.",
      "A missing entry means the app exited.",
      "An absent entry proves the app exited.",
      "On Chromium it is relaunched with restart-app.",
      "Use restart-app to relaunch a Chromium app.",
      "It only lacks a window, so relaunch there once.",
      "It only lacks a window — relaunch it there.",
      "Just relaunch it.",
      "It may still be up; just relaunch the app.",
      "Simply relaunch it once.",
      "Relaunch it regardless.",
      "debugger-status returns a guidance field, but ignore the guidance on Chromium.",
      "It returns a guidance field, but that guidance is stale here.",
      "Call debugger-status, but do not follow the guidance on its result.",
      "Read the result and skip the guidance.",
      "Disregard the guidance on Chromium.",
      "The guidance is out of date on Chromium.",
      // The imperative, which is how a rewrite states it.
      "Relaunch it with `restart-app` on Chromium.",
      "Relaunch the app with restart-app on Chromium.",
      // The negation one clause back is about a different claim - and it is the
      // recovery's own vocabulary, so this is what a shortening rewrite of it
      // produces.
      "The exit cannot be confirmed, so relaunch it anyway.",
      "The app is not listed, so just relaunch it.",
      "list-devices does not show it; just relaunch the app.",
      "debugger-status is not needed here, ignore the guidance.",
      // The word order the mirror pattern has to cover, and the rewordings each
      // pattern is one synonym away from missing.
      "On Chromium use restart-app to relaunch it.",
      "Reuse your existing id.",
      "A missing entry shows the app exited.",
      "An absent entry indicates the app is gone.",
      "If nothing is listed, boot the app again.",
      "Ignore that guidance on Chromium.",
      // A dash or a bracket between the negation and the act puts them in
      // different clauses, so the negation is about a different claim - these are
      // the barred sentences a rewrite of the recovery's own prose produces.
      "The exit is not confirmed - relaunch it anyway.",
      "The exit is not confirmed – relaunch it anyway.",
      "This is not a Metro session - use restart-app on chromium.",
      "[not confirmed] use restart-app on chromium",
      "list-devices is not authoritative - a missing entry means the app exited.",
      // A fronted "On Chromium," is one clause, not two.
      "On Chromium, use restart-app to bring it back.",
      // A "so" clause inherits the topic, so these are one claim across two
      // clauses - and each is assembled out of sentences the recovery itself
      // ships, which is what makes them the plausible rewrite rather than a
      // contrived one.
      "On Chromium, boot-device only starts an app, so use restart-app.",
      "On Chromium there is no launch-app, so use restart-app.",
      "On Chromium it never stops one, so use restart-app.",
      "On Chromium the exit cannot be confirmed, so use restart-app.",
      // Everything before the "so" is the reason, so a negation in it is about
      // the reason and never excuses the instruction - which is why this pattern
      // carries no negation guard, and why a negated reason is the commonest way
      // the barred sentence gets written.
      "On Chromium it will not come back so use restart-app.",
      "On Chromium there is never a window so use restart-app.",
      // `call` is the other verb the surfaces use for a tool, and a qualifier
      // before the comma is still one fronted clause.
      "Call restart-app on Chromium.",
      "Try restart-app on Chromium.",
      // A named exit is not a confirmed one, and a named window is not a live app.
      "The exit cannot be confirmed, so boot the app again.",
      "Reuse the id you already have — the app was relaunched on a new port.",
      "On Chromium, call restart-app.",
      "On Chromium it never stops one, so call restart-app.",
      // The same sentence as the two accepted above with the boundary taken out.
      "On Chromium the quit is the user's, so use restart-app.",
      "On Chromium browsers, use restart-app.",
      "Use restart-app there, on Chromium.",
    ])
      expect(() => expectNoForbiddenAdvice(text, "surface"), text).toThrow();
  });
});

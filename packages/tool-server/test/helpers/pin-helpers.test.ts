import { describe, it, expect } from "vitest";
import { expectNoForbiddenAdvice } from "./forbidden-advice";
import { pinsOnce, pinsSentenceEnd, pinsUnqualified } from "./pins";
import {
  CHROMIUM_WORDS,
  expectNoPlatformBeyondTag,
  expectTagEndsTheClaim,
  platformTag,
} from "./platform-tag";

/**
 * The doc-pinning helpers only ever fail under a mutation, so nothing in a green
 * suite tells a weakened one from the real thing — `pinsUnqualified` degraded to
 * `pinsOnce`, or the anchored tag regex degraded to a containment check, both
 * leave every caller passing. Their contracts are asserted here directly.
 */
describe("pinsOnce", () => {
  it("requires exactly one occurrence", () => {
    pinsOnce("restart-app is not supported on chromium", "not supported on chromium");
    expect(() => pinsOnce("nothing here", "not supported on chromium")).toThrow();
    expect(() => pinsOnce("chromium chromium", "chromium")).toThrow();
  });
});

describe("pinsUnqualified", () => {
  const claim = "not supported on chromium";

  it("passes when the claim stands on its own", () => {
    for (const tail of [
      ".",
      ", where boot-device only starts an app",
      " — the gate rejects it —",
    ]) {
      pinsUnqualified(`restart-app is ${claim}${tail}`, claim);
    }
  });

  // Every word the qualifier list carries, so a shortened list fails here rather
  // than silently letting that phrasing through on a real doc surface.
  it("fails on a carve-out appended to the claim it pins", () => {
    for (const tail of [
      " except for an Electron app you booted yourself",
      " unless you booted the app yourself",
      " until boot-device has started it",
      ", other than an app boot-device started",
      ", apart from an app you booted yourself",
      ", save for an Electron app",
      " provided boot-device started it",
      " as long as you booted it yourself",
      " only when the app was booted elsewhere",
      " only if boot-device started it",
      ", though a vanished entry settles it",
      ", although boot-device started this one",
      ", aside from an app boot-device started",
      ", barring an app you booted yourself",
      ", but an app boot-device started can be",
      ", however an app boot-device started can be",
    ]) {
      expect(() => pinsUnqualified(`restart-app is ${claim}${tail}`, claim), tail).toThrow();
    }
  });

  it("sees a carve-out through markdown emphasis and quotes", () => {
    // The device-interact row bolds the refusal, so the carve-out lands after the
    // closing marks rather than against the needle.
    expect(() => pinsUnqualified(`**${claim}** except for Electron`, claim)).toThrow();
    expect(() => pinsUnqualified(`"${claim}", unless you booted it`, claim)).toThrow();
  });
});

describe("pinsSentenceEnd", () => {
  const claim = "the ports `boot-device` opened";

  it("accepts a claim that closes its sentence", () => {
    for (const tail of ["."]) pinsSentenceEnd(`probes 9222 and ${claim}${tail}`, claim);
    pinsSentenceEnd(`probes 9222 and ${claim}`, claim);
    pinsSentenceEnd(`(probes 9222 and ${claim}). Use it early.`, claim);
  });

  it("fails on a clause appended after it", () => {
    for (const tail of [
      ", plus any port a Chromium process is listening on",
      " and anything else that answers",
      " — and any port you already know",
    ]) {
      expect(() => pinsSentenceEnd(`probes 9222 and ${claim}${tail}`, claim), tail).toThrow();
    }
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
    expectNoPlatformBeyondTag(`Full React fiber tree on ${tag} (names, depth)`, tag, "row");
  });

  it("rejects a platform claimed after the tag", () => {
    expect(() =>
      expectNoPlatformBeyondTag(`Full React fiber tree on ${tag} (names), and on Vega.`, tag, "row")
    ).toThrow();
  });
});

describe("expectTagEndsTheClaim", () => {
  const tag = platformTag({ apple: { simulator: true }, android: { emulator: true } });

  it("accepts a tag that ends the claim", () => {
    expect(tag).toBe("iOS / Android");
    for (const cell of [
      `| Reload JS | \`debugger-reload-metro\` (${tag}) |`,
      `Reload all connected apps (${tag}). Needs a CDP target.`,
      `Relaunch by bundleId (${tag}); not supported on Chromium`,
      `Relaunch by bundleId (${tag})`,
    ]) {
      expectTagEndsTheClaim(cell, tag, "row");
    }
  });

  it("rejects a platform appended outside the tag", () => {
    for (const cell of [
      `Relaunch by bundleId (${tag}) and Chromium. Use when …`,
      `Reload all connected apps (${tag}) plus any CDP browser.`,
    ]) {
      expect(() => expectTagEndsTheClaim(cell, tag, "row"), cell).toThrow();
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

  it("rejects each barred instruction, including the two the lookbehind must let past", () => {
    for (const text of [
      "It may still be up — relaunch it anyway.",
      "Keep using the old chromium-cdp-<port> id.",
      "If nothing is listed, boot it again.",
      "A missing entry does mean the app exited.",
      "On Chromium it is relaunched with restart-app.",
      "That string means the app is still up, not that it failed to launch.",
      "That string means the launch failed.",
      "It only lacks a window, so relaunch there once.",
    ])
      expect(() => expectNoForbiddenAdvice(text, "surface"), text).toThrow();
  });
});

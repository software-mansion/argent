import { describe, it, expect, vi } from "vitest";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

const UDID = "18BE573F-5240-4034-A391-5F0D33D1C18D";

/**
 * Drive the RN branch of the tool with a canned read-script response. The real
 * integration harness synthesizes its payloads in TypeScript rather than running
 * the injected JS, so it cannot exercise this logic — these tests hit `execute`
 * directly with the exact JSON shape the app returns.
 */
async function runWithReadResult(payload: Record<string, unknown>): Promise<string> {
  const evaluate = vi.fn(async (script: string) => {
    // The tool re-injects the interceptor before reading; that call's result is
    // deliberately not used, so any well-formed answer will do.
    if (script.includes("globalThis.fetch =")) {
      return JSON.stringify({ installed: false, reason: "already installed" });
    }
    return JSON.stringify(payload);
  });

  const services = { inspector: { port: 8081, cdp: { evaluate } } };
  return (await networkLogsTool.execute(
    services as never,
    { device_id: UDID, port: 8081, pageIndex: "latest" },
    {} as never
  )) as string;
}

describe("view-network-logs — empty result describes the capture window", () => {
  it("reports how long capture has been running instead of claiming it is simply active", async () => {
    const out = await runWithReadResult({
      entries: [],
      total: 0,
      interceptorInstalled: true,
      capturedForMs: 2,
    });

    expect(out).toContain("No network traffic captured.");
    expect(out).toContain("recording for 2 ms");
    // The whole point of the issue: an empty log must not read as a verdict.
    expect(out).toContain('not "the app made no requests"');
    // The old wording asserted a state it had just created.
    expect(out).not.toContain("Network interception is active");
  });

  it("renders a long window in human units so a genuine empty result reads as one", async () => {
    const out = await runWithReadResult({
      entries: [],
      total: 0,
      interceptorInstalled: true,
      capturedForMs: 754_000,
    });
    expect(out).toContain("recording for 12 min");
  });

  it("says the window is unknown rather than inventing a fresh one for a stale interceptor", async () => {
    // An interceptor installed by an older argent has no timestamp. Defaulting
    // that to "now" would report a 0 ms window forever — the same false
    // reassurance this fix exists to remove.
    const out = await runWithReadResult({
      entries: [],
      total: 0,
      interceptorInstalled: true,
      capturedForMs: null,
    });

    expect(out).toContain("start time is unknown");
    expect(out).not.toContain("recording for");
  });

  it("states plainly when nothing was recording at all", async () => {
    const out = await runWithReadResult({
      entries: [],
      total: 0,
      interceptorInstalled: false,
      capturedForMs: null,
    });

    expect(out).toContain("NOT installed");
    expect(out).toContain("says nothing about whether the app made requests");
  });

  it("still lists traffic when there is some", async () => {
    const out = await runWithReadResult({
      entries: [],
      total: 3,
      interceptorInstalled: true,
      capturedForMs: 5_000,
    });
    expect(out).toContain("NETWORK LOGS");
    expect(out).not.toContain("No network traffic captured.");
  });

  it("names the exclusions that make an empty result ambiguous", async () => {
    const out = await runWithReadResult({
      entries: [],
      total: 0,
      interceptorInstalled: true,
      capturedForMs: 10,
    });

    // fetch()-only is why an axios app sees nothing at all.
    expect(out).toContain("XMLHttpRequest");
    expect(out).toContain("axios");
    // The Metro filter is silent and was undocumented.
    expect(out).toContain("localhost:8081");
  });

  it("tolerates a runtime that reports neither field", async () => {
    // Older interceptors answer without the new keys; that must not throw or
    // produce "recording for undefined".
    const out = await runWithReadResult({ entries: [], total: 0 });
    expect(out).toContain("No network traffic captured.");
    expect(out).not.toContain("undefined");
  });
});

describe("interceptor scripts carry the capture-window fields", () => {
  it("stamps the install time when it actually installs", () => {
    expect(NETWORK_INTERCEPTOR_SCRIPT).toContain("__argent_network_installed_at = Date.now()");
  });

  it("computes elapsed inside the app so no host/device clock comparison happens", () => {
    const script = makeNetworkLogReadScript(0, 50, 8081);
    expect(script).toContain("capturedForMs");
    expect(script).toContain("Math.max(0, Date.now() - installedAt)");
    // Absent timestamp must stay null, never be defaulted to "now".
    expect(script).toContain("installedAt ?");
    expect(script).toContain(": null");
  });

  it("keeps reporting interceptorInstalled: false when there is no log", () => {
    expect(makeNetworkLogReadScript(0, 50, 8081)).toContain("interceptorInstalled: false");
  });
});

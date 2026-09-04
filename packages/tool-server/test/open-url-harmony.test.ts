import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";

// harmonyImpl's only device work is `openHarmonyUrl`, whose own reading of `aa`
// stdout is covered in harmony-apps.test.ts. Stub it at the module boundary so
// these tests are about what the platform impl builds on top: the note, and the
// arguments it hands down.
const openHarmonyUrlMock = vi.fn();
vi.mock("../src/utils/harmony-apps", async () => {
  const actual = await vi.importActual<object>("../src/utils/harmony-apps");
  return { ...actual, openHarmonyUrl: (...args: unknown[]) => openHarmonyUrlMock(...args) };
});

import { httpDeepLinkNote } from "../src/tools/open-url/deep-link-note";
import { harmonyImpl } from "../src/tools/open-url/platforms/harmony";

// A real handset id: the `harmony-` prefix is the registry's, the serial behind
// it is what `hdc` accepts as a connect key.
const CONNECT_KEY = "025DEK236V035771";
const device = {
  id: `harmony-${CONNECT_KEY}`,
  platform: "harmony",
  kind: "device",
} as unknown as DeviceInfo;

beforeEach(() => {
  openHarmonyUrlMock.mockReset();
  openHarmonyUrlMock.mockResolvedValue(undefined);
});

describe("open-url HarmonyOS handler caveats every URL it reports as opened", () => {
  it("attaches note for an https URL, appended to the shared web-URL note", async () => {
    const url = "https://bsky.app/profile/tvpworld.bsky.social";
    const res = await harmonyImpl.handler({}, { udid: device.id, url }, device);

    expect(res.opened).toBe(true);
    expect(res.url).toBe(url);
    // The HarmonyOS caveat extends the shared note rather than replacing it —
    // both halves are load-bearing, and on this platform the caveat is the only
    // signal that `opened: true` may mean nothing happened on screen.
    expect(res.note).toContain(httpDeepLinkNote(url));
    expect(res.note).toMatch(/aa start -U. reports success whenever the system accepts the URI/);
    expect(res.note?.startsWith(httpDeepLinkNote(url)!)).toBe(true);
    // No stray separator or stringified `undefined` from the composition.
    expect(res.note).not.toMatch(/undefined|^\s|\s\s|\s$/);
    // hdc gets the connect key, not the prefixed registry id, and the URL is
    // handed down unchanged.
    expect(openHarmonyUrlMock).toHaveBeenCalledWith(CONNECT_KEY, url);
  });

  it("attaches the caveat alone for a non-web scheme, which the shared note skips", async () => {
    // A scheme the system routes to its app selector reports success exactly
    // like a handled one: measured on 6.0.1, `tel:12345` and `mailto:a@b.com`
    // both print `start ability successfully.` and leave a modal "No options to
    // open with" on screen. Only a scheme nothing claims at all throws
    // (10103101), so `opened: true` needs the caveat here too.
    const res = await harmonyImpl.handler({}, { udid: device.id, url: "tel:12345" }, device);
    expect(res.opened).toBe(true);
    expect(httpDeepLinkNote("tel:12345")).toBeUndefined();
    expect(res.note).toMatch(/aa start -U. reports success whenever the system accepts the URI/);
    expect(res.note).toMatch(/No options to open with/);
    // The shared web-URL note must not be pasted onto a non-web scheme.
    expect(res.note).not.toMatch(/Universal Links/);
  });

  it("propagates a device-side failure instead of resolving with a note", async () => {
    openHarmonyUrlMock.mockRejectedValue(
      new FailureError(
        `HarmonyOS device '${CONNECT_KEY}' could not open 'nope://x': Error Code:10103101 ` +
          `Error Message:Failed to find a matching application for implicit launch.`,
        {
          error_code: FAILURE_CODES.HARMONY_ABILITY_START_FAILED,
          failure_stage: "harmony_open_url",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      )
    );
    await expect(
      harmonyImpl.handler({}, { udid: device.id, url: "nope://x" }, device)
    ).rejects.toThrow(/10103101/);
  });
});

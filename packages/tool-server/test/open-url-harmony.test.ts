import { describe, it, expect, vi, beforeEach } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";

// `openHarmonyUrl`'s reading of `aa` is covered in harmony-apps.test.ts.
const openHarmonyUrlMock = vi.fn();
vi.mock("../src/utils/harmony-apps", async () => {
  const actual = await vi.importActual<object>("../src/utils/harmony-apps");
  return { ...actual, openHarmonyUrl: (...args: unknown[]) => openHarmonyUrlMock(...args) };
});

import { httpDeepLinkNote } from "../src/tools/open-url/deep-link-note";
import { harmonyImpl } from "../src/tools/open-url/platforms/harmony";

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
    expect(res.note).toContain(httpDeepLinkNote(url));
    expect(res.note).toMatch(/aa start -U. reports success whenever the system accepts the URI/);
    expect(res.note?.startsWith(httpDeepLinkNote(url)!)).toBe(true);
    expect(res.note).not.toMatch(/undefined|^\s|\s\s|\s$/);
    expect(openHarmonyUrlMock).toHaveBeenCalledWith(CONNECT_KEY, url);
  });

  it("attaches the caveat alone for a non-web scheme, which the shared note skips", async () => {
    // On 6.0.1, `tel:` and `mailto:` print success and leave a chooser modal.
    const res = await harmonyImpl.handler({}, { udid: device.id, url: "tel:12345" }, device);
    expect(res.opened).toBe(true);
    expect(httpDeepLinkNote("tel:12345")).toBeUndefined();
    expect(res.note).toMatch(/aa start -U. reports success whenever the system accepts the URI/);
    expect(res.note).toMatch(/No options to open with/);
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

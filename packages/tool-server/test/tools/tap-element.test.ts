import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFailureSignal } from "@argent/registry";
import { tapElementSchema, tapElementTool } from "../../src/tools/tap-element";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";
import { RunnerCommandError } from "../../src/utils/ios-device/runner-client";

const DEVICE = "00008110-000978540290401E";

beforeEach(() => {
  setCurrentIosDeviceApp(DEVICE, "com.example.app");
});

describe("tap-element schema", () => {
  it("accepts exact identifier/label selectors and rejects role-only or imprecise shapes", () => {
    expect(
      tapElementSchema.safeParse({
        udid: DEVICE,
        selector: { identifier: "PickerSearch", role: "AXTextField" },
      }).success
    ).toBe(true);
    expect(
      tapElementSchema.safeParse({ udid: DEVICE, selector: { label: "Search" } }).success
    ).toBe(true);

    for (const params of [
      { udid: DEVICE, selector: { role: "AXTextField" } },
      { udid: DEVICE, selector: {} },
      { udid: DEVICE, selector: { label: "" } },
      { udid: DEVICE, selector: { label: "Search", role: "SearchField" } },
      { udid: DEVICE, selector: { label: "Search", role: "axtextfield" } },
      { udid: DEVICE, selector: { text: "Search" } },
      { udid: DEVICE, selector: { label: "Search", extra: true } },
      { udid: DEVICE, selector: { label: "Search" }, clickCount: 0 },
      { udid: DEVICE, selector: { label: "Search" }, clickCount: 2 },
      { udid: DEVICE, selector: { label: "Search" }, extra: true },
    ]) {
      expect(tapElementSchema.safeParse(params).success, JSON.stringify(params)).toBe(false);
    }
  });

  it("documents exact case-sensitive matching and the describe role mapping", () => {
    expect(tapElementTool.description).toContain("exact, case-sensitive");
    expect(tapElementSchema.shape.selector.description).toContain("case-sensitively");
    expect(tapElementTool.description).toContain("AXTextField");
  });
});

describe("tap-element execution", () => {
  it("preserves the runner's mutation warning", async () => {
    const warning = "accessibility noise was suppressed; confirm the effect";
    const run = vi.fn().mockResolvedValue({ warning });
    const result = await tapElementTool.execute(
      { iosDeviceRunner: { udid: DEVICE, run } } as never,
      { udid: DEVICE, selector: { label: "Search", role: "AXTextField" } }
    );
    expect(result.warning).toBe(warning);
    expect(run).toHaveBeenCalledOnce();
  });

  it("sends one mutation using the selector verbatim and surfaces reactivation", async () => {
    const run = vi.fn().mockResolvedValue({ reactivated: true });
    const services = { iosDeviceRunner: { udid: DEVICE, run } } as never;
    const selector = tapElementSchema.shape.selector.parse({
      identifier: "PickerSearch",
      label: "Search",
      role: "AXTextField",
    });

    const result = await tapElementTool.execute(services, {
      udid: DEVICE,
      selector,
    });

    expect(result).toMatchObject({ tapped: true, reactivated: true });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toEqual({
      command: "tapElement",
      appBundleId: "com.example.app",
      selector,
    });
    expect(run.mock.calls[0][1]).toEqual({ timeoutMs: 90_000 });
  });

  it.each(["ELEMENT_NOT_FOUND", "ELEMENT_AMBIGUOUS", "ELEMENT_NOT_INTERACTABLE"])(
    "propagates stable runner error %s without another action",
    async (code) => {
      const failure = new RunnerCommandError("native element tap failed", { code });
      const run = vi.fn().mockRejectedValue(failure);

      const caught = await tapElementTool
        .execute({ iosDeviceRunner: { udid: DEVICE, run } } as never, {
          udid: DEVICE,
          selector: { label: "Search", role: "AXTextField" },
        })
        .catch((error: unknown) => error);

      expect(caught).toBe(failure);
      expect((caught as RunnerCommandError).code).toBe(code);
      expect((caught as Error).message).toContain(code);
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it("rejects non-physical devices before dispatch", async () => {
    const run = vi.fn();
    const caught = await tapElementTool
      .execute({ iosDeviceRunner: { run } } as never, {
        udid: "2E35A650-9618-41E1-9E8D-5E4E7CC20929",
        selector: { label: "Search" },
      })
      .catch((error: unknown) => error);

    expect((caught as Error).message).toContain("not supported on ios simulator");
    expect(getFailureSignal(caught)?.error_kind).toBe("unsupported");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps selector values out of generic interaction messages", () => {
    const params = {
      udid: DEVICE,
      selector: { identifier: "private-account-selector", label: "Private Name" },
    };
    const messages = [
      tapElementTool.interaction!.startedMsg!({ params }),
      tapElementTool.interaction!.completedMsg!({
        params,
        result: { tapped: true, timestampMs: 1 },
      }),
      tapElementTool.interaction!.failedMsg!({
        params,
        error: new Error("failure"),
        failureSignal: getFailureSignal(
          new RunnerCommandError("failure", { code: "ELEMENT_NOT_FOUND" })
        )!,
      }),
    ].join(" ");

    expect(messages).not.toContain("private-account-selector");
    expect(messages).not.toContain("Private Name");
  });
});

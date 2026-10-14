import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@clack/prompts";
import { init } from "../src/init.js";
import { resolveTelemetryConsent } from "../src/first-run-notice.js";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  isCancel: vi.fn(() => false),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn(), success: vi.fn() },
}));

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  flush: vi.fn(async () => {}),
  warmTelemetryIdentitySync: vi.fn(),
  writeConsentFlag: vi.fn(),
  hasShownFirstRunNotice: vi.fn(() => false),
}));
vi.mock("@argent/telemetry", () => telemetryMock);

// Stops the run one statement past the guard, so a guard that failed to fire is
// visible as this mock having been reached.
vi.mock("../src/first-run-notice.js", () => ({
  resolveTelemetryConsent: vi.fn(async () => ({ kind: "cancelled" })),
}));

// Off a terminal Node leaves isTTY undefined, which its boolean type forbids.
function setIsTty(value: boolean | undefined): void {
  (process.stdin as { isTTY?: boolean }).isTTY = value;
}

class ExitSentinel extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let savedIsTty: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  savedIsTty = process.stdin.isTTY;
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinel(code);
  }) as never);
});

afterEach(() => {
  setIsTty(savedIsTty);
  exitSpy.mockRestore();
});

describe("init — nobody to ask", () => {
  it("refuses before resolving consent or installing when stdin is not a terminal", async () => {
    setIsTty(undefined);

    await expect(init([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(resolveTelemetryConsent).not.toHaveBeenCalled();
    // No settled consent on a first run. (The spied exit throws, so init's
    // catch still fires here; a real exit(2) does not reach it.)
    expect(telemetryMock.track).not.toHaveBeenCalledWith(
      "installation:cli_init_start",
      expect.anything()
    );
    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("take the defaults without being asked"))).toBe(true);
  });

  it("tracks the refusal once consent is settled", async () => {
    setIsTty(undefined);
    telemetryMock.hasShownFirstRunNotice.mockReturnValueOnce(true);

    await expect(init([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_init_start",
      expect.anything()
    );
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_init_complete",
      expect.objectContaining({ is_success: false, error_code: "INSTALL_NEEDS_TERMINAL" })
    );
  });

  it("tracks nothing under --no-telemetry", async () => {
    setIsTty(undefined);
    telemetryMock.hasShownFirstRunNotice.mockReturnValue(true);

    try {
      await expect(init(["--no-telemetry"])).rejects.toThrow(ExitSentinel);
    } finally {
      telemetryMock.hasShownFirstRunNotice.mockReturnValue(false);
    }

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(telemetryMock.track).not.toHaveBeenCalledWith(
      "installation:cli_init_start",
      expect.anything()
    );
  });

  it("runs on past the guard under --yes", async () => {
    setIsTty(undefined);

    await expect(init(["--yes"])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).not.toHaveBeenCalledWith(2);
    expect(resolveTelemetryConsent).toHaveBeenCalled();
  });

  it("runs on past the guard when a terminal is there to answer", async () => {
    setIsTty(true);

    await expect(init([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).not.toHaveBeenCalledWith(2);
    expect(resolveTelemetryConsent).toHaveBeenCalled();
  });
});

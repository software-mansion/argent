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
}));
vi.mock("@argent/telemetry", () => telemetryMock);

// Stops the run one statement past the guard, so a guard that failed to fire is
// visible as this mock having been reached.
vi.mock("../src/first-run-notice.js", () => ({
  resolveTelemetryConsent: vi.fn(async () => ({ kind: "cancelled" })),
}));

// Node leaves isTTY undefined on a stdin that is not a terminal; the declared
// type admits only boolean, hence the cast.
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

// A menu with no terminal behind it never settles once stdin runs dry: the run
// would end at a rendered prompt, exit 0, and have installed nothing.
describe("init — nobody to ask", () => {
  it("refuses before resolving consent or installing when stdin is not a terminal", async () => {
    setIsTty(undefined);

    await expect(init([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(resolveTelemetryConsent).not.toHaveBeenCalled();
    // The refusal lands before consent is resolved, so the run is never started
    // in telemetry either. (The spied exit throws instead of leaving, so init's
    // own catch does still fire here; a real exit(2) leaves at the guard.)
    expect(telemetryMock.track).not.toHaveBeenCalledWith(
      "installation:cli_init_start",
      expect.anything()
    );
    const errors = vi.mocked(log.error).mock.calls.map(([m]) => m as string);
    expect(errors.some((m) => m.includes("--yes"))).toBe(true);
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

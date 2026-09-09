import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as p from "@clack/prompts";
import { link, unlink } from "../src/link.js";
import { readLinkConfig, writeLinkConfig, clearLinkConfig } from "@argent/tools-client";

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  isCancel: vi.fn(() => false),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock("@argent/tools-client", () => ({
  readLinkConfig: vi.fn(async () => null),
  writeLinkConfig: vi.fn(async () => {}),
  clearLinkConfig: vi.fn(async () => {}),
  formatToolsServerUrl: (host: string, port: number) => `http://${host}:${port}`,
  parseLinkTarget: () => null,
}));

// Node leaves isTTY undefined on a stdin that is not a terminal; the declared
// type admits only boolean, hence the cast.
function setIsTty(value: boolean | undefined): void {
  (process.stdin as { isTTY?: boolean }).isTTY = value;
}

const EXISTING = {
  url: "http://10.0.0.42:3001",
  host: "10.0.0.42",
  port: 3001,
  createdAt: "2026-01-01T00:00:00.000Z",
};

let savedIsTty: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

class ExitSentinel extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  savedIsTty = process.stdin.isTTY;
  vi.mocked(readLinkConfig).mockResolvedValue(null);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinel(code);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setIsTty(savedIsTty);
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

function stderr(): string {
  return errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

// A prompt with no terminal behind it never settles: the run would end at a
// rendered question, exit 0, and have written nothing.
describe("link — nobody to ask", () => {
  it("refuses to ask for the host when stdin is not a terminal", async () => {
    setIsTty(undefined);

    await expect(link([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(p.text).not.toHaveBeenCalled();
    expect(writeLinkConfig).not.toHaveBeenCalled();
    expect(stderr()).toContain("no terminal on stdin");
    expect(stderr()).toContain("--host");
  });

  it("refuses to confirm replacing an existing link when stdin is not a terminal", async () => {
    setIsTty(undefined);
    vi.mocked(readLinkConfig).mockResolvedValue(EXISTING);

    await expect(link(["--host", "10.0.0.9", "--port", "3001", "--no-verify"])).rejects.toThrow(
      ExitSentinel
    );

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(p.confirm).not.toHaveBeenCalled();
    expect(writeLinkConfig).not.toHaveBeenCalled();
    expect(stderr()).toContain("--yes");
  });

  it("refuses to ask for the port when only --host was given", async () => {
    setIsTty(undefined);

    await expect(link(["--host", "10.0.0.9", "--no-verify"])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(p.text).not.toHaveBeenCalled();
    expect(writeLinkConfig).not.toHaveBeenCalled();
  });

  it("refuses to ask for the host when only --port was given", async () => {
    setIsTty(undefined);

    await expect(link(["--port", "3001", "--no-verify"])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(p.text).not.toHaveBeenCalled();
    expect(writeLinkConfig).not.toHaveBeenCalled();
  });

  // --yes answers the port question with 3001, so the flags the refusal names
  // must not themselves trip it.
  it("takes the default port under --yes rather than refusing", async () => {
    setIsTty(undefined);

    await link(["--host", "10.0.0.9", "--yes", "--no-verify"]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(writeLinkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://10.0.0.9:3001" })
    );
  });

  it("still saves a fully specified link that has nothing to ask", async () => {
    setIsTty(undefined);

    await link(["--host", "10.0.0.9", "--port", "3001", "--no-verify"]);

    expect(writeLinkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://10.0.0.9:3001" })
    );
  });

  // The retry menu the failed pre-flight opens is a question too; with nobody
  // to answer it the run must fail on the unreachable server, not hang there.
  it("fails the pre-flight instead of offering the retry menu without a terminal", async () => {
    setIsTty(undefined);
    // A retry menu that a mutation lets through must land on an assertion, not
    // spin the retry loop forever on an unanswered select.
    vi.mocked(p.select).mockResolvedValue("cancel");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    try {
      await expect(link(["--host", "10.0.0.9", "--port", "3001"])).rejects.toThrow(ExitSentinel);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(p.select).not.toHaveBeenCalled();
      expect(writeLinkConfig).not.toHaveBeenCalled();
      expect(stderr()).toContain("pre-flight");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for the host when a terminal is there to answer", async () => {
    setIsTty(true);
    vi.mocked(p.text).mockResolvedValueOnce("10.0.0.9").mockResolvedValueOnce("3001");

    await link(["--no-verify"]);

    expect(p.text).toHaveBeenCalled();
    expect(writeLinkConfig).toHaveBeenCalled();
  });
});

describe("unlink — nobody to ask", () => {
  it("refuses to confirm removal when stdin is not a terminal", async () => {
    setIsTty(undefined);
    vi.mocked(readLinkConfig).mockResolvedValue(EXISTING);

    await expect(unlink([])).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(p.confirm).not.toHaveBeenCalled();
    expect(clearLinkConfig).not.toHaveBeenCalled();
    expect(stderr()).toContain("no terminal on stdin");
    expect(stderr()).toContain("--yes");
  });

  it("removes the link without asking under --yes", async () => {
    setIsTty(undefined);
    vi.mocked(readLinkConfig).mockResolvedValue(EXISTING);

    await unlink(["--yes"]);

    expect(p.confirm).not.toHaveBeenCalled();
    expect(clearLinkConfig).toHaveBeenCalled();
  });

  it("confirms removal when a terminal is there to answer", async () => {
    setIsTty(true);
    vi.mocked(readLinkConfig).mockResolvedValue(EXISTING);
    vi.mocked(p.confirm).mockResolvedValue(true);

    await unlink([]);

    expect(p.confirm).toHaveBeenCalled();
    expect(clearLinkConfig).toHaveBeenCalled();
  });
});

import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { queryWarm, disposeWarmEngine } from "../src/wasm-trace-processor.js";

// The fixture is the same .pftrace the research harness proved parity against
// (slice=225073). It lives under the gitignored research/ tree, so this suite
// skips cleanly on a checkout that doesn't have it (e.g. CI without the cache).
const FIXTURE = path.resolve(
  __dirname,
  "../../../research/perfetto-wasm/.cache/fixture.pftrace"
);
const hasFixture = existsSync(FIXTURE);
const suite = hasFixture ? describe : describe.skip;

// Booting the wasm engine (~1.5 s) + parsing the ~26 MB trace exceeds the 5 s
// default; give the cold-start test room. Subsequent tests reuse the warm engine.
const BOOT_TIMEOUT_MS = 30_000;

suite("wasm-trace-processor — in-process engine against the real fixture", () => {
  afterAll(async () => {
    await disposeWarmEngine(FIXTURE);
  });

  it(
    "SELECT count(*) FROM slice returns the known baseline (225073)",
    async () => {
      const rows = await queryWarm<{ n: number }>(FIXTURE, "SELECT count(*) AS n FROM slice");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.n).toBe(225073);
    },
    BOOT_TIMEOUT_MS
  );

  it("trivial query round-trips through the RPC decoder", async () => {
    const rows = await queryWarm<{ v: number }>(FIXTURE, "SELECT 1 + 1 AS v");
    expect(rows[0]!.v).toBe(2);
  });

  it("BigInt cell reader: safe ints become Number, unsafe ints stay bigint", async () => {
    const rows = await queryWarm<{ small: unknown; big: unknown }>(
      FIXTURE,
      "SELECT 42 AS small, 9223372036854775807 AS big"
    );
    // 42 is a safe integer -> coerced to a plain JS number.
    expect(rows[0]!.small).toBe(42);
    expect(typeof rows[0]!.small).toBe("number");
    // int64 max (~9.2e18) overflows Number.MAX_SAFE_INTEGER -> kept as bigint.
    expect(typeof rows[0]!.big).toBe("bigint");
    expect(rows[0]!.big).toBe(9223372036854775807n);
  });

  it("text and NULL cells pass through unchanged", async () => {
    const rows = await queryWarm<{ s: string | null; nil: null }>(
      FIXTURE,
      "SELECT 'hello' AS s, NULL AS nil"
    );
    expect(rows[0]!.s).toBe("hello");
    expect(rows[0]!.nil).toBeNull();
  });

  it("a SQL error surfaces as a thrown Error", async () => {
    await expect(queryWarm(FIXTURE, "SELECT * FROM no_such_table")).rejects.toThrow(
      /no_such_table|no such table/i
    );
  });
});

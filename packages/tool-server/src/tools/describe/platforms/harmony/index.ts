import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import {
  harmonyDisplay,
  harmonyDumpLayout,
  remainingBudget,
  HARMONY_DISPLAY_TIMEOUT_MS,
  HARMONY_INTERACTION_TIMEOUT_MS,
  UITEST_TIMEOUT_MS,
} from "../../../../utils/harmony-uitest";
import { parseHarmonyLayout } from "./layout-parser";

/** `uitest` runs on the device; reaching it needs only the connector. */
export const harmonyRequires: ToolDependency[] = ["hdc"];

/**
 * A suspended display still dumps its windows — measured on a Mate 60 with
 * `powerStatus=POWER_STATUS_SUSPEND`: two visible `com.ohos.sceneboard` windows,
 * indistinguishable in the tree from a live screen. Nothing else in the result
 * says the panel is off, and injected touches land nowhere while it is, so the
 * hint is the only thing standing between an agent and a silent run of
 * successful-looking taps.
 */
const ASLEEP_HINT =
  "The display is off. This tree is what was last composited, and injected taps land nowhere " +
  "until the panel is on. Wake it with `button` (power), then describe again.";

const EMPTY_HINT =
  "The layout dump contains no windows. The foreground app may still be starting — " +
  "call describe again, or screenshot to see what is on screen.";

/**
 * Describe the current HarmonyOS screen from `uitest dumpLayout`.
 *
 * The dump is written on the device and copied back, so it needs somewhere to
 * land on the host; the file is temporary and removed once parsed, since
 * describe's contract is the rendered text and nothing downstream reads it.
 *
 * `timeoutMs` is the whole read's budget, split across the panel query and the
 * dump rather than given to each, and defaulting to the one-interaction ceiling
 * so a caller with no deadline of its own is bounded under the MCP client's
 * abort-and-replay cap. A caller polling to a deadline needs it: the
 * `uitest` client this spawns holds the device's queue until it is killed, so a
 * read left on its own 20s ceiling and abandoned at a 300ms deadline is 20s the
 * caller's NEXT call spends queued — measured at 0.8s of it on a warm emulator,
 * on every auto-screenshot that follows an interaction. Killing the client
 * frees the queue at once: the on-device `uitest` goes with it (measured — a
 * dump run 0.3s after one was killed mid-flight costs the same as a cold one).
 * Each leg is still capped at its own ceiling on top of that, so a wait handing
 * this its whole 120s buys retries rather than one 120s round trip.
 */
export async function describeHarmony(
  connectKey: string,
  timeoutMs: number = HARMONY_INTERACTION_TIMEOUT_MS
): Promise<DescribeTreeData> {
  const localPath = join(tmpdir(), `argent-harmony-dump-${process.hrtime.bigint()}.json`);
  const deadline = Date.now() + timeoutMs;
  const display = await harmonyDisplay(
    connectKey,
    Math.min(HARMONY_DISPLAY_TIMEOUT_MS, remainingBudget(connectKey, deadline, "the display read"))
  );
  try {
    const raw = await harmonyDumpLayout(
      connectKey,
      localPath,
      Math.min(UITEST_TIMEOUT_MS, remainingBudget(connectKey, deadline, "the layout dump"))
    );
    const { tree, screen } = parseHarmonyLayout(raw, {
      width: display.width,
      height: display.height,
    });
    const hint = !display.screenOn
      ? ASLEEP_HINT
      : tree.children.length === 0
        ? EMPTY_HINT
        : undefined;
    return { tree, source: "harmony-uitest", screen, ...(hint ? { hint } : {}) };
  } finally {
    await rm(localPath, { force: true }).catch(() => {});
  }
}

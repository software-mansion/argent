// The one place a grounded ToolCall becomes a real argent tool invocation.
// nickel-act (one shot) and nickel-do (loop) both call this, so the action
// semantics — how "tap"/"type_text"/"swipe" map onto argent's own tools —
// live in exactly one file. The grounding vocabulary (grounding/ground.ts)
// must stay in lockstep with the cases handled here.

import type { Screen } from "../describe/screen";
import { resolveTarget } from "../describe/screen";
import type { ToolCall } from "../grounding/ground";
import type { Invoke } from "../invoke";

export interface ExecOutcome {
  did: string; // human-readable "what changed"
  resolved: boolean; // did we actually perform a device action
  observe: boolean; // should the caller re-describe the screen after this?
}

export async function executeGrounded(
  invoke: Invoke,
  udid: string,
  screen: Screen,
  call: ToolCall
): Promise<ExecOutcome> {
  switch (call.tool) {
    case "tap": {
      const r = resolveTarget(screen, String(call.target ?? ""));
      if (!r) return { did: `could not find "${call.target}"`, resolved: false, observe: false };
      await invoke("gesture-tap", { udid, x: r[0], y: r[1] });
      return { did: `tapped "${r[2]}"`, resolved: true, observe: true };
    }
    case "type_text":
      await invoke("keyboard", { udid, text: String(call.text ?? "") });
      return { did: `typed "${call.text}"`, resolved: true, observe: true };
    case "swipe": {
      // Direction is the SCROLL direction (see the grounding prompt): "down"
      // reveals content below (finger moves up), "up" scrolls back (finger down).
      const dir = call.direction === "up" ? "up" : "down";
      const [fromY, toY] = dir === "down" ? [0.75, 0.3] : [0.3, 0.75];
      await invoke("gesture-swipe", { udid, fromX: 0.5, fromY, toX: 0.5, toY });
      return { did: `swiped ${dir}`, resolved: true, observe: true };
    }
    case "answer":
      return { did: `answer: ${call.value}`, resolved: true, observe: false };
    default:
      return { did: "unclear instruction", resolved: false, observe: false };
  }
}

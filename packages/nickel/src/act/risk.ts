// Harness-level risk guard. The minion asks the frontier for clearance before a
// side-effecting action — but a small local model is an unreliable self-police, so
// we DON'T trust it alone. This deterministic check intercepts risky targets and
// forces need_clearance no matter what the planner decided. Defense in depth: the
// model can only ever be MORE cautious than this floor, never less.

import type { Risk } from "../protocol";
import type { ToolCall } from "../grounding/ground";

// label substring -> risk class. Matched case-insensitively against the tap target.
// Kept focused on actions that publish, spend, or destroy — the things a "mundane
// goal" should never do without a human nod. Ordinary navigation/typing is exempt.
const RISKY: { re: RegExp; risk: Risk }[] = [
  { re: /\b(post|publish|share|send|reply|repost|tweet)\b/i, risk: "external" },
  { re: /\b(buy|purchase|pay|checkout|order|subscribe|upgrade)\b/i, risk: "purchase" },
  { re: /\b(delete|remove|discard|deactivate|erase|clear)\b/i, risk: "destructive" },
  { re: /\b(log ?out|sign ?out|unfollow|block|deregister)\b/i, risk: "irreversible" },
];

// Only taps commit a side effect; typing into a field does not.
export function classifyRisk(call: ToolCall): Risk | null {
  if (call.tool !== "tap") return null;
  const target = String(call.target ?? "");
  for (const { re, risk } of RISKY) {
    if (re.test(target)) return risk;
  }
  return null;
}

// The frontier resumes past a clearance by calling again with `context` carrying an
// approval (per the resume_hint). Any mention of "approve"/"approved"/"go ahead"
// lifts the guard for that run — the session and the decision live on the frontier.
export function isApproved(context?: string): boolean {
  return !!context && /\b(approv\w*|go ?ahead|proceed|confirmed|yes)\b/i.test(context);
}

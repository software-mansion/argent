import { FIND_TOOL_ID } from "../find";

type MissedFindResult = {
  found: false;
  note?: unknown;
};

export function isMissedFindResult(tool: string, result: unknown): result is MissedFindResult {
  if (tool !== FIND_TOOL_ID || typeof result !== "object" || result === null) return false;
  const r = result as { found?: unknown; action?: unknown };
  // `exists` reports presence as a yes/no answer: found:false is a SUCCESSFUL
  // "not present" result, not a missed locate, so it must never stop a flow or
  // block a step from being recorded. Every other action that returns found:false
  // (tap/type/fill/wait/get-text/get-attrs) genuinely failed to act on/read an
  // element, which is a real miss.
  if (r.action === "exists") return false;
  return r.found === false;
}

export function missedFindError(result: MissedFindResult): string {
  return typeof result.note === "string" && result.note.length > 0
    ? `find did not locate an element: ${result.note}`
    : "find did not locate an element";
}

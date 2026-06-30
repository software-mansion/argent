const FIND_TOOL_ID = "find";

type MissedFindResult = {
  found: false;
  note?: unknown;
};

export function isMissedFindResult(tool: string, result: unknown): result is MissedFindResult {
  return (
    tool === FIND_TOOL_ID &&
    typeof result === "object" &&
    result !== null &&
    (result as { found?: unknown }).found === false
  );
}

export function missedFindError(result: MissedFindResult): string {
  return typeof result.note === "string" && result.note.length > 0
    ? `find did not locate an element: ${result.note}`
    : "find did not locate an element";
}

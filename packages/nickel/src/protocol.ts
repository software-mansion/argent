// The Nickel ↔ frontier protocol. Every result carries a common envelope for
// situational awareness; the status-specific payload is the "with what / by what"
// the frontier needs to decide the next move.

export interface TraceStep {
  i: number;
  thought?: string; // System-2 reasoning, when it deliberated
  action: string; // the concrete tool call it made
  outcome: string; // what changed
}

export interface Cost {
  steps: number;
  model_calls: number;
  ground_ms: number;
  exec_ms: number;
  used_vision: boolean;
}

export interface Envelope {
  goal: string; // echo of what it was pursuing
  summary: string; // one-line human read of the situation
  screen: string[]; // element labels currently on screen (where we are)
  trace: TraceStep[];
  cost: Cost;
}

export type Risk = "destructive" | "irreversible" | "purchase" | "external";

export type NickelResult = Envelope &
  (
    | { status: "done"; done: { achieved: boolean; evidence: string } }
    | {
        status: "need_clearance";
        need_clearance: {
          proposed_action: { kind: string; target?: string };
          why: string;
          risk: Risk;
          reversible: boolean;
          resume_hint?: string;
        };
      }
    | {
        status: "blocked";
        blocked: {
          obstacle: string;
          likely_cause?: string;
          tried: { action: string; outcome: string }[];
          ask: string;
        };
      }
    | { status: "report"; report: { note: string; continue: boolean } }
  );

export function emptyCost(): Cost {
  return { steps: 0, model_calls: 0, ground_ms: 0, exec_ms: 0, used_vision: false };
}

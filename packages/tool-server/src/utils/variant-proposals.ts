/**
 * Process-wide store backing the `propose_variant` / `await_user_selection`
 * tools and the `/preview/variants` UI endpoints.
 *
 * The design goal is asymmetric blocking:
 *
 *   - `propose_variant` is fire-and-forget. The agent stages as many variants
 *     across as many on-screen elements as it likes and keeps working. Each
 *     call mutates this store and returns immediately.
 *   - `await_user_selection` is the single blocking call. It parks on a promise
 *     that only resolves when the human presses "Complete selection" in the
 *     preview UI (which POSTs to `/preview/variants/selection`).
 *
 * Both the tool layer (registry) and the preview HTTP router import the same
 * module singleton, so a variant proposed by an MCP tool call is immediately
 * visible to the browser polling `/preview/variants`, and a selection POSTed by
 * the browser immediately unblocks the parked tool call.
 *
 * Rounds: a "round" is one propose→await→submit cycle. After a completed
 * selection is consumed by `await_user_selection`, the next `propose_variant`
 * transparently opens a fresh round so the workflow is repeatable within a
 * single long-lived tool-server process.
 */

import { TypedEventEmitter } from "@argent/registry";

/** How the preview UI locates the live on-screen element for a proposal. */
export interface VariantMatch {
  /**
   * `text`   — fuzzy: any describe node whose label/value/identifier contains `value`.
   * `label`  — exact accessibility label.
   * `identifier` — exact accessibilityIdentifier / resource-id / testID.
   * `role`   — element role (e.g. "Button").
   */
  by: "text" | "label" | "identifier" | "role";
  value: string;
}

export interface Variant {
  id: string;
  name: string;
  summary: string;
  /** Inline code for the variant (optional — agent may pass code or a path). */
  code?: string;
  /** Path to a file containing the variant implementation (optional). */
  filePath?: string;
  createdAt: number;
}

export interface ElementProposal {
  id: string;
  /** Human-facing name the agent used, e.g. "Foo button". */
  element: string;
  match: VariantMatch;
  variants: Variant[];
  createdAt: number;
}

export interface SubmittedSelection {
  elementId: string;
  /** Chosen variant id, or null when the user explicitly skipped the element. */
  variantId: string | null;
  comment?: string;
}

export interface ResolvedSelection {
  element: string;
  match: VariantMatch;
  chosenVariant: Variant | null;
  comment?: string;
}

export type AwaitOutcome =
  | {
      status: "completed";
      round: number;
      selections: ResolvedSelection[];
      /** Elements the agent proposed but the user did not pick a variant for. */
      unselected: Array<{ element: string }>;
      globalComment?: string;
      completedAt: number;
    }
  | {
      status: "pending";
      round: number;
      message: string;
      proposedElements: Array<{ element: string; variantCount: number }>;
    }
  | {
      status: "no_proposals";
      message: string;
    };

export interface StoreSnapshot {
  round: number;
  completed: boolean;
  globalComment: string;
  proposals: ElementProposal[];
  /** Whether at least one `await_user_selection` call is currently parked. */
  agentWaiting: boolean;
}

type StoreEvents = {
  /** Emitted whenever proposals change (UI may live-refresh). */
  changed: () => void;
  /** Emitted when the user submits a selection for `round`. */
  completed: (round: number) => void;
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

class VariantProposalStore {
  readonly events = new TypedEventEmitter<StoreEvents>();

  private round = 1;
  private proposals: ElementProposal[] = [];
  private completed = false;
  private consumed = false;
  private globalComment = "";
  private submitted: SubmittedSelection[] = [];
  private variantSeq = 0;

  /** Begin a fresh round, discarding the previous one's proposals/selections. */
  reset(): void {
    this.round += 1;
    this.proposals = [];
    this.completed = false;
    this.consumed = false;
    this.globalComment = "";
    this.submitted = [];
    this.variantSeq = 0;
    this.events.emit("changed");
  }

  private autoRollIfConsumed(): void {
    // A completed round that has already been handed to the agent is closed —
    // the next proposal starts a clean round automatically.
    if (this.completed && this.consumed) this.reset();
  }

  proposeVariant(input: {
    element: string;
    match?: VariantMatch;
    variant: { name: string; summary: string; code?: string; filePath?: string };
  }): {
    round: number;
    elementId: string;
    variantId: string;
    element: string;
    variantCount: number;
    totalElements: number;
  } {
    this.autoRollIfConsumed();

    const match: VariantMatch = input.match ?? { by: "text", value: input.element };
    const key = `${match.by}:${match.value.trim().toLowerCase()}`;

    let proposal = this.proposals.find(
      (p) => `${p.match.by}:${p.match.value.trim().toLowerCase()}` === key
    );
    if (!proposal) {
      proposal = {
        id: `el-${slug(input.element) || "element"}-${this.proposals.length + 1}`,
        element: input.element,
        match,
        variants: [],
        createdAt: Date.now(),
      };
      this.proposals.push(proposal);
    }

    const variant: Variant = {
      id: `v${++this.variantSeq}`,
      name: input.variant.name,
      summary: input.variant.summary,
      code: input.variant.code,
      filePath: input.variant.filePath,
      createdAt: Date.now(),
    };
    proposal.variants.push(variant);
    this.events.emit("changed");

    return {
      round: this.round,
      elementId: proposal.id,
      variantId: variant.id,
      element: proposal.element,
      variantCount: proposal.variants.length,
      totalElements: this.proposals.length,
    };
  }

  snapshot(): StoreSnapshot {
    return {
      round: this.round,
      completed: this.completed,
      globalComment: this.globalComment,
      proposals: this.proposals.map((p) => ({
        ...p,
        variants: p.variants.map((v) => ({ ...v })),
      })),
      agentWaiting: this.waiters > 0,
    };
  }

  /** Called by the preview UI when the human presses "Complete selection". */
  submitSelection(input: {
    selections: SubmittedSelection[];
    globalComment?: string;
  }): { ok: true; round: number; resolved: number } {
    if (this.proposals.length === 0) {
      throw new Error("No proposals to select from.");
    }
    this.submitted = input.selections.filter((s) =>
      this.proposals.some((p) => p.id === s.elementId)
    );
    this.globalComment = (input.globalComment ?? "").trim();
    this.completed = true;
    this.consumed = false;
    this.events.emit("changed");
    this.events.emit("completed", this.round);
    return { ok: true, round: this.round, resolved: this.submitted.length };
  }

  private buildOutcome(): Extract<AwaitOutcome, { status: "completed" }> {
    const selections: ResolvedSelection[] = [];
    const unselected: Array<{ element: string }> = [];
    for (const p of this.proposals) {
      const picked = this.submitted.find((s) => s.elementId === p.id);
      if (!picked || picked.variantId == null) {
        unselected.push({ element: p.element });
        if (picked?.comment) {
          selections.push({
            element: p.element,
            match: p.match,
            chosenVariant: null,
            comment: picked.comment,
          });
        }
        continue;
      }
      const variant = p.variants.find((v) => v.id === picked.variantId) ?? null;
      selections.push({
        element: p.element,
        match: p.match,
        chosenVariant: variant,
        comment: picked.comment,
      });
    }
    return {
      status: "completed",
      round: this.round,
      selections,
      unselected,
      globalComment: this.globalComment || undefined,
      completedAt: Date.now(),
    };
  }

  private waiters = 0;

  /**
   * Block until the user submits a selection for the current round.
   *
   * Resolves immediately if a selection is already waiting to be consumed.
   * On `timeoutMs` elapse returns a `pending` outcome (so the agent — or the
   * MCP client wrapping it — can re-await without losing the live proposals).
   * Honors `signal`: a client disconnect rejects with an AbortError.
   */
  awaitSelection(opts: { signal?: AbortSignal; timeoutMs: number }): Promise<AwaitOutcome> {
    // A completed round whose result the agent already consumed is closed.
    // Don't re-park (that would block forever); tell the agent to propose anew.
    if (this.completed && this.consumed) {
      return Promise.resolve({
        status: "no_proposals",
        message:
          "The previous selection round was already returned. Call propose_variant to stage " +
          "new variants before awaiting again.",
      });
    }

    if (this.completed && !this.consumed) {
      this.consumed = true;
      return Promise.resolve(this.buildOutcome());
    }

    if (this.proposals.length === 0) {
      return Promise.resolve({
        status: "no_proposals",
        message:
          "No variants have been proposed yet. Call propose_variant first, then await_user_selection.",
      });
    }

    this.waiters += 1;
    this.events.emit("changed");

    return new Promise<AwaitOutcome>((resolve, reject) => {
      const cleanup = () => {
        this.waiters = Math.max(0, this.waiters - 1);
        this.events.off("completed", onComplete);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        this.events.emit("changed");
      };

      const onComplete = (round: number) => {
        if (this.completed && !this.consumed) {
          this.consumed = true;
          cleanup();
          resolve(this.buildOutcome());
        }
      };

      const onAbort = () => {
        cleanup();
        const err = new Error("await_user_selection aborted (client disconnected)");
        err.name = "AbortError";
        reject(err);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({
          status: "pending",
          round: this.round,
          message:
            "User has not completed their selection yet. The proposals are still live in the " +
            "preview UI — call await_user_selection again to keep waiting (this is expected; " +
            "it is not an error).",
          proposedElements: this.proposals.map((p) => ({
            element: p.element,
            variantCount: p.variants.length,
          })),
        });
      }, opts.timeoutMs);

      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.events.on("completed", onComplete);
    });
  }
}

/** Module singleton — shared by the tools and the preview router. */
export const variantProposalStore = new VariantProposalStore();

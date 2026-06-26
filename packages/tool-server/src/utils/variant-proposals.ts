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
  /**
   * Optional preview of how the variant looks. May be an http(s) URL, a
   * `data:` URI, or a local image file path (e.g. a screenshot from the
   * Argent screenshot tool) — the latter is streamed by
   * `GET /preview/variant-image/:elementId/:variantId`.
   */
  previewImage?: string;
  /**
   * Normalized [0..1] bounds of the target element AS IT APPEARED in this
   * variant's screenshot. The preview window crops the screenshot to these
   * bounds so each variant shows its own (re-laid-out) element instead of every
   * variant sharing one frozen frame. Optional (older callers omit it).
   */
  frame?: { x: number; y: number; width: number; height: number };
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

/**
 * A free-form comment the user anchored to an arbitrary on-screen element via
 * the "Add comment" inspector (not necessarily an element the agent proposed
 * variants for). Delivered to the agent alongside the variant selections.
 */
export interface ElementAnnotation {
  /** Human-readable element descriptor (a11y label / identifier / role). */
  target: string;
  /** Matcher the agent can use to re-locate the element. */
  match: VariantMatch;
  comment: string;
}

export type AwaitOutcome =
  | {
      status: "completed";
      round: number;
      selections: ResolvedSelection[];
      /** Elements the agent proposed but the user did not pick a variant for. */
      unselected: Array<{ element: string }>;
      /** User-initiated comments anchored to elements via the inspector. */
      annotations: ElementAnnotation[];
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
  /**
   * Device (iOS udid / Android serial) the variants target. The preview window
   * streams it directly instead of showing a chooser. Null until an agent
   * supplies one via `propose_variant`.
   */
  device: string | null;
  /** Whether at least one `await_user_selection` call is currently parked. */
  agentWaiting: boolean;
  /**
   * Whether a CLI-driven Lens session (`argent lens`) currently owns the window.
   * When true the window is opened up front (not on an await) and is NOT
   * auto-closed when the user submits — the human keeps iterating and their
   * feedback is piped into the spawned `claude` terminal instead. The UI reads
   * this to relabel its submit action ("Request changes" rather than the
   * await-and-close phrasing).
   */
  cliSession: boolean;
}

type StoreEvents = {
  /** Emitted whenever proposals change (UI may live-refresh). */
  changed: () => void;
  /**
   * Emitted whenever an `await_user_selection` call parks for a round —
   * fires every time (not just the first waiter) so listeners doing
   * idempotent work (e.g. "ensure the preview window is open") get a wake
   * signal on each fresh await.
   */
  awaitParked: () => void;
  /** Emitted after a successful `submitSelection` — the round is done. */
  selectionSubmitted: () => void;
  /**
   * Emitted when a CLI-driven Lens session is begun or ended (`argent lens`).
   * The tool-server's window manager listens: begin ⇒ open the window now, end
   * ⇒ close it. Carries the new active state so listeners need not re-snapshot.
   */
  cliSessionChanged: (active: boolean) => void;
};

/** A parked `await_user_selection` call, bound to the round it is waiting on. */
interface Waiter {
  round: number;
  settled: boolean;
  settle: (outcome: AwaitOutcome) => void;
}

/**
 * Max stored length for any user-supplied free-text comment (a selection's
 * comment, an annotation's comment, or the round-wide globalComment). The
 * selection route (`POST /preview/variants/selection`) is unauthenticated, so
 * everything ingested here is capped to bound memory regardless of caller —
 * the same cap annotations already used. */
const MAX_COMMENT_LENGTH = 2_000;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class VariantProposalStore {
  readonly events = new TypedEventEmitter<StoreEvents>();

  private round = 1;
  private proposals: ElementProposal[] = [];
  private completed = false;
  private consumed = false;
  private globalComment = "";
  /**
   * Device the variants target (last non-empty udid an agent passed to
   * `propose_variant`). Persists across rounds — the agent works on one device
   * — so it is intentionally NOT cleared by `reset()`.
   */
  private device: string | null = null;
  /**
   * True while an `argent lens` CLI session owns the window. Set via
   * `setCliSession`; deliberately NOT cleared by `reset()` — a CLI session spans
   * many propose→submit rounds, like `device`.
   */
  private cliSession = false;
  private submitted: SubmittedSelection[] = [];
  private submittedAnnotations: ElementAnnotation[] = [];
  private variantSeq = 0;
  /** Parked await_user_selection calls. */
  private waitersList: Waiter[] = [];
  /** Frozen result of the current round once the user submits. */
  private lastOutcome: Extract<AwaitOutcome, { status: "completed" }> | null = null;

  /** Begin a fresh round, discarding the previous one's proposals/selections. */
  reset(): void {
    // Any await still parked on the round being discarded must not hang
    // forever — resolve it so the agent gets a definitive answer and can
    // re-propose. (Reachable when a second caller proposes/resets while an
    // earlier round's await is parked.)
    const superseded = this.waitersList.filter((w) => !w.settled);
    this.waitersList = [];
    for (const w of superseded) {
      w.settled = true;
      w.settle({
        status: "no_proposals",
        message:
          "The selection round was superseded before the user submitted. Call " +
          "propose_variant then await_user_selection again for the new round.",
      });
    }

    this.round += 1;
    this.proposals = [];
    this.completed = false;
    this.consumed = false;
    this.globalComment = "";
    this.submitted = [];
    this.submittedAnnotations = [];
    this.variantSeq = 0;
    this.lastOutcome = null;
    this.events.emit("changed");
  }

  /** Look up a stored variant (used to resolve a preview-image path safely). */
  findVariant(elementId: string, variantId: string): Variant | null {
    const p = this.proposals.find((x) => x.id === elementId);
    return p?.variants.find((v) => v.id === variantId) ?? null;
  }

  /**
   * Called when the native preview window could not be launched (e.g. the
   * optional `electron` dependency is absent on a headless/CI host). Settles
   * every currently-parked, unsettled waiter with a `pending` outcome whose
   * message points the agent at the browser fallback URL, rather than letting
   * the await park for the full timeout with no window and no feedback. The
   * proposals stay live, so the agent can relay the URL and re-await. No-ops
   * when nothing is parked.
   */
  notifyWindowUnavailable(reason: string, url: string | null): void {
    const toSettle = this.waitersList.filter((w) => !w.settled);
    if (toSettle.length === 0) return;
    this.waitersList = this.waitersList.filter((w) => w.settled);
    const proposedElements = this.proposals.map((p) => ({
      element: p.element,
      variantCount: p.variants.length,
    }));
    const message =
      `⚠️ The native preview window could not open (${reason}). The proposed variants ` +
      `are live — open ${url ?? "the tool-server /preview/ URL"} in a browser to make your ` +
      `selection, then call await_user_selection again. (Install the optional \`electron\` ` +
      `dependency to get the native window.)`;
    for (const w of toSettle) {
      w.settled = true;
      w.settle({
        status: "pending",
        round: w.round,
        message,
        proposedElements,
      });
    }
  }

  private autoRollIfConsumed(): void {
    // A completed round that has already been handed to the agent is closed —
    // the next proposal starts a clean round automatically.
    if (this.completed && this.consumed) this.reset();
  }

  proposeVariant(input: {
    element: string;
    match?: VariantMatch;
    udid?: string;
    variant: {
      name: string;
      summary: string;
      code?: string;
      filePath?: string;
      previewImage?: string;
      frame?: { x: number; y: number; width: number; height: number };
    };
  }): {
    round: number;
    elementId: string;
    variantId: string;
    element: string;
    variantCount: number;
    totalElements: number;
  } {
    this.autoRollIfConsumed();

    // Remember which device these variants are for, so the window streams it
    // directly. Last non-empty value wins; usually set once on the first call.
    if (input.udid && input.udid.trim()) this.device = input.udid.trim();

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
      previewImage: input.variant.previewImage,
      frame: input.variant.frame,
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
      device: this.device,
      agentWaiting: this.waitersList.some((w) => !w.settled),
      cliSession: this.cliSession,
    };
  }

  /**
   * Begin or end a CLI-driven Lens session (`argent lens`). Idempotent: a
   * no-change call does nothing. Emits `cliSessionChanged` (and `changed`) so
   * the window manager can open/close the window and the UI can relabel.
   */
  setCliSession(active: boolean): void {
    if (this.cliSession === active) return;
    this.cliSession = active;
    this.events.emit("cliSessionChanged", active);
    this.events.emit("changed");
  }

  /** Whether a CLI-driven Lens session currently owns the window. */
  isCliSession(): boolean {
    return this.cliSession;
  }

  /**
   * The frozen outcome of the last submitted round, or null if nothing has been
   * submitted since the last reset. Read by `GET /preview/outcome` so the
   * `argent lens` watcher can format the user's feedback and type it into the
   * spawned `claude` terminal. Cleared (to null) when a new round begins.
   */
  getLastOutcome(): Extract<AwaitOutcome, { status: "completed" }> | null {
    return this.lastOutcome;
  }

  /** Called by the preview UI when the human presses "Complete selection". */
  submitSelection(input: {
    selections: SubmittedSelection[];
    globalComment?: string;
    annotations?: ElementAnnotation[];
  }): {
    ok: true;
    round: number;
    resolved: number;
  } {
    const cleanAnnotations = (input.annotations ?? [])
      .filter((a) => a && typeof a.comment === "string" && a.comment.trim())
      .map((a) => ({
        target: String(a.target ?? "").slice(0, 200) || "(element)",
        match: a.match,
        comment: a.comment.trim().slice(0, MAX_COMMENT_LENGTH),
      }));
    // A round with neither proposals nor any inspector comment has nothing to
    // deliver. Annotations alone ARE deliverable (free-form element feedback).
    if (this.proposals.length === 0 && cleanAnnotations.length === 0) {
      throw new Error("Nothing to submit — no proposals and no comments.");
    }
    // Cap each selection's comment on ingestion (the route is unauthenticated),
    // mirroring the annotation-comment cap above.
    this.submitted = input.selections
      .filter((s) => this.proposals.some((p) => p.id === s.elementId))
      .map((s) =>
        s.comment === undefined ? s : { ...s, comment: s.comment.slice(0, MAX_COMMENT_LENGTH) }
      );
    this.submittedAnnotations = cleanAnnotations;
    this.globalComment = (input.globalComment ?? "").trim().slice(0, MAX_COMMENT_LENGTH);
    this.completed = true;
    this.consumed = false;
    // Freeze the outcome once so every parked waiter (and any later fast-path
    // await) sees the exact same selections, regardless of subsequent rounds.
    this.lastOutcome = this.buildOutcome();

    // Resolve EVERY await parked on this round with the same frozen outcome —
    // not just the first. A round whose result was delivered to a waiter is
    // closed (consumed) so the next bare await returns no_proposals.
    const round = this.round;
    const toSettle = this.waitersList.filter((w) => !w.settled && w.round === round);
    this.waitersList = this.waitersList.filter((w) => w.round !== round || w.settled);
    if (toSettle.length > 0) this.consumed = true;
    // In a CLI Lens session no await_user_selection consumes the round — the
    // `argent lens` watcher reads the frozen outcome over HTTP and types it into
    // the agent terminal. Mark the round consumed here too, so the agent's next
    // propose_variant opens a FRESH round (the preview UI keys "new round" off
    // the round number, and getLastOutcome stops returning a stale outcome)
    // rather than appending to this already-submitted one.
    if (this.cliSession) this.consumed = true;
    for (const w of toSettle) {
      w.settled = true;
      w.settle(this.lastOutcome);
    }
    this.events.emit("changed");
    this.events.emit("selectionSubmitted");
    return { ok: true, round, resolved: this.submitted.length };
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
      if (!variant) {
        // Picked id doesn't resolve to a real variant — treat as no choice.
        unselected.push({ element: p.element });
        if (picked.comment) {
          selections.push({
            element: p.element,
            match: p.match,
            chosenVariant: null,
            comment: picked.comment,
          });
        }
        continue;
      }
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
      annotations: this.submittedAnnotations.map((a) => ({ ...a })),
      globalComment: this.globalComment || undefined,
      completedAt: Date.now(),
    };
  }

  /**
   * Block until the user submits a selection for the current round.
   *
   * Resolves immediately if a selection is already waiting to be consumed.
   * On `timeoutMs` elapse returns a `pending` outcome (so the agent — or the
   * MCP client wrapping it — can re-await without losing the live proposals).
   * Honors `signal`: a client disconnect rejects with an AbortError. Every
   * await parked on a round is resolved when that round is submitted (or the
   * round is superseded), so concurrent / re-entrant awaits never strand.
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

    // Submitted but no waiter was parked to receive it → hand back the frozen
    // outcome and close the round.
    if (this.completed && !this.consumed) {
      this.consumed = true;
      return Promise.resolve(this.lastOutcome ?? this.buildOutcome());
    }

    if (this.proposals.length === 0) {
      return Promise.resolve({
        status: "no_proposals",
        message:
          "No variants have been proposed yet. Call propose_variant first, then await_user_selection.",
      });
    }

    return new Promise<AwaitOutcome>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        const i = this.waitersList.indexOf(waiter);
        if (i >= 0) this.waitersList.splice(i, 1);
        this.events.emit("changed");
        fn();
      };

      // Bound to the round captured at park time. submitSelection() / reset()
      // call settle(); they also remove it from waitersList first.
      const waiter: Waiter = {
        round: this.round,
        settled: false,
        settle: (outcome) => finish(() => resolve(outcome)),
      };

      const onAbort = () => {
        waiter.settled = true;
        finish(() => {
          const err = new Error("await_user_selection aborted (client disconnected)");
          err.name = "AbortError";
          reject(err);
        });
      };

      const timer = setTimeout(() => {
        waiter.settled = true;
        finish(() =>
          resolve({
            status: "pending",
            round: waiter.round,
            message:
              "User has not completed their selection yet. The proposals are still live in " +
              "the preview window — call await_user_selection again to keep waiting (this is " +
              "expected; it is not an error).",
            proposedElements: this.proposals.map((p) => ({
              element: p.element,
              variantCount: p.variants.length,
            })),
          })
        );
      }, opts.timeoutMs);

      this.waitersList.push(waiter);
      this.events.emit("changed");
      this.events.emit("awaitParked");

      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

/** Module singleton — shared by the tools and the preview router. */
export const variantProposalStore = new VariantProposalStore();

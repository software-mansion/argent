# Corrected-training result — `silver-realistic:e4b` (the overnight run)

Same OpenCode + live-iOS-sim benchmark, **8-tool** `argentbench` agent (train == inference),
8 iOS-Settings tasks. Trained overnight: native gemma4 tool format + no-narration + a **fixed
8-tool nav set** + **realistic observations** (strip the gym's free `[screenshot]` caption;
interactions return only argent's `--- Screen after action ---` path, so the model must
`describe` for screen state). 900 iters, seq 4608. On HF as `LatekVo/silver`.

## Headline

| model (Argent, 8-tool agent)     | success       | behaviour                                                    |
| -------------------------------- | ------------- | ------------------------------------------------------------ |
| **gemma4:e4b** (untuned base)    | **4/8 (50%)** | works; the focused 8-tool agent helped (was 25% at 69 tools) |
| **silver-realistic** (corrected) | **0/8**       | correct nav loop, but a gesture-name bug blocks all taps     |

## The corrected training fixed the behaviour (real progress)

Every prior silver failed _before_ navigating — it narrated nothing, or stopped after one call,
or wandered, or hallucinated tool names. `silver-realistic` does **none** of that. On every task
it runs the **correct loop**: `list-devices → launch-app → describe → (tap/swipe) → describe →
…`, reads udids/screens from results, persists for 30-40 calls, and **never invents a tool**. The
format + no-narration + fixed-tool-set + realistic-observation fixes all landed. This is the
closest any version has been to working.

## The remaining blocker: gesture-name truncation under real `describe`

It still completes **0/8**, for one specific reason: under a **real** argent `describe` (the live
Settings screen has ~20+ elements; the gym's screens have only ~5-8), the 4B model degrades and
**truncates the gesture tool name** — it emits `tap`/`swipe` instead of `gesture-tap`/`gesture-swipe`.
OpenCode namespaces that to `argent_tap` (not a real tool) → error _"unavailable tool 'invalid'"_ →
**every tap/swipe fails** → the agent loops describe→tap(error)→describe until it times out, never
completing the task (15+ gesture errors/task).

It is **context-triggered, not a fixed format error** — verified:

- In short/clean `/v1` tests (and even with the full 8-tool set + a short describe), silver emits
  `argent_gesture-tap` **correctly** (name + args).
- In the live run, after a long real describe is in context, it truncates. The truncation is
  **intermittent** (some gestures keep the full name and succeed), which is the signature of
  capacity/context degradation, not a deterministic bug.

**Root cause:** the gym's screens are far sparser than real argent, so the model never trained on
describe outputs as long as the live ones, and the 4B can't sustain a clean multi-segment tool name
right after a long describe.

## Fix path (the navigation is already right)

1. **Enrich the gym screens to real-argent element counts** so training `describe` outputs are as
   long as live ones — the most direct fix; the model already navigates correctly, so this should
   unlock task completion.
2. A **larger base** (E4B is ~4B effective) would also hold the tool name over long contexts.
3. Cheap mitigation to test first: a more compact live `describe` (fewer/needed elements) keeps the
   context short enough that the 4B doesn't truncate.

The corrected weights are on `LatekVo/silver`; this result + fix path is the handoff for the next
iteration.

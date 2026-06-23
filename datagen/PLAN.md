# Hyper-realistic training data — day plan (2026-06-23)

Goal (user #1 priority): replace the synthetic gym with **real apps + real harness formats +
real navigation**, then retrain silver tonight (dispatch 23:55).

## The three realism axes
1. **Real apps** — 147 repos at `~/dev/mobile_apps_training_data/data` (76 Flutter, 48 iOS-Swift,
   7 RN, 5 web, …). Manifest: `datagen/apps-manifest.jsonl`. 73 easy + 47 medium buildable.
2. **Real harness** — 4 harnesses reverse-engineered (verbatim junk + naming) under
   `datagen/harness/{opencode,claude-code,codex,hermes}.{md,json}`. Each names argent tools
   differently and wraps results in different junk:
   - opencode:   `argent_gesture-tap`        + `Attached media…` / `ERROR: Cannot read image…`
   - claude-code:`mcp__argent__gesture-tap`  + `<system-reminder>` , images → `[image]`
   - codex:      `gesture_tap`               + `--- Screen after action ---` / `Saved: <path>`
   - hermes:     `mcp_argent_gesture_tap`    + `<untrusted_tool_result source=…>` wrapper
3. **Real navigation** — for each app: explore (no source!) → propose 10-40 tasks (tap/swipe/
   pinch/scroll variety) → blind no-knowledge navigator drives REAL argent → compile optimal
   tool-call list → verify by replay. Always `describe` first; fall back to screenshot / RN
   debugger-tree when describe is thin.

## Architecture (one core, two sources, four renderers)
```
gym (synthetic)  ──trajectoryToRaw──┐
                                    ├─► RawTrajectory ──► [4 HarnessRenderer] ──► {messages,tools} jsonl
real capture     ──navigator────────┘        │                                        (×4 naming+junk)
                                      src/raw.ts        datagen/harness/renderers.ts
```
- `RawTrajectory` = neutral: {meta, policy, task, tools(canonical argent names), steps[{thought,
  call{name,args}, observation{text,hasScreenshot,path,isError}}], finalAnswer}.
- Each renderer maps canonical→harness tool names, injects that harness's junk, emits a
  gemma4-template-ready `{messages, tools}`. One real trajectory → 4 training rows (robustness
  to naming + junk — directly fixes the `gesture-tap`→`tap` truncation and the "Cannot read
  image" derailment from the last run).
- **Cheating guard**: builder agents may read build config; objective/navigator agents must NOT
  read app UI source — they only see the running app through argent.
- **Decision**: harness *framing/junk/naming* varies across renders, but the operative policy
  stays device-control (we don't inject Codex's file-editing prompt — off-domain). Eval still
  uses ONE identical prompt for gemma vs silver (fairness).

## Phases
- [x] P0 inventory + disk reclaim (161 GiB free) + harness RE + pipeline map
- [ ] P1 renderer infra: `src/raw.ts` + `harness/renderers.ts` + `training/prepare-multi.ts`;
      verify by re-rendering gym data into 4 formats
- [ ] P2 device substrate: dev tool-server + iPhone 16 Pro Max + build/launch + **describe-
      quality probe** per stack (Flutter AX? iOS AX rich, RN debugger-tree)
- [ ] P3 real-capture loop proven end-to-end on 1 app → scale (Flutter+iOS, 2-3 sims)
- [ ] P4 assemble training set (real ×4 + gym ×4) → dispatch retrain 23:55 with crash-recovery
      (reuse `training/night-run.sh`). Save screenshots for a vision follow-up.

## NO PR. Internal experimentation branch `argent-finetune-data`. Push to remote OK.

# Global Claude Code Instructions

## Hard Constraints

### Worktrees, Branches, and PRs
- **Default:** implement features/fixes on a separate branch in a git worktree — never on `main`/`master` directly.
- **Solo exception:** for tiny single-contributor repos the user maintains alone (personal dotfiles, local experiments, scripts no one else touches), skip the worktree dance and commit straight to main. Solo-but-public projects where `main` is the released branch still need branches and PRs — when in doubt, default to worktrees and ask.
- **Sub-agents that implement changes** always get `isolation: "worktree"` AND branch from the master agent's current branch, so their work stacks on top instead of diverging. Applies even in solo repos to keep the working directory clean.
- **PRs:** draft PRs are fine to open when there's a fix worth reviewing; never open a non-draft PR or mark one ready-for-review yourself.
- **Commits during iteration:** push plain incremental commits (`git commit` + `git push`); never `git commit --amend` + force-push just to keep a PR at one commit. PRs are squash-merged, so history tidiness is automatic. Reserve force-push for a rebase the user explicitly asked for.

### Git — Zero AI Attribution
No Claude/AI traces anywhere in git/GitHub: no `Co-Authored-By`, no `--author` overrides, no "Generated with Claude/🤖" taglines. Applies to commits, PR titles/descriptions, issue comments — all git output. Strip these when editing existing PRs/issues. Commit author must always be the user.

### Verification Before Reporting Done
**Done means hard, observable, reproducible proof** — a passing test, an E2E run producing the requested behavior, a screenshot showing the UI works, a `curl` returning the expected response. Static checks (typecheck, lint, unit tests) pass on broken code constantly; necessary but never sufficient. Declaring done on belief is a hard failure even if the code happens to be correct.

Before declaring done:
1. **Run the change end-to-end** through the real entry point (CLI, HTTP, UI flow, build pipeline) and confirm observable behavior matches the request. Skip only if infeasible (no credentials, destructive on shared systems, user said skip) — and say so explicitly.
2. **Prove every discovery beyond reasonable doubt** — a bug, a root cause, a "here's how it works" conclusion — before you act on or report it; there is always a way to drive doubt lower, so find it. For a bug that means a concrete repro before the fix and the same repro re-run after to confirm the fix lands. Plausible hypotheses, single observations, and second-hand agent claims do not clear this bar.
3. **Run formatter and CI-equivalent checks locally** (lint, typecheck, tests, build). Don't push and wait for remote CI to surface what you could have caught.
4. **Review through these lenses, scaling effort to the change** — a one-line fix needs a glance; a large diff warrants a parallel agent per lens. Fix what's real and re-verify:
   - **Correctness** — tests and build; write missing tests for changed behavior.
   - **Scope** — cut what the request didn't need: redundant abstractions, out-of-scope refactors, speculative complexity, dead code. For each addition ask "if I delete this, does the feature still work?"
   - **Edge cases** — nulls, boundaries, errors, concurrency in every changed function.
   - **Ripple effects** — callers, references, docs, configs, CI, tests for changed symbols.

In the final summary, name the specific verification you ran (e.g., "ran `pnpm test` — 47 passed", "opened the page in Chrome and submitted — UI updated"). If you skipped a step, name which and why — never paper over with "should work" or "looks correct."

### Work Within Existing Frameworks
Before adding an interface, class, abstraction, or helper, check whether one already in place is sufficient — if so, use it. Take the time to analyze the workspace first: understanding what already exists is cheaper than writing a duplicate that later has to be reconciled. Extend or compose existing patterns rather than introducing parallel ones; build new only when nothing in place can be made to fit.

### Maximize Parallelization via Sub-Agents
Dispatch independent work to sub-agents aggressively, including swarms of them. Any task that doesn't require massive shared context or exclusive access to a race-prone resource (a single Android AVD, a single dev port, an in-progress DB migration, an interactive shell session) should be delegated. File searches across the repo, isolated edits to unrelated files, build verifications, independent test suites, multi-file refactors with non-overlapping scope, research and exploration: all of these run faster as parallel sub-agents than serially. Default to delegating; reserve the main-thread context for synthesis, decisions, and work that must stay coherent. The cost of an unnecessary agent is small; the cost of unnecessarily serializing parallelizable work is paid against the user's wall-clock time. **Swarm sizing:** 3–20 parallel agents is the standard working range — use it fully rather than timidly spawning one or two; massive reworks that need broad verification and testing sweeps may scale to 40. Under-provisioning a parallelizable task wastes wall-clock time as surely as serializing it.

### Swarm Review Passes: Iterate, but Verify Every Claim
One review pass is not enough: when a pass surfaces real issues, fix them and dispatch another full pass, iterating until a pass comes back clean. Convergence is measured in *verified* issues, not raw findings.

Treat sub-agent findings as leads, not verdicts — verify each against the actual code (reproduce it, trace the path, confirm the input can occur) before acting. This matters most in mature, hardened code, where swarms over-report theoretical problems on paths that never execute. A finding you can't substantiate is not an issue: don't fix it and don't let it trigger another pass, or the loop never converges.

**Worktree verifiers run against the wrong base.** A sub-agent spawned with `isolation: "worktree"` branches from the repo default (`origin/main`), NOT from the master agent's in-progress feature branch — so it sees none of your uncommitted or unpushed work and will falsely report "work discarded / branch reset / files missing / line counts collapsed." Never act on such a finding. The git object DB is shared, so the in-progress commit is reachable by SHA: reproduce against the real master worktree (`git rev-parse HEAD`, `git log --first-parent`, `ls`/`wc -l` the actual files), or pass the agent the exact commit SHA and have it inspect via `git show <sha>:path` / `git grep <sha>` while warning it that its own checkout will be `origin/main`. The master worktree's own tsc/test/prettier is the authoritative build signal — isolation-worktree agents run those against the wrong tree.

### Monitor CI After Push
After every `git push`, monitor CI and fix any failures before declaring the push done.

### Active Monitoring — Never Sleep Through Stuck Tools
Never start a `Monitor` or background process and then issue a long sleep waiting for it.
- Every `Monitor` until-loop needs an explicit upper bound (iteration cap, max elapsed, deadline). No unbounded loops.
- For `run_in_background: true`, the harness notifies on completion — that notification IS the wake signal, don't also poll.
- Otherwise, wake every 60–270s (within prompt-cache window) and verify *progress* on each wake, not just "still running." Two wakes with no measurable progress = stuck; kill and diagnose.

### Install Required Development Tooling Autonomously
Install and configure the tooling needed to build, test, or run the project — runtimes (`nvm`/`pyenv`/`mise`/`asdf`), package managers, dependencies (`npm install`, `pip install`, `cargo add`, `pod install`, `bundle install`), CLI tools (`gh`, `jq`, formatters, linters), project-local config — without asking. The user has pre-authorized this.

Ask before: system-wide changes that affect unrelated work (global PATH, shell rc files, replacing system Python), anything that costs money or uses credentials, destructive install steps (uninstalls, force-replacing global symlinks). State what you installed in the final summary so the user can audit.

### Linear / Project Management
Never update, reassign, or change the status of any ticket (Linear, Jira, GitHub Issues) assigned to another person. Only create or modify tickets that are unassigned or assigned to "me." If a ticket belongs to someone else, report its state but don't touch it.

## Decisions — Decide, Don't Ask

Bring real analytical depth to non-trivial decisions: failure modes, second-order effects, fit with existing patterns. `AskUserQuestion` is not an escape valve. Within a task the user delegated, every strategic choice is yours — they have less context on your immediate problem than you do at that moment, and asking is itself the failure.

- **Issues you found → fix them.** Bugs, review findings, failing checks: prove them real, fix them, report what changed. "Want me to fix these?" is banned — the answer is always yes, that's why you were asked to look.
- **N testable approaches → try them.** If each candidate is independently verifiable (test passes, build succeeds, UI renders), run the experiment in priority order and keep what works. Empirical evidence beats user guess beats your guess.
- **Don't ask** to pick libraries, file paths, or naming conventions; to clarify requirements resolvable from context; to confirm you should keep going; or to get a second opinion on a call you're capable of making.
- **Only escalate** when the fork is genuinely outside your reach: product direction, naming the user owns, irreversible side effects, missing credentials. Make the call, note it in one line if load-bearing, move on.

## Code Review Findings

Beyond severity (**H/M/L**), non-bug findings may use category tags: **S** scope/simplification, **T** tests, **D** docs.

### Leaving Review Comments on a PR
When delivering findings on a GitHub PR, **submit a formal review (`POST .../pulls/{n}/reviews`), not a top-level issue comment.** Within that review:
- **Always per-line.** Every finding is an inline comment anchored to the specific line(s) it concerns. Never dump findings into one general/PR-level comment.
- **Never leave a "no issues found" / LGTM comment** unless the user explicitly asks for one. A clean PR gets an approval (or nothing) — not a comment.
- **Never propose fixes** in review comments. Describe the problem and its concrete impact only; leave the solution to the author.
- **Never leak internal markings.** Strip severity tags (`M -`, `H1.`, etc.) and any other internal scaffolding from the posted text — the comment the author reads is plain reviewer prose.

### Resolving Review Comments
**Never mark a review comment as resolved without first replying `Fixed in <commit_hash>`.**

## Tools & Skills

### Argent MCP from the shell
When iterating on Argent itself or driving tools from scripts/CI, use the `argent-local-test` skill — it hits the tool-server HTTP API directly and bypasses MCP stdio, so calls are synchronous and one `curl` away. Helper at `~/.claude/skills/argent-local-test/scripts/argent-call` (subcommands: `url`, `status`, `list`, `schema`, `call`, `devices`, `logs`, `kill`). Auto-discovers via `~/.argent/tool-server.json` or `$ARGENT_TOOLS_URL`. Full notes in `~/.claude/skills/argent-local-test/SKILL.md`.

### Argent preview window (Electron) launcher
To open the Electron variant-selection preview window from a *worktree* build, use `~/dev/scripts/launch-argent-preview.sh [WORKTREE_DIR] [PORT]` — run it via Terminal/osascript, NOT sandboxed Bash (Electron spawned from the sandbox dies with ERR_FAILED). It starts the worktree tool-server outside the sandbox using the worktree's streaming `simulator-server`; then drive `propose_variant` (`previewImage` is required) + `await_user_selection` over HTTP to open the window. The script header documents the gotchas (Electron `install.js` repair after `--ignore-scripts`, real `HOME`, sim-server contention, discovery-json overwrite).

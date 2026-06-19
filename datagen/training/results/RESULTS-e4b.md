# Gemma 4 E4B gym benchmark — `silver:e4b`

The same eval-through-gym recipe as the 2B (`RESULTS.md`), scaled to **Gemma 4 E4B**
(effective-4B, ~7.46B params). 120 held-out tasks (seeds 5,000,000+, greedy), scored
by replaying the model's tool calls through the gym + the same JSON-schema validators
the data is built with. Raw numbers: `eval-base-e4b.json`, `eval-tuned-e4b.json`.

| metric                             | base   | **gym-tuned (silver:e4b)** | 2B (silver:2b) |
| ---------------------------------- | ------ | -------------------------- | -------------- |
| Navigation success                 | **0%** | **60.3%**                  | 44.1%          |
| Schema-valid tool calls            | 100%\* | **96.2%**                  | 99.2%          |
| Grounded taps (coords not guessed) | **0%** | **87.9%**                  | 97.2%          |
| Tool calls / episode               | 0.5    | 8.9                        | 7.3            |
| Episodes ending with no attempt    | 85%    | (44% clean-finish)         | 31.7%          |
| Policy violations / episode        | 0      | 0.32                       | —              |

\* The base only emits ~0.5 calls/episode (it mostly just chats — 85% of episodes end
with a plain answer and no tool use), so its 100% "schema-valid" is over a tiny base of
calls and it never navigates or grounds a tap. It is a more capable chatter than the 2B
base (which emitted **zero** tool calls) but is still untrained for the agent loop.

**The tuned E4B beats the 2B** — 60.3% vs 44.1% navigation success on the same held-out
suite — and the larger model fixes the 2B's worst weakness: `scroll-find` went from
**0/9 → 3/9**. By kind: `login 6/6`, `android-setup 3/3`, `navigate-tap 10/19`,
`hide-and-seek 7/12`, `deep-link 5/8`, `toggle 6/9`, `scroll-find 3/9`, `chromium-tabs 1/2`.
The gym demonstrably teaches Argent tool-use at 4B scale, and more capacity converts the
demonstrations into higher navigation success.

## Methodology note (read this if reproducing)

The tuned model is evaluated as a **4-bit merged checkpoint** (`mlx_lm fuse` of the LoRA
into the base _without_ `--dequantize` → `fused/silver-e4b-q4merged`), **not** base +
runtime adapter. `eval.ts --adapter-path …` deadlocks inside `mlx::core::eval` for gemma4
(hangs at "model ready", 0 episodes — verified via a stack sample). Base-only and merged
checkpoints generate fine. The 4-bit merged is equivalent to base+adapter and is the
closest match to the deployed q4 `silver:e4b`. Also: kill any orphaned Ollama
`llama-server` runners before evaluating — they survive `ollama stop` and starve mlx.

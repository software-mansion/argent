# Gemma 2 2B — base vs gym-tuned (eval through the gym)

Held-out tasks (seeds 5,000,000+), greedy decoding.
Base: `120` eps · Tuned: `120` eps.

| metric                      | base | tuned | Δ     |
| --------------------------- | ---- | ----- | ----- |
| Navigation success %        | 0    | 44.1  | +44.1 |
| Schema-valid calls %        | 0    | 99.2  | +99.2 |
| Grounded taps %             | 0    | 97.2  | +97.2 |
| Avg tool calls / episode    | 0    | 7.3   | +7.3  |
| Policy violations / episode | 0    | 0.06  | +0.1  |
| Clean finish (no attempt) % | 100  | 68.3  | -31.7 |

## Navigation success by task kind

- base: `{"login":"0/6","navigate-tap":"0/19","hide-and-seek":"0/12","scroll-find":"0/9","deep-link":"0/8","toggle":"0/9","android-setup":"0/3","chromium-tabs":"0/2"}`
- tuned: `{"login":"6/6","navigate-tap":"6/19","hide-and-seek":"5/12","scroll-find":"0/9","deep-link":"4/8","toggle":"6/9","android-setup":"2/3","chromium-tabs":"1/2"}`

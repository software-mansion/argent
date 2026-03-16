---
name: simulator-screenshot
description: Take a screenshot of an iOS simulator screen using argent tools. Use when capturing the initial screen state, checking state after a delay, or when no interaction tool was just called.
---

## 1. When to Use

Call `screenshot` separately only when:

- You need the screen state **before any action** (baseline).
- You want to check state **after a delay** (e.g. waiting for a network response).
- The auto-attached screenshot shows a **transitional or loading frame**.
- You need additional context about the simulator state

## 2. Usage

Get the simulator UDID via `list-simulators` if you don't have it.

```json
{ "udid": "<UDID>" }
```

With optional rotation:

```json
{ "udid": "<UDID>", "rotation": "LandscapeLeft" }
```

The MCP adapter fetches the PNG and returns it as an inline image.

## 3. Troubleshooting

| Problem              | Solution                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| Screenshot times out | Restart simulator-server via the `simulator-server` tool with a JWT token, then retry. |
| No booted simulator  | Run `boot-simulator` first.                                                            |

## Notes

- Screenshot requires a Pro/Team/Enterprise JWT token.
- The token only needs to be passed once — subsequent calls reuse the running process.

## Related Skills

| Skill                | When to use                                         |
| -------------------- | --------------------------------------------------- |
| `simulator-setup`    | Booting and connecting a simulator                  |
| `simulator-interact` | Tapping, swiping, typing on the simulator           |
| `test-ui-flow`       | Interactive UI testing with screenshot verification |

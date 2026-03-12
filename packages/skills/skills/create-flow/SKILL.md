---
name: create-flow
description: Record a reusable flow (scripted sequence of MCP tool calls) that can be replayed later with a single command. Use when the user asks to create, record, or build a flow, or to script a sequence of simulator actions.
---

## 1. Overview

A flow is a recorded sequence of MCP tool calls saved to a `.flow` file in the `.argent/` directory. Each step is **executed live** as you add it, so you verify it works before it becomes part of the flow. Replay a finished flow with `run_flow`.

## 2. Tools

| Tool                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `flow_start`        | Start recording — takes a name, creates the file     |
| `flow_add_step`     | Execute a tool call live and record it if it succeeds |
| `flow_insert_echo`  | Add a label/comment that prints during replay        |
| `flow_finish`       | Stop recording and get a summary                     |
| `run_flow`          | Replay a saved flow by name                          |

## 3. Workflow

1. **Start**: Call `flow_start` with a descriptive name.
2. **Build step-by-step**: For each action, call `flow_add_step` with the tool name and args. The tool runs immediately — check the result before moving on.
3. **Add labels**: Use `flow_insert_echo` between steps to describe what each section does.
4. **Finish**: Call `flow_finish` to stop recording.

Every tool returns the current flow file contents so you can track what has been recorded.

## 4. flow_add_step Usage

The `command` parameter is the MCP tool name. The `args` parameter is a **JSON string** (not an object):

```
command: "launch-app"
args: "{\"udid\": \"<UDID>\", \"bundleId\": \"com.apple.Preferences\"}"
```

```
command: "tap"
args: "{\"udid\": \"<UDID>\", \"x\": 0.5, \"y\": 0.35}"
```

```
command: "screenshot"
args: "{\"udid\": \"<UDID>\"}"
```

For tools with no arguments, omit `args` entirely.

## 5. Important Rules

- **Every step runs live.** You will see the real tool result (including screenshots). Use this to verify the step worked before continuing.
- **Only successful steps are recorded.** If a tool call fails, nothing is written to the flow file — fix the issue and try again.
- **You do NOT need to pass a flow name** to `flow_add_step`, `flow_insert_echo`, or `flow_finish`. The active flow is tracked automatically after `flow_start`.
- **Mistakes can be edited out.** If a step was recorded but shouldn't have been, tell the user they can edit the `.flow` file by hand to remove or reorder lines.
- **Do NOT write to the `.flow` file directly.** Always use the flow tools.

## 6. Example Session

```
flow_start       { name: "open-settings" }
flow_insert_echo { message: "Launch Settings app" }
flow_add_step    { command: "launch-app", args: "{\"udid\": \"ABC\", \"bundleId\": \"com.apple.Preferences\"}" }
flow_insert_echo { message: "Tap General" }
flow_add_step    { command: "tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.35}" }
flow_insert_echo { message: "Tap About" }
flow_add_step    { command: "tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.17}" }
flow_finish      {}
```

## 7. Flow File Format

Each line is either:
- `tool:<name> <json>` — a tool call
- `echo:<message>` — a label

Example `.flow` file:
```
echo:Launch Settings app
tool:launch-app {"udid":"ABC","bundleId":"com.apple.Preferences"}
echo:Tap General
tool:tap {"udid":"ABC","x":0.5,"y":0.35}
echo:Tap About
tool:tap {"udid":"ABC","x":0.5,"y":0.17}
```

## Related Skills

| Skill                  | When to use                                      |
| ---------------------- | ------------------------------------------------ |
| `simulator-interact`   | Detailed tool usage for tapping, swiping, typing |
| `simulator-setup`      | Booting and connecting a simulator               |
| `test-ui-flow`         | Interactive UI testing with screenshot verification |

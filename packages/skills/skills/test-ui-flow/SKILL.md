---
name: test-ui-flow
description: Autonomously test an iOS app UI by running interact-screenshot-verify loops using argent simulator tools. Use when testing a UI flow, verifying login works, testing navigation, or running an end-to-end UI test scenario.
---

## 1. Workflow

All interactions go through argent MCP tools. Ensure the simulator is booted before starting.

1. **Baseline screenshot**: Call `screenshot` to see the current UI state.
2. **Find target**: If unsure where to tap, use `describe` (or `debugger-component-tree` for React Native apps) to get element locations.
3. **Interact**: Perform the action (`tap`, `swipe`, `paste`, etc.) — you receive a screenshot automatically.
4. **Verify**: Check the returned screenshot for expected results. If it shows a loading/transitional state, retake with `screenshot`.
5. **Repeat** for each step in the flow.

## 2. Template

```
Goal: Test [feature name]

Steps:
1. screenshot → see current state (baseline)
2. [Navigate / tap / type to reach starting point] → verify auto-screenshot
3. [Perform the action to test] → verify auto-screenshot
4. Report: pass / fail with details
```

## 3. Examples

### Login flow

```
1. screenshot → see login screen
2. tap { x: 0.5, y: 0.4 }  → tap email field
3. paste { text: "user@example.com" }
4. tap { x: 0.5, y: 0.55 } → tap password field
5. paste { text: "password123" }
6. tap { x: 0.5, y: 0.7 }  → tap Login button
7. screenshot → verify home screen appeared
```

### Scroll and navigation

```
1. screenshot → see list at top
2. swipe { fromY: 0.7, toY: 0.3 } → scroll down
3. tap item at visible position → verify auto-screenshot
4. screenshot → verify detail view opened
5. button { button: "back" }
6. screenshot → verify returned to list
```

---

## Tips

- **Call `screenshot` only for baseline or when no action was just performed** — actions return screenshots automatically.
- **Use `paste` for text entry** — faster and more reliable than key-by-key `keyboard`.
- **Use `gesture` for long-press** context menus (800ms hold).
- **Check for loading states** — retake with `screenshot` if the auto-screenshot shows a transitional frame.
- **Report clearly**: state what you expected, what you saw, and the verdict.
- **Coordinate estimation**: center = 0.5, 0.5; top-third ~ 0.2; bottom-third ~ 0.8.

## Related Skills

| Skill                  | When to use                                      |
| ---------------------- | ------------------------------------------------ |
| `simulator-interact`   | Detailed tool usage for tapping, swiping, typing |
| `simulator-screenshot` | Screenshot-specific options and troubleshooting  |
| `simulator-setup`      | Booting and connecting a simulator               |
| `run-react-native-app` | Starting the app, Metro, build issues            |
| `metro-debugger`       | Breakpoints, console logs, JS evaluation         |

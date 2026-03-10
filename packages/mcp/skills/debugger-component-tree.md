---
name: use-component-tree
description: Describes the debugger-component-tree MCP tool for understanding React Native screen contents and finding tap targets. Use when interacting with a running React Native app, tapping UI elements, or needing to know what is currently visible on the simulator screen.
---

# Using `debugger-component-tree` for Screen Understanding

## When to Use

Call `debugger-component-tree` any time you need to:

- Know what is currently visible on a React Native app screen
- Find the tap coordinates of a specific button, text, or interactive element
- Verify a navigation or state change happened (the tree reflects the live screen)

**Always call before a `tap`** unless the coordinates were already returned by a prior call on the same screen state. Call again after navigation, scrolling, or any action that changes the screen.

## Workflow

```
1. debugger-component-tree → read the text tree
2. Find the target element by name, text content, testID, or accessibilityLabel
3. Use the (tap: x,y) coordinates with the tap tool
```

### Example

Tool call: `debugger-component-tree(port: 8081)`

Output:

```
Screen: 402x874

MainScreen (tap: 0.50,0.45)
  Logo (tap: 0.50,0.19)
  ScrollView (tap: 0.50,0.61)
    Button "Sign In" (tap: 0.50,0.40)
    Button "Register" [testID=register-btn] (tap: 0.50,0.52)
BottomTabBar (tap: 0.50,0.95)
  BottomTabItem "Home" (tap: 0.17,0.94)
  BottomTabItem "Settings" (tap: 0.83,0.94)
```

To tap "Register": `tap(udid: "...", x: 0.50, y: 0.52)`

## Output Anatomy

Each line is one component. Indentation shows parent-child hierarchy.

| Part | Meaning |
|------|---------|
| `Button` | React component name |
| `"Register"` | Visible text, title prop, or accessibilityLabel |
| `[testID=register-btn]` | Developer-assigned test identifier |
| `(tap: 0.50,0.52)` | Normalized center coordinates in [0,1] space, directly usable with `tap` tool |

`Screen: WxH` at the top gives pixel dimensions; tap coordinates are already normalized so you do not need to convert.

## Limitations

- **Snapshot, not live**: the tree reflects the moment the tool was called. Call again after any action that changes the screen.
- **Visible screen only**: off-screen content (e.g. below the fold in a ScrollView) may have positions outside the viewport.
- **Requires Metro connection**: the app must be running in dev mode with Metro on the specified port (default 8081).
- **iOS and Android**: works on both platforms via the React DevTools hook (Fabric and Paper architectures).

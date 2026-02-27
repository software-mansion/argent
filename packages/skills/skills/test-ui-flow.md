# Test UI Flow

Autonomously test an iOS app UI by orchestrating screenshot → interact → screenshot loops.

## Workflow

1. **Setup**: Ensure tools server is running and simulator is booted.
2. **Baseline screenshot**: See the current UI state.
3. **Interact**: Perform the action (tap, swipe, type, etc.).
4. **Verify screenshot**: Confirm the expected result appeared.
5. **Repeat** for each step of the flow.

## Template

```
Goal: Test [feature name]

Steps:
1. Take a screenshot to see the current state
2. [Navigate / tap / type to reach starting point]
3. Take a screenshot to confirm starting state
4. [Perform the action to test]
5. Take a screenshot to verify the result
6. Report: ✓ passed / ✗ failed with details
```

## Example: Test login flow

```
1. screenshot → see login screen
2. tap { x: 0.5, y: 0.4 }  → tap email field
3. paste { text: "user@example.com" }
4. tap { x: 0.5, y: 0.55 } → tap password field
5. paste { text: "password123" }
6. tap { x: 0.5, y: 0.7 }  → tap Login button
7. screenshot → verify home screen appeared
```

## Example: Test scroll and navigation

```
1. screenshot → see list at top
2. swipe { fromY: 0.7, toY: 0.3 }  → scroll down
3. screenshot → verify new items visible
4. tap item at visible position
5. screenshot → verify detail view opened
6. button { button: "back" }
7. screenshot → verify returned to list
```

## Tips

- **Always screenshot before and after** each significant action
- **Use `gesture` for long-press** context menus — hold 800ms then release
- **Use `paste` not key-by-key** for text entry — it's faster and more reliable
- **Check for loading states** — take an extra screenshot if the app might be loading
- **Report clearly**: state what you expected, what you saw, and the verdict
- **Coordinate estimation**: use 0.5,0.5 for center; top-third ≈ 0.2, bottom-third ≈ 0.8

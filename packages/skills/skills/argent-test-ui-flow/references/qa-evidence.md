# QA Evidence Planning

Before running a QA flow, classify each expected result and choose the evidence to collect:

- **Visual**: pixel-visible layout, position, size, spacing, color, typography, image/icon rendering, clipping, overflow, or text rendering. Use screenshots, visual inspection, frame/attribute checks, and `screenshot-diff` when stable comparable images are available.
- **Structural**: navigation state, element existence, accessibility labels/values, selection state, hierarchy, or route changes. Use `describe`, `native-describe-screen`, `debugger-component-tree`, source/frame inspection, or app state checks.
- **Runtime/log/network**: console errors, API calls, persistence, side effects, timing, or data flow. Use logs, network tools, debugger evaluation, or targeted tests.
- **Mixed**: any assertion that combines visual behavior with structural, runtime, log, or network state. Collect evidence for each relevant class.

Treat `screenshot-diff` as supporting visual evidence, not the sole oracle. For exact use cases, parameter choices, and full-resolution screenshot guidance, use the `argent-screenshot-diff` skill. If the user explicitly asks for screenshot diffing or before/after visual comparison, use it unless no stable comparable screenshots can be produced.

Report the combined verdict with expected behavior, observed behavior, evidence used, and any blocker for requested visual diffing.

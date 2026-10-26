---
name: argent-screenshot-diff
description: Compare saved or live app screenshots with the argent screenshot-diff tool. Use when testing visual regressions, before/after UI comparisons, screenshot diff checks, visible layout, spacing, color, typography, clipping, overflow, text rendering, or image/icon rendering changes.
---

## 1. Role

Use `screenshot-diff` as supporting visual evidence for UI QA and visual regression checks. It highlights pixel-visible change or stability; it does not replace visual inspection, accessibility/component-tree state, frame/attribute checks, logs, network evidence, or app behavior. Its description covers the input combinations, physical-iPhone captures and the result.

Do not use screenshot diffing for tap-coordinate discovery. Use `describe`, `debugger-component-tree`, or `native-describe-screen` to find targets first.

## 2. When To Use

- Required for explicit "UI regression test", "visual regression test", "screenshot diff", "compare screenshots", or "before/after visual comparison" requests, unless stable comparable screenshots cannot be produced.
- Good fit when the expected result is pixel-visible, or when the risk is an unintended visual regression outside the exact element changed.
- Poor fit when the result is better verified structurally: state changes, navigation existence, accessibility tree contents, console/network behavior, or unit tests.
- Poor fit when dynamic content, unpausable animation, timestamps, ads, random data, or missing baseline/current screenshots would make the comparison noisy or meaningless.

## 3. Deterministic Flow

1. Navigate to the known-good state. Capture the baseline before the relevant interaction or before editing whenever feasible.
2. Save a baseline PNG with `screenshot` using `scale: 1.0` and `includeImageInContext: false`, so the full-size image stays out of context; keep the returned `path`. Use normal downscaled screenshots for everything else.
3. Perform the interaction, apply the code change and navigate to the state under test, after the app reloads or rebuilds.
4. Call `screenshot-diff` with that `baselinePath`, `captureCurrent: true`, `udid`, and `outputDir`. If both images are already saved, pass `currentPath` instead of `captureCurrent`.
5. Inspect the summary and artifact paths, then combine the diff with normal visual inspection and any structural/runtime evidence needed for the assertion.

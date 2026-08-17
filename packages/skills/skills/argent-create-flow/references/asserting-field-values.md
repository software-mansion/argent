# Assert a field value after `type`

`type` does not verify its result. Select a reliable check from this table.

| Platform | Value in the flow tree                                                                                             | Reliable check                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Android  | Available except for password fields. A `contentDescription` joins the hint and value.                             | Use `equals` for a bare value. Use `contains` for a joined value.                  |
| iOS      | Never available. The tree exposes the label instead.                                                               | Assert an app consequence.                                                         |
| Chromium | Available as the accessible name unless a non-empty label or placeholder overrides it. Password values are hidden. | Check the field only when its value is available. Otherwise, assert a consequence. |

Chromium truncates accessible names to 200 characters. For longer values, use `contains` on a prefix or assert a consequence.

Give each Chromium field an `id` or `data-testid`. Otherwise, its value can enter ancestor text and misdirect text selectors.

An unlabeled Chromium field can expose a typed secret to later `describe` calls. Use a password field or accessible label. Submit or navigate away before `describe`.

Prefer app consequences when possible. Examples include a filtered list, an enabled button, or a cleared error.

## A clear-only step

The flow cannot assert an empty field directly. `equals: ""` and `contains: ""` are rejected.
`matches: '^$'` parses, but it does not match missing or empty text.

Assert the OLD value's absence instead: `- assert: { hidden: "the old value" }`.
Use this only when the tree exposed the old value. Otherwise, assert an app consequence.

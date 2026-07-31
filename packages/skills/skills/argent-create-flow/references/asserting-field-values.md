# Asserting a field's value after a `type`

`type` does not read the field back, so proving a `clear` (or a replacement) landed means asserting
it yourself. Which assert works depends on the platform, because a text field's contents reach the
flow tree unevenly. Check this table before writing one: a directive that fails hard-stops the flow,
so a mis-targeted assert costs every later step.

- **Android** exposes them, except for a **password** field, which reports the `[password]` placeholder and never its value — assert the consequence there, as on iOS. A field with a `contentDescription` reports the hint and the value together, so assert `contains` (or `equals` the whole `"<hint> <value>"` string); a field without one — most React Native `TextInput`s — reports the contents alone, and `equals` on the bare value is right.
- **iOS** never exposes them. The assert reads the field's label instead, so it hard-fails on a perfectly good clear.
- **Chromium** exposes an `<input>`/`<textarea>`'s contents only as the element's accessible _name_, and only when it carries no `aria-label`, no `aria-labelledby` and no `placeholder` (never for a password field). With any of those the assert reads that label and hard-fails, exactly like iOS — and an assert written against the label instead passes whether or not the clear happened, which proves nothing.

Where the contents are invisible, assert the _consequence_ instead — the filtered list, the enabled
submit button, the cleared error message. That works on every platform and does not depend on how
the field exposes itself.

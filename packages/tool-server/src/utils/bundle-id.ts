// Union of the Android package and iOS bundle-id (dashes allowed) alphabets.
// The head excludes `-` and `.` so a value like `--user` can't masquerade as a
// flag in `am start -n …` / `pm …` / `devicectl …`; call sites exec via an argv
// array or shellQuote, so that is defense in depth. Digits are admitted at the
// head because an iOS CFBundleIdentifier may begin with one (`9gag.app`).
export const BUNDLE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export const BUNDLE_ID_MESSAGE =
  "bundleId may only contain letters, digits, '.', '_' and '-', and may not start with '-' or '.'";

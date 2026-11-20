/** Modifier keys in Mac menu order, which e2e YAML uses when writing a tap. */
export const MACOS_MODIFIERS = ["control", "option", "shift", "command"] as const;
export type MacosModifier = (typeof MACOS_MODIFIERS)[number];

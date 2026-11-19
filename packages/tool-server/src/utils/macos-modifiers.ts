/**
 * The modifier keys a Mac app takes with a key or a click, in the order a menu
 * shows them. Apart from macos-input, which needs the app connection, so that
 * the e2e file parser can check them.
 */
export const MACOS_MODIFIERS = ["control", "option", "shift", "command"] as const;
export type MacosModifier = (typeof MACOS_MODIFIERS)[number];

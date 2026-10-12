export interface FillParams {
  udid: string;
  /** Resolved: any `{{secret:NAME}}` placeholder is already substituted. */
  text: string;
}

/**
 * How the text got into the field:
 * - `accessibility`: the iOS ax-service's text operations (select all, insert or delete);
 * - `helper`: the Android devtools helper's ACTION_SET_TEXT;
 * - `cdp`: the page's own editing commands over Chrome DevTools Protocol;
 * - `keys`: a delete-key burst, then typed keys.
 */
export type FillMethod = "accessibility" | "helper" | "cdp" | "keys";

/**
 * Never carries the field's text, its previous text or the requested text:
 * any of them may be a credential.
 */
export interface FillResult {
  method: FillMethod;
  /** The field was read back and holds the text. Null when nothing could read it back. */
  verified: boolean | null;
  /** Length of the text the field holds after the call, in UTF-16 units, when read back. */
  length?: number;
}

export interface FillParams {
  udid: string;
  /** Resolved: any `{{secret:NAME}}` placeholder is already substituted. */
  text: string;
}

/**
 * Never carries the field's text, its previous text or the requested text:
 * any of them may be a credential. A field that does not read back the text
 * fails with FILL_NOT_VERIFIED instead.
 */
export interface FillResult {
  /** The field was read back and holds the text. False where nothing can read it back: a physical iPhone. */
  verified: boolean;
}

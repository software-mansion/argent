export interface KeyboardParams {
  udid: string;
  text?: string;
  /**
   * Rejected alongside `text` and `clear` in ./index.ts, so a backend sees at
   * most one of the three. Not valid on TV targets.
   */
  key?: string;
  /**
   * Empty the focused text field. Only `true` acts — `false` reads as absent,
   * like an omitted parameter — and it is rejected alongside `text` / `key` in
   * ./index.ts. Served on every platform; the one target that refuses it is a
   * REMOTE Apple TV (platforms/ios.ts), whose HID daemon is host-local.
   */
  clear?: boolean;
  delayMs?: number;
}

export interface KeyboardResult {
  typed: string;
  keys: number;
  /**
   * Present only on a `clear` call, and it means two different things per
   * backend — read `clearVerified` to tell them apart rather than inferring it
   * from `keys`, which is documented as the count of key presses issued.
   *
   * On every key-injecting backend — iOS, Android, Apple TV, Android TV and
   * Vega — it reports that the burst was SENT: nothing is read back (a cleared
   * field may have held a secret, and the key transports cannot read one
   * anyway), and a field longer than the burst keeps its remainder.
   * On Chromium it reports that the delete was ACCEPTED.
   */
  cleared?: true;
  /**
   * The structural discriminator for the two meanings of `cleared`: present only
   * where the backend read the field back and found it empty, which today is
   * Chromium alone — and not even there when the read could not be taken (a page
   * that replaced the field, sealed `window`, or left the field on screen with
   * nothing readable on it). Absent means "not verified":
   * assert the field or its consequence if you need proof.
   */
  clearVerified?: true;
}

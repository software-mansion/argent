const BULLETS = new Set(["•", "●"]);

/**
 * Whether a field's reported text shows `expected`. A secure field reports
 * bullets, so a bullet stands for any character there; its last character may
 * still show in the clear for a moment after it was typed. Compared after
 * canonical composition, as AX may answer either form.
 */
export function textMatches(current: string, expected: string): boolean {
  if (current === expected) return true;
  const units = current.normalize("NFC");
  const want = expected.normalize("NFC");
  if (units === want) return true;
  // A secure field masks each UTF-16 unit.
  if (units.length !== want.length || units.length === 0) return false;
  let sawBullet = false;
  for (let i = 0; i < units.length; i++) {
    if (BULLETS.has(units[i]!)) {
      sawBullet = true;
      continue;
    }
    if (units[i] !== want[i]) return false;
  }
  return sawBullet;
}

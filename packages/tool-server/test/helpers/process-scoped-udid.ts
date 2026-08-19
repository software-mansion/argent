/**
 * A UDID whose first 8 characters belong to this process alone.
 *
 * The native-devtools factory really binds `/tmp/argent-nd-<first 8 UDID
 * chars>.sock` (getNativeDevtoolsSocketPath), and the bind unlinks and rebinds
 * over whatever already holds that path. A constant UDID therefore makes two
 * concurrent runs — a second checkout, a CI matrix cell — silently destroy each
 * other's live socket, and the loser reads its own device back as unregistered.
 *
 * `tail` supplies the remaining UDID groups, so a file that needs two distinct
 * devices can still tell them apart.
 */
export function processScopedUdid(tail: string): string {
  return `${process.pid.toString(16).toUpperCase().padStart(8, "0")}${tail}`;
}

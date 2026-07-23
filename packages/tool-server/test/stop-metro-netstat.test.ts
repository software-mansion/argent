// Unit coverage for the win32 `netstat -ano` → listening-PID parser. The logic
// only runs on Windows in production (POSIX uses lsof), but the parser is a
// pure function, so it is exercised here on any host. Fixtures mirror real
// `netstat -ano` output (CRLF line endings, the "Active Connections" banner and
// column header, IPv4 + IPv6 LISTENING rows, ESTABLISHED rows, a UDP row, and a
// row for a neighbouring port that must not be matched).

import { describe, it, expect } from "vitest";
import { parseNetstatListeningPids } from "../src/tools/simulator/stop-metro";

describe("parseNetstatListeningPids", () => {
  it("returns the deduped listening PIDs for the port across IPv4 and IPv6, ignoring everything else", () => {
    // PID 1234 listens on both 0.0.0.0:8081 (IPv4) and 127.0.0.1:8081 (a second
    //   IPv4 row) — the duplicate must collapse.
    // PID 5678 listens on [::]:8081 (IPv6) — must be picked up.
    // PID 9999 has an ESTABLISHED connection on :8081 — must be ignored (it is
    //   the tool-server's own CDP client socket; killing it is the bug guarded
    //   against).
    // PID 4444 LISTENS on 0.0.0.0:18081 — the leading-colon guard must keep
    //   `:18081` from matching port 8081.
    // PID 4321 is a UDP row (4 columns, no state) on :8081 — must be ignored.
    const netstat = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       1234",
      "  TCP    127.0.0.1:8081         0.0.0.0:0              LISTENING       1234",
      "  TCP    [::]:8081              [::]:0                 LISTENING       5678",
      "  TCP    127.0.0.1:8081         127.0.0.1:52345        ESTABLISHED     9999",
      "  TCP    0.0.0.0:18081          0.0.0.0:0              LISTENING       4444",
      "  UDP    0.0.0.0:8081           *:*                                    4321",
      "",
    ].join("\r\n");

    const pids = parseNetstatListeningPids(netstat, 8081);

    // Deduped, in first-seen order: 1234 (IPv4) then 5678 (IPv6).
    expect(pids).toEqual([1234, 5678]);
    // The colon guard kept the :18081 listener out.
    expect(pids).not.toContain(4444);
    // ESTABLISHED and UDP rows were ignored.
    expect(pids).not.toContain(9999);
    expect(pids).not.toContain(4321);
  });

  it("matches an IPv6-only listener via the [::]:<port> row", () => {
    const netstat = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    [::]:8081              [::]:0                 LISTENING       7777",
    ].join("\r\n");

    expect(parseNetstatListeningPids(netstat, 8081)).toEqual([7777]);
  });

  it("returns an empty list when nothing is listening on the port", () => {
    const netstat = [
      "Active Connections",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       2222",
      "  TCP    127.0.0.1:8081         127.0.0.1:50000        ESTABLISHED     3333",
    ].join("\r\n");

    expect(parseNetstatListeningPids(netstat, 8081)).toEqual([]);
  });

  it("returns an empty list for empty or header-only output", () => {
    expect(parseNetstatListeningPids("", 8081)).toEqual([]);
    expect(parseNetstatListeningPids("\r\nActive Connections\r\n", 8081)).toEqual([]);
  });

  it("matches listeners on a LOCALIZED (non-English) Windows host", () => {
    // Windows localizes the State column, so keying off the literal "LISTENING"
    // used to return [] on a German/French host and stop-metro silently no-opped.
    // The wildcard foreign address (0.0.0.0:0 / [::]:0) still identifies the
    // listener, while a localized ESTABLISHED row (real remote endpoint) is
    // still correctly skipped.
    const german = [
      "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
      "  TCP    0.0.0.0:8081           0.0.0.0:0              ABHÖREN         1234",
      "  TCP    [::]:8081              [::]:0                 ABHÖREN         5678",
      "  TCP    127.0.0.1:8081         127.0.0.1:52345        HERGESTELLT     9999",
    ].join("\r\n");
    expect(parseNetstatListeningPids(german, 8081)).toEqual([1234, 5678]);

    const french = [
      "  Proto  Adresse locale         Adresse distante       État            PID",
      "  TCP    0.0.0.0:8081           0.0.0.0:0              À L'ÉCOUTE       2468",
      "  TCP    127.0.0.1:8081         127.0.0.1:60000        ESTABLISHED     9999",
    ].join("\r\n");
    expect(parseNetstatListeningPids(french, 8081)).toEqual([2468]);
  });

  it("handles bare LF line endings as well as CRLF", () => {
    const netstat =
      "Proto Local Address Foreign Address State PID\n" +
      "  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       1515\n";
    expect(parseNetstatListeningPids(netstat, 8081)).toEqual([1515]);
  });
});

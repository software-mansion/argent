// Telemetry's subject matter is the environment, so a unit run that inherits the
// developer's shell asserts what that shell says rather than what the code does,
// and nothing in the resulting failure points at the cause. Two families reach
// in:
//
//   - Consent (src/consent.ts). DO_NOT_TRACK — the consortium standard, which a
//     privacy-conscious developer exports globally rather than per project — and
//     a falsy ARGENT_TELEMETRY each short-circuit track(), so every emission
//     assertion in index.test.ts fails on an event that was never sent.
//   - Cloud-agent detection (src/cloud-agent-detect.ts). Its markers are read in
//     combination, not individually — copilot needs GITHUB_ACTIONS *and* a
//     matching actor or workflow ref — so an ambient set can move
//     getBaseProps().cloud_agent to a vendor the test never asked for, which is
//     what the base-props case pinning the replit branch reads.
//
// The ARGENT_ prefix is swept rather than listed so an override added to src
// later is covered without a second edit here; ARGENT_TELEMETRY_DEBUG is the
// other one it covers today. DO_NOT_TRACK carries no prefix and the detector's
// markers belong to other vendors, so those are named.
//
// One name below — GITHUB_ACTIONS — is a ci-info vendor input as well as a
// copilot-agent marker (GITHUB_ACTOR and GITHUB_WORKFLOW_REF appear in neither
// ci-info's vendors.json nor ci-detect.ts's generic list), so clearing it does
// move isCi(), but only its GitHub Actions branch: an Actions run also sets CI,
// which isCi() answers ahead of any vendor check. The rest of the ci-info
// surface is left alone, and so is OTEL_* — otel.ts strips the header variables
// around exporter construction and otel-endpoint-live.test.ts plants the
// endpoint ones it needs.
//
// This runs before the test module graph is imported, so module-level env reads
// observe the cleared state too. On a machine exporting none of these the loop
// bodies never run, so no suite failure can catch this file being weakened;
// test/clear-telemetry-env.test.ts re-imports it against planted sentinels.

/** Every env name the consent and cloud-agent-detect paths read that the ARGENT_ sweep misses. */
export const CLEARED_ENV_VARS = [
  "DO_NOT_TRACK",
  "CLAUDE_CODE_ENVIRONMENT_KIND",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CURSOR_AGENT_WORKER_ID",
  "CURSOR_WORKER_POOL_NAME",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "GITHUB_WORKFLOW_REF",
  "REPLIT_AGENT",
];

for (const name of CLEARED_ENV_VARS) {
  delete process.env[name];
}

for (const name of Object.keys(process.env)) {
  // Upper-cased first: Windows env lookups are case-insensitive while the keys
  // enumerate with the casing they were set in, so a `set argent_telemetry=0`
  // survives a literal prefix match and still reads back as ARGENT_TELEMETRY.
  if (name.toUpperCase().startsWith("ARGENT_")) {
    delete process.env[name];
  }
}

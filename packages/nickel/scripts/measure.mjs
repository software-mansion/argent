#!/usr/bin/env node
// Phase-4 measurement harness for Nickel. Drives the running tool-server over HTTP and
// reports the numbers that matter: grounding latency, nickel_do success, round-trips
// saved (frontier turns the minion absorbed), vision-escalation lift, and escalation rate.
//
// Prereqs: tool-server on :3001 with the `nickel` flag on, a booted device, a running
// or spawnable llama-server. Usage:
//   node packages/nickel/scripts/measure.mjs [--udid <id>] [--base http://127.0.0.1:3001]
//
// Each task starts from the Home tab (we reset between tasks) so runs are comparable.
// Reported per-task outcomes are descriptive (status + cost), not graded against a
// golden path — the point is the distribution, not a pass/fail gate.

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = opt("base", "http://127.0.0.1:3001");
const UDID = opt("udid", process.env.NICKEL_UDID);
if (!UDID) {
  console.error("Pass --udid <device id> (or set NICKEL_UDID).");
  process.exit(1);
}

async function call(tool, body, timeoutMs = 240000) {
  const t = Date.now();
  const res = await fetch(`${BASE}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ udid: UDID, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  return { data: j.data ?? j, wall_ms: Date.now() - t };
}

const reset = () =>
  call("nickel-act", { instruction: "tap the Home tab at the bottom" }).catch(() => {});

// Single-action probes → grounding latency.
const ACT_TASKS = [
  "tap the Search tab at the bottom",
  "tap the Notifications tab at the bottom",
  "tap the Profile tab at the bottom",
  "tap the Home tab at the bottom",
];

// Multi-step goals → do success, steps, escalation, vision.
const DO_TASKS = [
  "open the Search tab",
  "open the Profile tab",
  "go to the Search tab, tap the search box, and type cats",
];

function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    median: q(0.5),
    p90: q(0.9),
    min: s[0],
    max: s[s.length - 1],
  };
}

async function main() {
  console.log(`Nickel measurement · base=${BASE} · udid=${UDID.slice(0, 8)}…\n`);

  // ---- Grounding latency (nickel_act) ----
  const groundMs = [];
  console.log("== nickel_act — grounding latency ==");
  for (const instruction of ACT_TASKS) {
    const { data } = await call("nickel-act", { instruction });
    const ms = data?.latency?.ground_ms;
    if (typeof ms === "number") groundMs.push(ms);
    console.log(
      `  ${data?.resolved ? "✓" : "·"} ${instruction.padEnd(44)} ground=${ms}ms exec=${data?.latency?.exec_ms}ms`
    );
  }
  const gl = stats(groundMs);
  console.log(`  grounding_ms: mean=${gl.mean} median=${gl.median} p90=${gl.p90} (n=${gl.n})\n`);

  // ---- nickel_do — success / cost / escalation / vision ----
  console.log("== nickel_do — autonomy ==");
  const runs = [];
  for (const goal of DO_TASKS) {
    await reset();
    const { data, wall_ms } = await call("nickel-do", { goal, max_steps: 10 });
    const c = data?.cost ?? {};
    runs.push({
      goal,
      status: data?.status,
      steps: c.steps ?? 0,
      model_calls: c.model_calls ?? 0,
      used_vision: !!c.used_vision,
      wall_ms,
    });
    console.log(
      `  [${String(data?.status).padEnd(14)}] steps=${c.steps} calls=${c.model_calls} vision=${c.used_vision} wall=${(wall_ms / 1000).toFixed(1)}s  «${goal.slice(0, 46)}»`
    );
  }

  const done = runs.filter((r) => r.status === "done");
  const escalated = runs.filter((r) => r.status === "need_clearance" || r.status === "blocked");
  const stepsExecuted = runs.reduce((a, r) => a + r.steps, 0);
  const doCalls = runs.length;
  console.log("");
  console.log("== summary ==");
  console.log(`  grounding latency:   mean ${gl.mean}ms · median ${gl.median}ms · p90 ${gl.p90}ms`);
  console.log(`  do success:          ${done.length}/${runs.length} reached "done"`);
  console.log(`  escalation rate:     ${escalated.length}/${runs.length} (need_clearance|blocked)`);
  console.log(
    `  steps executed:      ${stepsExecuted} local steps across ${doCalls} nickel_do call(s)`
  );
  console.log(
    `  frontier turns saved: ~${Math.max(0, stepsExecuted - doCalls)} (each local step is a frontier↔minion round-trip the frontier didn't make)`
  );
  console.log(
    `  vision escalations:  ${runs.filter((r) => r.used_vision).length}/${runs.length} run(s) fell back to a screenshot`
  );
  const doneAvg = done.length
    ? (done.reduce((a, r) => a + r.steps, 0) / done.length).toFixed(1)
    : "—";
  console.log(`  avg steps per done:  ${doneAvg}`);
}

main().catch((e) => {
  console.error("measurement failed:", e?.message ?? e);
  process.exit(1);
});

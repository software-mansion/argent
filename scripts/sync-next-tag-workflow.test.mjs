/**
 * A dry-run publish must not trigger the `next` dist-tag sync. `inputs` never
 * reach a workflow_run listener, so sync-next-tag.yml tells a dry run apart by
 * the title publish-npm.yml's run-name gives it; the two strings live in
 * different files.
 *
 * Run: node --test scripts/sync-next-tag-workflow.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = (name) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

test("sync-next-tag skips a successful run titled as publish-npm's dry run", () => {
  const runName = /^run-name: \$\{\{ inputs\.dry_run && '([^']+)' \|\| '' \}\}$/m.exec(
    workflow("publish-npm.yml")
  );
  assert.ok(runName, "publish-npm.yml titles a dry run through run-name");
  const guard = /^\s+if: \$\{\{ (.+) \}\}$/m.exec(workflow("sync-next-tag.yml"));
  assert.ok(guard, "sync-next-tag.yml has a job-level if");
  assert.equal(
    guard[1],
    "github.event_name == 'workflow_dispatch' || " +
      "(github.event.workflow_run.conclusion == 'success' && " +
      `github.event.workflow_run.display_title != '${runName[1]}')`
  );
});

// A standalone parent for the orphan-reaping test.
//
// The lifeline watchdog's whole job is to stop a runner whose parent died, so
// proving it needs a parent that can be `SIGKILL`ed — which the test process
// itself cannot be. This driver runs one script through the real executor and
// then waits; the test kills it and checks that the runner did not survive.
//
// Run through ts-node's own binary, with the workspace tsconfig, which is what
// `flow-script-lifecycle.test.ts` spawns:
// `node <ts-node/dist/bin.js> -T -P packages/tool-server/tsconfig.json <this file> <script> <cwd>`.
import { FlowScriptExecutor } from "../../src/tools/flows/script/flow-script-executor";

const [scriptPath, projectRoot] = process.argv.slice(2);

const executor = new FlowScriptExecutor({ concurrency: 2, maxTimeoutMs: 600_000 });
void executor
  .execute({ scriptPath, projectRoot, timeoutMs: 300_000 })
  .then((result) => {
    process.stdout.write(`DONE ${JSON.stringify(result)}\n`);
  })
  .catch((err: unknown) => {
    process.stderr.write(`FAILED ${String(err)}\n`);
    process.exit(1);
  });

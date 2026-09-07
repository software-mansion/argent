// The lifeline watchdog stops a runner whose parent died, so proving it needs a
// parent that can be `SIGKILL`ed — which the test process itself cannot be.
import { FlowScriptExecutor } from "../../src/tools/flows/script/flow-script-executor";

const [scriptPath, projectRoot, interpreter, exchangeRoot] = process.argv.slice(2);

// A root of the test's own, so the exchange directory of the step this driver
// is SIGKILLed in the middle of is one the test can clean up. That kill is the
// one case `removeExchange`'s `finally` cannot cover.
const executor = new FlowScriptExecutor({
  concurrency: 2,
  maxTimeoutMs: 600_000,
  ...(exchangeRoot ? { exchangeRoot } : {}),
});
void executor
  .execute({
    scriptPath,
    projectRoot,
    timeoutMs: 300_000,
    ...(interpreter === "bash" ? { interpreter: "bash" as const } : {}),
  })
  .then((result) => {
    process.stdout.write(`DONE ${JSON.stringify(result)}\n`);
  })
  .catch((err: unknown) => {
    process.stderr.write(`FAILED ${String(err)}\n`);
    process.exit(1);
  });

import { FlowScriptExecutor } from "../../src/tools/flows/script/flow-script-executor";

const [scriptPath, projectRoot, interpreter, exchangeRoot] = process.argv.slice(2);

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

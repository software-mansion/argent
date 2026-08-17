// `argent secrets` — inspect the values a `{{secret:<NAME>}}` placeholder can
// resolve to, without ever printing one.
//
// The placeholder mechanism is deliberately opaque from the agent's side: a
// name that is not defined fails at typing time, deep inside a flow run. This
// command is the way to check the setup *before* that — it lists the source
// chain (`@argent/configuration-core`'s `secretSources`) with the names each
// one contributes, so "is my secrets file being picked up?" is answerable in
// one line. Values are never read out: printing them here would put the
// credential in a terminal scrollback and, when an agent runs the command, in
// its context — the exact leak the placeholder exists to prevent.

import pc from "picocolors";
import { getResolvedToolsUrl } from "@argent/tools-client";
import { secretSources, secretNames, SECRET_ENV_PREFIX } from "@argent/configuration-core";

export async function secrets(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "list") return cmdList(rest);
  if (sub === "--help" || sub === "-h") return printUsage();
  if (sub === "--json") return cmdList([sub, ...rest]);
  console.error(`Error: unknown subcommand "secrets ${sub}". Try \`argent secrets --help\`.`);
  process.exit(2);
}

function printUsage(): void {
  console.log(`Usage: argent secrets [list] [--json]

List the secrets a \`{{secret:<NAME>}}\` placeholder can resolve, and the sources
they come from. Names only — a value is never printed.

A name is resolved by the machine running the tool-server, taking the first
source that defines it:

  1. ${SECRET_ENV_PREFIX}<NAME> in the environment    prefixed variables only
  2. <project>/.argent/secrets.env             every key (gitignore this file)
  3. <project>/.env.local, then <project>/.env  only ${SECRET_ENV_PREFIX}-prefixed keys
  4. ~/.argent/secrets.env                     every key, any project

A secrets file applies to the next tool call — no restart. An environment
variable only reaches a tool-server started after it was exported.

Examples:
  echo 'APP_PASSWORD=…' >> ~/.argent/secrets.env   # available in every project
  argent secrets                                   # check it is picked up`);
}

async function cmdList(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) return printUsage();
  const json = argv.includes("--json");
  const sources = secretSources();
  const all = secretNames(sources);

  if (json) {
    console.log(
      JSON.stringify(
        {
          secrets: all,
          sources: sources.map((s) => ({
            source: s.label,
            present: s.present,
            names: s.names,
            ...(s.needsPrefix ? { needsPrefix: true } : {}),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Secrets available to \`{{secret:<NAME>}}\` on this machine:\n`);
  // Two files can define the same name; only the earlier one is ever used. Mark
  // the later copies rather than listing them as if they applied — a name that
  // silently loses to a file you forgot about is the confusing case this
  // command exists to answer.
  const claimed = new Set<string>();
  for (const source of sources) {
    console.log(`  ${source.label}`);
    if (!source.present) {
      console.log(`    ${pc.dim("not found")}`);
    } else if (source.needsPrefix) {
      console.log(
        `    ${pc.dim(`no ${SECRET_ENV_PREFIX}* keys — only prefixed keys are exposed from a file the app shares`)}`
      );
    } else if (source.names.length === 0) {
      console.log(`    ${pc.dim("no secrets")}`);
    } else {
      const rendered = source.names.map((name) =>
        claimed.has(name) ? pc.dim(`${name} (shadowed above)`) : name
      );
      for (const name of source.names) claimed.add(name);
      console.log(`    ${rendered.join(", ")}`);
    }
  }

  console.log(
    `\n${all.length === 0 ? "No secrets are defined." : `${all.length} name${all.length === 1 ? "" : "s"} in effect: ${all.join(", ")}`}`
  );
  console.log(
    pc.dim("Values are never printed. Run `argent secrets --help` to see where to add one.")
  );

  // Resolution happens wherever the tool-server runs. With a linked remote
  // server that is a different machine, and this listing describes the wrong
  // one — say so rather than let it read as authoritative.
  const routed = await getResolvedToolsUrl().catch(() => ({ url: null }));
  if (routed.url) {
    console.log(
      pc.yellow(
        `\nNote: a remote tool-server is linked (${routed.url}). Placeholders resolve there, ` +
          `against that machine's environment and secrets files — not the ones listed above.`
      )
    );
  }
}

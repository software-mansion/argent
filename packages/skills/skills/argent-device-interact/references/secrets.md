# Typing Secrets

Where a `{{secret:<NAME>}}` placeholder gets its value, and the rules for using one. See the `keyboard` section of SKILL.md for the placeholder syntax itself.

## Where the value comes from

The placeholder is resolved on the machine running the tool-server, from the first of these that defines the name:

| #   | Source                                        | Which keys it exposes                                                |
| --- | --------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `ARGENT_SECRET_<NAME>` environment variable   | prefixed vars only — the CI-native path                              |
| 2   | `<project>/.argent/secrets.env`               | every key (`APP_PASSWORD=…`) — gitignore this file                   |
| 3   | `<project>/.env.local`, then `<project>/.env` | only `ARGENT_SECRET_`-prefixed keys, so app config stays unreachable |
| 4   | `~/.argent/secrets.env`                       | every key — per-user, works in any project                           |

## Rules

- The result echoes the placeholder, never the value. An unknown name fails with the list of available secret _names_ and every source it looked in, with paths — read that list before asking the user anything.
- The auto-screenshot after the call is skipped so the typed value cannot re-enter your context as pixels. Do **not** `describe` or `screenshot` a non-secure field you just filled with a secret — submit or navigate away first, then verify the resulting screen. To submit, put the text step and the Enter step in **one `run-sequence`**. The skip covers a whole batch that contains the placeholder, but a second bare `keyboard` call gets its own screenshot of the filled field.
- Nothing outside those sources is reachable; never ask the user to paste a secret value into the conversation. Ask them to put it in a secrets file instead — a file edit applies to the next call, while an exported env var only reaches a tool-server started afterwards.
- The project sources are found by walking up from the tool-server's working directory. If a project file is not being picked up, the failure's source list shows the paths actually consulted; `~/.argent/secrets.env` needs no project and always applies.

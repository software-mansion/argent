# E2E runner for version 1 files

`e2e-execute` sends an e2e test file without `version: 2` to this runner when the run's
device is an iOS simulator (see the check in `../flow-run.ts`). The files here are main's
files at `e79714225`, unchanged except for import paths, so an old e2e test runs as main's
runner at that commit ran it:

```sh
git show e79714225:packages/tool-server/src/tools/flows/flow-run.ts |
  diff - packages/tool-server/src/tools/flows/version-1/flow-run.ts
```

- Do not change these files. Fixes go to the current runner in `..`.
- These files also import code outside this folder. Before you change how such code behaves,
  copy main's version of it into this folder, so that old e2e tests do not change.
- To remove version 1, delete this folder and `test/flows/version-1/`. Then remove what
  refers to version 1:
  - the check in `../flow-run.ts`;
  - `isVersion1` and the version 1 runner in the comment on `FLOW_FILE_VERSION`, in
    `../flow-utils.ts`, and the `isVersion1` cases in `test/flows/flow-file-version.test.ts`;
  - the old e2e test warning in `../flow-add-step.ts`;
  - the version 1 cases and the mocks of this folder in `test/flows/flow-file-version-run.test.ts`;
  - the test comments that explain a `version: 2`
    (`git grep -n '// Version 2' -- packages/tool-server/test`);
  - the skipped folder in `scripts/extract-tools.mjs` and its test;
  - the entry for this folder in `knip.jsonc`;
  - the view hierarchy text of "File version", "Runner tree and discovery tree" and
    "Conditions" in `packages/docs/docs/reference/e2e-yaml.mdx`, and the file version paragraph in
    `packages/docs/docs/features/e2e.mdx`;
  - "Old e2e tests" in `packages/skills/skills/argent-create-e2e/references/e2e-yaml.md`, and
    the lines that refer to it there and in that skill's `SKILL.md`.

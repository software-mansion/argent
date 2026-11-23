# E2E runner for version 1 files

`e2e-execute` sends an e2e test file without `version: 2` to this runner when the run's
device is an iOS simulator (see the check in `../flow-run.ts`). The files here are main's
files at `e7951ccca`, unchanged except for import paths, so an old e2e test runs exactly as
it did before version 2:

```sh
git show e7951ccca:packages/tool-server/src/tools/flows/flow-run.ts |
  diff - packages/tool-server/src/tools/flows/version-1/flow-run.ts
```

- Do not change these files. Fixes go to the current runner in `..`.
- These files also import code outside this folder. Before you change how such code behaves,
  copy main's version of it into this folder, so that old e2e tests do not change.
- To remove version 1, delete this folder and `test/flows/version-1/`. Then remove what
  refers to version 1:
  - the check in `../flow-run.ts`;
  - the old e2e test warning in `../flow-add-step.ts`;
  - the version 1 cases in `test/flows/flow-file-version-run.test.ts`;
  - the skipped folder in `scripts/extract-tools.mjs` and its test;
  - the entry for this folder in `knip.jsonc`;
  - the version 1 row of "File version" in `packages/docs/docs/reference/e2e-yaml.mdx`.

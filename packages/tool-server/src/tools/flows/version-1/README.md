# E2E runner for version 1 files

`e2e-execute` sends an e2e test file without `version: 2` to this runner when the run's
device is an iOS simulator (see the check in `../flow-run.ts`). The files here are main's
files at `34696ae7a`, unchanged except for import paths, so an old e2e test runs exactly as
it did before version 2:

```sh
git show 34696ae7a:packages/tool-server/src/tools/flows/flow-run.ts |
  diff - packages/tool-server/src/tools/flows/version-1/flow-run.ts
```

- Do not change these files. Fixes go to the current runner in `..`.
- These files also import code outside this folder. Before you change how such code behaves,
  copy main's version of it into this folder, so that old e2e tests do not change.
- To remove version 1: delete this folder and `test/flows/version-1/`, and remove the check
  in `../flow-run.ts`.

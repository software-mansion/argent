import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_NATIVE_DEVTOOLS_DIR lets the launcher override the dylib directory,
// matching the same pattern used by ARGENT_SIMULATOR_SERVER_DIR.
const DYLIB_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_DIR ??
  path.join(__dirname, "..", "dylibs");

function requireDylib(name: string): string {
  const p = path.join(DYLIB_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Native devtools dylib not found: ${p}`);
  }
  return p;
}

export const bootstrapDylibPath = () =>
  requireDylib("libInjectionBootstrap.dylib");
export const nativeDevtoolsDylibPath = () =>
  requireDylib("libNativeDevtoolsIos.dylib");
export const keyboardPatchDylibPath = () =>
  requireDylib("libKeyboardPatch.dylib");

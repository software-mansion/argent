import vendors from "ci-info/vendors.json";

type VendorEnv =
  | string
  | { env: string; includes: string }
  | { any: string[] }
  | Record<string, string>;

interface VendorDefinition {
  env: VendorEnv | VendorEnv[];
}

// Copied verbatim from ci-info 4.4.0's `isCI` detector: the same generic env
// vars and the `CI === "false"` bypass in isCi() below. ci-info is the de-facto
// ecosystem standard (npm, Jest, etc.), so we inherit exactly its false-positive
// surface — narrowing this list would diverge from it and risk false negatives
// (missing real Jenkins/TeamCity/TaskCluster CI). We re-implement rather than
// import ci-info's `isCI` because that value is computed once at import time;
// this wrapper takes `env` lazily so tests can inject it.
const GENERIC_CI_ENV_VARS = [
  "BUILD_ID",
  "BUILD_NUMBER",
  "CI",
  "CI_APP_ID",
  "CI_BUILD_ID",
  "CI_BUILD_NUMBER",
  "CI_NAME",
  "CONTINUOUS_INTEGRATION",
  "RUN_ID",
] as const;

function checkEnv(env: NodeJS.ProcessEnv, def: VendorEnv): boolean {
  if (typeof def === "string") return Boolean(env[def]);

  if ("env" in def) {
    const value = env[def.env];
    return Boolean(value && value.includes(def.includes));
  }

  if ("any" in def && Array.isArray(def.any)) {
    return def.any.some((key: string) => Boolean(env[key]));
  }

  return Object.entries(def).every(([key, value]) => env[key] === value);
}

function isKnownVendorCi(env: NodeJS.ProcessEnv): boolean {
  return (vendors as VendorDefinition[]).some((vendor) => {
    const defs = Array.isArray(vendor.env) ? vendor.env : [vendor.env];
    return defs.every((def) => checkEnv(env, def));
  });
}

export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI === "false") return false;
  if (GENERIC_CI_ENV_VARS.some((name) => Boolean(env[name]))) return true;
  return isKnownVendorCi(env);
}

/** Exposed for vitest coverage assertions; do not import outside tests. */
export const _CI_VENDOR_COUNT_FOR_TEST: number = (vendors as VendorDefinition[]).length;

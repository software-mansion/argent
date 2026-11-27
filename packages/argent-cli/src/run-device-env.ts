import { isRetiredField, type JsonSchema } from "./flag-parser.js";

const DEVICE_ENV_VAR = "ARGENT_UDID";

const DEVICE_FIELDS = ["udid", "device_id"] as const;

function requiredDeviceField(schema: JsonSchema | undefined): string | undefined {
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  return DEVICE_FIELDS.find(
    (name) => required.includes(name) && properties[name] && !isRetiredField(properties[name])
  );
}

// Optional device fields stay untouched: leaving one out has its own meaning, such as
// `boot-device` booting an AVD instead of a simulator.
export function applyDeviceFromEnv(
  payload: Record<string, unknown>,
  schema: JsonSchema | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  const deviceId = env[DEVICE_ENV_VAR]?.trim();
  if (!deviceId) return;
  const field = requiredDeviceField(schema);
  if (field && !Object.hasOwn(payload, field)) payload[field] = deviceId;
}

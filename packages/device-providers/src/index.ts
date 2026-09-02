/**
 * `@argent/device-providers` — the external device provider contract.
 *
 * - [`contract.ts`](./contract.ts) — the frozen v1 vocabulary. Pure, zod only.
 * - [`read.ts`](./read.ts) — Argent's discovery path. Never throws, never
 *   caches, never unlinks.
 * - [`write.ts`](./write.ts) — the publish helpers a provider calls, directly
 *   or through `argent providers publish`. Validates strictly and throws.
 *
 * The JSON document in `~/.argent/providers/` stays the contract of record;
 * this package is a convenience for providers that happen to be Node.
 *
 * This package is CommonJS, unlike its ESM siblings. `@argent/tool-server` is
 * CommonJS and requires it and on Node older than 20.19 requiring an ESM module
 * that imports zod overflows the stack. CommonJS loads zod's CommonJS build
 * instead, so the crash never happens.
 */

export {
  ALLOWED_SIM_SERVER_ENDPOINTS,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_PREFIX,
  type ExternalCapability,
  type ExternalDevice,
  externalNativeId,
  externalProviderId,
  externalProviderLabel,
  isExternalDeviceUrn,
  isExternalId,
  makeExternalId,
  nativeIdPlatform,
  parseExternalId,
  PROVIDER_ID_SHAPE,
  PROVIDER_SCHEMA_VERSION,
  type ProviderDevice,
  providerDeviceSchema,
  type ProviderRecord,
  providerRecordSchema,
  type ProviderRecordStrict,
} from "./contract.js";

export {
  __resetProviderWarningsForTesting,
  descriptorFiles,
  discoverProviders,
  providersDirectory,
  readProviderDevices,
  readProviderFile,
} from "./read.js";

export {
  isProcessAlive,
  pruneOrphanedProviders,
  type PruneOptions,
  type PruneResult,
  type PublishOptions,
  type PublishResult,
  publishProvider,
  ProviderValidationError,
  withdrawProvider,
} from "./write.js";

import { secretSources } from "@argent/configuration-core";
import type { ToolContext } from "@argent/registry";
import { secretRedactor, type SecretRedactor } from "../../utils/secrets";
import { typedSecrets } from "../../utils/typed-secrets";

/**
 * What the network tools return holds what the app sent and received, so a
 * secret an agent typed as `{{secret:NAME}}` comes back in a body, a URL or a
 * header. These helpers put the placeholder back in place of the value, in the
 * result only: the records keep the raw values, so matching, redirect detection
 * and body decoding work on what was sent.
 */

type NetworkSecret = { name: string; value: string };

/**
 * The values of every secret exposed to argent: the secrets the client
 * forwarded with this call (an e2e run passes them to each step), every value
 * of every secret source (also one an earlier source shadows), and the values
 * typed on each device (see `typedSecrets`), so an edit of a secrets file does
 * not bring back a value already in a field. Read fresh on each call, so an
 * edited secrets file applies to the next one.
 */
export function networkSecrets(ctx?: ToolContext): NetworkSecret[] {
  const secrets: NetworkSecret[] = [];
  for (const [name, value] of ctx?.clientSecrets ?? []) secrets.push({ name, value });
  for (const source of secretSources()) {
    for (const [name, value] of source.values) secrets.push({ name, value });
  }
  return [...secrets, ...typedSecrets()];
}

/**
 * One whole-value redactor over `secrets`, so the longest value wins where two
 * overlap. A value under 2 names is named by the first: for `networkSecrets`,
 * the client, then the sources in the order a placeholder resolves, then typing.
 */
export function networkRedactorOf(secrets: readonly NetworkSecret[]): SecretRedactor {
  const byValue = new Map<string, string>();
  for (const { name, value } of secrets) {
    if (value.length > 0 && !byValue.has(value)) byValue.set(value, name);
  }
  return secretRedactor(
    [...byValue].map(([value, name]) => ({ name, value })),
    { wholeValues: true }
  );
}

/** A redactor for `networkSecrets(ctx)`. */
export function networkSecretRedactor(ctx?: ToolContext): SecretRedactor {
  return networkRedactorOf(networkSecrets(ctx));
}

/**
 * A copy of `result` with every string value and every object key redacted,
 * except the values at `keep`: dotted paths from the root, `*` for any array
 * index, naming the tool's own ids, which a short value would otherwise break
 * (`rn-net-4821` with a PIN of `4821`). The copy matters: a result can share
 * objects with the records, such as Chromium's `initiator`. A key that
 * redacts to one already present overwrites it.
 */
export function redactNetworkResult<T>(
  result: T,
  redact: SecretRedactor,
  keep: readonly string[] = []
): T {
  if (redact.names.size === 0) return result;
  const kept = keep.map((path) => path.split("."));
  const walk = (node: unknown, path: string[]): unknown => {
    if (typeof node === "string") {
      return kept.some(
        (k) =>
          k.length === path.length &&
          k.every((p, i) => (p === "*" ? /^\d+$/.test(path[i]) : p === path[i]))
      )
        ? node
        : redact(node);
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, String(i)]));
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[redact(key)] = walk(value, [...path, key]);
    }
    return out;
  };
  return walk(result, []) as T;
}

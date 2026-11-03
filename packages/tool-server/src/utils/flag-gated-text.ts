/**
 * Flag-gated parts of a tool's advertised surface. Tool descriptions must stay
 * single string literals (`scripts/extract-tools.mjs` reads them statically), so
 * a span that only applies while a feature flag is on is marked inside the text:
 *
 *   "(iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos>or Chromium id)"
 *
 * A schema property that exists only behind a flag carries
 * `.meta({ [FLAG_META_KEY]: "<flag>" })`.
 */
export const FLAG_META_KEY = "x-argent-flag";

const FLAG_SPAN = /<flag:([a-z0-9-]+)>([\s\S]*?)<\/flag:\1>/g;

/**
 * Renders flag spans and flag-gated properties against `isFlagEnabled`: an
 * enabled span keeps its text without the tags, a disabled one disappears, and
 * so does a disabled property (with its `required` entry). Walks strings,
 * arrays and plain objects; returns a copy.
 */
export function renderFlagGated<T>(value: T, isFlagEnabled: (flag: string) => boolean): T {
  return render(value, isFlagEnabled) as T;
}

function render(value: unknown, isFlagEnabled: (flag: string) => boolean): unknown {
  if (typeof value === "string") {
    return value.replace(FLAG_SPAN, (_, flag: string, text: string) =>
      isFlagEnabled(flag) ? text : ""
    );
  }
  if (Array.isArray(value)) return value.map((item) => render(item, isFlagEnabled));
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const dropped = new Set<string>();
  for (const [key, child] of Object.entries(source)) {
    if (key === FLAG_META_KEY) continue;
    if (key === "properties" && child !== null && typeof child === "object") {
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(child as Record<string, unknown>)) {
        const flag = (prop as Record<string, unknown> | null)?.[FLAG_META_KEY];
        if (typeof flag === "string" && !isFlagEnabled(flag)) {
          dropped.add(name);
          continue;
        }
        props[name] = render(prop, isFlagEnabled);
      }
      out[key] = props;
      continue;
    }
    out[key] = render(child, isFlagEnabled);
  }
  if (dropped.size > 0 && Array.isArray(out.required)) {
    out.required = out.required.filter((name) => !dropped.has(name as string));
  }
  return out;
}

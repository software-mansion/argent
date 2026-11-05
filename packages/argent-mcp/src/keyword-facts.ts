type Schema = Record<string, unknown>;

/**
 * The MCP `clientInfo.name` of the clients whose model sees the schema keywords, on every
 * model they were checked with: Claude Code, Gemini CLI, Zed, Kiro IDE (`kiro`) and Kiro
 * CLI (`Q DEV CLI`). VS Code's agent host (`copilot-cli`) writes the keywords into the
 * description itself. For these the copy would only repeat a fact.
 *
 * Every other client gets the copy, an unknown one included. Codex drops the keywords;
 * opencode drops them on OpenAI and Google models, and VS Code's chat on gpt-4 models.
 * Cursor, Devin and Hermes were checked on one model at most, and Devin and Hermes send
 * their SDK's default name. A repeated fact costs less than a missing one.
 */
const SHOWS_KEYWORDS = [
  /^claude-code\b/,
  /^gemini-cli-mcp-client\b/,
  /^zed\b/,
  /^kiro\b/,
  /^q dev cli\b/,
  /^copilot-cli\b/,
];

/** True when the client named in the MCP handshake shows schema keywords to its model. */
export function showsSchemaKeywords(clientName: string | undefined): boolean {
  const name = clientName?.trim().toLowerCase() ?? "";
  return SHOWS_KEYWORDS.some((pattern) => pattern.test(name));
}

/**
 * A fact that only a schema keyword states never reaches the model of a client that drops
 * the keyword. This copies each such fact into the description of the property it
 * constrains, unless that description already states it. The keywords stay, for the
 * clients that validate with them.
 *
 * Left out on purpose: `pattern`, `minLength: 1` and `minItems: 1` (input guards the
 * tool-server enforces with a clear error), and `enum` (every client keeps it). Bounds on
 * scalar array items are not copied either; no tool declares any.
 */
export function withKeywordFacts(schema: Schema): Schema {
  const properties = asSchema(schema.properties);
  return properties ? { ...schema, properties: withPropertyFacts(properties) } : schema;
}

function withPropertyFacts(properties: Schema): Schema {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const prop = asSchema(value);
      return [key, prop ? withFacts(prop) : value];
    })
  );
}

function withFacts(prop: Schema): Schema {
  const out: Schema = { ...prop };
  const nested = asSchema(prop.properties);
  if (nested) out.properties = withPropertyFacts(nested);
  const items = asSchema(prop.items);
  if (items) out.items = withKeywordFacts(items);

  const description = typeof prop.description === "string" ? prop.description.trimEnd() : "";
  const facts = factsOf(prop, description);
  if (facts.length === 0) return out;
  const separator = description === "" ? "" : /[.!?:]$/.test(description) ? " " : ". ";
  out.description = `${description}${separator}${facts.join(" ")}`;
  return out;
}

/** The facts the keywords state and the description does not, in a fixed order. */
function factsOf(prop: Schema, description: string): string[] {
  const facts: string[] = [];
  if (prop.default !== undefined && !statesDefault(description, prop.default)) {
    facts.push(`Default: ${show(prop.default)}.`);
  }
  // A union's branches (e.g. `integer | "latest"`) constrain the same property.
  for (const branch of [prop, ...branchesOf(prop)]) {
    facts.push(...boundFacts(branch, description));
    if (branch.const !== undefined && !mentions(description, branch.const)) {
      facts.push(`Also accepts ${show(branch.const)}.`);
    }
  }
  return facts;
}

function branchesOf(prop: Schema): Schema[] {
  const branches = [prop.anyOf, prop.oneOf].flatMap((list) => (Array.isArray(list) ? list : []));
  return branches.map(asSchema).filter((branch): branch is Schema => branch !== undefined);
}

function boundFacts(schema: Schema, description: string): string[] {
  const facts: string[] = [];
  const min = bound(schema.minimum);
  const max = bound(schema.maximum);
  const above = bound(schema.exclusiveMinimum);
  const below = bound(schema.exclusiveMaximum);

  const rangeStated = min !== undefined && max !== undefined && statesRange(description, min, max);
  const showMin = min !== undefined && !rangeStated && !statesLimit(description, MIN_WORDS, min);
  const showMax = max !== undefined && !rangeStated && !statesLimit(description, MAX_WORDS, max);
  if (showMin && showMax) facts.push(`Range: ${min} to ${max}.`);
  else if (showMin) facts.push(`Minimum: ${min}.`);
  else if (showMax) facts.push(`Maximum: ${max}.`);
  if (above !== undefined && !statesAbove(description, above)) {
    facts.push(`Must be greater than ${above}.`);
  }
  if (below !== undefined && !statesLimit(description, BELOW_WORDS, below)) {
    facts.push(`Must be less than ${below}.`);
  }

  const lengthOrCount: Array<[unknown, string, RegExp]> = [
    [schema.minLength, "Min length", MIN_WORDS],
    [schema.maxLength, "Max length", MAX_WORDS],
    [schema.minItems, "Min items", MIN_WORDS],
    [schema.maxItems, "Max items", MAX_WORDS],
  ];
  for (const [value, label, words] of lengthOrCount) {
    const n = bound(value);
    const trivialMin = label.startsWith("Min") && n !== undefined && n <= 1;
    if (n !== undefined && !trivialMin && !statesLimit(description, words, n)) {
      facts.push(`${label}: ${n}.`);
    }
  }
  return facts;
}

const MIN_WORDS = /\b(min(imum)?|at least|no less than)\b|>=|≥/;
const MAX_WORDS = /\b(max(imum)?|at most|up to|no more than|caps? at|capped at|limit)\b|<=|≤/;
const BELOW_WORDS = /\b(less than|below|under)\b|</;

/** True when `description` names `value` within a few words after one of `words`. */
function statesLimit(description: string, words: RegExp, value: number): boolean {
  return new RegExp(`(${words.source})[^.;\\n]{0,24}?${numberPattern(value)}`, "i").test(
    description
  );
}

/** True for "0.0–1.0", "1-10", "0 (closed) to 180 (open)" and the like. */
function statesRange(description: string, min: number, max: number): boolean {
  return new RegExp(
    `${numberPattern(min)}\\s*(\\([^)]{0,20}\\)\\s*)?(–|—|-|to|\\.\\.)\\s*${numberPattern(max)}`,
    "i"
  ).test(description);
}

function statesAbove(description: string, value: number): boolean {
  if (value === 0 && /\bpositive\b/i.test(description)) return true;
  return statesLimit(description, /\b(greater than|more than|above|over)\b|>/, value);
}

function statesDefault(description: string, value: unknown): boolean {
  const v = valuePattern(raw(value));
  return new RegExp(
    `\\bdefault(s|s to| is|:)?[^.;\\n]{0,24}?${v}|${v}[^.;\\n]{0,16}\\bby default|${v}\\s*\\(default\\)`,
    "i"
  ).test(description);
}

function mentions(description: string, value: unknown): boolean {
  return new RegExp(valuePattern(raw(value)), "i").test(description);
}

/** Matches the value as a whole token, so `20` does not match inside `200`. */
function valuePattern(value: string): string {
  return `(?<![\\w.])${escapeRegExp(value)}(?![\\w])`;
}

/** Like `valuePattern`, but `1` also matches `1.0`, and `0` does not match inside `0.25`. */
function numberPattern(value: number): string {
  return `(?<![\\w.])${escapeRegExp(String(value))}(\\.0+)?(?![\\w]|\\.\\d)`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// zod's `.int()` emits ±MAX_SAFE_INTEGER bounds; they state nothing.
function bound(value: unknown): number | undefined {
  return typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : undefined;
}

function raw(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function show(value: unknown): string {
  return JSON.stringify(value);
}

function asSchema(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

/**
 * Reads the requests a harness sent to its model and works out what the model can read
 * of Argent's tools.
 *
 * A "fact" is one value a schema keyword states: a default, a minimum or maximum, a length
 * or item limit, or a constant in a union. For each fact of each Argent tool in the
 * request, it looks for the places the model can read it:
 *   keyword      the keyword itself, with the same value, is still in the request
 *   description  the description Argent wrote states it
 *   added        a sentence Argent added to the description states it
 *   harness      text the harness itself added states it (VS Code writes "{minimum: 0}")
 * No place means the fact is lost; two or more mean the model reads it twice.
 *
 * Text matching is by regular expressions, written apart from Argent's own renderer
 * (packages/argent-mcp/src/keyword-facts.ts), so one can catch the other's mistakes. It is
 * a heuristic: an unusual phrasing in a description can be missed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEYWORDS = [
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "const",
];

/** Every keyword fact in the reference tool list, one per keyword per param. */
function factsOf(tools) {
  const facts = [];
  const visit = (schema, tool, prefix) => {
    for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
      const path = `${prefix}${name}`;
      for (const node of [prop, ...(prop.anyOf ?? []), ...(prop.oneOf ?? [])]) {
        for (const key of KEYWORDS) {
          const value = node[key];
          if (value === undefined) continue;
          // zod's .int() emits ±MAX_SAFE_INTEGER; it states nothing.
          if (typeof value === "number" && Math.abs(value) >= Number.MAX_SAFE_INTEGER) continue;
          // A 1-minimum is an input guard the tool-server reports clearly; not counted.
          if ((key === "minLength" || key === "minItems") && value <= 1) continue;
          facts.push({ tool, path, key, value });
        }
      }
      if (prop.properties) visit(prop, tool, `${path}.`);
      if (prop.items?.properties) visit(prop.items, tool, `${path}[].`);
    }
  };
  for (const t of tools) visit(t.inputSchema, t.name, "");
  return facts;
}

function paramsOf(tools) {
  const params = [];
  const visit = (schema, tool, prefix) => {
    for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
      const path = `${prefix}${name}`;
      params.push({ tool, path });
      if (prop.properties) visit(prop, tool, `${path}.`);
      if (prop.items?.properties) visit(prop.items, tool, `${path}[].`);
    }
  };
  for (const t of tools) visit(t.inputSchema, t.name, "");
  return params;
}

function propAt(schema, path) {
  let node = schema;
  for (const part of path.split(".")) {
    if (!node) return undefined;
    node = part.endsWith("[]")
      ? node.properties?.[part.slice(0, -2)]?.items
      : node.properties?.[part];
  }
  return node;
}

// Harnesses prefix tool names, and some turn hyphens into underscores.
const PREFIX = /^(mcp__argent__|mcp_argent_|argent___|argent__|argent_|argent-|argent::)/;
const normalize = (name) => name.replace(PREFIX, "").replaceAll("_", "-");

/** The Argent tools in one request body: name -> { description, schema }. */
function argentToolsIn(body, known) {
  const found = new Map();
  // A tool without params may come with no schema at all (Gemini's format leaves it out).
  const add = (name, description, schema = {}) => {
    const n = typeof name === "string" ? normalize(name) : "";
    if (!known.has(n) || !schema || typeof schema !== "object") return;
    found.set(n, { description: typeof description === "string" ? description : "", schema });
  };
  const walk = (o) => {
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o.functionDeclarations)) {
      for (const d of o.functionDeclarations)
        add(d.name, d.description, d.parameters ?? d.parametersJsonSchema);
      return;
    }
    if (o.ToolSpecification) {
      const t = o.ToolSpecification;
      add(t.name, t.description, t.input_schema?.json);
      return;
    }
    if (o.function && typeof o.function.name === "string") {
      add(o.function.name, o.function.description, o.function.parameters);
      return;
    }
    const schema = o.parameters ?? o.input_schema ?? o.parametersJsonSchema ?? o.inputSchema;
    if (typeof o.name === "string" && schema && typeof schema === "object")
      add(o.name, o.description, schema);
    for (const v of Object.values(o)) walk(v);
  };
  walk(body);
  return found;
}

function stringsIn(body) {
  const out = [];
  const walk = (o) => {
    if (typeof o === "string") out.push(o);
    else if (o && typeof o === "object") Object.values(o).forEach(walk);
  };
  walk(body);
  return out;
}

/** Every request recorded for one run, oldest first. */
function loadRequests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, file), "utf8"));
        return [{ file: join(dir, file), body: j?.body ?? j, usage: j?.response?.usage ?? null }];
      } catch {
        return [];
      }
    });
}

// --- text detectors ---
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tok = (v) => `(?<![\\w.])${esc(typeof v === "string" ? v : JSON.stringify(v))}(?![\\w])`;
const num = (v) => `(?<![\\w.])${esc(v)}(\\.0+)?(?![\\w]|\\.\\d)`;
const RANGE = `\\s*(\\([^)]{0,20}\\)\\s*)?(–|—|-|to|\\.\\.)\\s*`;
const STATES = {
  default: (v) =>
    new RegExp(
      `default[^.;\\n]{0,30}?${tok(v)}|${tok(v)}[^.;\\n]{0,16}by default|${tok(v)}\\s*\\(default\\)`,
      "i"
    ),
  minimum: (v) =>
    new RegExp(`(min(imum)?|at least|range:?)[^.;\\n]{0,30}?${tok(v)}|${num(v)}${RANGE}-?\\d`, "i"),
  maximum: (v) =>
    new RegExp(`(max(imum)?|at most|up to)[^.;\\n]{0,30}?${num(v)}|\\d${RANGE}${num(v)}`, "i"),
  exclusiveMinimum: (v) =>
    new RegExp(
      `(greater than|more than|above|>)[^.;\\n]{0,10}?${tok(v)}${v === 0 ? "|positive" : ""}`,
      "i"
    ),
  exclusiveMaximum: (v) => new RegExp(`(less than|below|<)[^.;\\n]{0,10}?${tok(v)}`, "i"),
  minLength: (v) => new RegExp(`min(imum)? ?length[^.;\\n]{0,10}?${tok(v)}`, "i"),
  maxLength: (v) => new RegExp(`(max(imum)? ?length|at most)[^.;\\n]{0,10}?${tok(v)}`, "i"),
  minItems: (v) => new RegExp(`(min(imum)? ?items|at least)[^.;\\n]{0,10}?${tok(v)}`, "i"),
  maxItems: (v) => new RegExp(`(max(imum)? ?items|at most|up to)[^.;\\n]{0,10}?${tok(v)}`, "i"),
  const: (v) => new RegExp(tok(v), "i"),
};

// The sentences Argent's renderer can add, and nothing else.
const N = `-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?`;
const ADDED = new RegExp(
  [
    `Default: .+?\\.(?=\\s|$)`,
    `Range: ${N} to ${N}\\.`,
    `Minimum: ${N}\\.`,
    `Maximum: ${N}\\.`,
    `Must be greater than ${N}\\.`,
    `Must be less than ${N}\\.`,
    `(?:Min|Max) (?:length|items): \\d+\\.`,
    `Also accepts .+?\\.(?=\\s|$)`,
  ].join("|"),
  "g"
);

/** Splits a param description from the request into Argent's text, added sentences and harness text. */
function splitDescription(reference, seen) {
  const own = reference.trimEnd();
  if (seen === reference || seen === own) return { own: seen, added: [], harness: "", changed: "" };
  if (own && own.startsWith(seen))
    return {
      own: seen,
      added: [],
      harness: "",
      changed: `cut from ${own.length} to ${seen.length} chars`,
    };
  let rest;
  if (!own) rest = seen;
  else if (seen.startsWith(own)) rest = seen.slice(own.length);
  else if (seen.includes(own)) rest = seen.replace(own, "");
  else return { own: seen, added: [], harness: "", changed: "rewritten" };
  return { own, added: rest.match(ADDED) ?? [], harness: rest.replace(ADDED, ""), changed: "" };
}

/** What the model of one run can read of Argent's tools and instructions. */
export function analyzeRun(reference, requestsDir) {
  const known = new Set(reference.tools.map((t) => t.name));
  const refSchema = new Map(reference.tools.map((t) => [t.name, t.inputSchema]));
  const requests = loadRequests(requestsDir);
  if (requests.length === 0) return { recorded: 0 };

  // The request with the most Argent tools is the one to read; on a tie, the later one.
  let best = {
    file: requests[requests.length - 1].file,
    body: requests[requests.length - 1].body,
    usage: requests[requests.length - 1].usage,
    tools: new Map(),
  };
  for (const r of requests) {
    const tools = argentToolsIn(r.body, known);
    if (tools.size >= best.tools.size && tools.size > 0) best = { ...r, tools };
  }

  const facts = factsOf(reference.tools).filter((f) => best.tools.has(f.tool));
  const rows = facts.map((f) => {
    const prop = propAt(best.tools.get(f.tool).schema, f.path);
    const refProp = propAt(refSchema.get(f.tool), f.path);
    const nodes = prop ? [prop, ...(prop.anyOf ?? []), ...(prop.oneOf ?? [])] : [];
    const same = (n) =>
      JSON.stringify(n[f.key], sortedKeys) === JSON.stringify(f.value, sortedKeys);
    const keyword = nodes.some(
      (n) => same(n) || (f.key === "const" && (n.enum ?? []).includes(f.value))
    );
    const d = splitDescription(
      refProp?.description ?? "",
      typeof prop?.description === "string" ? prop.description : ""
    );
    const re = STATES[f.key](f.value);
    // A harness that renders keywords as text writes "{exclusiveMinimum: 0}", on the
    // param or on the union branch that holds the keyword.
    const rendered = new RegExp(`[{,]\\s*${f.key}: ${esc(JSON.stringify(f.value))}\\s*[,}]`);
    const refBranches = new Set(
      [...(refProp?.anyOf ?? []), ...(refProp?.oneOf ?? [])].map((n) => n.description)
    );
    const branchText = nodes
      .slice(1)
      .map((n) => n.description)
      .filter((t) => typeof t === "string" && !refBranches.has(t))
      .join("\n");
    const description = re.test(d.own);
    // "Default: \"latest\"." names a constant too, but states a different fact.
    const added = d.added.some(
      (s) => re.test(s) && (f.key !== "const" || s.startsWith("Also accepts"))
    );
    const harness = [d.harness, branchText].some((t) => re.test(t) || rendered.test(t));
    return {
      ...f,
      keyword,
      description,
      added,
      harness,
      places: keyword + description + added + harness,
    };
  });

  // Added text that is not one of Argent's fact sentences, or that states no keyword of its param.
  const unexpected = [];
  const changedByHarness = [];
  let paramsWithAddedText = 0;
  for (const { tool, path } of paramsOf(reference.tools)) {
    if (!best.tools.has(tool)) continue;
    const prop = propAt(best.tools.get(tool).schema, path);
    if (!prop) continue;
    const ref = propAt(refSchema.get(tool), path)?.description ?? "";
    const d = splitDescription(ref, typeof prop.description === "string" ? prop.description : "");
    if (d.changed) changedByHarness.push(`${tool}.${path}: ${d.changed}`);
    if (d.added.length) paramsWithAddedText++;
    const own = facts.filter((f) => f.tool === tool && f.path === path);
    for (const s of d.added) {
      if (!own.some((f) => STATES[f.key](f.value).test(s)))
        unexpected.push(`${tool}.${path}: "${s}" matches no keyword of this param`);
    }
    // Harness text may only be a keyword rendering such as "{minimum: 0, maximum: 1}".
    const leftover = d.harness.replace(/\s*\{[a-zA-Z]+: .*\}\s*$/s, "").replace(/[\s.]/g, "");
    if (leftover)
      unexpected.push(`${tool}.${path}: unexplained text "${d.harness.trim().slice(0, 80)}"`);
  }

  const flat = (s) => s.replace(/\s+/g, " ");
  const text = stringsIn(best.body).map(flat);
  const instr = flat(reference.instructions);
  const probes = instr ? [instr.slice(0, 60), instr.slice(-60)] : [];
  const hits = probes.filter((p) => text.some((t) => t.includes(p))).length;

  const fmt = (r) => `${r.tool}.${r.path} ${r.key}=${JSON.stringify(r.value)}`;
  return {
    recorded: requests.length,
    requestFile: best.file,
    // Only the Claude Code proxy records it: the input tokens Anthropic counted for this request.
    apiInputTokens: best.usage
      ? (best.usage.input_tokens ?? 0) +
        (best.usage.cache_creation_input_tokens ?? 0) +
        (best.usage.cache_read_input_tokens ?? 0)
      : null,
    toolsSeen: best.tools.size,
    toolsTotal: reference.tools.length,
    factsChecked: rows.length,
    lost: rows.filter((r) => r.places === 0).map(fmt),
    repeatedByArgent: rows.filter((r) => r.places >= 2 && r.added).map(fmt),
    repeatedInDescription: rows
      .filter((r) => r.places >= 2 && !r.added && r.description && r.keyword)
      .map(fmt),
    repeatedByHarness: rows.filter((r) => r.places >= 2 && !r.added && r.harness).map(fmt),
    paramsWithAddedText,
    unexpected,
    changedByHarness,
    instructions: hits === 2 ? "yes" : hits === 1 ? "partly" : "no",
    view: Object.fromEntries(best.tools),
  };
}

export function verdict(r) {
  if (r.failure) return `FAILED: ${r.failure}`;
  if (!r.toolsSeen) return "NO ARGENT TOOLS IN REQUEST";
  const problems = [];
  if (r.lost.length) problems.push(`LOSES ${r.lost.length}`);
  if (r.repeatedByArgent.length) problems.push(`REPEATS ${r.repeatedByArgent.length}`);
  if (r.unexpected.length) problems.push(`UNEXPECTED TEXT (${r.unexpected.length})`);
  return problems.length ? problems.join(", ") : "OK";
}

// --- comparing two checks ---
// Key order is not stable across runs in every harness (Kiro CLI shuffles it), so sort keys.
const sortedKeys = (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v;
const stripDescriptions = (schema) =>
  JSON.stringify(schema, (k, v) =>
    k === "description" && typeof v === "string" ? undefined : sortedKeys(k, v)
  );

function paramDescriptions(schema, prefix = "", out = new Map()) {
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    const path = `${prefix}${name}`;
    out.set(path, typeof prop.description === "string" ? prop.description : "");
    if (prop.properties) paramDescriptions(prop, `${path}.`, out);
    if (prop.items?.properties) paramDescriptions(prop.items, `${path}[].`, out);
  }
  return out;
}

/** What changed in what the model of one harness reads, between an earlier check and this one. */
export function compareRun(before, after) {
  const a = before.view ?? {};
  const b = after.view ?? {};
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = {
    skipped: "",
    toolsAdded: [],
    toolsRemoved: [],
    toolDescriptions: [],
    schemas: [],
    appended: [],
    otherText: [],
    instructions: "",
    tokensBefore: null,
    tokensAfter: null,
  };
  // A failed run has no view of the tools, and every tool would read as added or removed.
  const failed = [before.failure && "the earlier run failed", after.failure && "this run failed"];
  if (failed.some(Boolean)) {
    diff.skipped = failed.filter(Boolean).join(", ");
    return diff;
  }
  for (const name of names) {
    if (!a[name]) diff.toolsAdded.push(name);
    else if (!b[name]) diff.toolsRemoved.push(name);
    else {
      if (a[name].description !== b[name].description) diff.toolDescriptions.push(name);
      if (stripDescriptions(a[name].schema) !== stripDescriptions(b[name].schema))
        diff.schemas.push(name);
      const pa = paramDescriptions(a[name].schema);
      for (const [path, db] of paramDescriptions(b[name].schema)) {
        const da = pa.get(path);
        if (da === undefined || da === db) continue;
        if (db.startsWith(da.trimEnd()))
          diff.appended.push(`${name}.${path}: +"${db.slice(da.trimEnd().length).trim()}"`);
        else if (da.startsWith(db.trimEnd()))
          diff.otherText.push(
            `${name}.${path}: text removed at the end: "${da.slice(db.trimEnd().length).trim()}"`
          );
        else diff.otherText.push(`${name}.${path}: rewritten`);
      }
    }
  }
  diff.tokensBefore = before.apiInputTokens ?? null;
  diff.tokensAfter = after.apiInputTokens ?? null;
  diff.instructions =
    before.instructions === after.instructions
      ? `same (${after.instructions ?? "-"})`
      : `${before.instructions} -> ${after.instructions}`;
  return diff;
}

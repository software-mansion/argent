import fs from "fs/promises";
import path from "path";
import type { ToolDefinition } from "@argent/registry";
import { advertisedSchema } from "./catalog";

/**
 * Vocabulary for "this image is at the device's own resolution", in the
 * spellings the screenshot surfaces reach for. `screenshot-diff` captures live
 * input at full resolution only when the device streams it, and writes its diff
 * at whatever size the comparison ran at, so every one of these is a claim that
 * has to be checked against `captureLiveInput` and `writeDiffArtifacts`.
 *
 * A vocabulary, not a paraphrase detector: a claim that shares no token here
 * ("the diff keeps the capture's own dimensions") goes unseen.
 *
 * A range mention ("`scale` accepts values from 0.01 to 1.0") is not
 * a claim about a capture and does not match; the boundary before `scale` keeps
 * `grayscale = 1`, `upscale: 1` and `ARGENT_SCREENSHOT_SCALE` out. `original
 * resolution` is a claim only under `at`, because these docs also use it as the
 * denominator of a fraction — "30% of original resolution" asserts the opposite.
 *
 * `scale` written with a `:` or `=` is the parameter wherever it appears, so it
 * is read as a claim on its own — a description writing `scale = 1` is writing
 * about this parameter and nothing else.
 */
const CLAIMS_SIZE_PLAIN =
  /full[- ](?:resolution|res\b)|\bunscaled\b|\bpixel[- ]for[- ]pixel\b|\b(?:never|not|no)\s+(?:down)?(?:scaled|scaling|resampled|resampling|resized|resizing)\b|\boriginal\s+dimensions\b|100%\s*(?:of\s+)?(?:the\s+)?(?:original\s+|device\s+|native\s+)?(?:scale|resolution)|\bat\s+(?:the\s+|its\s+)?(?:original|device(?:'s)?)\s+(?:resolution|size|dimensions|scale)\b|["'`]?\bscale["'`]?\s*[:=]\s*1(?:\.0+)?\b/i;

/**
 * The same vocabulary in spellings that carry no subject of their own. `1:1`,
 * `full-size` and a prose `scale` beside a `1` all read as claims about an
 * image only when the sentence is about one: "a 1:1 mapping of remote presses to
 * key events", "opens the full-size dialog" and "rate it on a scale of 1 to 5"
 * assert nothing about a capture, and this sweep runs over all 77 tools, where
 * an unrelated tool's prose failing a screenshot check points the next author at
 * the wrong problem.
 */
const CLAIMS_SIZE_IN_CONTEXT =
  /full[- ]size|\b1:1\b|\b1(?:\.0+)?\s*x\b|\b1(?:\.0+)?\s+scale\b|\b(?:re)?scaled?\s+(?:of\s+|to\s+|at\s+)?1(?:\.0+)?\b/i;

/** What those spellings have to be about before they are a claim. */
const IMAGE_SUBJECT =
  /\b(?:screenshots?|captures?|captured|capturing|images?|pngs?|frames?|diffs?|diffing|baselines?|snapshots?|pixels?|resolutions?|screens?)\b/i;

/**
 * `at the device's native resolution` says the same thing as the rest of the
 * vocabulary, and is the natural way to write the falsehood on a capture
 * surface — but it is the true thing to say on a recording one, where
 * argent-screen-recording's h264 frames really are taken at it and no
 * `wrong data size` rejection is in reach.
 */
const CLAIMS_NATIVE = /\bat\s+(?:the\s+)?device(?:'s)?\s+native\s+(?:resolution|size)\b/i;
const ABOUT_A_RECORDING = /\brecord(?:s|ed|ing|ings)?\b|\bvideos?\b|\bh264\b|\bmp4\b|\bfps\b/i;

const claimsSize = (sentence: string): boolean => {
  if (CLAIMS_SIZE_PLAIN.test(sentence)) return true;
  if (CLAIMS_SIZE_IN_CONTEXT.test(sentence) && IMAGE_SUBJECT.test(sentence)) return true;
  return CLAIMS_NATIVE.test(sentence) && !ABOUT_A_RECORDING.test(sentence);
};

/**
 * Whitespace is not part of a claim: a wrap inside "full resolution" must not
 * hide it. Nor is the typography — a non-breaking hyphen in "full-resolution"
 * or a typographic apostrophe in "device's" reads the same to an agent and slips
 * an ASCII-only vocabulary. Only the in-word forms are folded; the em-dash these
 * surfaces use as a separator stays as written.
 */
const flatten = (text: string): string =>
  text
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The sentences of `text` that reach for that vocabulary. Pinning the whole
 * collection, rather than the presence of a corrected phrase, is what makes a
 * contradicting *addition* visible: it arrives as an extra element instead of
 * sitting beside the phrase a positive assertion already found.
 *
 * Split on a period followed by whitespace, which leaves decimals ("0.3 by
 * default") intact.
 */
export function sentencesClaimingSize(text: string): string[] {
  return flatten(text)
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => claimsSize(sentence));
}

/**
 * The same sweep over a rendered summary, which is line- rather than
 * sentence-shaped. Splitting first means a claim wrapped across two lines is
 * seen by neither, which is why prose is swept by sentence instead.
 */
export function linesClaimingSize(text: string): string[] {
  return text.split("\n").filter((line) => claimsSize(flatten(line)));
}

/**
 * Every `description` in a served JSON Schema, at any depth: array `items` and
 * nested object properties are advertised in `input_schema` the same as a
 * top-level parameter.
 */
function schemaDescriptions(node: unknown, path: string): Array<[string, string]> {
  if (!node || typeof node !== "object") return [];
  const schema = node as Record<string, unknown>;
  const here: Array<[string, string]> =
    path && typeof schema.description === "string" ? [[path, schema.description]] : [];
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const arms = ["anyOf", "oneOf", "allOf"].flatMap((key) =>
    Array.isArray(schema[key])
      ? (schema[key] as unknown[]).flatMap((arm, index) =>
          schemaDescriptions(arm, `${path}|${index}`)
        )
      : []
  );
  return [
    ...here,
    ...Object.entries(properties).flatMap(([name, child]) =>
      schemaDescriptions(child, path ? `${path}.${name}` : name)
    ),
    ...schemaDescriptions(schema.items, `${path}[]`),
    ...arms,
  ];
}

/**
 * The strings a tool puts in front of an agent: the description, the schema a
 * client is actually served, the search hint, and the progress messages. Read
 * through `advertisedSchema` rather than `zodSchema.shape`, because a
 * `.describe()` written before `.optional()` is dropped from the shape while
 * still being advertised — a description an agent reads and a sweep does not.
 *
 * The progress messages are read as source, so a formatter that returns a
 * constant declared elsewhere hands back only that identifier.
 */
export function agentFacingText(def: ToolDefinition<any, any>): Array<[string, string]> {
  const interaction = (def.interaction ?? {}) as Record<string, unknown>;
  return [
    ["description", def.description ?? ""],
    ["searchHint", def.searchHint ?? ""],
    ...Object.entries(interaction).map(([name, formatter]): [string, string] => [
      name,
      typeof formatter === "function" ? formatter.toString() : "",
    ]),
    ...schemaDescriptions(advertisedSchema(def), ""),
  ];
}

/**
 * A walked path as its callers read it: they split the name on `/` to tell the
 * three published directories apart, and `path.relative` hands back backslashes
 * on win32. Split on either separator rather than on `path.sep`, so the
 * conversion is exercised by the suite on every platform instead of only on the
 * one that needs it.
 */
export const toPosixName = (relative: string): string => relative.split(/[\\/]/).join("/");

/**
 * Every markdown file the `argent` package ships as agent-facing prose, so a
 * claim cannot hide in a `references/` page — nor in `rules/argent.md`, which is
 * loaded on every session rather than on demand.
 */
export async function readAgentDocs(): Promise<Array<{ name: string; text: string }>> {
  const root = path.join(__dirname, "../../../skills");
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return Promise.resolve(entry.name.endsWith(".md") ? [full] : []);
      })
    );
    return nested.flat();
  };
  // The three directories `packages/argent/package.json` publishes; `scripts/`
  // is build tooling and never reaches an agent.
  const files = (
    await Promise.all(["skills", "rules", "agents"].map((d) => walk(path.join(root, d))))
  ).flat();
  return Promise.all(
    files.map(async (file) => ({
      name: toPosixName(path.relative(root, file)),
      text: await fs.readFile(file, "utf8"),
    }))
  );
}

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getScreenshotScale } from "../src/utils/simulator-client";
import { readAgentDocs, sentencesClaimingSize } from "./helpers/size-claims";

let docs: Array<{ name: string; text: string }> = [];

/**
 * The size claims of one markdown region, swept a block at a time. Whole-text
 * flattening would run a sentence from the end of a code fence into the
 * paragraph after it, so a claim would inherit the `"scale": 1.0` of a JSON
 * example it merely sits below.
 */
const claimsIn = (text: string): string[] =>
  text.split(/\n\s*\n/).flatMap((block) => sentencesClaimingSize(block));

/** Split at markdown headings, so an escort three sections away cannot cover a claim. */
const sections = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (out.length === 0 || /^#{1,6}\s/.test(line)) out.push(line);
    else out[out.length - 1] += `\n${line}`;
  }
  return out;
};

beforeAll(async () => {
  docs = await readAgentDocs();
});

// `screenshot` has no fallback of its own — it hands the simulator-server
// whatever `scale` it was given, and simulator-client turns the emulator's
// in-band rejection into a hard SIMULATOR_SCREENSHOT_FAILED — so a page
// that sends an agent at a full-resolution capture without naming that failure
// sends it at a call it cannot recover from. The claim keeps being copied into
// new pages, so pin the pairing rather than any one file's wording — the error
// string is the source of truth. Per section, because a page that names the
// rejection once would otherwise be trusted for everything else it ever says;
// and by sentence, because the `agents/` pages hard-wrap and a claim split
// across two lines is in neither of them. An unrelated match is to be re-read,
// not narrowed away.
describe("agent docs reaching for a full-resolution screenshot", () => {
  it("finds some, so the checks below cannot pass vacuously", () => {
    expect(docs.flatMap(({ text }) => claimsIn(text))).not.toHaveLength(0);
  });

  it("never lets the escort cover a claim about the diff's own artifacts", () => {
    // The escort excuses a claim about capturing, because the `wrong data size`
    // rejection is what capturing at 1.0 runs into. It is no evidence at all
    // about the size of what the diff writes: `diffPath` comes back at the
    // compared size whenever the sides were normalized.
    //
    // Asked as "does this name a diff artifact", a closed set of identifiers,
    // rather than "is this about a capture", which no word list decides: every
    // spelling of the subject reads as a capture to one, `screenshot-diff` and
    // `screenshot diff` and "the diff frame" alike. The cost is the converse —
    // a claim that neither names an artifact nor spells one out goes unseen,
    // and only the escort stands under it.
    const misattributed = docs.flatMap(({ name, text }) =>
      claimsIn(text)
        .filter((claim) =>
          /\b(?:context)?diffPath\b|\bdiff (?:image|frame|output)s?\b/i.test(claim)
        )
        .map((claim) => `${name}: ${claim}`)
    );
    expect(misattributed).toEqual([]);
  });

  it("states every claim as a condition, never an absolute", () => {
    // The escort excuses a claim because the capture is conditional, so a claim
    // asserting it never fails contradicts the very sentence exempting it —
    // "always captures at full resolution" is both the most natural way to write
    // the falsehood and the one the escort cannot be evidence for.
    const absolute = docs.flatMap(({ name, text }) =>
      claimsIn(text)
        .filter((claim) => /\balways\b|\bwhatever\b|\bregardless\b|\bno matter\b/i.test(claim))
        .map((claim) => `${name}: ${claim}`)
    );
    expect(absolute).toEqual([]);
  });

  it("splits at headings, so a claim is escorted by its own section", () => {
    // The floor above counts docs while the check below counts sections, so a
    // splitter returning one whole-file section would exempt every claim in the
    // corpus with both still green.
    expect(sections("intro\n\n## A\n\nclaim\n\n## B\n\nother")).toEqual([
      "intro\n",
      "## A\n\nclaim\n",
      "## B\n\nother",
    ]);
  });

  it("every one of them names the emulators that reject it", () => {
    const unescorted = docs.flatMap(({ name, text }) =>
      sections(text)
        .filter((section) => !section.includes("wrong data size"))
        .flatMap((section) => claimsIn(section))
        .map((claim) => `${name}: ${claim}`)
    );
    expect(unescorted).toEqual([]);
  });

  it("names the way out wherever it names the rejection", () => {
    // Naming the rejection exempts every claim in the section, so what the page
    // says to do instead carries the whole weight — and the check above cannot
    // see it go. Strip the `ARGENT_SCREENSHOT_SCALE` 1.0 clause from all three
    // pages and the corpus stays green, which is the exact truncation these
    // guards were written after: omitting `scale` is only a way out while the
    // env var is below 1, and at 1.0 it re-sends the request that just failed.
    //
    // Per page, not per section: the same pages carry compressed prompt
    // templates that name the rejection in a line with no room for the remedy,
    // and it is the page an agent reads.
    const escorted = docs.filter(({ text }) => text.includes("wrong data size"));
    expect(escorted.map(({ name }) => name)).not.toHaveLength(0);
    expect(
      escorted
        .filter(({ text }) => !/ARGENT_SCREENSHOT_SCALE[^.]*\b1(?:\.0+)?\b/i.test(text))
        .map(({ name }) => name)
    ).toEqual([]);
  });

  it("reaches all three published directories", () => {
    // Narrowing the walk is otherwise invisible: rules/ and agents/ simply stop
    // being read.
    expect(new Set(docs.map(({ name }) => name.split("/")[0]))).toEqual(
      new Set(["skills", "rules", "agents"])
    );
  });
});

describe("agent docs quoting the tool-server's screenshot scale", () => {
  // Spelled as a percentage in prose ("30% of original resolution") rather than
  // as the 0.3 the tool descriptions quote, so it drifts out of reach of the
  // cross-surface check in screenshot-diff-tool.test.ts. Read by sentence over
  // flattened blocks, like the claims above and for the same reason: `agents/`
  // pages hard-wrap, and a figure wrapped between "50% of original" and
  // "resolution" is on neither line.
  const quotes = (text: string): string[] =>
    text
      .split(/\n\s*\n/)
      .flatMap((block) => block.replace(/\s+/g, " ").split(/(?<=\.)\s+/))
      .filter((sentence) => /of (?:the )?original resolution/i.test(sentence));
  const quoted = (): string => `${getScreenshotScale() * 100}% of original resolution`;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds some, so the per-file check below cannot pass vacuously", () => {
    expect(docs.filter(({ text }) => quotes(text).length > 0)).not.toHaveLength(0);
  });

  it("every such line quotes the scale getScreenshotScale falls back to, for named platforms", () => {
    // Markdown ships as a static file, so it can only ever quote the default —
    // read the ambient env instead and the assertion fails on correct prose for
    // every developer who exports the var these same docs tell them about.
    vi.stubEnv("ARGENT_SCREENSHOT_SCALE", "");
    const wrong: string[] = [];
    for (const { name, text } of docs) {
      // Every such line, not the first: a second one is where a stale figure
      // sits unread while the first keeps the check green.
      for (const line of quotes(text)) {
        if (!line.includes(quoted())) {
          wrong.push(`${name}: does not quote "${quoted()}" — ${line.trim()}`);
        }
        // …and it names a platform this is the default for. Chromium is not one
        // of them and so does not count, or the exception clause these lines
        // carry ("Chromium has no default downscale") satisfies the check on
        // behalf of the claim it is an exception to. Any of the other four: a
        // page about one device class is entitled to describe only that class.
        if (!/iOS|Android|Apple TV|Vega/.test(line)) {
          wrong.push(`${name}: names no platform this is the default for — ${line.trim()}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

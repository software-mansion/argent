import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeParamIssues } from "../src/registry";

// `describeParamIssues` renders a Zod failure as prose. The behaviors below are
// the ones flow-execute's flat schema cannot reach (nested paths, unrecognized
// keys, the value-never-leaked guarantee, the 24-key cap), so they are covered
// directly here rather than through a tool.

function issuesOf(schema: z.ZodTypeAny, value: unknown) {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("expected the parse to fail");
  return parsed.error;
}

describe("describeParamIssues", () => {
  it("names a NESTED missing field as missing, not as a type error", () => {
    const schema = z.object({ steps: z.array(z.object({ tool: z.string() })) });
    const value = { steps: [{}] };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`steps.0.tool` is required (string) and was not provided");
    expect(msg).not.toContain('"code"');
  });

  it("path-qualifies an unrecognized NESTED key (selector.id, not a bare id)", () => {
    // The hottest instance is flow YAML's `id` under a strict `selector` whose
    // schema wants `identifier`: a bare `id` would contradict the top-level
    // "You sent:" list printed one clause later.
    const schema = z.object({
      selector: z.object({ identifier: z.string().optional() }).strict(),
    });
    const value = { selector: { id: "x" } };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("unknown parameter `selector.id`");
  });

  it("names the keys sent but NEVER their values (a params object can carry a secret)", () => {
    const schema = z.object({ token: z.number() });
    const value = { token: "hunter2-SUPER-SECRET" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).not.toContain("hunter2-SUPER-SECRET");
    expect(msg).toContain("`token`"); // the key is named
  });

  it("does not leak a present-but-wrong ENUM value (invalid_value branch, secret-shaped value)", () => {
    // The enum branch renders "Invalid option: expected one of …" — the ALLOWED
    // options, which are schema-public. The rejected value the caller sent must
    // never appear, since it can carry a secret (a tenant id, a token).
    const schema = z.object({ mode: z.enum(["read", "write"]) });
    const value = { mode: "SECRET-TENANT-ID-abc123" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).not.toContain("SECRET-TENANT-ID-abc123");
    expect(msg).toContain("`mode`"); // the key is named
  });

  it("does not leak the VALUE of an unrecognized key (unrecognized_keys branch names the key only)", () => {
    // The unrecognized-keys branch is the one most likely to receive a caller's
    // stray secret under a misspelled key. It must name the KEY and never echo
    // the value beside it.
    const schema = z.object({ known: z.string().optional() }).strict();
    const value = { secret_key: "sk-live-DEADBEEF" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).not.toContain("sk-live-DEADBEEF");
    expect(msg).toContain("unknown parameter `secret_key`");
  });

  it("caps the 'You sent:' list at 24 keys and SIGNALS the cut with an ellipsis", () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) value[`k${i}`] = i; // 30 unknown keys, all stripped
    const schema = z.object({ needed: z.string() });
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`needed` is required");
    expect(msg).toContain("…"); // truncation is not silent
    expect(msg).not.toContain("`k29`"); // the 30th key is dropped
    // The cap is 24 and not merely "some number below 30": assert the last key
    // that survives and the first that does not, so a narrower cap — which
    // would drop the misspelling this list exists to surface — fails here.
    expect(msg).toContain("`k23`");
    expect(msg).not.toContain("`k24`");
  });

  it("prints all 24 keys with NO ellipsis when the list exactly fills the cap", () => {
    // The other side of the boundary. The ellipsis has to mean "keys were
    // dropped", so a list that fits must not carry one — otherwise a reader
    // who cannot find their key in the list cannot tell whether it was
    // stripped as unknown or merely cut off.
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 24; i++) value[`k${i}`] = i;
    const schema = z.object({ needed: z.string() });
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`k0`");
    expect(msg).toContain("`k23`");
    expect(msg).not.toContain(", ….");
  });

  it("adds the ellipsis as soon as ONE key is over the cap", () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) value[`k${i}`] = i;
    const schema = z.object({ needed: z.string() });
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`k23`");
    expect(msg).not.toContain("`k24`");
    expect(msg).toContain(", ….");
  });

  it("joins several bad parameters into one sentence each", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("`a` is required");
    expect(msg).toContain("`b` is required");
    expect(msg).toContain("; ");
  });

  it("names an OMITTED required enum as missing, not 'Invalid option' (implying a bad value was sent)", () => {
    // Zod emits `invalid_value` (not `invalid_type`) for a missing enum, so its
    // message is "Invalid option: expected one of ...", which reads as though a
    // wrong value was sent when the field was simply absent. The verdict must
    // come from the input (value undefined), not the message.
    const schema = z.object({ mode: z.enum(["a", "b"]) });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("`mode` is required and was not provided");
    expect(msg).not.toContain("Invalid option");
  });

  it("still reports a PRESENT-but-wrong enum value as an invalid option (not as missing)", () => {
    // The mirror case: a value WAS sent, it is just not allowed. This must not
    // be swept into the "is required" wording; the caller did supply the key.
    const schema = z.object({ mode: z.enum(["a", "b"]) });
    const value = { mode: "c" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`mode`");
    expect(msg).not.toContain("is required");
    expect(msg).toContain("You sent: `mode`");
  });

  it("treats a PRESENT null for a required field as a type error, not as missing", () => {
    // `null` is a value the caller chose to send; only `undefined` is absence.
    const schema = z.object({ name: z.string() });
    const value = { name: null };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).not.toContain("is required");
    expect(msg).toContain("`name`");
  });

  it("renders a missing top-level field with the caller's own keys, not raw JSON", () => {
    const schema = z.object({ name: z.string(), project_root: z.string() });
    const value = { name: "x" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`project_root` is required");
    expect(msg).toContain("You sent: `name`");
    expect(msg).not.toContain('"code":"invalid_type"');
  });

  it("names an OMITTED field named after a prototype member as missing, not a type error", () => {
    // A bare `params[key]` reads `Object.prototype.toString` (a function) for an
    // absent `toString` field, which is `!== undefined`, so the field would be
    // misreported as "expected string, received function". The value-at-path
    // lookup must be own-property only for the "is required" verdict to hold.
    const schema = z.object({ toString: z.string() });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("`toString` is required (string) and was not provided");
    expect(msg).not.toContain("received function");
  });

  it("enumerates a UNION's branches instead of Zod's bare 'Invalid input'", () => {
    // A union's own message carries nothing — the alternatives live in a nested
    // per-branch array. `tv-remote`'s `button` is this exact shape, and it is
    // the parameter a caller most often gets wrong, so losing the 16-value
    // enumeration would make this message worse than the JSON it replaced.
    const schema = z.object({
      button: z.union([
        z.enum(["up", "down", "select"]),
        z.array(z.enum(["up", "down", "select"])),
      ]),
    });
    const value = { button: "OK" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`button`");
    expect(msg).toContain('expected one of "up"|"down"|"select"');
    expect(msg).toContain("expected array");
    expect(msg).not.toBe("`button`: Invalid input. You sent: `button`.");
    expect(msg).not.toContain('"code"');
  });

  it("path-qualifies a union branch's own nested issue", () => {
    const schema = z.object({
      target: z.union([z.string(), z.object({ id: z.string() })]),
    });
    const value = { target: { id: 7 } };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("target.id:");
    expect(msg).toContain("expected string");
  });

  it("says a union branch's reason once when two branches fail identically", () => {
    const schema = z.object({ mode: z.union([z.enum(["a"]), z.enum(["a"])]) });
    const value = { mode: "z" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg.match(/expected "a"/g)?.length).toBe(1);
  });

  it("caps a union's enumerated branches at 12 and SIGNALS the cut", () => {
    // A union branch that is an ARRAY reports one issue per element, so the
    // branch-issue count follows the caller's input rather than the schema.
    // Both the enumeration and the work spent building it have to stop.
    const schema = z.object({
      button: z.union([z.enum(["up"]), z.array(z.enum(["up"]))]),
    });
    const value = { button: Array.from({ length: 40 }, (_, i) => `bad-${i}`) };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    // Each element's reason is distinct (zod qualifies it by index), so 41
    // alternatives are available — the scalar branch's own reason plus one per
    // element — and exactly 12 must be printed.
    expect(msg.match(/; or /g)?.length).toBe(12); // 12 alternatives + the "; or …"
    expect(msg).toContain("; or ….");
    expect(msg).toContain("button.0:");
    expect(msg).toContain("button.10:");
    expect(msg).not.toContain("button.11:");
  });

  it("does not truncate a union that fits, and adds no ellipsis to it", () => {
    // The boundary the cap above is measured against: 12 alternatives render in
    // full, so the ellipsis is evidence of a cut and never decoration.
    const schema = z.object({
      button: z.union([z.enum(["up"]), z.array(z.enum(["up"]))]),
    });
    const value = { button: Array.from({ length: 11 }, (_, i) => `bad-${i}`) };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("button.10:"); // the 12th and last alternative
    expect(msg).not.toContain("; or …");
    expect(msg.match(/; or /g)?.length).toBe(11); // 12 alternatives, 11 joiners
  });

  it("still reports an OMITTED union field as missing, not as a branch list", () => {
    const schema = z.object({ button: z.union([z.enum(["up"]), z.array(z.enum(["up"]))]) });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("`button` is required");
    expect(msg).not.toContain("; or ");
  });

  it("does not double the full stop of a custom message that already ends in one", () => {
    // A custom refinement's message survives verbatim and is author-written
    // prose, so it normally ends in a period — every cross-field rule in the
    // repo does. Existing assertions use `toContain`, which passes on "..".
    const schema = z
      .object({ deltaX: z.number().optional(), deltaY: z.number().optional() })
      .superRefine((_v, ctx) =>
        ctx.addIssue({ code: "custom", message: "Pass a non-zero deltaX and/or deltaY.", path: [] })
      );
    const msg = describeParamIssues(issuesOf(schema, { deltaY: 0 }), { deltaY: 0 });
    expect(msg).toContain("Pass a non-zero deltaX and/or deltaY. You sent: `deltaY`.");
    expect(msg).not.toContain("..");
  });

  it("keeps a message's own terminal punctuation when it is not a period", () => {
    const schema = z
      .object({ a: z.string().optional() })
      .superRefine((_v, ctx) => ctx.addIssue({ code: "custom", message: "Which one?", path: [] }));
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("Which one?.");
  });

  it("separates several parts without doubling any of their periods", () => {
    const schema = z.object({ a: z.string().optional() }).superRefine((_v, ctx) => {
      ctx.addIssue({ code: "custom", message: "First rule.", path: [] });
      ctx.addIssue({ code: "custom", message: "Second rule.", path: [] });
    });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("First rule; Second rule.");
    expect(msg).not.toContain("..");
  });

  it("path-qualifies a custom rule BOUND to a field, so the prose names its parameter", () => {
    // The live instance is `selector.text`'s visible-character rule, reached by
    // `await-ui-element` — which also declares `expectedText`, so bare prose
    // about "text" lands ambiguously between the two. "You sent:" only ever
    // carries top-level keys, so without the path the sub-key is named nowhere.
    const schema = z.object({
      selector: z.object({
        text: z.string().refine(() => false, { message: "text must contain a visible character" }),
      }),
    });
    const value = { selector: { text: "​" } };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`selector.text`: text must contain a visible character");
  });

  it("leaves a ROOT-anchored cross-field rule unqualified", () => {
    // The other half of the pair above. A rule spanning several fields has no
    // one field to name — a qualifier would point at whichever field the author
    // happened to anchor on, which is as likely as not the one the caller got
    // right — so the author's prose is the whole message.
    const schema = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .superRefine((_v, ctx) =>
        ctx.addIssue({ code: "custom", message: "Pass exactly one of a or b.", path: [] })
      );
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("Pass exactly one of a or b.");
    expect(msg).not.toContain("(root)");
    expect(msg).not.toMatch(/`[^`]*`: Pass exactly one/);
  });

  it("leaves a multi-sentence message's internal periods alone", () => {
    // Only the TERMINAL stop is ours to drop — flow-execute's no-source message
    // is two sentences and the first one's period must survive.
    const schema = z.object({ a: z.string().optional() }).superRefine((_v, ctx) =>
      ctx.addIssue({
        code: "custom",
        message: "Pass exactly one flow source. It resolves <project_root>/<name>.yaml.",
        path: [],
      })
    );
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("Pass exactly one flow source. It resolves <project_root>/<name>.yaml.");
    expect(msg).not.toContain("..");
  });
});

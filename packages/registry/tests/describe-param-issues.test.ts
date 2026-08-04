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

  it("caps the 'You sent:' list at 24 keys and SIGNALS the cut with an ellipsis", () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) value[`k${i}`] = i; // 30 unknown keys, all stripped
    const schema = z.object({ needed: z.string() });
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`needed` is required");
    expect(msg).toContain("…"); // truncation is not silent
    expect(msg).not.toContain("`k29`"); // the 30th key is dropped
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
});

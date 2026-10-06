import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeParamIssues } from "../src/registry";

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
    expect(msg).toContain("`token`");
  });

  it("does not leak a present-but-wrong ENUM value (invalid_value branch, secret-shaped value)", () => {
    const schema = z.object({ mode: z.enum(["read", "write"]) });
    const value = { mode: "SECRET-TENANT-ID-abc123" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).not.toContain("SECRET-TENANT-ID-abc123");
    expect(msg).toContain("`mode`");
  });

  it("does not leak the VALUE of an unrecognized key (unrecognized_keys branch names the key only)", () => {
    const schema = z.object({ known: z.string().optional() }).strict();
    const value = { secret_key: "sk-live-DEADBEEF" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).not.toContain("sk-live-DEADBEEF");
    expect(msg).toContain("unknown parameter `secret_key`");
  });

  it("caps the 'You sent:' list at 24 keys and SIGNALS the cut with an ellipsis", () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) value[`k${i}`] = i;
    const schema = z.object({ needed: z.string() });
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`needed` is required");
    expect(msg).toContain("…");
    expect(msg).not.toContain("`k29`");
    expect(msg).toContain("`k23`");
    expect(msg).not.toContain("`k24`");
  });

  it("prints all 24 keys with NO ellipsis when the list exactly fills the cap", () => {
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
    const schema = z.object({ mode: z.enum(["a", "b"]) });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("`mode` is required and was not provided");
    expect(msg).not.toContain("Invalid option");
  });

  it("still reports a PRESENT-but-wrong enum value as an invalid option (not as missing)", () => {
    const schema = z.object({ mode: z.enum(["a", "b"]) });
    const value = { mode: "c" };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg).toContain("`mode`");
    expect(msg).not.toContain("is required");
    expect(msg).toContain("You sent: `mode`");
  });

  it("treats a PRESENT null for a required field as a type error, not as missing", () => {
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
    const schema = z.object({ toString: z.string() });
    const msg = describeParamIssues(issuesOf(schema, {}), {});
    expect(msg).toContain("`toString` is required (string) and was not provided");
    expect(msg).not.toContain("received function");
  });

  it("enumerates a UNION's branches instead of Zod's bare 'Invalid input'", () => {
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

  it("renders a SCALAR union's branches with no dangling path prefix", () => {
    const schema = z.object({
      button: z.union([
        z.enum(["up", "down", "select"]),
        z.array(z.enum(["up", "down", "select"])),
      ]),
    });
    const value = { button: "OK" };
    expect(describeParamIssues(issuesOf(schema, value), value)).toBe(
      '`button`: Invalid option: expected one of "up"|"down"|"select"; ' +
        "or Invalid input: expected array, received string. You sent: `button`."
    );
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
    const schema = z.object({
      button: z.union([z.enum(["up"]), z.array(z.enum(["up"]))]),
    });
    const value = { button: Array.from({ length: 40 }, (_, i) => `bad-${i}`) };
    const msg = describeParamIssues(issuesOf(schema, value), value);
    expect(msg.match(/; or /g)?.length).toBe(12); // 11 joiners plus the "; or …"
    expect(msg).toContain("; or ….");
    expect(msg).toContain("button.0:");
    expect(msg).toContain("button.10:");
    expect(msg).not.toContain("button.11:");
  });

  it("does not truncate a union that fits, and adds no ellipsis to it", () => {
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

import { describe, it, expect } from "vitest";
import {
  findMissingRequired,
  describeServerValidationFailure,
  formatValidationError,
  missingFlagNames,
} from "../src/run-validation.js";
import type { JsonSchema } from "../src/flag-parser.js";

const gestureTapSchema: JsonSchema = {
  type: "object",
  properties: {
    udid: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    clickCount: { type: "integer" },
  },
  required: ["udid", "x", "y"],
};

const debuggerConnectSchema: JsonSchema = {
  type: "object",
  // `port` carries a default, so the schema generator leaves it out of `required`.
  properties: { port: { type: "number" }, device_id: { type: "string" } },
  required: ["device_id"],
};

const runSequenceSchema: JsonSchema = {
  type: "object",
  properties: {
    udid: { type: "string" },
    steps: { type: "array", items: { type: "object" } },
    tags: { type: "array", items: { type: "string" } },
    filter: { type: "object" },
    verbose: { type: "boolean" },
  },
  required: ["udid", "steps", "tags", "filter", "verbose"],
};

/** The shape the tool-server returns for a missing required string, verbatim from Zod. */
function missingIssue(field: string) {
  return {
    expected: "string",
    code: "invalid_type",
    path: [field],
    message: `Invalid input: expected string, received undefined`,
  };
}

describe("findMissingRequired", () => {
  it("lists every unsupplied required field in schema order", () => {
    expect(findMissingRequired({}, gestureTapSchema)).toEqual(["udid", "x", "y"]);
  });

  it("treats a supplied falsy value as supplied", () => {
    // `0` and `false` are legitimate values; a truthiness check would demand them again.
    expect(findMissingRequired({ udid: "X", x: 0, y: 0 }, gestureTapSchema)).toEqual([]);
    expect(
      findMissingRequired({ udid: "X", x: 0, y: 0, verbose: false }, gestureTapSchema)
    ).toEqual([]);
  });

  it("never asks for a field that carries a default", () => {
    expect(findMissingRequired({ device_id: "X" }, debuggerConnectSchema)).toEqual([]);
  });

  it("does not confuse an inherited property name with a supplied value", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { constructor: { type: "string" } },
      required: ["constructor"],
    };
    expect(findMissingRequired({}, schema)).toEqual(["constructor"]);
  });

  it("never asks for a retired key", () => {
    // `formatSchemaUsage` filters retired keys out of the usage block and the parser refuses every
    // spelling of one, so this reader must agree with them. A retirement declared without
    // `.optional()` lands in `required` and would be reported as `missing required flag --settle`
    // for a flag the help does not show and no input can supply.
    const schema: JsonSchema = {
      type: "object",
      properties: {
        udid: { type: "string" },
        settle: { not: {}, description: "Retired: renamed to `momentum`" },
      },
      required: ["udid", "settle"],
    };
    expect(findMissingRequired({}, schema)).toEqual(["udid"]);
    expect(findMissingRequired({ udid: "X" }, schema)).toEqual([]);
  });

  it("reports nothing when the schema requires nothing", () => {
    expect(findMissingRequired({}, { type: "object", properties: {} })).toEqual([]);
    expect(findMissingRequired({}, undefined)).toEqual([]);
  });
});

describe("formatValidationError", () => {
  const report = (missing: string[]) => ({ missing, invalid: [], rawIssues: null });

  it("names a single missing flag", () => {
    expect(formatValidationError(report(["device_id"]), debuggerConnectSchema)).toBe(
      "missing required flag --device_id"
    );
  });

  it("names several missing flags in schema order", () => {
    expect(formatValidationError(report(["y", "udid", "x"]), gestureTapSchema)).toBe(
      "missing required flags --udid, --x, --y"
    );
  });

  it("names a field that can only be passed as JSON by its -json flag", () => {
    expect(formatValidationError(report(["steps"]), runSequenceSchema)).toBe(
      "missing required flag --steps-json"
    );
    expect(formatValidationError(report(["filter"]), runSequenceSchema)).toBe(
      "missing required flag --filter-json"
    );
  });

  it("names an array of scalars and a boolean by their plain flag", () => {
    expect(formatValidationError(report(["tags"]), runSequenceSchema)).toBe(
      "missing required flag --tags"
    );
    expect(formatValidationError(report(["verbose"]), runSequenceSchema)).toBe(
      "missing required flag --verbose"
    );
  });

  it("attributes a rejected value to its flag", () => {
    const text = formatValidationError(
      { missing: [], invalid: [{ path: ["x"], message: "out of range" }], rawIssues: [] },
      gestureTapSchema
    );
    expect(text).toBe("--x out of range");
  });

  it("states a rule that spans the whole payload without inventing a flag", () => {
    // An object-level rule reports an empty path — there is no single field to blame.
    const text = formatValidationError(
      {
        missing: [],
        invalid: [{ path: [], message: "pass a non-zero deltaX or deltaY" }],
        rawIssues: [],
      },
      gestureTapSchema
    );
    expect(text).toBe("pass a non-zero deltaX or deltaY");
    expect(text).not.toContain("undefined");
  });

  it("points inside a nested value", () => {
    const text = formatValidationError(
      {
        missing: [],
        invalid: [{ path: ["steps", 0, "tool"], message: "expected a string" }],
        rawIssues: [],
      },
      runSequenceSchema
    );
    expect(text).toBe("--steps-json steps[0].tool expected a string");
  });

  it("reports missing and rejected fields together, missing first", () => {
    const text = formatValidationError(
      { missing: ["udid"], invalid: [{ path: ["x"], message: "out of range" }], rawIssues: [] },
      gestureTapSchema
    );
    expect(text.split("\n")[0]).toBe("missing required flag --udid");
    expect(text).toContain("--x out of range");
  });
});

describe("missingFlagNames", () => {
  it("renders flag names a caller can echo back", () => {
    expect(
      missingFlagNames(
        { missing: ["steps", "udid"], invalid: [], rawIssues: null },
        runSequenceSchema
      )
    ).toEqual(["--udid", "--steps-json"]);
  });
});

describe("describeServerValidationFailure", () => {
  const forGestureTap = (err: unknown, payload: Record<string, unknown> = {}) =>
    describeServerValidationFailure(err, payload, gestureTapSchema);

  it("recognises missing required fields the server rejected", () => {
    const err = new Error(
      JSON.stringify([missingIssue("udid"), missingIssue("x"), missingIssue("y")])
    );
    const report = forGestureTap(err);
    expect(report?.missing).toEqual(["udid", "x", "y"]);
    expect(report?.invalid).toEqual([]);
  });

  it("recognises a value the tool rejected", () => {
    const err = new Error(JSON.stringify([{ code: "too_big", path: ["x"], message: "too big" }]));
    const report = forGestureTap(err, { udid: "X", x: 99, y: 0.5 });
    expect(report?.missing).toEqual([]);
    expect(report?.invalid).toEqual([{ path: ["x"], message: "too big" }]);
  });

  it("recognises a rule that spans the whole payload", () => {
    // An object-level rule reports an empty path; it is still this tool rejecting this input.
    const err = new Error(
      JSON.stringify([{ code: "custom", path: [], message: "pass a non-zero delta" }])
    );
    const report = forGestureTap(err, { udid: "X", x: 0, y: 0 });
    expect(report).not.toBeNull();
    expect(report?.invalid).toEqual([{ path: [], message: "pass a non-zero delta" }]);
  });

  it("does not call an optional field a missing required flag", () => {
    // A rule can fire on a field the schema does not require. Reporting it as missing would
    // contradict the help block printed underneath, which marks no such field required.
    const err = new Error(
      JSON.stringify([
        { code: "custom", path: ["clickCount"], message: "condition requires clickCount" },
      ])
    );
    const report = forGestureTap(err, { udid: "X", x: 0.5, y: 0.5 });
    expect(report?.missing).toEqual([]);
    expect(report?.invalid).toEqual([
      { path: ["clickCount"], message: "condition requires clickCount" },
    ]);
  });

  it("does not call a retired key a missing required flag", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        udid: { type: "string" },
        settle: { not: {}, description: "Retired: renamed to `momentum`" },
      },
      required: ["udid", "settle"],
    };
    const message = "Invalid input: expected never, received undefined";
    const err = new Error(JSON.stringify([{ code: "invalid_type", path: ["settle"], message }]));
    const report = describeServerValidationFailure(err, { udid: "X" }, schema);
    expect(report?.missing).toEqual([]);
    expect(report?.invalid).toEqual([{ path: ["settle"], message }]);
  });

  it("treats an explicitly supplied null as rejected, not missing", () => {
    const err = new Error(
      JSON.stringify([
        { code: "invalid_type", path: ["udid"], message: "expected string, received null" },
      ])
    );
    const report = forGestureTap(err, { udid: null, x: 0.5, y: 0.5 });
    expect(report?.missing).toEqual([]);
    expect(report?.invalid).toHaveLength(1);
  });

  it("orders missing fields by the schema, whatever order the server reported them", () => {
    const err = new Error(
      JSON.stringify([missingIssue("y"), missingIssue("udid"), missingIssue("x")])
    );
    expect(forGestureTap(err)?.missing).toEqual(["udid", "x", "y"]);
  });

  it("keeps the raw issue list for programmatic callers", () => {
    const issues = [missingIssue("udid")];
    expect(forGestureTap(new Error(JSON.stringify(issues)))?.rawIssues).toEqual(issues);
  });

  describe("reads the issue list the live server sends beside its prose", () => {
    const withIssues = (issues: unknown[], message = "`x`: Too big. You sent: `udid`, `x`, `y`.") =>
      Object.assign(new Error(message), { issues });

    it("maps a rejected value back to its field", () => {
      const report = forGestureTap(
        withIssues([{ code: "too_big", path: ["x"], message: "Too big: expected <=1" }]),
        { udid: "X", x: 99, y: 0.5 }
      );
      expect(report?.invalid).toEqual([{ path: ["x"], message: "Too big: expected <=1" }]);
      expect(formatValidationError(report!, gestureTapSchema)).toBe("--x Too big: expected <=1");
    });

    it("recognises missing required fields", () => {
      const report = forGestureTap(withIssues([missingIssue("udid"), missingIssue("x")]));
      expect(report?.missing).toEqual(["udid", "x"]);
    });

    it("prefers the structured field over a message that is not JSON at all", () => {
      const report = forGestureTap(
        withIssues([missingIssue("udid")], "Pass a non-zero deltaX and/or deltaY.")
      );
      expect(report).not.toBeNull();
      expect(report?.missing).toEqual(["udid"]);
    });

    it.each([
      ["an empty list", []],
      ["a list of non-issues", [{ a: 1 }]],
    ])("still refuses %s, whichever channel carried it", (_label, issues) => {
      expect(forGestureTap(withIssues(issues, "Simulator not booted"))).toBeNull();
    });
  });

  describe("leaves anything that is not this tool's input validation alone", () => {
    it.each([
      ["an ordinary runtime error", new Error("Simulator not booted")],
      ["a JSON object", new Error('{"error":"nope"}')],
      ["an empty array", new Error("[]")],
      ["an array of non-issues", new Error('[{"a":1}]')],
      ["an array of strings", new Error('["nope"]')],
      ["a non-Error rejection", { weird: true }],
    ])("%s", (_label, err) => {
      expect(forGestureTap(err)).toBeNull();
    });

    it("a validation error about something other than this tool's input", () => {
      // A tool that validates a device's response and lets that error escape names fields that
      // are not flags of this tool; dressing it up as user error would be a lie.
      const err = new Error(
        JSON.stringify([
          { code: "invalid_type", path: ["batteryLevel"], message: "expected number" },
        ])
      );
      expect(forGestureTap(err)).toBeNull();
    });

    it("a mixed list where only some issues address this tool", () => {
      const err = new Error(
        JSON.stringify([missingIssue("udid"), { code: "custom", path: ["nope"], message: "x" }])
      );
      expect(forGestureTap(err)).toBeNull();
    });
  });
});

describe("the two ways an invocation is rejected read identically", () => {
  it("renders the same message whether detected locally or reported by the server", () => {
    const local = {
      missing: findMissingRequired({}, gestureTapSchema),
      invalid: [],
      rawIssues: null,
    };
    // Deliberately shuffled: the renderer, not the server, decides the order.
    const server = describeServerValidationFailure(
      new Error(JSON.stringify([missingIssue("y"), missingIssue("udid"), missingIssue("x")])),
      {},
      gestureTapSchema
    );

    expect(server).not.toBeNull();
    expect(formatValidationError(server!, gestureTapSchema)).toBe(
      formatValidationError(local, gestureTapSchema)
    );
    expect(formatValidationError(local, gestureTapSchema)).toBe(
      "missing required flags --udid, --x, --y"
    );
  });
});

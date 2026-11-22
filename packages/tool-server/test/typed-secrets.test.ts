import { beforeEach, describe, expect, it } from "vitest";
import type { DescribeNode, DescribeTreeData } from "../src/tools/describe/contract";
import { nodeText } from "../src/utils/ui-tree-match";
import {
  __resetTypedSecretsForTesting,
  noteTypedSecrets,
  quotedText,
  redactTypedSecrets,
  secretTypedOn,
  WITHHELD_INPUT_TEXT,
} from "../src/utils/typed-secrets";

const DEVICE = "00000000-0000-0000-0000-0000000000AB";
const TOKEN = { name: "TOKEN", value: "tok-REVIEW-4242" };

beforeEach(() => {
  __resetTypedSecretsForTesting();
});

describe("redactTypedSecrets", () => {
  it("returns text as it is for a device that no secret was typed on", () => {
    noteTypedSecrets("other-device", [TOKEN]);

    expect(secretTypedOn(DEVICE)).toBe(false);
    expect(redactTypedSecrets(DEVICE, `Token ${TOKEN.value}`)).toBe(`Token ${TOKEN.value}`);
  });

  it("puts the placeholder in place of a value, for a device id in either case", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);

    expect(secretTypedOn(DEVICE.toLowerCase())).toBe(true);
    expect(redactTypedSecrets(DEVICE.toLowerCase(), "Token tok-REVIEW-4242 saved")).toBe(
      "Token {{secret:TOKEN}} saved"
    );
    expect(redactTypedSecrets(DEVICE, "nothing here")).toBe("nothing here");
    expect(redactTypedSecrets(DEVICE, "")).toBe("");
  });

  it("finds a value only as it was typed, letter for letter", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);

    // What a field made of the value is not looked for: see WITHHELD_INPUT_TEXT.
    for (const shown of ["Tok-REVIEW-4242", "TOK-REVIEW-4242", "tok-REVIEW-4243"]) {
      expect(redactTypedSecrets(DEVICE, shown)).toBe(shown);
    }
  });

  it("leaves every other character where it was, whatever its lowercase form", () => {
    noteTypedSecrets(DEVICE, [TOKEN, { name: "GREEK", value: "Σ-κλειδί-İ9" }]);

    expect(redactTypedSecrets(DEVICE, "İsim tok-REVIEW-4242 ΟΔΌΣ 😀")).toBe(
      "İsim {{secret:TOKEN}} ΟΔΌΣ 😀"
    );
    expect(redactTypedSecrets(DEVICE, "İ Σ-κλειδί-İ9 ς")).toBe("İ {{secret:GREEK}} ς");
  });

  it("keeps both values of a name that resolved to a second one", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);
    noteTypedSecrets(DEVICE, [{ name: "TOKEN", value: "second-VALUE-99" }]);

    expect(redactTypedSecrets(DEVICE, "tok-REVIEW-4242 / second-VALUE-99")).toBe(
      "{{secret:TOKEN}} / {{secret:TOKEN}}"
    );
  });

  it("takes the longest value at a position, and never searches a placeholder it wrote", () => {
    // One value inside another, and one that is in every placeholder.
    noteTypedSecrets(DEVICE, [
      { name: "HOST", value: "api.example.com" },
      { name: "URL", value: "https://api.example.com/v1" },
      { name: "WORD", value: "secret" },
    ]);

    expect(redactTypedSecrets(DEVICE, "at https://api.example.com/v1 (api.example.com)")).toBe(
      "at {{secret:URL}} ({{secret:HOST}})"
    );
    expect(redactTypedSecrets(DEVICE, "a secret")).toBe("a {{secret:WORD}}");
    // Two values that start alike: the short one would leave the rest of the long one.
    noteTypedSecrets(DEVICE, [
      { name: "PREFIX", value: "sk-" },
      { name: "KEY", value: "sk-live-9d3f" },
    ]);
    expect(redactTypedSecrets(DEVICE, "key sk-live-9d3f, prefix sk-")).toBe(
      "key {{secret:KEY}}, prefix {{secret:PREFIX}}"
    );
  });

  it("notes nothing for a call that typed no secret, and ignores an empty value", () => {
    noteTypedSecrets(DEVICE, []);
    expect(secretTypedOn(DEVICE)).toBe(false);

    noteTypedSecrets(DEVICE, [{ name: "EMPTY", value: "" }]);
    expect(redactTypedSecrets(DEVICE, "boom")).toBe("boom");
  });

  it("forgets the oldest value past its limit, and never that a secret was typed", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);
    for (let i = 0; i < 256; i++) {
      noteTypedSecrets(DEVICE, [{ name: `N${i}`, value: `value-${i}-x` }]);
    }

    expect(redactTypedSecrets(DEVICE, TOKEN.value)).toBe(TOKEN.value);
    expect(redactTypedSecrets(DEVICE, "value-255-x")).toBe("{{secret:N255}}");
    expect(secretTypedOn(DEVICE)).toBe(true);
  });
});

// The runner's one quote of the screen. The iOS simulator tree comes with a
// projection to quote from (flow-ios-tree.test.ts); every other tree is quoted
// as it was read, with the values named.
describe("quotedText", () => {
  const field: DescribeNode = {
    role: "EditText",
    identifier: "token",
    label: "Token",
    value: "tok-REVIEW-4242",
    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
    children: [],
  };
  const screen = (...children: DescribeNode[]): DescribeNode => ({
    role: "Screen",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });

  it("names a typed value in a tree without a projection, and withholds nothing there", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);
    const corrected = { ...field, value: "Too-REVIEW-4242" };
    const data: DescribeTreeData = { tree: screen(field, corrected), source: "android-devtools" };

    expect(quotedText(data, DEVICE, field, nodeText)).toBe("Token {{secret:TOKEN}}");
    expect(quotedText(data, DEVICE, corrected, nodeText)).toBe("Token Too-REVIEW-4242");
  });

  it("reads the node at the same place in the projection, and nothing from the tree itself", () => {
    const other = { ...field, identifier: "other", value: "linda" };
    const quotable = screen(
      { ...other, value: "projected other" },
      { ...field, value: "projected" }
    );
    const data: DescribeTreeData = {
      tree: screen(other, field),
      quotableTree: quotable,
      source: "native-devtools",
    };

    expect(quotedText(data, DEVICE, field, nodeText)).toBe("Token projected");
    expect(quotedText(data, DEVICE, other, nodeText)).toBe("Token projected other");
  });

  it("quotes only the note for a node the projection has no place for", () => {
    const data: DescribeTreeData = {
      tree: screen(field),
      quotableTree: screen(),
      source: "native-devtools",
    };

    expect(quotedText(data, DEVICE, field, nodeText)).toBe(WITHHELD_INPUT_TEXT);
    expect(quotedText(data, DEVICE, { ...field }, nodeText)).toBe(WITHHELD_INPUT_TEXT);
  });
});

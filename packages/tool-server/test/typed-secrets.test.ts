import { beforeEach, describe, expect, it } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import {
  __resetTypedSecretsForTesting,
  forgetSecretFields,
  noteSecretField,
  noteShownSecret,
  noteTypedSecrets,
  redactTypedSecrets,
} from "../src/utils/typed-secrets";

const DEVICE = "00000000-0000-0000-0000-0000000000AB";
const TOKEN = { name: "TOKEN", value: "tok-REVIEW-4242" };
const WITHHELD = "[withheld: a step typed {{secret:TOKEN}} into this field]";

function field(identifier: string, texts: { label?: string; value?: string }): DescribeNode {
  return {
    role: "AXTextField",
    identifier,
    frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
    children: [],
    ...texts,
  };
}

function screen(...children: DescribeNode[]): DescribeNode {
  return { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
}

beforeEach(() => {
  __resetTypedSecretsForTesting();
});

describe("redactTypedSecrets", () => {
  it("returns text as it is for a device that no secret was typed on", () => {
    noteTypedSecrets("other-device", [TOKEN]);

    expect(redactTypedSecrets(DEVICE, `Token ${TOKEN.value}`)).toBe(`Token ${TOKEN.value}`);
  });

  it("puts the placeholder in place of a value, whatever its case and the case of the device id", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);

    expect(redactTypedSecrets(DEVICE.toLowerCase(), "Token TOK-review-4242 saved")).toBe(
      "Token {{secret:TOKEN}} saved"
    );
    expect(redactTypedSecrets(DEVICE, "nothing here")).toBe("nothing here");
    expect(redactTypedSecrets(DEVICE, "")).toBe("");
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
  });

  it("ignores an empty value", () => {
    noteTypedSecrets(DEVICE, [{ name: "EMPTY", value: "" }]);

    expect(redactTypedSecrets(DEVICE, "boom")).toBe("boom");
  });

  it("puts the step's text in place of the text a field showed for it", () => {
    noteShownSecret(DEVICE, "Too-REVIEW-4242@example.com", "{{secret:TOKEN}}@example.com");
    noteShownSecret(DEVICE, "   ", "{{secret:TOKEN}}");

    expect(redactTypedSecrets(DEVICE, "Email too-review-4242@example.com")).toBe(
      "Email {{secret:TOKEN}}@example.com"
    );
    expect(redactTypedSecrets(DEVICE, "a   b")).toBe("a   b");
  });

  it("forgets the oldest value once a device has more than it keeps", () => {
    noteTypedSecrets(DEVICE, [TOKEN]);
    for (let i = 0; i < 256; i++)
      noteTypedSecrets(DEVICE, [{ name: `N${i}`, value: `value-${i}-x` }]);

    expect(redactTypedSecrets(DEVICE, TOKEN.value)).toBe(TOKEN.value);
    expect(redactTypedSecrets(DEVICE, "value-255-x")).toBe("{{secret:N255}}");
  });
});

describe("the text of a field that took a secret", () => {
  // An empty iOS field: its accessibility label, and its placeholder as its value.
  const before = { label: "Token", value: "Search" };

  beforeEach(() => {
    noteTypedSecrets(DEVICE, [TOKEN]);
    noteSecretField(DEVICE, "token", { before, typed: "{{secret:TOKEN}}" });
  });

  it("is withheld when it is no known form of the secret", () => {
    const tree = screen(field("token", { label: "Token", value: "Too-REVIEW-4243" }));

    // In the field's own text, and in the text of a view around it.
    expect(redactTypedSecrets(DEVICE, "Token Too-REVIEW-4243", tree)).toBe(`Token ${WITHHELD}`);
    expect(redactTypedSecrets(DEVICE, "Form Token Too-REVIEW-4243 Save", tree)).toBe(
      `Form Token ${WITHHELD} Save`
    );
    // Not without the tree it was read from: nothing says which text is the field's.
    expect(redactTypedSecrets(DEVICE, "Token Too-REVIEW-4243")).toBe("Token Too-REVIEW-4243");
  });

  it("is withheld whole when a known form is only part of it", () => {
    const tree = screen(field("token", { value: "tok-REVIEW-4242-and-more" }));

    expect(redactTypedSecrets(DEVICE, "tok-REVIEW-4242-and-more", tree)).toBe(WITHHELD);
  });

  it("shows the placeholder when it is a known form", () => {
    const tree = screen(field("token", { value: "TOK-REVIEW-4242" }));

    expect(redactTypedSecrets(DEVICE, "TOK-REVIEW-4242", tree)).toBe("{{secret:TOKEN}}");
  });

  it("is quoted when it is what the field held before the secret", () => {
    const tree = screen(field("token", { label: "Token", value: "Search" }));

    expect(redactTypedSecrets(DEVICE, "Token Search", tree)).toBe("Token Search");
  });

  it("is withheld from the label too, where a field's text is its label", () => {
    // An Android EditText without a content description.
    noteSecretField(DEVICE, "android", { before: { label: "Hint" }, typed: "{{secret:TOKEN}}" });
    const tree = screen(field("android", { label: "Too-REVIEW-4243" }));

    expect(redactTypedSecrets(DEVICE, "Too-REVIEW-4243", tree)).toBe(WITHHELD);
    expect(redactTypedSecrets(DEVICE, "Hint", screen(field("android", { label: "Hint" })))).toBe(
      "Hint"
    );
  });

  it("is quoted for a field with a different identifier", () => {
    const tree = screen(field("other", { value: "Too-REVIEW-4243" }));

    expect(redactTypedSecrets(DEVICE, "Too-REVIEW-4243", tree)).toBe("Too-REVIEW-4243");
  });

  it("keeps the first note of a field, whose earlier text is not a secret", () => {
    // A second secret step finds the first one's text in the field.
    noteSecretField(DEVICE, "token", {
      before: { value: "Too-REVIEW-4243" },
      typed: "{{secret:OTHER}}",
    });
    const tree = screen(field("token", { value: "Too-REVIEW-4243" }));

    expect(redactTypedSecrets(DEVICE, "Too-REVIEW-4243", tree)).toBe(WITHHELD);
  });

  it("is quoted again once the fields of the device are forgotten, and a value is not", () => {
    forgetSecretFields(DEVICE);
    const tree = screen(field("token", { value: "linda" }), field("b", { value: TOKEN.value }));

    expect(redactTypedSecrets(DEVICE, "linda", tree)).toBe("linda");
    expect(redactTypedSecrets(DEVICE, TOKEN.value, tree)).toBe("{{secret:TOKEN}}");
  });
});

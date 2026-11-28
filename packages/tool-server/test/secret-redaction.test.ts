import { describe, expect, it } from "vitest";
import { redactSecrets, secretRedactor } from "../src/utils/secrets";

const T = { name: "T", value: "abcdef123456" };
const HOST = { name: "HOST", value: "api.example.com" };
const URL_SECRET = { name: "URL", value: "https://api.example.com/v1/key" };

const cases: Array<{
  title: string;
  text: string;
  secrets: Array<{ name: string; value: string }>;
  expected: string;
}> = [
  {
    title: "a whole value",
    text: "token=abcdef123456 end",
    secrets: [T],
    expected: "token={{secret:T}} end",
  },
  {
    title: "every occurrence",
    text: "abcdef123456,abcdef123456",
    secrets: [T],
    expected: "{{secret:T}},{{secret:T}}",
  },
  {
    title: "a value split across lines",
    text: "abcdef\n123456",
    secrets: [T],
    expected: "{{secret:T}}\n{{secret:T}}",
  },
  {
    title: "a truncated prefix of six",
    text: "key: abcdef…",
    secrets: [T],
    expected: "key: {{secret:T}}…",
  },
  {
    title: "not a fragment shorter than six",
    text: "key: abcde… 23456",
    secrets: [T],
    expected: "key: abcde… 23456",
  },
  {
    title: "a short secret, whole",
    text: "pin pin42!",
    secrets: [{ name: "S", value: "pin42" }],
    expected: "pin {{secret:S}}!",
  },
  {
    title: "not part of a short secret",
    text: "pin4 in42",
    secrets: [{ name: "S", value: "pin42" }],
    expected: "pin4 in42",
  },
  {
    title: "the URL-encoded spelling",
    text: "GET /?q=p%40ss%20word%2F1&x=1",
    secrets: [{ name: "P", value: "p@ss word/1" }],
    expected: "GET /?q={{secret:P}}&x=1",
  },
  {
    title: "the JSON-escaped spelling",
    text: String.raw`{"v":"a\"b\\c\nline"}`,
    secrets: [{ name: "J", value: 'a"b\\c\nline' }],
    expected: '{"v":"{{secret:J}}"}',
  },
  {
    title: "the longer of two nested secrets",
    text: "GET https://api.example.com/v1/key now",
    secrets: [HOST, URL_SECRET],
    expected: "GET {{secret:URL}} now",
  },
  {
    title: "the same, in the other order",
    text: "GET https://api.example.com/v1/key now",
    secrets: [URL_SECRET, HOST],
    expected: "GET {{secret:URL}} now",
  },
  {
    title: "two adjacent secrets as two markers",
    text: "aaaaaaaa1bbbbbbbb2",
    secrets: [
      { name: "A", value: "aaaaaaaa1" },
      { name: "B", value: "bbbbbbbb2" },
    ],
    expected: "{{secret:A}}{{secret:B}}",
  },
  {
    title: "nothing for an empty value",
    text: "abc",
    secrets: [{ name: "E", value: "" }],
    expected: "abc",
  },
  {
    title: "a unicode value and its prefix",
    text: "x zażółć-gęślą y zażółć",
    secrets: [{ name: "U", value: "zażółć-gęślą" }],
    expected: "x {{secret:U}} y {{secret:U}}",
  },
  {
    title: "a value with a lone surrogate",
    text: "id=\ud800abcdef",
    secrets: [{ name: "L", value: "\ud800abcdef" }],
    expected: "id={{secret:L}}",
  },
];

describe("redactSecrets", () => {
  it.each(cases)("redacts $title", ({ text, secrets, expected }) => {
    expect(redactSecrets(text, secrets)).toBe(expected);
  });
});

describe("secretRedactor with a cut", () => {
  const redact = secretRedactor([T]);

  it("redacts a short piece of a secret at the end of a cut text", () => {
    expect(redact("log abcd", { cut: true })).toBe("log {{secret:T}}");
  });

  it("leaves the same ending alone when the text was not cut", () => {
    expect(redact("log abcd")).toBe("log abcd");
  });
});

it("redacts a whole character where a fragment ends inside a surrogate pair", () => {
  // Same low surrogate as the secret's emoji, different high one.
  const out = redactSecrets("\u{10600}abcdefg", [{ name: "S", value: "\u{1F600}abcdefg" }]);
  expect(out).toBe("{{secret:S}}");
});

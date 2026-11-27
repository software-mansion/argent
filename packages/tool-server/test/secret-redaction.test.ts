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

describe("secretRedactor for network data (wholeValues)", () => {
  const PASSWORD = { name: "PASSWORD", value: 'p w&d="1"/x' };
  const PIN = { name: "PIN", value: "4821" };
  const redact = secretRedactor([PASSWORD, PIN], { wholeValues: true });

  it.each([
    ["JSON.stringify", JSON.stringify({ password: PASSWORD.value })],
    ["a slash written \\/", '{"password":"p w&d=\\"1\\"\\/x"}'],
    ["Gson's HTML-safe escapes", '{"password":"p w\\u0026d\\u003d\\"1\\"/x"}'],
    ["a URLSearchParams form body", new URLSearchParams({ password: PASSWORD.value }).toString()],
    ["encodeURIComponent", `password=${encodeURIComponent(PASSWORD.value)}`],
  ])("finds the whole value in %s", (_title, text) => {
    const out = redact(text);
    expect(out).toContain("{{secret:PASSWORD}}");
    expect(out).not.toMatch(/p w|p%20w|p\+w/);
  });

  it.each([
    // Gson escapes `&` and leaves `ä` as it is; Python's json does the reverse.
    ["Gson", '{"p":"p\u00e4\\u0026ss1234"}'],
    ["Python's json", '{"p": "p\\u00e4&ss1234"}'],
  ])("finds a value with a non-ASCII character and an `&` as %s writes it", (_title, text) => {
    const own = secretRedactor([{ name: "PW", value: "p\u00e4&ss1234" }], { wholeValues: true });
    expect(own(text)).toMatch(/^\{"p": ?"\{\{secret:PW\}\}"\}$/);
  });

  it.each(["p@ss word", "Za\u017c\u00f3\u0142\u0107:1", "ab|cd e9", "pa ss'wd{^}"])(
    "finds %j left unencoded in a URL, as a URL parser writes it",
    (value) => {
      const own = secretRedactor([{ name: "PW", value }], { wholeValues: true });
      expect(own(new URL(`https://h.test/x?pw=${value}`).href)).toBe(
        "https://h.test/x?pw={{secret:PW}}"
      );
      expect(own(new URL(`https://h.test/u/${value}`).pathname)).toBe("/u/{{secret:PW}}");
    }
  );

  it("finds no fragment, so a password that holds a common word leaves keys alone", () => {
    const own = secretRedactor([{ name: "P", value: "password1" }], { wholeValues: true });
    expect(own('{"password":"x","passwords":2}')).toBe('{"password":"x","passwords":2}');
    expect(own('{"password":"password1"}')).toBe('{"password":"{{secret:P}}"}');
  });

  it("finds a short value only where it stands alone, also after an escape", () => {
    expect(redact('{"pin":"4821","count":14821,"code":"x4821","n":48210}')).toBe(
      '{"pin":"{{secret:PIN}}","count":14821,"code":"x4821","n":48210}'
    );
    expect(redact('{"note":"code\\n4821"}')).toBe('{"note":"code\\n{{secret:PIN}}"}');
    expect(redact("q=a%204821&pin=4821")).toBe("q=a%20{{secret:PIN}}&pin={{secret:PIN}}");
  });

  it("leaves a marker already in the text as it is", () => {
    const named = secretRedactor([{ name: "S", value: "PIN" }], { wholeValues: true });
    expect(named("{{secret:PIN}} and PIN")).toBe("{{secret:PIN}} and {{secret:S}}");
  });

  it("at a cut, redacts the start of a value that ends the text", () => {
    const token = secretRedactor([{ name: "T", value: "hunter2-SECRET-value" }], {
      wholeValues: true,
    });
    expect(token('{"password":"hunter2-SE', { cut: true })).toBe('{"password":"{{secret:T}}');
    expect(token('{"password":"hu', { cut: true })).toBe('{"password":"{{secret:T}}');
    // A start shorter than six after a letter or a digit is too likely to be chance.
    expect(token('{"name":"Ahu', { cut: true })).toBe('{"name":"Ahu');
    expect(token('{"password":"hu')).toBe('{"password":"hu');
  });

  it("at a cut, redacts the start of a short value only where it stands alone", () => {
    expect(redact('{"pin":"48', { cut: true })).toBe('{"pin":"{{secret:PIN}}');
    expect(redact('{"count":148', { cut: true })).toBe('{"count":148');
  });
});

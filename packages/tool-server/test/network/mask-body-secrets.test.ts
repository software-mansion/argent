import { describe, expect, it } from "vitest";
import { maskBodySecrets } from "../../src/tools/network/mask-body-secrets";

const JSON_TYPE = "application/json";
const FORM_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";

describe("maskBodySecrets", () => {
  it("masks password and confirmation fields in a JSON sign-up body", () => {
    const body = `{"email":"a@b.c","password":"hunter2","password_confirmation":"hunter2","confirmPassword":"hunter2"}`;
    expect(maskBodySecrets(body, JSON_TYPE)).toBe(
      `{"email":"a@b.c","password":"[REDACTED]","password_confirmation":"[REDACTED]","confirmPassword":"[REDACTED]"}`
    );
  });

  it("keeps the rest of the JSON text as sent, big integers and spacing included", () => {
    const body = `{"orderId": 1234567890123456789, "amount": 1.10,\n  "user": {"access_token" : "t\\"ok", "path": "C:\\\\", "n": 1}}`;
    expect(maskBodySecrets(body, "text/plain;charset=UTF-8")).toBe(
      `{"orderId": 1234567890123456789, "amount": 1.10,\n  "user": {"access_token" : "[REDACTED]", "path": "C:\\\\", "n": 1}}`
    );
  });

  it("masks every secret field name, in any case and with _ or -", () => {
    const names = [
      "PASSWORD",
      "passwd",
      "pwd",
      "new-password",
      "oldPassword",
      "current_password",
      "confirmPassword",
      "password_confirm",
      "password_confirmation",
      "client_secret",
      "accessToken",
      "refresh_token",
      "id_token",
      "api_key",
      "otp",
      "passphrase",
      "private_key",
      "secretKey",
      "auth_token",
      "session_token",
    ];
    const pairs = names.map((name, i) => `"${name}"${i === 3 ? "\n" : ""}:"x"`);
    const masked = names.map((name, i) => `"${name}"${i === 3 ? "\n" : ""}:"[REDACTED]"`);
    expect(maskBodySecrets(` [{${pairs.join(",")}}]`, JSON_TYPE)).toBe(` [{${masked.join(",")}}]`);
  });

  it("reads a JSON body sent with a form Content-Type as JSON", () => {
    expect(maskBodySecrets(`{"user":"a","password":"x&y=1"}`, FORM_TYPE)).toBe(
      `{"user":"a","password":"[REDACTED]"}`
    );
  });

  it("leaves fields that only contain a secret word, and empty or non-string values", () => {
    const body = `{"max_tokens":1024,"nextPageToken":"p2","token_type":"Bearer","password":"","otp":123456}`;
    expect(maskBodySecrets(body, JSON_TYPE)).toBe(body);
  });

  it("masks a JSON body cut inside the secret", () => {
    expect(maskBodySecrets(`{"user":"a","password":"hun`, JSON_TYPE)).toBe(
      `{"user":"a","password":"[REDACTED]`
    );
  });

  it("leaves a body that is neither JSON nor form-encoded", () => {
    const body = `<login password="x"/>`;
    expect(maskBodySecrets(body, "application/xml")).toBe(body);
  });

  it("masks form fields by decoded name and keeps the rest as sent", () => {
    const body = "q%=1&log=admin&pwd=wp&user%5Bpassword%5D=rails&max_tokens=5&password=&";
    expect(maskBodySecrets(body, FORM_TYPE)).toBe(
      "q%=1&log=admin&pwd=[REDACTED]&user%5Bpassword%5D=[REDACTED]&max_tokens=5&password=&"
    );
  });

  it("masks dotted form field names by their last part", () => {
    expect(maskBodySecrets("Input.Email=a&Input.Password=x&user.password=y", FORM_TYPE)).toBe(
      "Input.Email=a&Input.Password=[REDACTED]&user.password=[REDACTED]"
    );
  });

  it("scans a large crafted body in linear time", () => {
    const body = "[" + `{"password":"\\"","a":`.repeat(100_000) + '"\\'.repeat(100_000);
    const started = performance.now();
    maskBodySecrets(body, JSON_TYPE);
    maskBodySecrets(body, FORM_TYPE);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

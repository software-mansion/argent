const MASK = "[REDACTED]";

/** Field names compared in lower case without `_` and `-`, so `newPassword` and `new_password` match. */
const SECRET_FIELDS = new Set([
  "password",
  "passwd",
  "pwd",
  "newpassword",
  "oldpassword",
  "currentpassword",
  "confirmpassword",
  "passwordconfirm",
  "passwordconfirmation",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "otp",
  "passphrase",
  "privatekey",
  "secretkey",
  "authtoken",
  "sessiontoken",
]);

function isSecretField(name: string): boolean {
  return SECRET_FIELDS.has(name.toLowerCase().replace(/[-_]/g, ""));
}

/**
 * Replaces the non-empty string values of secret fields in a JSON or
 * form-encoded request body. Everything else keeps the text the app sent.
 */
export function maskBodySecrets(body: string, contentType: string): string {
  const first = body.trimStart()[0];
  if (first === "{" || first === "[") return maskJsonBody(body);
  const mimeType = contentType.split(/[;,]/)[0]!.trim().toLowerCase();
  return mimeType === "application/x-www-form-urlencoded" ? maskFormBody(body) : body;
}

function maskFormBody(body: string): string {
  return body
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1 || eq === pair.length - 1) return pair;
      return isSecretField(formFieldName(pair.slice(0, eq)))
        ? `${pair.slice(0, eq + 1)}${MASK}`
        : pair;
    })
    .join("&");
}

/** The last part of a form field name, as in Rails' `user[password]` or ASP.NET's `Input.Password`. */
function formFieldName(rawKey: string): string {
  const key = withoutArraySuffix(decodeFormKey(rawKey));
  const open = key.lastIndexOf("[");
  const name = open !== -1 && key.endsWith("]") ? key.slice(open + 1, -1) : key;
  return name.slice(name.lastIndexOf(".") + 1);
}

function withoutArraySuffix(key: string): string {
  let end = key.length;
  while (key[end - 1] === "]") {
    let open = end - 2;
    while (open >= 0 && key[open]! >= "0" && key[open]! <= "9") open--;
    if (key[open] !== "[") break;
    end = open;
  }
  return key.slice(0, end);
}

function decodeFormKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return rawKey;
  }
}

/** Edits the text in place, so big integers and formatting survive; the text may be cut short. */
function maskJsonBody(body: string): string {
  let masked = "";
  let copied = 0;
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '"') {
      i++;
      continue;
    }
    const keyClose = closingQuote(body, i);
    const colon = skipSpace(body, keyClose + 1);
    if (body[colon] !== ":") {
      i = keyClose + 1;
      continue;
    }
    const valueOpen = skipSpace(body, colon + 1);
    if (body[valueOpen] !== '"') {
      i = valueOpen;
      continue;
    }
    const valueClose = closingQuote(body, valueOpen);
    if (valueClose > valueOpen + 1 && isSecretField(jsonKeyName(body.slice(i + 1, keyClose)))) {
      masked += body.slice(copied, valueOpen + 1) + MASK;
      copied = valueClose;
    }
    i = valueClose + 1;
  }
  return masked + body.slice(copied);
}

function jsonKeyName(rawKey: string): string {
  if (!rawKey.includes("\\")) return rawKey;
  try {
    return JSON.parse(`"${rawKey}"`) as string;
  } catch {
    return rawKey;
  }
}

/** The index of the quote that closes the string opened at `open`, or past the text's end. */
function closingQuote(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i;
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  return i;
}

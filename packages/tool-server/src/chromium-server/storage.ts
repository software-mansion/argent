import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";

/**
 * Cookie + Web Storage helpers for a Chromium (CDP) page session. Cookies go
 * through the CDP Network domain (so httpOnly cookies are visible/settable);
 * localStorage / sessionStorage go through `Runtime.evaluate` against the
 * active page (simple and origin-correct).
 */

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface SetCookieParams {
  name: string;
  value: string;
  /** Either `url`, or `domain` (+ optional `path`), must scope the cookie. */
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Unix seconds. Omit for a session cookie. */
  expires?: number;
}

export interface DeleteCookieParams {
  name: string;
  url?: string;
  domain?: string;
  path?: string;
}

export async function getCookies(cdp: CDPClient, urls?: string[]): Promise<Cookie[]> {
  const out = (await cdp.send("Network.getCookies", urls && urls.length ? { urls } : {})) as {
    cookies?: Cookie[];
  };
  return out.cookies ?? [];
}

export async function setCookie(cdp: CDPClient, params: SetCookieParams): Promise<boolean> {
  if (!params.url && !params.domain) {
    throw new FailureError("setCookie requires either `url` or `domain` to scope the cookie.", {
      error_code: FAILURE_CODES.CHROMIUM_PARAM_INVALID,
      failure_stage: "chromium_cookie_scope",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  const out = (await cdp.send("Network.setCookie", { ...params })) as { success?: boolean };
  return out.success === true;
}

export async function deleteCookies(cdp: CDPClient, params: DeleteCookieParams): Promise<void> {
  await cdp.send("Network.deleteCookies", { ...params });
}

export async function clearCookies(cdp: CDPClient): Promise<void> {
  await cdp.send("Network.clearBrowserCookies");
}

export type StorageType = "local" | "session";

function storeRef(type: StorageType): string {
  return type === "local" ? "localStorage" : "sessionStorage";
}

async function evalValue(cdp: CDPClient, expression: string): Promise<unknown> {
  const out = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  };
  if (out.exceptionDetails) {
    throw new FailureError(`Storage evaluation failed: ${out.exceptionDetails.text ?? "threw"}`, {
      error_code: FAILURE_CODES.CHROMIUM_STORAGE_EVAL_FAILED,
      failure_stage: "chromium_storage_eval",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  }
  return out.result?.value;
}

export async function getStorageAll(
  cdp: CDPClient,
  type: StorageType
): Promise<Record<string, string>> {
  const value = await evalValue(
    cdp,
    `(() => { const s = ${storeRef(type)}; const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; })()`
  );
  return (value as Record<string, string>) ?? {};
}

export async function getStorageItem(
  cdp: CDPClient,
  type: StorageType,
  key: string
): Promise<string | null> {
  const value = await evalValue(cdp, `${storeRef(type)}.getItem(${JSON.stringify(key)})`);
  return (value as string | null) ?? null;
}

export async function setStorageItem(
  cdp: CDPClient,
  type: StorageType,
  key: string,
  value: string
): Promise<void> {
  await evalValue(
    cdp,
    `${storeRef(type)}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
  );
}

export async function removeStorageItem(
  cdp: CDPClient,
  type: StorageType,
  key: string
): Promise<void> {
  await evalValue(cdp, `${storeRef(type)}.removeItem(${JSON.stringify(key)})`);
}

export async function clearStorage(cdp: CDPClient, type: StorageType): Promise<void> {
  await evalValue(cdp, `${storeRef(type)}.clear()`);
}

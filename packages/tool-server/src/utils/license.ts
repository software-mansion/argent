import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORTAL_URL = "https://portal.ide.swmansion.com";
const KEYCHAIN_SERVICE = "argent";
const KEYCHAIN_ACCOUNT = "license-token";
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const REFRESH_META_DIR = path.join(os.homedir(), ".argent");
const LAST_REFRESH_FILE = path.join(REFRESH_META_DIR, "last-token-refresh");

// Binary lives at workspace root (three levels up from dist/ at runtime).
// When bundled by esbuild, __dirname is dist/ — use ARGENT_SIMULATOR_SERVER_DIR env var instead.
function getBinaryPath(): string {
  const BINARY_DIR =
    process.env.ARGENT_SIMULATOR_SERVER_DIR ??
    path.join(__dirname, "..", "..", "..", "..");
  return path.join(BINARY_DIR, "simulator-server");
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function readToken(): Promise<string | null> {
  // Try Keychain first
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // not in Keychain yet — fall through to migration
  }

  return null;
}

export async function saveToken(token: string): Promise<void> {
  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      token,
    ]);
  } catch (err) {
    console.error("[argent] Failed to save token to keychain:", err);
  }
}

export async function removeToken(): Promise<void> {
  try {
    await execFileAsync("security", [
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
    ]);
  } catch {
    // not found — that's fine
  }

  try {
    await fs.unlink(LAST_REFRESH_FILE);
  } catch {
    // missing metadata file — that's fine
  }
}

async function readLastRefreshAt(): Promise<number | null> {
  try {
    const value = (await fs.readFile(LAST_REFRESH_FILE, "utf8")).trim();
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeLastRefreshAt(timestamp = Date.now()): Promise<void> {
  try {
    await fs.mkdir(REFRESH_META_DIR, { recursive: true });
    await fs.writeFile(LAST_REFRESH_FILE, String(timestamp), "utf8");
  } catch {
    // Non-fatal: refresh metadata persistence should not break auth flow
  }
}

// ── JWT decode (no subprocess) ────────────────────────────────────────────────

export function decodeJWTPayload(
  token: string,
): { cp_plan?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]!;
    // base64url → base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json) as { cp_plan?: string; exp?: number };
  } catch {
    return null;
  }
}

// ── Binary helpers ────────────────────────────────────────────────────────────

export async function verifyToken(token: string): Promise<
  | { valid: true; plan: string }
  | {
      valid: false;
      reason: "corrupted" | "expired" | "fingerprint_mismatch" | "unknown";
    }
> {
  try {
    const { stdout } = await execFileAsync(getBinaryPath(), [
      "verify_token",
      token,
    ]);
    const line = stdout.trim();
    if (line.startsWith("token_valid ")) {
      return { valid: true, plan: line.slice("token_valid ".length).trim() };
    }
    if (line.startsWith("token_invalid ")) {
      const reason = line.slice("token_invalid ".length).trim() as
        | "corrupted"
        | "expired"
        | "fingerprint_mismatch"
        | "unknown";
      return { valid: false, reason };
    }
    return { valid: false, reason: "unknown" };
  } catch {
    return { valid: false, reason: "unknown" };
  }
}

export async function getFingerprint(): Promise<string> {
  const { stdout } = await execFileAsync(getBinaryPath(), ["fingerprint"]);
  return stdout.trim();
}

// ── Portal API helpers ────────────────────────────────────────────────────────

async function portalPost(
  endpoint: string,
  body: Record<string, string>,
): Promise<{ code: string; token?: string }> {
  const url = `${PORTAL_URL}${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ code: string; token?: string }>;
}

// ── Save if valid ─────────────────────────────────────────────────────────────

export async function saveTokenIfValid(token: string): Promise<boolean> {
  const result = await verifyToken(token);
  if (!result.valid) return false;
  await saveToken(token);
  return true;
}

// ── License-key activation ────────────────────────────────────────────────────

export async function activateWithLicenseKey(
  licenseKey: string,
  name = os.hostname(),
): Promise<
  { success: true; plan: string } | { success: false; error: string }
> {
  let fingerprint: string;
  try {
    fingerprint = await getFingerprint();
  } catch {
    return { success: false, error: "Failed to read machine fingerprint" };
  }

  let data: { code: string; token?: string };
  try {
    data = await portalPost("/api/create-token", {
      fingerprint,
      name,
      licenseKey,
    });
  } catch {
    return {
      success: false,
      error: "Network error contacting activation portal",
    };
  }

  if (data.code === "E001") {
    return { success: false, error: "License key not found" };
  }
  if (data.code === "E002") {
    return {
      success: false,
      error: "No active subscription for this license key",
    };
  }
  if (data.code !== "E000" || !data.token) {
    return {
      success: false,
      error: `Unexpected portal response: ${data.code}`,
    };
  }

  const saved = await saveTokenIfValid(data.token);
  if (!saved) {
    return {
      success: false,
      error: "Portal returned a token that failed local validation",
    };
  }

  await writeLastRefreshAt();
  const decoded = decodeJWTPayload(data.token);
  return { success: true, plan: decoded?.cp_plan ?? "unknown" };
}

// ── SSO (PKCE) activation ─────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export async function activateWithSSO(
  name = os.hostname(),
): Promise<
  | { success: true; plan: string }
  | { success: false; error: string; ssoUrl?: string }
> {
  let fingerprint: string;
  try {
    fingerprint = await getFingerprint();
  } catch {
    return { success: false, error: "Failed to read machine fingerprint" };
  }

  // PKCE
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  const state = base64url(crypto.randomBytes(16));

  // Start local callback server on a random port
  let callbackResolve: (code: string) => void;
  let callbackReject: (err: Error) => void;
  const callbackPromise = new Promise<string>((res, rej) => {
    callbackResolve = res;
    callbackReject = rej;
  });

  const callbackServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (returnedState !== state || !code) {
        res.writeHead(400).end("Invalid callback");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          "<html><body><h2>Activation complete — return to your terminal.</h2></body></html>",
        );
      callbackResolve!(code);
    } catch (err) {
      res.writeHead(500).end();
      callbackReject!(err as Error);
    }
  });

  const port = await new Promise<number>((res, rej) => {
    callbackServer.listen(0, "127.0.0.1", () => {
      const addr = callbackServer.address();
      if (addr && typeof addr === "object") res(addr.port);
      else rej(new Error("Could not bind callback server"));
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const ssoUrl =
    `${PORTAL_URL}/sso/authorize` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`;

  // Try to open browser
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  let browserOpened = true;
  try {
    await execFileAsync(opener, [ssoUrl]);
  } catch {
    browserOpened = false;
  }

  if (!browserOpened) {
    callbackServer.close();
    return {
      success: false,
      error: "Could not open browser automatically",
      ssoUrl,
    };
  }

  // Race: callback vs 5-minute timeout
  const timeoutMs = 5 * 60 * 1000;
  let code: string;
  try {
    code = await Promise.race([
      callbackPromise,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error("SSO timed out (5 minutes)")),
          timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    callbackServer.close();
  }

  // Exchange code for token
  let data: { code: string; token?: string };
  try {
    data = await portalPost("/api/sso/create-token", {
      fingerprint,
      name,
      code,
      code_verifier: codeVerifier,
    });
  } catch {
    return { success: false, error: "Network error during token exchange" };
  }

  if (data.code !== "S001" || !data.token) {
    return { success: false, error: `SSO token exchange failed: ${data.code}` };
  }

  const saved = await saveTokenIfValid(data.token);
  if (!saved) {
    return {
      success: false,
      error: "Portal returned a token that failed local validation",
    };
  }

  await writeLastRefreshAt();
  const decoded = decodeJWTPayload(data.token);
  return { success: true, plan: decoded?.cp_plan ?? "unknown" };
}

// ── Token refresh ─────────────────────────────────────────────────────────────

export async function refreshToken(): Promise<void> {
  const token = await readToken();
  if (!token) return;

  let data: { code: string; token?: string };
  try {
    data = await portalPost("/api/refresh-token", { token });
  } catch {
    return; // Network error — keep existing token
  }

  if ((data.code === "E000" || data.code === "S001") && data.token) {
    await saveTokenIfValid(data.token);
  } else {
    await removeToken();
  }

  await writeLastRefreshAt();
}

export async function refreshTokenIfDue(): Promise<void> {
  const lastRefreshAt = await readLastRefreshAt();
  if (
    typeof lastRefreshAt === "number" &&
    Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS
  ) {
    return;
  }

  await refreshToken();
}

// ── Startup validation ────────────────────────────────────────────────────────

export async function validateStoredToken(): Promise<boolean> {
  let token = await readToken();
  if (!token) return false;

  await refreshTokenIfDue();
  token = await readToken();
  if (!token) return false;

  const result = await verifyToken(token);
  if (result.valid) return true;

  if (result.reason === "expired") {
    await refreshToken();
    const refreshed = await readToken();
    if (refreshed) {
      const recheck = await verifyToken(refreshed);
      if (recheck.valid) return true;
    }
    await removeToken();
    return false;
  }

  if (result.reason === "fingerprint_mismatch") {
    await removeToken();
    return false;
  }

  await removeToken();
  return false;
}

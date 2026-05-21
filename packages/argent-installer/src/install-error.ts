import * as p from "@clack/prompts";
import pc from "picocolors";

// `npm install --save-dev <argent>` re-resolves every existing dep in the
// user's manifest. When that fails, the surfaced error is usually about
// one of their own entries (a broken `link:` path, an unreachable file:
// dep, a peer conflict) — not about argent itself. We pattern-match the
// common error strings so the hint can redirect blame appropriately.

const EXISTING_MANIFEST_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /EUNSUPPORTEDPROTOCOL/i,
  /Unsupported URL Type/i,
  /\blink:/i,
  /ERESOLVE/i,
  /peer dep/i,
  /could not resolve dependency/i,
  /ENOENT.*package\.json/i,
];

export function looksLikeExistingManifestError(message: string): boolean {
  return EXISTING_MANIFEST_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function reportLocalInstallFailure(
  err: unknown,
  cmdStr: string,
  projectRoot: string
): void {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);

  if (looksLikeExistingManifestError(message)) {
    p.log.info(
      `${pc.yellow("Note:")} this looks like a problem with an existing dependency in ` +
        `${pc.dim(`${projectRoot}/package.json`)}, not with argent itself. ` +
        `Argent was added to package.json but the wider install ran a re-resolve ` +
        `of every dep and one of them failed. Fix the offending entry (the error ` +
        `above names it) and re-run ${pc.cyan("argent init")}, or install argent ` +
        `globally instead with ${pc.cyan("argent init")} → Global.`
    );
  }

  p.log.info(`Install Argent manually with: ${pc.cyan(cmdStr)}`);
}

/**
 * The provider-facing half of the contract: publish a descriptor, withdraw it
 * and prune the ones a crashed provider left behind.
 *
 * Writing `~/.argent/providers/<id>.json` yourself stays legal. A provider
 * written in Swift or Rust cannot import this. What this module saves a Node
 * provider is reimplementing the atomic write, the no-op dedupe and the orphan
 * prune, which everyone gets subtly wrong in ways nothing catches until
 * runtime.
 *
 * Validation here is the inverse of [`read.ts`](./read.ts): discovery is quiet
 * and fail-closed so a provider can never break Argent, while publishing
 * throws, because this is the moment the provider can still fix the mistake.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PROVIDER_ID_SHAPE, type ProviderRecord, providerRecordSchema } from "./contract.js";
import { descriptorFiles, providersDirectory, readProviderFile } from "./read.js";

/**
 * Thrown by {@linkcode publishProvider} for a descriptor Argent would reject.
 */
export class ProviderValidationError extends Error {
  /** One line per problem, `path: message`, in the order zod reported them. */
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "ProviderValidationError";
    this.issues = issues;
  }
}

export interface PublishOptions {
  /**
   * The provider's process id, so `pruneOrphanedProviders` can remove this
   * descriptor if that process dies without withdrawing. Overrides the
   * document's `pid`.
   *
   * Never default it to the current process: the usual caller is a CLI that
   * exits immediately and the pid it recorded would be dead on arrival.
   */
  pid?: number;
}

export interface PublishResult {
  /**
   * False when the file already held exactly this document, in which case its
   * mtime is untouched — what makes republishing on every device change cheap.
   */
  changed: boolean;
  /** Canonical path written: `<providers directory>/<record id>.json`. */
  path: string;
}

/**
 * Validate `record` the way `argent providers check` does and write it to its
 * canonical path.
 *
 * Two deliberate properties beyond writing the file by hand:
 *
 * - The filename comes from the id. Argent keys on `id` and keeps only the
 *   first file claiming one, so a provider choosing its own filename can shadow
 *   itself across a restart. This makes that unrepresentable.
 * - The document is written as given, unknown fields included. The publishing
 *   CLI can be older than the reading tool-server (several installs share one
 *   machine-wide `cli.json`), and stripping unknown fields would silently drop
 *   anything added to v1 after this CLI shipped. The read side ignores what it
 *   does not know, so writing it through is safe.
 *
 * @throws {ProviderValidationError} when the descriptor is not conformant.
 */
/**
 * Deep-sort object keys (arrays keep their order) so the unchanged-document
 * dedupe does not care about key order. The JSON round-trip first reduces the
 * value to plain objects, the way stringify would (`toJSON`, dropped
 * `undefined`s).
 */
function canonicalize(value: unknown): unknown {
  const normalized: unknown = JSON.parse(JSON.stringify(value));

  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sort(child)])
    );
  };

  return sort(normalized);
}

export function publishProvider(record: unknown, options: PublishOptions = {}): PublishResult {
  const candidate =
    options.pid === undefined
      ? record
      : { ...(record as Record<string, unknown>), pid: options.pid };

  const parsed = providerRecordSchema.safeParse(candidate);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
    );

    throw new ProviderValidationError(
      `Refusing to publish a descriptor argent would reject:\n  ${issues.join("\n  ")}`,
      issues
    );
  }

  const validated = parsed.data;

  /**
   * Not expressible in the schema: two entries for one `nativeId` collapse to a
   * single `ext:` id, leaving the second unreachable and the provider unable to
   * tell which one Argent kept.
   */
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const device of validated.devices) {
    if (seen.has(device.nativeId)) duplicates.add(device.nativeId);
    seen.add(device.nativeId);
  }

  if (duplicates.size > 0) {
    const issues = Array.from(duplicates).map(
      (nativeId) => `devices: '${nativeId}' is listed more than once`
    );

    throw new ProviderValidationError(
      `Refusing to publish a descriptor argent would reject:\n  ${issues.join("\n  ")}`,
      issues
    );
  }

  const directory = providersDirectory();
  const file = path.join(directory, `${validated.id}.json`);
  /** The document as given, not `validated`. See the note above. */
  const body = JSON.stringify(canonicalize(candidate), null, 2) + "\n";

  /**
   * Compared against the file rather than an in-memory copy. It survives a
   * restart and notices edits made underneath us, and at this size the read is
   * cheaper than the write it avoids.
   */
  try {
    if (fs.readFileSync(file, "utf8") === body) return { changed: false, path: file };
  } catch {
    /** Absent, unreadable or different. Fall through and write it. */
  }

  fs.mkdirSync(directory, { recursive: true });

  /**
   * tmp + rename: Argent reads this directory concurrently with no locking, so
   * a half-written document must never be observable. The pid keeps two
   * publishers from colliding on the temporary name.
   */
  const temporary = `${file}.${process.pid}.tmp`;

  try {
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /** The throw below is the story, not the leftover file. */
    }

    throw error;
  }

  return { changed: true, path: file };
}

/**
 * Remove a provider's descriptor. Returns false when there was nothing to
 * remove — the normal outcome of a second `dispose()`.
 *
 * The id is shape-checked before it reaches the filesystem. It is interpolated
 * into a path, and `../../` is not a provider id.
 */
export function withdrawProvider(id: string): boolean {
  if (!PROVIDER_ID_SHAPE.test(id)) {
    throw new Error(`'${id}' is not a valid provider id (${String(PROVIDER_ID_SHAPE)}).`);
  }

  const file = path.join(providersDirectory(), `${id}.json`);

  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Is `pid` a live process? Signal 0 checks existence without delivering
 * anything. `EPERM` means it exists under another user and reading that as dead
 * would let one user's prune delete another's descriptor.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PruneOptions {
  /**
   * Report what would be pruned without unlinking anything. The decision is
   * otherwise identical, so a dry run is an exact preview.
   */
  dryRun?: boolean;
  /**
   * Restrict the prune to a vendor's own descriptors (e.g.
   * `record => record.id.startsWith("acme-")`) — the polite default when
   * embedding this. `argent providers prune` passes nothing. A user running it
   * by hand means all of them.
   */
  filter?: (record: ProviderRecord) => boolean;
}

export interface PruneResult {
  /** Provider id of the removed descriptor. */
  id: string;
  /** Human-readable provider name, for the report. */
  name: string;
  /** The descriptor that was (or would be) removed. */
  path: string;
  /** The dead process it named. */
  pid: number;
}

/**
 * Remove descriptors whose owning process is gone.
 *
 * The only place in the package that unlinks a file it did not write, so the
 * bar is high. The descriptor must parse, declare a `pid`, and that pid must be
 * dead. Anything else is left alone. An unparseable file has no owner to
 * attribute it to and a missing pid is not evidence of death.
 *
 * The read path never unlinks at all. The pid is the difference: discovery
 * cannot tell a stale descriptor from a live one it merely cannot reach.
 */
export function pruneOrphanedProviders(options: PruneOptions = {}): PruneResult[] {
  const removed: PruneResult[] = [];

  for (const file of descriptorFiles()) {
    const record = readProviderFile(file);
    if (!record) continue;
    if (record.pid === undefined) continue;
    if (options.filter && !options.filter(record)) continue;
    if (isProcessAlive(record.pid)) continue;

    const entry = { id: record.id, name: record.name, path: file, pid: record.pid };

    if (options.dryRun) {
      removed.push(entry);
      continue;
    }

    try {
      fs.unlinkSync(file);
      removed.push(entry);
    } catch {
      /** Someone else pruned it first, or it is not ours. */
    }
  }

  return removed;
}

import { promises as fs } from 'fs';
import { join } from 'path';

const DEBUG_DIR_NAME = 'rn-devtools-debug';

/**
 * Returns (and creates if needed) <projectRoot>/rn-devtools-debug/.
 */
export async function getDebugDir(projectRoot: string): Promise<string> {
  const dir = join(projectRoot, DEBUG_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Writes `data` as pretty-printed JSON to `<dir>/<filename>`.
 * Returns the full file path. Non-fatal — returns null on error.
 */
export async function writeDump(dir: string, filename: string, data: unknown): Promise<string | null> {
  try {
    const path = join(dir, filename);
    const json = JSON.stringify(data, (_key, value) => {
      // Serialize Map as plain object
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      return value as unknown;
    }, 2);
    await fs.writeFile(path, json, 'utf8');
    return path;
  } catch {
    return null;
  }
}

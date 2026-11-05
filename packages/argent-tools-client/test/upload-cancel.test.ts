import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { uploadFile } from "../src/file-inputs.js";

const afterTar = vi.hoisted(() => ({ run: (): void => {} }));
vi.mock("@argent/archive", async (importOriginal) => {
  const real = await importOriginal<typeof import("@argent/archive")>();
  return {
    ...real,
    createTarGzFile: async (...args: Parameters<typeof real.createTarGzFile>) => {
      await real.createTarGzFile(...args);
      afterTar.run();
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("stops before hashing and uploading when the call is cancelled after tar", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "argent-upload-cancel-"));
    try {
      await fs.writeFile(path.join(tmp, "app"), "bytes");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const controller = new AbortController();
      afterTar.run = () => controller.abort(new Error("cancelled"));

      await expect(
        uploadFile(
          path.join(tmp, "app"),
          { url: "http://127.0.0.1:9", token: "t" },
          controller.signal
        )
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

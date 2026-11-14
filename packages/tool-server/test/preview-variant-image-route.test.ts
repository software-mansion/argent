import { describe, it, expect, vi } from "vitest";
import express from "express";
import * as http from "node:http";
import type { ReadStream } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "@argent/registry";

const readStreams = vi.hoisted(() => [] as ReadStream[]);

// Records each file stream the route opens, so a test can see whether it was released.
// preview.ts calls it off the default export.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    readStreams.push(stream);
    return stream;
  }) as typeof actual.createReadStream;
  return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});

import { createPreviewRouter } from "../src/preview";
import { variantProposalStore } from "../src/utils/variant-proposals";

describe("GET /variant-image/:elementId/:variantId", () => {
  it("closes the image file when the client aborts mid-download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview-image-"));
    const server = http.createServer();
    try {
      const filePath = join(dir, "shot.png");
      // Under the route's 25 MB cap, yet far more than the socket buffers hold, so the
      // route is still reading when the client leaves.
      await writeFile(filePath, "");
      await truncate(filePath, 24 * 1024 * 1024);
      const { elementId, variantId } = variantProposalStore.proposeVariant({
        element: "Foo",
        variant: { name: "Big", summary: "s", previewImage: filePath },
      });
      const app = express();
      app.use(createPreviewRouter({} as Registry));
      server.on("request", app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      await new Promise<void>((resolve) => {
        const req = http.get(
          `http://127.0.0.1:${port}/variant-image/${elementId}/${variantId}`,
          (res) => {
            res.on("error", () => {});
            res.once("data", () => req.destroy());
          }
        );
        req.on("error", () => {});
        req.on("close", resolve);
      });

      expect(readStreams).toHaveLength(1);
      await vi.waitFor(() => expect(readStreams[0]!.closed).toBe(true), { timeout: 2_000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

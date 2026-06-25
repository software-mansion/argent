import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import supertest from "supertest";

import { serveUiFile } from "../src/preview";

// Regression guard for the Express 5 `send` dotfiles default (`dotfiles: "ignore"`),
// which 404s any file path containing a dot-segment. argent is routinely installed
// under such a path — nvm (`~/.nvm/...`), fnm, volta, asdf — so a bare
// `res.sendFile(absolutePath)` made the Lens preview window fail to load its UI
// (`/preview/` and `/preview/theme.css` returned NotFoundError). serveUiFile must
// serve the file regardless of where on disk it lives.
describe("serveUiFile under a dot-segment install path", () => {
  let dir: string;

  beforeAll(() => {
    // Directory name starts with "." — the exact shape that trips send's dotfile
    // filter, mirroring an install at ~/.nvm/.../preview-ui.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), ".argent-dotfix-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>lens</title>");
    fs.writeFileSync(path.join(dir, "theme.css"), ":root{--accent:#0a7ea4}");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function appServing(file: string, contentType: string) {
    const app = express();
    app.get("/x", (_req, res) => serveUiFile(res, path.join(dir, file), contentType));
    return app;
  }

  it("serves index.html from a dot-path (200, not 404)", async () => {
    const res = await supertest(appServing("index.html", "text/html")).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("lens");
  });

  it("serves theme.css from a dot-path (200, not 404)", async () => {
    const res = await supertest(appServing("theme.css", "text/css")).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
    expect(res.text).toContain("--accent");
  });
});

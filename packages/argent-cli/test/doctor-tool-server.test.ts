import { describe, expect, it } from "vitest";
import { redactUrl, remoteCheck } from "../src/doctor-tool-server.js";

describe("remoteCheck", () => {
  it("tells a rejected token apart from a dead server", () => {
    expect(remoteCheck(200, "http://h:1", "link").status).toBe("ok");
    expect(remoteCheck(401, "http://h:1", "link").label).toMatch(/rejects the token/);
    expect(remoteCheck(null, "http://h:1", "link").label).toMatch(/unreachable/);
  });

  it("blames the host name, not the token, for a 403", () => {
    const result = remoteCheck(403, "http://h:1", "link");
    expect(result.label).toMatch(/refuses this host name/);
    expect(result.fix).toMatch(/ARGENT_HOST/);
  });

  it("spells fix commands the way this install runs argent", () => {
    expect(remoteCheck(null, "http://h:1", "link", "npx argent").fix).toMatch(/npx argent unlink/);
    expect(remoteCheck(401, "http://h:1", "link", "npx argent").fix).toMatch(/npx argent link/);
  });

  it("doesn't suggest argent unlink when the URL comes from ARGENT_TOOLS_URL", () => {
    expect(remoteCheck(null, "http://h:1", "env").fix).toMatch(/unset ARGENT_TOOLS_URL/);
    expect(remoteCheck(null, "http://h:1", "link").fix).toMatch(/argent unlink/);
  });
});

describe("remote tool-server", () => {
  it("does not call a non-2xx answer reachable", () => {
    const result = remoteCheck(404, "http://h:1/", "env");
    expect(result.status).toBe("error");
    expect(result.label).toMatch(/HTTP 404/);
  });

  it("never prints a token from the URL", () => {
    expect(redactUrl("argent://secret-token@127.0.0.1:47611")).not.toContain("secret-token");
    expect(remoteCheck(null, "http://user:pw@h:1", "env").label).not.toMatch(/user|pw/);
    expect(redactUrl("http://h:1/")).toBe("http://h:1/");
  });
});

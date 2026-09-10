/**
 * The parity rule, enforced at each site that speaks HTTP to a provider's
 * simulator-server. On a server Argent did not spawn, use only the endpoints
 * Argent's own build serves.
 *
 * `external-devices.test.ts` covers the allowlist itself, which endpoints it
 * admits and refuses. That is the list, not the enforcement. This file covers
 * the other half, that every caller actually consults it, because the two fail
 * independently. Deleting `assertAllowedSimServerEndpoint` from all three call
 * sites left the whole suite green.
 *
 * No caller takes its endpoint from the outside, so none can be steered at a
 * refused one. What can be observed is whether the guard was asked. The
 * allowlist is stubbed to refuse everything, and the assertion is that the
 * provider's server never receives the request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { SimulatorServerApi } from "../src/blueprints/simulator-server";

const REFUSAL = /Refusing to call/;

const assertAllowedMock = vi.fn();

vi.mock("../src/utils/external-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/external-devices")>();

  return {
    ...actual,
    assertAllowedSimServerEndpoint: (endpoint: string) => assertAllowedMock(endpoint),
  };
});

import {
  httpScreenshot,
  setPointerVisible,
  setSimulatorClipboardText,
} from "../src/utils/simulator-client";

/** A provider's server, standing in for one Argent did not spawn. */
let server: http.Server;
let requested: string[];
let apiUrl: string;

beforeEach(async () => {
  requested = [];
  server = http.createServer((request, response) => {
    requested.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ok", url: "file:///shot.png", path: "/shot.png" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assertAllowedMock.mockReset();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function api(external: boolean): SimulatorServerApi {
  return {
    apiUrl,
    external,
    pressKey: async () => {},
    streamUrl: `${apiUrl}/stream.mjpeg`,
  };
}

/**
 * Each case names the endpoint its site is expected to offer the allowlist.
 * Pinning it means a site that starts posting somewhere else has to say so
 * here, rather than silently widening what Argent asks of a provider.
 */
const SITES = [
  {
    endpoint: "/api/screenshot",
    name: "httpScreenshot",
    /** Propagates, so the caller learns the endpoint was refused. */
    refused: (a: SimulatorServerApi) => expect(httpScreenshot(a)).rejects.toThrow(REFUSAL),
    reaches: async (a: SimulatorServerApi) => void (await httpScreenshot(a)),
  },
  {
    endpoint: "/api/pointer",
    name: "setPointerVisible",
    /**
     * Swallows every failure and answers `false`, the pointer being cosmetic.
     * The refusal is therefore only visible as a request that was not made,
     * which is the assertion that matters here anyway.
     */
    refused: async (a: SimulatorServerApi) => expect(await setPointerVisible(a, true)).toBe(false),
    reaches: async (a: SimulatorServerApi) => void (await setPointerVisible(a, true)),
  },
  {
    endpoint: "/api/clipboard/text",
    name: "setSimulatorClipboardText",
    refused: (a: SimulatorServerApi) =>
      expect(setSimulatorClipboardText(a, "hello")).rejects.toThrow(REFUSAL),
    reaches: async (a: SimulatorServerApi) => void (await setSimulatorClipboardText(a, "hello")),
  },
] as const;

describe("every provider HTTP path consults the endpoint allowlist", () => {
  it.each(SITES)("$name asks about $endpoint and sends nothing when refused", async (site) => {
    assertAllowedMock.mockImplementation((endpoint: string) => {
      throw new Error(`Refusing to call '${endpoint}' on an externally-provided simulator-server.`);
    });

    await site.refused(api(true));

    expect(assertAllowedMock).toHaveBeenCalledWith(site.endpoint);
    expect(requested).toEqual([]);
  });

  /**
   * The gate belongs to provider-supplied servers only. A server Argent spawned
   * is its own process and needs no restriction, so asking the allowlist about
   * it would be the wrong kind of correct.
   */
  it.each(SITES)("$name leaves a server argent spawned alone", async (site) => {
    assertAllowedMock.mockImplementation(() => {
      throw new Error("the allowlist must not be consulted for a local server");
    });

    await site.reaches(api(false));

    expect(assertAllowedMock).not.toHaveBeenCalled();
    expect(requested).toHaveLength(1);
  });
});

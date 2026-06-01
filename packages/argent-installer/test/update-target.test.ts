import { describe, it, expect, vi, beforeEach } from "vitest";

// update-target is a thin wrapper over @argent/update-core (whose registry
// fetch, release-age probe, and target picking are unit-tested in that package).
// Here we only assert the wiring: the right packument URL, the right PM probe,
// and the field mapping into ResolvedUpdateTarget.
const { mockFetchRegistryInfo, mockDetectMinReleaseAgeMsForPm, mockPickInstallableTarget } =
  vi.hoisted(() => ({
    mockFetchRegistryInfo: vi.fn(),
    mockDetectMinReleaseAgeMsForPm: vi.fn(),
    mockPickInstallableTarget: vi.fn(),
  }));

vi.mock("@argent/update-core", () => ({
  fetchRegistryInfo: mockFetchRegistryInfo,
  detectMinReleaseAgeMsForPm: mockDetectMinReleaseAgeMsForPm,
  pickInstallableTarget: mockPickInstallableTarget,
}));

import { resolveInstallableUpdateTarget } from "../src/update-target.js";
import { NPM_REGISTRY, PACKAGE_NAME } from "../src/constants.js";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveInstallableUpdateTarget", () => {
  it("fetches the packument URL, applies the PM policy, and maps the result", async () => {
    mockFetchRegistryInfo.mockResolvedValue({
      latest: { version: "99.0.0", publishedAt: "2026-05-31T00:00:00Z" },
      times: { "98.0.0": "2026-05-20T00:00:00Z", "99.0.0": "2026-05-31T00:00:00Z" },
    });
    mockDetectMinReleaseAgeMsForPm.mockResolvedValue(7 * DAY_MS);
    mockPickInstallableTarget.mockReturnValue({
      version: "98.0.0",
      publishedAt: "2026-05-20T00:00:00Z",
    });

    const result = await resolveInstallableUpdateTarget("npm", "1.0.0");

    expect(mockFetchRegistryInfo).toHaveBeenCalledWith(`${NPM_REGISTRY}/${PACKAGE_NAME}`);
    expect(mockDetectMinReleaseAgeMsForPm).toHaveBeenCalledWith("npm");
    expect(result).toEqual({
      latestVersion: "99.0.0",
      latestPublishedAt: "2026-05-31T00:00:00Z",
      targetVersion: "98.0.0",
      minReleaseAgeMs: 7 * DAY_MS,
    });
  });

  it("maps a held-back latest (no installable target) to targetVersion null", async () => {
    mockFetchRegistryInfo.mockResolvedValue({
      latest: { version: "99.0.0", publishedAt: "2026-05-31T00:00:00Z" },
      times: { "99.0.0": "2026-05-31T00:00:00Z" },
    });
    mockDetectMinReleaseAgeMsForPm.mockResolvedValue(7 * DAY_MS);
    mockPickInstallableTarget.mockReturnValue(null);

    const result = await resolveInstallableUpdateTarget("npm", "1.0.0");

    expect(result?.latestVersion).toBe("99.0.0");
    expect(result?.targetVersion).toBeNull();
  });

  it("returns null without probing when the registry is unreachable", async () => {
    mockFetchRegistryInfo.mockResolvedValue(null);

    await expect(resolveInstallableUpdateTarget("npm", "1.0.0")).resolves.toBeNull();
    expect(mockDetectMinReleaseAgeMsForPm).not.toHaveBeenCalled();
  });
});

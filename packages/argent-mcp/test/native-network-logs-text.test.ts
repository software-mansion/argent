import { describe, it, expect } from "vitest";
import { nativeNetworkLogsText } from "../src/native-network-logs-text.js";

describe("nativeNetworkLogsText", () => {
  it("renders a listing with one line per request across states", () => {
    const text = nativeNetworkLogsText({
      status: "ok",
      header: "ios-native: armed, 4 requests (pid 4321)",
      armed: true,
      count: 4,
      total: 4,
      requests: [
        {
          id: "ios-3f9a-1",
          method: "GET",
          url: "https://api.example.com/v1/users?page=1",
          state: "complete",
          status: 200,
          mimeType: "application/json",
          durationMs: 42,
        },
        {
          id: "ios-3f9a-2",
          method: "POST",
          url: "https://api.example.com/v1/login",
          state: "failed",
          errorText: "The Internet connection appears to be offline.",
          durationMs: 120,
        },
        {
          id: "ios-3f9a-3",
          method: "GET",
          url: "https://api.example.com/v1/stream",
          state: "headers",
          status: 200,
          mimeType: "text/event-stream",
        },
        {
          id: "ios-3f9a-4",
          method: "GET",
          url: "https://api.example.com/v1/slow",
          state: "pending",
          rnRequestId: 7,
        },
      ],
    });

    expect(text).toBe(
      [
        "ios-native: armed, 4 requests (pid 4321)",
        '{id: ios-3f9a-1} "GET https://api.example.com/v1/users?page=1" 200 application/json 42ms',
        '{id: ios-3f9a-2} "POST https://api.example.com/v1/login" failed "The Internet connection appears to be offline." 120ms',
        '{id: ios-3f9a-3} "GET https://api.example.com/v1/stream" 200 (headers) text/event-stream',
        '{id: ios-3f9a-4} "GET https://api.example.com/v1/slow" pending rnRequestId=7',
      ].join("\n")
    );
  });

  it("shows truncation count when limit hides older requests, and handles limit=0", () => {
    const partial = nativeNetworkLogsText({
      status: "ok",
      header: "android-native: armed, 25 requests (pid 99; capture active)",
      armed: true,
      capture: "active",
      count: 2,
      total: 25,
      requests: [
        {
          id: "android-a-24",
          method: "GET",
          url: "https://ex.test/24",
          state: "complete",
          status: 200,
        },
        {
          id: "android-a-25",
          method: "GET",
          url: "https://ex.test/25",
          state: "complete",
          status: 204,
        },
      ],
    });
    expect(partial).toBe(
      [
        "android-native: armed, 25 requests (pid 99; capture active)",
        "Showing last 2 of 25 requests.",
        '{id: android-a-24} "GET https://ex.test/24" 200',
        '{id: android-a-25} "GET https://ex.test/25" 204',
      ].join("\n")
    );

    const zero = nativeNetworkLogsText({
      status: "ok",
      header: "ios-native: armed, 10 requests (pid 12)",
      armed: true,
      count: 0,
      total: 10,
      requests: [],
    });
    expect(zero).toBe("ios-native: armed, 10 requests (pid 12)\nShowing 0 of 10 requests.");
  });

  it("surfaces Android capture details when not already repeated in the header", () => {
    const text = nativeNetworkLogsText({
      status: "ok",
      header: "android-native: stopped, 0 requests (capture stopped by network-capture-stop)",
      armed: false,
      stopped: true,
      capture: "active",
      captureDetail: "OkHttp3 only",
      count: 0,
      total: 0,
      requests: [],
    });
    expect(text).toBe(
      [
        "android-native: stopped, 0 requests (capture stopped by network-capture-stop)",
        "Capture: active (OkHttp3 only)",
      ].join("\n")
    );
  });

  it("carries unknown future fields on the listing and on requests", () => {
    const text = nativeNetworkLogsText({
      status: "ok",
      header: "ios-native: armed, 1 request",
      armed: true,
      count: 1,
      total: 1,
      truncatedByBudget: true,
      requests: [
        {
          id: "ios-1",
          method: "GET",
          url: "https://ex.test/",
          state: "complete",
          status: 200,
          protocol: "h2",
        },
      ],
    });
    expect(text).toBe(
      [
        "ios-native: armed, 1 request",
        "truncatedByBudget",
        '{id: ios-1} "GET https://ex.test/" 200 protocol=h2',
      ].join("\n")
    );
  });

  it("returns undefined for precheck blocks and unknown shapes so they fall back to JSON", () => {
    expect(
      nativeNetworkLogsText({
        status: "restart_required",
        message: "Restart the app to attach native devtools.",
      })
    ).toBeUndefined();
    expect(nativeNetworkLogsText(null)).toBeUndefined();
    expect(nativeNetworkLogsText({ status: "ok", requests: "not-an-array" })).toBeUndefined();
  });
});

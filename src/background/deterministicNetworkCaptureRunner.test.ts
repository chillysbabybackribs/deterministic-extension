import { describe, expect, it } from "vitest";
import {
  formatDeterministicNetworkCaptureForLlm,
  shouldRunDeterministicNetworkCapture,
  type DeterministicNetworkCaptureBundle
} from "./deterministicNetworkCaptureRunner";
import type { CaptureSummary } from "../tools/networkCapture/captureBuffer";

function makeSummary(overrides: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    tabId: 7,
    source: "cdp",
    capturing: true,
    totalRequests: 3,
    dataRequestCount: 3,
    assetRequestCount: 0,
    dataRequestsWithBody: 3,
    droppedRequests: 0,
    totalWebSocketFrames: 0,
    droppedFrames: 0,
    endpoints: [],
    graphqlOperations: [],
    origins: [],
    sensitiveSummary: [],
    webSocketUrls: [],
    ...overrides
  };
}

function makeBundle(overrides: Partial<DeterministicNetworkCaptureBundle> = {}): DeterministicNetworkCaptureBundle {
  return {
    id: "nc1",
    tabId: 7,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    status: "completed",
    capturing: false,
    reloaded: true,
    summary: makeSummary(),
    captureBlocked: false,
    blockedReason: "",
    bodiesUnobtainable: false,
    warnings: [],
    errors: [],
    ...overrides
  };
}

describe("shouldRunDeterministicNetworkCapture", () => {
  it("fires for capture + network intent", () => {
    expect(shouldRunDeterministicNetworkCapture("capture the network requests on this page")).toBe(true);
    expect(shouldRunDeterministicNetworkCapture("trace the api calls this app makes")).toBe(true);
    expect(shouldRunDeterministicNetworkCapture("intercept the graphql traffic")).toBe(true);
  });

  it("fires for api-design questions", () => {
    expect(shouldRunDeterministicNetworkCapture("what endpoints does this site use?")).toBe(true);
    expect(shouldRunDeterministicNetworkCapture("map out the api design here")).toBe(true);
  });

  it("does not fire for unrelated prompts", () => {
    expect(shouldRunDeterministicNetworkCapture("summarize this article")).toBe(false);
    expect(shouldRunDeterministicNetworkCapture("click the login button")).toBe(false);
    expect(shouldRunDeterministicNetworkCapture("")).toBe(false);
  });

  it("does not fire for the word network alone without a capture verb", () => {
    expect(shouldRunDeterministicNetworkCapture("explain neural networks")).toBe(false);
  });
});

describe("formatDeterministicNetworkCaptureForLlm", () => {
  it("reports an unavailable message when capture failed", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      status: "failed",
      summary: undefined,
      errors: ["debugger denied"]
    }));
    expect(text).toContain("Network capture unavailable");
    expect(text).toContain("debugger denied");
  });

  it("renders endpoints, graphql, and origins compactly", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      summary: makeSummary({
        totalRequests: 5,
        endpoints: [
          { method: "GET", origin: "https://api.x.com", path: "/v1/items", count: 3, statuses: [200], sensitiveKinds: [], kind: "data" },
          { method: "POST", origin: "https://api.x.com", path: "/graphql", count: 2, statuses: [200], sensitiveKinds: ["bearer"], kind: "data" }
        ],
        graphqlOperations: [{ operationType: "query", operationName: "GetItems", count: 2 }],
        origins: [{ origin: "https://api.x.com", count: 5 }]
      })
    }));
    expect(text).toContain("GET https://api.x.com/v1/items ×3 [200]");
    expect(text).toContain("POST https://api.x.com/graphql ×2 [200] {sensitive: bearer}");
    expect(text).toContain("query GetItems ×2");
    expect(text).toContain("https://api.x.com: 5");
  });

  it("splits application-data endpoints from static assets in the totals and listing", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      summary: makeSummary({
        source: "web-request",
        totalRequests: 115,
        dataRequestCount: 3,
        assetRequestCount: 112,
        dataRequestsWithBody: 1,
        endpoints: [
          { method: "POST", origin: "https://api.x.com", path: "/graphql", count: 2, statuses: [200], sensitiveKinds: [], kind: "data" },
          { method: "GET", origin: "https://cdn.x.com", path: "/app.js", count: 50, statuses: [200], sensitiveKinds: [], kind: "asset" }
        ],
        origins: [{ origin: "https://cdn.x.com", count: 112 }]
      })
    }));
    expect(text).toContain("3 application-data/API call(s) + 112 static asset(s)");
    expect(text).toContain("Application-data / API endpoints");
    expect(text).toContain("POST https://api.x.com/graphql");
    expect(text).toContain("Static assets: 112 request(s)");
    // The data endpoint is listed; the asset is rolled up by origin, not listed.
    expect(text).not.toContain("/app.js");
  });

  it("emits a TERMINAL LIMITATION marker when data calls exist but no body was captured", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      summary: makeSummary({
        source: "web-request",
        totalRequests: 4,
        dataRequestCount: 2,
        assetRequestCount: 2,
        dataRequestsWithBody: 0,
        endpoints: [
          { method: "GET", origin: "https://api.x.com", path: "/v1/data", count: 2, statuses: [200], sensitiveKinds: [], kind: "data" }
        ]
      })
    }));
    expect(text).toContain("TERMINAL LIMITATION");
    expect(text).toContain("do not replan");
  });

  it("does NOT emit the terminal marker when at least one body was captured", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      summary: makeSummary({
        source: "web-request",
        dataRequestCount: 2,
        dataRequestsWithBody: 1
      })
    }));
    expect(text).not.toContain("TERMINAL LIMITATION");
  });

  it("lists sensitive signals without including values", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      summary: makeSummary({
        sensitiveSummary: [{ kind: "jwt", requestCount: 4 }]
      })
    }));
    expect(text).toContain("jwt: in 4 request(s)");
    expect(text).toContain("values NOT included");
    expect(text).toContain("explicit network dump");
  });

  it("never leaks raw bodies (no requestBody/responseBody keys)", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle());
    expect(text).not.toContain("requestBody");
    expect(text).not.toContain("responseBody");
  });

  it("uses a neutral page-shim source label, not '(limited)'", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      summary: makeSummary({ source: "page-shim" })
    }));
    expect(text).toContain("source: page-shim");
    expect(text).not.toContain("(limited)");
  });

  it("does not claim load-time traffic is missing or blame the build on a zero page-shim result", () => {
    const text = formatDeterministicNetworkCaptureForLlm(makeBundle({
      status: "partial",
      summary: makeSummary({ source: "page-shim", totalRequests: 0 })
    }));
    expect(text).not.toContain("this build");
    expect(text).not.toContain("cannot see load-time traffic");
    expect(text).not.toContain("Load-time requests");
    // Neutral, accurate caveat about cache / service worker instead.
    expect(text.toLowerCase()).toContain("service worker");
  });
});

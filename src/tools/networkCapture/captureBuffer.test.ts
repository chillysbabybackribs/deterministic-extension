import { afterEach, describe, expect, it } from "vitest";
import {
  addFrame,
  addRequest,
  buildSummary,
  clearBuffer,
  createBuffer,
  detectGraphql,
  framePreview,
  mergeShimRequest,
  type CapturedRequest
} from "./captureBuffer";

function makeRequest(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: Math.random().toString(36).slice(2),
    source: "cdp",
    startedAtMs: 0,
    method: "GET",
    url: "https://api.example.com/v1/items",
    requestHeaders: [],
    responseHeaders: [],
    sensitiveKinds: [],
    ...overrides
  };
}

describe("captureBuffer sensitive tagging", () => {
  afterEach(() => clearBuffer(1));

  it("tags Authorization bearer headers", () => {
    const buffer = createBuffer(1, "cdp");
    addRequest(buffer, makeRequest({
      requestHeaders: [{ name: "Authorization", value: "Bearer abc.def.ghi" }]
    }));
    expect(buffer.requests[0].sensitiveKinds).toContain("bearer");
    expect(buffer.requests[0].requestHeaders[0].sensitive).toBe("bearer");
  });

  it("tags JWTs found in a response body", () => {
    const buffer = createBuffer(1, "cdp");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh";
    addRequest(buffer, makeRequest({ responseBody: `{"token":"${jwt}"}` }));
    expect(buffer.requests[0].sensitiveKinds).toContain("jwt");
  });

  it("tags cookie headers and x-api-key", () => {
    const buffer = createBuffer(1, "cdp");
    addRequest(buffer, makeRequest({
      requestHeaders: [
        { name: "Cookie", value: "session=xyz" },
        { name: "X-API-Key", value: "sk_live_123" }
      ]
    }));
    expect(buffer.requests[0].sensitiveKinds).toEqual(expect.arrayContaining(["cookie", "api-key"]));
  });
});

describe("captureBuffer ring buffer", () => {
  afterEach(() => clearBuffer(2));

  it("drops oldest requests past the cap and counts drops", () => {
    const buffer = createBuffer(2, "cdp");
    for (let i = 0; i < 600; i += 1) {
      addRequest(buffer, makeRequest({ id: `r${i}` }));
    }
    expect(buffer.requests.length).toBe(500);
    expect(buffer.droppedRequests).toBe(100);
    expect(buffer.requests[0].id).toBe("r100");
  });
});

describe("detectGraphql", () => {
  it("extracts operation name and type from a query body", () => {
    const gql = detectGraphql("https://x/graphql", JSON.stringify({
      query: "query GetUser($id: ID!) { user(id:$id){ name } }"
    }));
    expect(gql).toEqual({ operationType: "query", operationName: "GetUser" });
  });

  it("uses explicit operationName when present", () => {
    const gql = detectGraphql("https://x/graphql", JSON.stringify({
      operationName: "DoThing",
      query: "mutation DoThing { thing }"
    }));
    expect(gql?.operationName).toBe("DoThing");
    expect(gql?.operationType).toBe("mutation");
  });

  it("returns undefined for non-graphql requests", () => {
    expect(detectGraphql("https://x/api/items", '{"foo":1}')).toBeUndefined();
  });
});

describe("buildSummary", () => {
  afterEach(() => clearBuffer(3));

  it("aggregates endpoints, origins, graphql and sensitive counts", () => {
    const buffer = createBuffer(3, "cdp");
    addRequest(buffer, makeRequest({ url: "https://api.x.com/v1/a", status: 200 }));
    addRequest(buffer, makeRequest({ url: "https://api.x.com/v1/a", status: 200 }));
    addRequest(buffer, makeRequest({
      url: "https://api.x.com/graphql",
      method: "POST",
      requestBody: JSON.stringify({ query: "query Q { a }" }),
      graphql: { operationType: "query", operationName: "Q" }
    }));
    addRequest(buffer, makeRequest({
      url: "https://api.x.com/v1/auth",
      requestHeaders: [{ name: "Authorization", value: "Bearer t.t.t" }]
    }));
    addFrame(buffer, {
      id: "f1", source: "cdp", atMs: 0, url: "wss://x/ws",
      direction: "received", payloadLength: 3, payloadPreview: "abc"
    });

    const summary = buildSummary(buffer, true);
    expect(summary.totalRequests).toBe(4);
    expect(summary.endpoints[0].count).toBe(2);
    expect(summary.endpoints[0].path).toBe("/v1/a");
    expect(summary.graphqlOperations).toEqual([{ operationType: "query", operationName: "Q", count: 1 }]);
    expect(summary.sensitiveSummary).toEqual([{ kind: "bearer", requestCount: 1 }]);
    expect(summary.webSocketUrls).toEqual([{ url: "wss://x/ws", sent: 0, received: 1 }]);
    expect(summary.capturing).toBe(true);
  });
});

describe("mergeShimRequest (web-request + page-shim dedup)", () => {
  afterEach(() => clearBuffer(4));

  it("enriches a matching web-request entry instead of duplicating it", () => {
    const buffer = createBuffer(4, "web-request");
    addRequest(buffer, makeRequest({
      source: "web-request",
      url: "https://api.x.com/v1/data",
      method: "POST",
      startedAtMs: 1_000,
      status: 200,
      responseBodyPending: true
    }));

    mergeShimRequest(buffer, makeRequest({
      source: "page-shim",
      url: "https://api.x.com/v1/data",
      method: "POST",
      startedAtMs: 1_200,
      responseBody: '{"ok":true}',
      requestBody: '{"q":1}'
    }));

    // No duplicate endpoint, and the web-request entry now carries the body.
    expect(buffer.requests).toHaveLength(1);
    expect(buffer.requests[0].source).toBe("web-request");
    expect(buffer.requests[0].responseBody).toBe('{"ok":true}');
    expect(buffer.requests[0].requestBody).toBe('{"q":1}');
    expect(buffer.requests[0].responseBodyPending).toBe(false);
  });

  it("adds a standalone entry when no web-request match exists (shim-only)", () => {
    const buffer = createBuffer(4, "web-request");
    mergeShimRequest(buffer, makeRequest({
      source: "page-shim",
      url: "https://api.x.com/v1/orphan",
      responseBody: "{}"
    }));
    expect(buffer.requests).toHaveLength(1);
    expect(buffer.requests[0].source).toBe("page-shim");
  });

  it("does not merge across a stale time gap", () => {
    const buffer = createBuffer(4, "web-request");
    addRequest(buffer, makeRequest({
      source: "web-request",
      url: "https://api.x.com/v1/data",
      startedAtMs: 0
    }));
    mergeShimRequest(buffer, makeRequest({
      source: "page-shim",
      url: "https://api.x.com/v1/data",
      startedAtMs: 60_000,
      responseBody: "{}"
    }));
    expect(buffer.requests).toHaveLength(2);
  });

  it("re-tags credentials attached only by the shim body", () => {
    const buffer = createBuffer(4, "web-request");
    addRequest(buffer, makeRequest({
      source: "web-request",
      url: "https://api.x.com/v1/login",
      method: "POST",
      startedAtMs: 100,
      responseBodyPending: true
    }));
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefgh";
    mergeShimRequest(buffer, makeRequest({
      source: "page-shim",
      url: "https://api.x.com/v1/login",
      method: "POST",
      startedAtMs: 200,
      responseBody: `{"token":"${jwt}"}`
    }));
    expect(buffer.requests).toHaveLength(1);
    expect(buffer.requests[0].sensitiveKinds).toContain("jwt");
  });
});

describe("framePreview", () => {
  it("truncates long payloads", () => {
    expect(framePreview("a".repeat(5000)).endsWith("...[truncated]")).toBe(true);
    expect(framePreview("short")).toBe("short");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { clearBuffer, createBuffer } from "./captureBuffer";
import { ingestShimEntry } from "./pageShimCapture";

const TAB = 42;

describe("pageShim ingestShimEntry", () => {
  afterEach(() => clearBuffer(TAB));

  it("turns a shim request entry into a buffer request with origin/path and graphql", () => {
    const buffer = createBuffer(TAB, "page-shim");
    ingestShimEntry(buffer, {
      kind: "request",
      id: "shim-1",
      method: "post",
      url: "https://api.example.com/graphql?x=1",
      status: 200,
      statusText: "OK",
      durationMs: 12,
      requestHeaders: [["content-type", "application/json"], ["authorization", "Bearer a.b.c"]],
      responseHeaders: [["content-type", "application/json"]],
      requestBody: JSON.stringify({ query: "query GetX { x }" }),
      responseBody: '{"data":{"x":1}}'
    });

    expect(buffer.requests).toHaveLength(1);
    const r = buffer.requests[0];
    expect(r.source).toBe("page-shim");
    expect(r.origin).toBe("https://api.example.com");
    expect(r.path).toBe("/graphql?x=1");
    expect(r.graphql).toEqual({ operationType: "query", operationName: "GetX" });
    // Sensitive tagging runs on add: the bearer header should be flagged.
    expect(r.sensitiveKinds).toContain("bearer");
  });

  it("turns a shim ws entry into a frame", () => {
    const buffer = createBuffer(TAB, "page-shim");
    ingestShimEntry(buffer, { kind: "ws", url: "wss://x/sock", direction: "received", payload: "hello" });
    expect(buffer.webSocketFrames).toHaveLength(1);
    expect(buffer.webSocketFrames[0].direction).toBe("received");
    expect(buffer.webSocketFrames[0].url).toBe("wss://x/sock");
    expect(buffer.webSocketFrames[0].payloadLength).toBe(5);
  });

  it("propagates the preStart marker onto flushed request and frame entries", () => {
    const buffer = createBuffer(TAB, "page-shim");
    ingestShimEntry(buffer, {
      kind: "request",
      id: "pre-1",
      method: "GET",
      url: "https://x/boot",
      requestHeaders: [],
      responseHeaders: [],
      preStart: true
    });
    ingestShimEntry(buffer, { kind: "ws", url: "wss://x/s", direction: "sent", payload: "hi", preStart: true });
    expect(buffer.requests[0].preStart).toBe(true);
    expect(buffer.webSocketFrames[0].preStart).toBe(true);
  });

  it("leaves preStart undefined for live entries (no schema noise)", () => {
    const buffer = createBuffer(TAB, "page-shim");
    ingestShimEntry(buffer, {
      kind: "request",
      id: "live-1",
      method: "GET",
      url: "https://x/y",
      requestHeaders: [],
      responseHeaders: []
    });
    expect(buffer.requests[0].preStart).toBeUndefined();
  });

  it("clamps oversized bodies", () => {
    const buffer = createBuffer(TAB, "page-shim");
    ingestShimEntry(buffer, {
      kind: "request",
      id: "big",
      method: "GET",
      url: "https://x/y",
      requestHeaders: [],
      responseHeaders: [],
      responseBody: "z".repeat(500_000)
    });
    const body = buffer.requests[0].responseBody ?? "";
    expect(body.length).toBeLessThan(500_000);
    expect(body).toContain("truncated");
  });
});

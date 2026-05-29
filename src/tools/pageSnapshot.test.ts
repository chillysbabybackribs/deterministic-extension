import { afterEach, describe, expect, it } from "vitest";
import { snapshotFromFetchedText, snapshotTab } from "./pageSnapshot";

const originalChromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

describe("page snapshot extraction", () => {
  afterEach(() => {
    restoreGlobal("chrome", originalChromeDescriptor);
    restoreGlobal("document", originalDocumentDescriptor);
    restoreGlobal("location", originalLocationDescriptor);
    restoreGlobal("window", originalWindowDescriptor);
  });

  it("extracts fetched HTML metadata, code blocks, and price candidates", () => {
    const snapshot = snapshotFromFetchedText(
      "https://example.com/pricing",
      `
        <html lang="en">
          <head>
            <title>Example Pricing</title>
            <meta name="author" content="Example Team">
            <meta property="og:site_name" content="Example">
            <meta property="article:published_time" content="2026-05-10">
          </head>
          <body>
            <h1>Plans</h1>
            <p>Starter is $19 per month and Pro is USD 49 per month.</p>
            <pre class="language-ts">const plan = "pro";</pre>
          </body>
        </html>
      `,
      "text/html",
      4000
    );

    expect(snapshot.title).toBe("Example Pricing");
    expect(snapshot.metadata?.author).toBe("Example Team");
    expect(snapshot.metadata?.publishedTime).toBe("2026-05-10");
    expect(snapshot.codeBlocks?.[0]).toMatchObject({
      language: "ts",
      text: 'const plan = "pro";'
    });
    expect(snapshot.priceCandidates?.map((candidate) => candidate.text)).toEqual(["$19", "USD 49"]);
  });

  it("extracts targeted sections from below the main text cap", () => {
    const snapshot = snapshotFromFetchedText(
      "https://example.com/docs/limits",
      `
        <html>
          <body>
            <h1>Documentation</h1>
            <p>${"Introductory documentation text. ".repeat(80)}</p>
            <h2>Rate limits</h2>
            <p>The API allows 120 requests per minute for standard projects.</p>
          </body>
        </html>
      `,
      "text/html",
      200,
      { targetedTerms: ["rate limits", "requests"] }
    );

    expect(snapshot.text).not.toContain("120 requests per minute");
    expect(snapshot.targetedSections?.[0]).toMatchObject({
      matchedTerms: expect.arrayContaining(["requests"])
    });
    expect(snapshot.targetedSections?.[0]?.text).toContain("120 requests per minute");
    expect(snapshot.truncation?.text).toBe(true);
  });

  it("preserves table rows from fetched HTML snapshots", () => {
    const snapshot = snapshotFromFetchedText(
      "https://example.com/docs/batch",
      `
        <html>
          <body>
            <h1>Batch API reference</h1>
            <table>
              <caption>Batch limits</caption>
              <tr><th>Field</th><th>Value</th></tr>
              <tr><td>Completion window</td><td>24 hours</td></tr>
              <tr><td>Request size</td><td>50,000 requests</td></tr>
              <tr><td>Discount</td><td>50%</td></tr>
            </table>
          </body>
        </html>
      `,
      "text/html",
      4000
    );

    expect(snapshot.tables?.[0]).toMatchObject({
      caption: "Batch limits",
      headers: ["Field", "Value"],
      rows: [
        ["Completion window", "24 hours"],
        ["Request size", "50,000 requests"],
        ["Discount", "50%"]
      ]
    });
    expect(snapshot.text).toContain("Completion window");
  });

  it("extracts useful visible text from an injected HTTPS page snapshot", async () => {
    installInjectedSnapshotHarness({
      url: "https://example.com/",
      title: "Example Domain",
      text: "Example Domain\n\nThis domain is for use in illustrative examples in documents.",
      headings: ["Example Domain"]
    });

    const snapshot = await snapshotTab(7, {
      maxChars: 4000,
      includeLinks: true,
      includeStructured: true,
      targetedTerms: ["illustrative examples"],
      fullTextMaxChars: 8000
    });

    expect(snapshot.url).toBe("https://example.com/");
    expect(snapshot.title).toBe("Example Domain");
    expect(snapshot.text).toContain("illustrative examples");
    expect(snapshot.headings).toEqual(["Example Domain"]);
    expect(snapshot.sections?.[0]?.text).toContain("This domain is for use");
    expect(snapshot.targetedSections?.[0]?.text).toContain("illustrative examples");
  });

  it("extracts useful visible text from an injected localhost HTTP page snapshot", async () => {
    installInjectedSnapshotHarness({
      url: "http://localhost:3000/",
      title: "Local Fixture",
      text: "Local Fixture\n\nCurrent development UI is ready.",
      headings: ["Local Fixture"]
    });

    const snapshot = await snapshotTab(8, {
      maxChars: 4000,
      includeLinks: false,
      includeStructured: true,
      fullTextMaxChars: 8000
    });

    expect(snapshot.url).toBe("http://localhost:3000/");
    expect(snapshot.title).toBe("Local Fixture");
    expect(snapshot.text).toContain("development UI");
    expect(snapshot.sections?.[0]?.headingPath).toEqual(["Local Fixture"]);
  });

  it("surfaces a clear failure when an injected snapshot returns no content", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        scripting: {
          executeScript: async () => [{ result: undefined }]
        }
      }
    });

    await expect(snapshotTab(9, {
      maxChars: 4000,
      includeLinks: false,
      includeStructured: true
    })).rejects.toThrow("Page snapshot returned no content.");
  });
});

function installInjectedSnapshotHarness(args: {
  url: string;
  title: string;
  text: string;
  headings: string[];
}): void {
  const headingElements = args.headings.map((heading) => ({ textContent: heading }));
  const fakeDocument = {
    title: args.title,
    body: {
      innerText: args.text
    },
    documentElement: {
      lang: "en"
    },
    links: [{
      textContent: "More information",
      href: `${args.url.replace(/\/$/, "")}/more`
    }],
    forms: [],
    querySelector: (selector: string) => {
      if (selector === 'meta[name="description"]' || selector === 'meta[property="og:description"]') {
        return { content: "Fixture page description." };
      }
      if (selector === 'link[rel="canonical"]') {
        return { href: args.url };
      }
      return undefined;
    },
    querySelectorAll: (selector: string) => {
      if (selector === "h1, h2, h3") {
        return headingElements;
      }
      if (selector === "table" || selector === "pre, code") {
        return [];
      }
      return [];
    }
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: args.url }
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      getSelection: () => ({ toString: () => "" })
    }
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      scripting: {
        executeScript: async ({ func, args: scriptArgs }: {
          func: (...values: unknown[]) => unknown;
          args: unknown[];
        }) => [{ result: func(...scriptArgs) }]
      }
    }
  });
}

function restoreGlobal(
  key: "chrome" | "document" | "location" | "window",
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }

  Reflect.deleteProperty(globalThis, key);
}

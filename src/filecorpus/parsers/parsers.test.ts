import { describe, expect, it } from "vitest";
import { parseDelimited, parseDelimitedRows } from "./delimited";
import { parseText } from "./text";

describe("parseText", () => {
  it("splits prose into paragraphs and drops too-short fragments", () => {
    const { units } = parseText(
      "This is a sufficiently long first paragraph of prose.\n\nhi\n\nAnother sufficiently long second paragraph here.",
      false
    );
    expect(units).toHaveLength(2);
    expect(units[0].kind).toBe("paragraph");
    expect(units[0].text).toContain("first paragraph");
  });

  it("tracks markdown heading hierarchy as headingPath", () => {
    const md = [
      "# Pricing",
      "",
      "Intro paragraph about pricing that is long enough to keep.",
      "",
      "## Enterprise",
      "",
      "The enterprise tier paragraph that is also long enough to keep."
    ].join("\n");
    const { units } = parseText(md, true);

    const enterprisePara = units.find((unit) => unit.text.includes("enterprise tier"));
    expect(enterprisePara?.address.headingPath).toEqual(["Pricing", "Enterprise"]);

    const headingUnits = units.filter((unit) => unit.structure.isHeading);
    expect(headingUnits.map((unit) => unit.text)).toEqual(["Pricing", "Enterprise"]);
  });

  it("treats plain-text numbered sections as headings and list lines as units", () => {
    const doc = [
      "1. Reconnaissance & Scanning",
      "Nmap - Network scanning, service enumeration",
      "Amass - Subdomain enumeration and mapping",
      "2. Vulnerability Scanning",
      "SQLmap - SQL injection detection and exploitation"
    ].join("\n");
    const { units } = parseText(doc, false);

    const headings = units.filter((u) => u.structure.isHeading).map((u) => u.text);
    expect(headings).toEqual(["Reconnaissance & Scanning", "Vulnerability Scanning"]);

    // Each tool line is its own unit (not collapsed into one blob).
    const nmap = units.find((u) => u.text.startsWith("Nmap"));
    expect(nmap).toBeDefined();
    expect(nmap?.address.headingPath).toEqual(["Reconnaissance & Scanning"]);

    const sqlmap = units.find((u) => u.text.startsWith("SQLmap"));
    expect(sqlmap?.address.headingPath).toEqual(["Vulnerability Scanning"]);
  });

  it("splits bullet lists into one unit per item", () => {
    const { units } = parseText("- first tool here\n- second tool here\n- third tool here", false);
    expect(units).toHaveLength(3);
    expect(units[0].text).toBe("first tool here");
  });

  it("does not mistake a prose sentence starting with a number for a heading", () => {
    const { units } = parseText(
      "1. This is actually a full sentence of prose that ends with punctuation.",
      false
    );
    expect(units.some((u) => u.structure.isHeading)).toBe(false);
  });

  it("pops sibling/deeper headings off the stack correctly", () => {
    const md = [
      "# A",
      "",
      "Paragraph under A that is long enough to be kept here.",
      "",
      "## A1",
      "",
      "Paragraph under A1 that is long enough to be kept here too.",
      "",
      "# B",
      "",
      "Paragraph under B that is long enough to be kept in the corpus."
    ].join("\n");
    const { units } = parseText(md, true);
    expect(units.find((u) => u.text.includes("under A1"))?.address.headingPath).toEqual(["A", "A1"]);
    expect(units.find((u) => u.text.includes("under B"))?.address.headingPath).toEqual(["B"]);
  });
});

describe("parseDelimitedRows", () => {
  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseDelimitedRows('a,"b,c","d""e"\n1,2,3', ",");
    expect(rows[0]).toEqual(["a", "b,c", 'd"e']);
    expect(rows[1]).toEqual(["1", "2", "3"]);
  });

  it("handles a trailing row without a final newline", () => {
    const rows = parseDelimitedRows("x,y\n1,2", ",");
    expect(rows).toHaveLength(2);
  });
});

describe("parseDelimited", () => {
  it("builds one row unit per data row with header-flattened text and columns", () => {
    const csv = "Name,Revenue\nAcme,100\nGlobex,250";
    const { units } = parseDelimited(csv, ",");
    expect(units).toHaveLength(2);
    expect(units[0].kind).toBe("row");
    expect(units[0].text).toBe("Name: Acme | Revenue: 100");
    expect(units[0].address.columns).toEqual({ Name: "Acme", Revenue: "100" });
    expect(units[0].address.rowIndex).toBe(1);
    expect(units[0].structure.headerColumns).toEqual(["Name", "Revenue"]);
  });

  it("parses TSV with the tab delimiter", () => {
    const tsv = "Country\tCode\nFrance\tFR\nSpain\tES";
    const { units } = parseDelimited(tsv, "\t");
    expect(units).toHaveLength(2);
    expect(units[1].text).toBe("Country: Spain | Code: ES");
  });

  it("skips fully-empty rows", () => {
    const { units } = parseDelimited("A,B\n1,2\n,\n3,4", ",");
    expect(units).toHaveLength(2);
  });
});

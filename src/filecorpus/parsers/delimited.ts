/**
 * Parse CSV / TSV into row units. A small RFC-4180-ish parser (handles quoted
 * fields, embedded delimiters, escaped quotes, CRLF) — intentionally not a
 * dependency. The first row is the header; each data row becomes one `row` unit
 * whose text flattens "Header: value | …" so lexical search hits both header
 * names and cell values.
 */

import type { ParseResult, ParsedUnit } from "./types";

/** Split delimited content into a matrix of rows × fields. */
export function parseDelimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += char;
    }
  }
  // Trailing field/row (no final newline).
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function parseDelimited(content: string, delimiter: string): ParseResult {
  const matrix = parseDelimitedRows(content, delimiter).filter((row) =>
    row.some((cell) => cell.trim() !== "")
  );
  if (!matrix.length) {
    return { units: [], warnings: ["The delimited file appears to be empty."] };
  }

  const headers = matrix[0].map((header) => header.trim());
  const units: ParsedUnit[] = [];

  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const cells = matrix[rowIndex];
    const columns: Record<string, string> = {};
    const parts: string[] = [];
    for (let col = 0; col < headers.length; col += 1) {
      const header = headers[col] || `Column ${col + 1}`;
      const value = (cells[col] ?? "").trim();
      columns[header] = value;
      if (value) {
        parts.push(`${header}: ${value}`);
      }
    }
    const text = parts.join(" | ");
    if (!text) {
      continue;
    }
    units.push({
      kind: "row",
      text,
      address: { rowIndex, columns },
      structure: { headerColumns: headers }
    });
  }

  return { units, warnings: [] };
}

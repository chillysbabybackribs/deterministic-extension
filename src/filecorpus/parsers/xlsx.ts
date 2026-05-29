/**
 * Parse an XLSX workbook into row units, one per data row per sheet, tagged
 * with sheet name + 1-based row index. SheetJS (`xlsx`) is dynamically imported
 * so it only loads when a spreadsheet is actually ingested.
 *
 * Row text flattens "Header: value | …" (same shape as the CSV parser) so
 * lexical search hits header names and cell values alike.
 */

import type { ParseResult, ParsedUnit } from "./types";

export async function parseXlsx(bytes: ArrayBuffer): Promise<ParseResult> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "array" });
  const units: ParsedUnit[] = [];
  const warnings: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
    if (!matrix.length) {
      continue;
    }

    const headers = (matrix[0] as unknown[]).map((header, index) =>
      String(header ?? "").trim() || `Column ${index + 1}`
    );

    for (let row = 1; row < matrix.length; row += 1) {
      const cells = matrix[row] as unknown[];
      const columns: Record<string, string> = {};
      const parts: string[] = [];
      for (let col = 0; col < headers.length; col += 1) {
        const value = cells[col] === undefined || cells[col] === null ? "" : String(cells[col]).trim();
        columns[headers[col]] = value;
        if (value) {
          parts.push(`${headers[col]}: ${value}`);
        }
      }
      const text = parts.join(" | ");
      if (!text) {
        continue;
      }
      units.push({
        kind: "row",
        text,
        address: { sheet: sheetName, rowIndex: row, columns },
        structure: { headerColumns: headers }
      });
    }
  }

  if (!units.length) {
    warnings.push("No data rows found in the workbook.");
  }

  return { units, warnings };
}

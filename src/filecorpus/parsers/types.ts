import type { FileUnitAddress, FileUnitStructure, UnitKind } from "../corpusTypes";

/**
 * A unit produced by a parser, before it is assigned a stable id/ordinal and
 * indexed. Parsers are pure (string/bytes -> ParsedUnit[]); ingest.ts assembles
 * the final FileCorpus.
 */
export type ParsedUnit = {
  kind: UnitKind;
  text: string;
  address: FileUnitAddress;
  structure: FileUnitStructure;
};

export type ParseResult = {
  units: ParsedUnit[];
  warnings: string[];
};

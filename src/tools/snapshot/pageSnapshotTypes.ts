export type PageLink = {
  text: string;
  url: string;
};

export type PageMetadata = {
  canonicalUrl?: string;
  language?: string;
  author?: string;
  publishedTime?: string;
  modifiedTime?: string;
  siteName?: string;
  pageType?: string;
  keywords?: string[];
};

export type PageTable = {
  caption?: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated?: boolean;
};

export type PageCodeBlock = {
  language?: string;
  text: string;
  truncated?: boolean;
};

export type PageFormField = {
  label?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
};

export type PageForm = {
  id?: string;
  name?: string;
  action?: string;
  method?: string;
  fields: PageFormField[];
};

export type PagePriceCandidate = {
  text: string;
  context: string;
  truncated?: boolean;
};

export type PageTargetedSection = {
  headingPath?: string[];
  matchedTerms: string[];
  text: string;
  truncated?: boolean;
};

export type PageTextSection = {
  headingPath?: string[];
  text: string;
  start: number;
  truncated?: boolean;
};

export type PageSnapshotTruncation = {
  html?: boolean;
  text?: boolean;
  fullText?: boolean;
  sections?: boolean;
  tables?: boolean;
  tableRows?: boolean;
  codeBlocks?: boolean;
  priceCandidates?: boolean;
  targetedSections?: boolean;
};

export type PageSnapshot = {
  url: string;
  title: string;
  description?: string;
  metadata?: PageMetadata;
  headings: string[];
  selection?: string;
  text: string;
  fullText?: string;
  sections?: PageTextSection[];
  links: PageLink[];
  tables?: PageTable[];
  codeBlocks?: PageCodeBlock[];
  forms?: PageForm[];
  priceCandidates?: PagePriceCandidate[];
  targetedSections?: PageTargetedSection[];
  truncation?: PageSnapshotTruncation;
};

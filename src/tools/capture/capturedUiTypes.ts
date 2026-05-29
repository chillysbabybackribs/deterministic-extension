export type CapturedUiViewport = {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
};

export type CapturedUiPointer = {
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
};

export type CapturedUiBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CapturedUiStyleSummary = {
  display: string;
  position: string;
  color: string;
  backgroundColor: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  padding: string;
  margin: string;
  border: string;
  borderRadius: string;
  boxShadow: string;
};

export type CapturedUiStyleProfile = {
  typography?: {
    fontFamily?: string;
    fontSize?: string;
    fontWeight?: string;
    lineHeight?: string;
  };
  colors?: {
    text?: string;
    background?: string;
  };
  spacing?: {
    padding?: string;
    margin?: string;
  };
  shape?: {
    border?: string;
    borderRadius?: string;
    boxShadow?: string;
  };
  layout?: {
    display?: string;
    position?: string;
  };
  visualTags: string[];
};

export type CapturedUiLayoutElementSummary = {
  tagName: string;
  role?: string;
  label?: string;
  selector?: string;
  selectorConfidence?: CapturedUiSelectorConfidence;
  bounds?: CapturedUiBounds;
  display?: string;
};

export type CapturedUiLayoutContext = {
  parent?: CapturedUiLayoutElementSummary & {
    flexDirection?: string;
    alignItems?: string;
    justifyContent?: string;
    gap?: string;
    gridTemplateColumns?: string;
  };
  nearestSemanticContainer?: CapturedUiLayoutElementSummary;
  previousSiblings: CapturedUiLayoutElementSummary[];
  nextSiblings: CapturedUiLayoutElementSummary[];
  children: CapturedUiLayoutElementSummary[];
  childCount: number;
  siblingCount: number;
};

export type CapturedUiAssetImage = {
  src?: string;
  alt?: string;
  selector?: string;
  selectorConfidence?: CapturedUiSelectorConfidence;
  bounds?: CapturedUiBounds;
  loading?: string;
};

export type CapturedUiAssetSvg = {
  selector?: string;
  selectorConfidence?: CapturedUiSelectorConfidence;
  bounds?: CapturedUiBounds;
  title?: string;
  ariaLabel?: string;
  role?: string;
  iconLike: boolean;
};

export type CapturedUiAssetBackgroundImage = {
  url: string;
  selector?: string;
  selectorConfidence?: CapturedUiSelectorConfidence;
};

export type CapturedUiAssetVideo = {
  src?: string;
  poster?: string;
  selector?: string;
  selectorConfidence?: CapturedUiSelectorConfidence;
  bounds?: CapturedUiBounds;
};

export type CapturedUiAssetProfile = {
  images: CapturedUiAssetImage[];
  svgs: CapturedUiAssetSvg[];
  backgroundImages: CapturedUiAssetBackgroundImage[];
  videos: CapturedUiAssetVideo[];
};

export type CapturedUiAccessibilityProfile = {
  role?: string;
  accessibleName?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  associatedLabel?: string;
  focusable: boolean;
  tabIndex?: number;
  disabled?: boolean;
  required?: boolean;
  contrast?: {
    foreground: string;
    background: string;
    ratio: number;
    passesAA: boolean;
  };
  issues: string[];
};

export type CapturedUiCssVariableClue = {
  name: string;
  value: string;
  source: "element" | "root";
};

export type CapturedUiSourceClues = {
  documentLanguage?: string;
  colorScheme?: string;
  metaGenerator?: string;
  frameworkHints: string[];
  componentLibraryHints: string[];
  cssFiles: string[];
  fontFamilies: string[];
  cssVariables: CapturedUiCssVariableClue[];
  scriptHints: string[];
};

export type CapturedUiComponentKind =
  | "button"
  | "link"
  | "input"
  | "image"
  | "icon"
  | "text"
  | "nav"
  | "form"
  | "card"
  | "section"
  | "media"
  | "unknown";

export type CapturedUiComponentIntent = "action" | "navigation" | "input" | "content" | "layout" | "media" | "unknown";

export type CapturedUiComponentIR = {
  kind: CapturedUiComponentKind;
  intent: CapturedUiComponentIntent;
  confidence: CapturedUiSelectorConfidence;
  score: number;
  label?: string;
  role?: string;
  tagName: string;
  selector: string;
  content?: {
    text?: string;
    href?: string;
    src?: string;
    alt?: string;
    placeholder?: string;
    valuePreview?: string;
  };
  behavior?: {
    disabled?: boolean;
    checked?: boolean;
    type?: string;
    focusable?: boolean;
  };
  structure?: {
    container?: string;
    parentDisplay?: string;
    childCount?: number;
    siblingCount?: number;
    hasIcon?: boolean;
    hasImage?: boolean;
  };
  appearance?: {
    typography?: CapturedUiStyleProfile["typography"];
    colors?: CapturedUiStyleProfile["colors"];
    spacing?: CapturedUiStyleProfile["spacing"];
    shape?: CapturedUiStyleProfile["shape"];
    layout?: CapturedUiStyleProfile["layout"];
    visualTags: string[];
  };
  accessibility?: {
    accessibleName?: string;
    focusable?: boolean;
    issues?: string[];
  };
  sourceHints?: {
    frameworks?: string[];
    componentLibraries?: string[];
    fonts?: string[];
  };
  templateHints: string[];
  limitations: string[];
};

export type CapturedUiQualityProfile = {
  confidence: CapturedUiSelectorConfidence;
  score: number;
  stableSelector: boolean;
  promotedTarget: boolean;
  usableForTemplate: boolean;
  signals: string[];
  limitations: string[];
};

export type CapturedUiIntelligenceProfiles = {
  style?: CapturedUiStyleProfile;
  layoutContext?: CapturedUiLayoutContext;
  assets?: CapturedUiAssetProfile;
  accessibility?: CapturedUiAccessibilityProfile;
  sourceClues?: CapturedUiSourceClues;
  component?: CapturedUiComponentIR;
  quality?: CapturedUiQualityProfile;
};

export type CapturedUiSelectorConfidence = "high" | "medium" | "low";

export type CapturedUiElement = {
  selector: string;
  selectorConfidence: CapturedUiSelectorConfidence;
  tagName: string;
  id?: string;
  classNames: string[];
  textPreview?: string;
  role?: string;
  ariaLabel?: string;
  accessibleName?: string;
  href?: string;
  src?: string;
  alt?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  valuePreview?: string;
  dataAttributes: Record<string, string>;
  bounds: CapturedUiBounds;
  computedStyle: CapturedUiStyleSummary;
};

export type CapturedUiHitElement = Omit<CapturedUiElement, "computedStyle" | "dataAttributes"> & {
  dataAttributes?: Record<string, string>;
};

export type CapturedUiReference = {
  captureId: string;
  url: string;
  title: string;
  viewport: CapturedUiViewport;
  pointer: CapturedUiPointer;
  element: CapturedUiElement;
  hitElement?: CapturedUiHitElement;
  profiles?: CapturedUiIntelligenceProfiles;
};

export type CapturedUiDisplaySummary = {
  title: string;
  subtitle: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDomain: string;
  elementLabel: string;
  elementDescription: string;
  selector: string;
  selectorConfidence: CapturedUiSelectorConfidence;
  tagName: string;
  role?: string;
  bounds?: {
    width: number;
    height: number;
  };
  styleSummary?: {
    font?: string;
    color?: string;
    background?: string;
    radius?: string;
    shadow?: string;
  };
  semanticContext?: string;
  hitElement?: string;
  component?: {
    kind: CapturedUiComponentKind;
    intent: CapturedUiComponentIntent;
    confidence: CapturedUiSelectorConfidence;
    templateHints: string[];
    limitations: string[];
  };
};

export type CaptureScriptResult =
  | {
      status: "captured";
      capture: CapturedUiReference;
    }
  | {
      status: "cancelled";
    };

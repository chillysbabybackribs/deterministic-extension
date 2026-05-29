export type PageObservedElement = {
  ref: string;
  selector: string;
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled: boolean;
  editable: boolean;
  visible: boolean;
  required?: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type PageObservation = {
  url: string;
  title: string;
  readyState: DocumentReadyState;
  viewport: {
    width: number;
    height: number;
  };
  scroll: {
    x: number;
    y: number;
    maxY: number;
  };
  textSample: string;
  elements: PageObservedElement[];
  frameCount: number;
  warnings: string[];
};

export type PageActionTarget = {
  /**
   * Deterministic handle from the actionable overlay: the 1-based badge index.
   * When present it resolves to the EXACT element the overlay marked, via the
   * stamped [data-ohmygod-idx="N"] attribute — no text/selector guessing.
   */
  overlayIndex?: number;
  elementRef?: string;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  index?: number;
};

export type PageActionOptions = {
  text?: string;
  clear?: boolean;
  value?: string;
  optionText?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
  amount?: number;
  maxElements?: number;
};

export type PageInteractionAction =
  | "click"
  | "type"
  | "select"
  | "press"
  | "scroll";

export type PageInteractionResult = {
  action: PageInteractionAction;
  ok: boolean;
  message: string;
  url: string;
  title: string;
  target?: PageObservedElement;
  warnings: string[];
};

export type PageCondition = {
  selector?: string;
  text?: string;
  urlIncludes?: string;
  titleIncludes?: string;
  elementState?: "present" | "visible" | "hidden" | "absent";
};

export type PageConditionCheck = {
  condition: PageCondition;
  satisfied: boolean;
  url: string;
  title: string;
  readyState: DocumentReadyState;
  selectorMatched?: boolean;
  textMatched?: boolean;
  urlMatched?: boolean;
  titleMatched?: boolean;
  elementVisible?: boolean;
  textSample: string;
};

export type ObserveOptions = {
  maxElements?: number;
  includeInvisible?: boolean;
};

export type PageActionTargetSource = PageActionTarget & {
  target?: unknown;
};

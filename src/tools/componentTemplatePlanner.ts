import type {
  CapturedUiComponentIR,
  CapturedUiComponentKind,
  CapturedUiReference,
  CapturedUiSelectorConfidence
} from "./pageCapture";

export type ComponentTemplateName =
  | "Button"
  | "Link"
  | "Input"
  | "Image"
  | "Icon"
  | "Text"
  | "Nav"
  | "Form"
  | "Card"
  | "Section"
  | "Media"
  | "Unknown";

export type ComponentTemplatePrimitive =
  | "Button"
  | "Link"
  | "Input"
  | "Image"
  | "Icon"
  | "Text"
  | "Typography"
  | "Nav"
  | "Form"
  | "Card"
  | "Section"
  | "Media";

export type ComponentTemplateStyleTokensWanted = {
  bg?: string;
  fg?: string;
  border?: string;
  radius?: string;
  padding?: string;
  margin?: string;
  shadow?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
};

export type ComponentTemplateLayoutTokensWanted = {
  display?: string;
  position?: string;
  parentDisplay?: string;
  childCount?: number;
  siblingCount?: number;
  hasIcon?: boolean;
  hasImage?: boolean;
};

export type ComponentTemplatePlan = {
  template: ComponentTemplateName;
  sourceKind: CapturedUiComponentKind;
  intent: CapturedUiComponentIR["intent"];
  confidence: CapturedUiSelectorConfidence;
  score: number;
  selector: string;
  props: Record<string, string | number | boolean>;
  styleTokensWanted: ComponentTemplateStyleTokensWanted;
  layoutTokensWanted: ComponentTemplateLayoutTokensWanted;
  requiredPrimitives: ComponentTemplatePrimitive[];
  templateHints: string[];
  limitations: string[];
  warnings: string[];
};

export function planComponentTemplate(reference: CapturedUiReference): ComponentTemplatePlan {
  const component = reference.profiles?.component;
  if (!component) {
    return planUnknownTemplate(reference, ["component profile is missing"]);
  }

  const template = templateNameForKind(component.kind);
  const props = propsForComponent(component);
  const styleTokensWanted = styleTokensForComponent(component);
  const layoutTokensWanted = layoutTokensForComponent(component);
  const limitations = Array.from(new Set(component.limitations));
  const warnings = warningsForComponent(reference, component, template);

  return {
    template,
    sourceKind: component.kind,
    intent: component.intent,
    confidence: component.confidence,
    score: component.score,
    selector: component.selector,
    props,
    styleTokensWanted,
    layoutTokensWanted,
    requiredPrimitives: primitivesForTemplate(template),
    templateHints: component.templateHints,
    limitations,
    warnings
  };
}

function planUnknownTemplate(reference: CapturedUiReference, warnings: string[]): ComponentTemplatePlan {
  return {
    template: "Unknown",
    sourceKind: "unknown",
    intent: "unknown",
    confidence: "low",
    score: 0,
    selector: reference.element.selector,
    props: {},
    styleTokensWanted: styleTokensForComponentLikeReference(reference),
    layoutTokensWanted: {},
    requiredPrimitives: [],
    templateHints: [],
    limitations: ["component kind could not be planned"],
    warnings
  };
}

function templateNameForKind(kind: CapturedUiComponentKind): ComponentTemplateName {
  switch (kind) {
    case "button":
      return "Button";
    case "link":
      return "Link";
    case "input":
      return "Input";
    case "image":
      return "Image";
    case "icon":
      return "Icon";
    case "text":
      return "Text";
    case "nav":
      return "Nav";
    case "form":
      return "Form";
    case "card":
      return "Card";
    case "section":
      return "Section";
    case "media":
      return "Media";
    case "unknown":
      return "Unknown";
  }
}

function propsForComponent(component: CapturedUiComponentIR): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {};
  const content = component.content;
  const behavior = component.behavior;
  const accessibility = component.accessibility;

  if (component.kind === "button") {
    assignString(props, "children", content?.text ?? component.label);
    assignString(props, "type", behavior?.type);
    assignBoolean(props, "disabled", behavior?.disabled);
  } else if (component.kind === "link") {
    assignString(props, "children", content?.text ?? component.label ?? accessibility?.accessibleName);
    assignString(props, "href", content?.href);
  } else if (component.kind === "input") {
    assignString(props, "name", inputNameFromSelector(component.selector));
    assignString(props, "type", behavior?.type);
    assignString(props, "placeholder", content?.placeholder);
    assignString(props, "defaultValue", content?.valuePreview);
    assignBoolean(props, "disabled", behavior?.disabled);
    assignBoolean(props, "checked", behavior?.checked);
    assignString(props, "aria-label", accessibility?.accessibleName ?? component.label);
  } else if (component.kind === "image") {
    assignString(props, "src", content?.src);
    assignString(props, "alt", content?.alt ?? component.label);
  } else if (component.kind === "icon") {
    assignString(props, "aria-label", accessibility?.accessibleName ?? component.label);
    assignBoolean(props, "aria-hidden", !(accessibility?.accessibleName ?? component.label));
  } else if (component.kind === "text") {
    assignString(props, "children", content?.text ?? component.label);
  } else if (component.kind === "card" || component.kind === "section") {
    assignString(props, "children", content?.text ?? component.label);
    assignNumber(props, "childCount", component.structure?.childCount);
  } else if (component.kind === "nav") {
    assignString(props, "aria-label", accessibility?.accessibleName ?? component.label);
    assignNumber(props, "itemCount", component.structure?.childCount);
  } else if (component.kind === "form") {
    assignString(props, "aria-label", accessibility?.accessibleName ?? component.label);
    assignNumber(props, "fieldCount", component.structure?.childCount);
  } else if (component.kind === "media") {
    assignString(props, "src", content?.src);
    assignString(props, "alt", content?.alt ?? component.label);
  }

  return props;
}

function styleTokensForComponent(component: CapturedUiComponentIR): ComponentTemplateStyleTokensWanted {
  const appearance = component.appearance;
  return omitUndefinedStyleTokens({
    bg: appearance?.colors?.background,
    fg: appearance?.colors?.text,
    border: appearance?.shape?.border,
    radius: appearance?.shape?.borderRadius,
    padding: appearance?.spacing?.padding,
    margin: appearance?.spacing?.margin,
    shadow: appearance?.shape?.boxShadow,
    fontFamily: appearance?.typography?.fontFamily,
    fontSize: appearance?.typography?.fontSize,
    fontWeight: appearance?.typography?.fontWeight,
    lineHeight: appearance?.typography?.lineHeight
  });
}

function styleTokensForComponentLikeReference(reference: CapturedUiReference): ComponentTemplateStyleTokensWanted {
  const style = reference.element.computedStyle;
  return omitUndefinedStyleTokens({
    bg: style.backgroundColor,
    fg: style.color,
    border: style.border,
    radius: style.borderRadius,
    padding: style.padding,
    margin: style.margin,
    shadow: style.boxShadow,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight
  });
}

function layoutTokensForComponent(component: CapturedUiComponentIR): ComponentTemplateLayoutTokensWanted {
  const structure = component.structure;
  return omitUndefinedLayoutTokens({
    display: component.appearance?.layout?.display,
    position: component.appearance?.layout?.position,
    parentDisplay: structure?.parentDisplay,
    childCount: structure?.childCount,
    siblingCount: structure?.siblingCount,
    hasIcon: structure?.hasIcon,
    hasImage: structure?.hasImage
  });
}

function primitivesForTemplate(template: ComponentTemplateName): ComponentTemplatePrimitive[] {
  switch (template) {
    case "Button":
      return ["Button"];
    case "Link":
      return ["Link"];
    case "Input":
      return ["Input"];
    case "Image":
      return ["Image"];
    case "Icon":
      return ["Icon"];
    case "Text":
      return ["Text", "Typography"];
    case "Nav":
      return ["Nav", "Link"];
    case "Form":
      return ["Form", "Input"];
    case "Card":
      return ["Card"];
    case "Section":
      return ["Section"];
    case "Media":
      return ["Media"];
    case "Unknown":
      return [];
  }
}

function warningsForComponent(
  reference: CapturedUiReference,
  component: CapturedUiComponentIR,
  template: ComponentTemplateName
): string[] {
  const warnings: string[] = [];
  if (template === "Unknown") {
    warnings.push("no deterministic template is available for this component kind");
  }
  if (component.confidence === "low") {
    warnings.push("component classification confidence is low");
  }
  if (reference.profiles?.quality && !reference.profiles.quality.usableForTemplate) {
    warnings.push("capture quality is below template planning threshold");
  }
  if (reference.element.selectorConfidence === "low") {
    warnings.push("selector is structurally fragile");
  }
  if (!Object.keys(propsForComponent(component)).length) {
    warnings.push("no stable props could be inferred");
  }
  return Array.from(new Set(warnings));
}

function inputNameFromSelector(selector: string): string | undefined {
  const match = selector.match(/\bname=["']?([^"'\]\s]+)["']?/i);
  return match?.[1];
}

function assignString(props: Record<string, string | number | boolean>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") {
    props[key] = value;
  }
}

function assignBoolean(props: Record<string, string | number | boolean>, key: string, value: boolean | undefined): void {
  if (value !== undefined) {
    props[key] = value;
  }
}

function assignNumber(props: Record<string, string | number | boolean>, key: string, value: number | undefined): void {
  if (value !== undefined) {
    props[key] = value;
  }
}

function omitUndefinedStyleTokens(value: ComponentTemplateStyleTokensWanted): ComponentTemplateStyleTokensWanted {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined && entry[1] !== "")) as ComponentTemplateStyleTokensWanted;
}

function omitUndefinedLayoutTokens(value: ComponentTemplateLayoutTokensWanted): ComponentTemplateLayoutTokensWanted {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as ComponentTemplateLayoutTokensWanted;
}

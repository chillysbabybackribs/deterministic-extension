export type SearchBlockerInput = {
  url?: string;
  title?: string;
  text?: string;
};

export function detectSearchResultBlocker(input: SearchBlockerInput): string | undefined {
  const haystack = `${input.url ?? ""}\n${input.title ?? ""}\n${input.text ?? ""}`;
  if (/\/sorry\/index|unusual traffic|automated queries|are you a robot|captcha|detected unusual|verify you are human/i.test(haystack)) {
    return "Search page returned an anti-automation/non-result page instead of organic results.";
  }

  if (/\/httpservice\/retry\/enablejs|enable javascript|emsg=SG_REL/i.test(haystack)) {
    return "Search page returned an enable-JavaScript retry page instead of organic results.";
  }

  if (/consent\.google|before you continue|agree to the use of cookies|cookie consent/i.test(haystack)) {
    return "Search page returned a consent page instead of organic results.";
  }

  return undefined;
}

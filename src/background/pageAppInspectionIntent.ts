export function shouldUsePageAppInspectionIntent(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase();
  if (!text) {
    return false;
  }

  const currentPageReference =
    /\b(current|this|active|open)\s+(tab|page|site|website|web\s*app|app|document|dom|tree)\b/.test(text) ||
    /\b(on|from|about|in|for)\s+(this|the current|the active|the open)\s+(tab|page|site|website|web\s*app|app|document)\b/.test(text) ||
    /\b(this|current|active|open)\b/.test(text) && /\b(page|site|website|web\s*app|app|dom|network|tree)\b/.test(text);
  const explicitInspectionContext =
    /\b(deep technical inspection|technical inspection|page inspection|web app inspection|app inspection)\b/.test(text) &&
    /\b(page|homepage|site|website|web\s*app|app|dom|network|request|api|storage|form|script|style|tree|functionality)\b/.test(text);
  if (!currentPageReference && !explicitInspectionContext) {
    return false;
  }

  const asksForAppInspection =
    /\b(how|what|explain|inspect|inspection|analy[sz]e|understand|map|show|tell me|walk me through|deep|technical)\b/.test(text) &&
    /\b(works?|functionality|functions?|features?|flows?|structure|dom|document object model|network|requests?|api calls?|resources?|tree|elements?|components?|routes?|state|storage|localstorage|sessionstorage|scripts?|styles?|performance|forms?)\b/.test(text);
  const explicitInspectionView =
    /\b(dom tree|element tree|accessibility tree|network view|request tree|resource timing|performance entries|api calls?|localstorage|sessionstorage|dom\/form|form structure)\b/.test(text);

  return asksForAppInspection || explicitInspectionView;
}

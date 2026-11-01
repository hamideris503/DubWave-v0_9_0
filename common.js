// Shared by background.js (importScripts), offscreen.html and popup.html
const DW_MODEL = "models/gemini-3.5-live-translate-preview";
const WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";
const DW_COOL_LIMIT = 30 * 60 * 1000;
const DW_COOL_INVALID = 24 * 3600 * 1000;
const DW_COOL_UNKNOWN = 15 * 1000;

const DW_DEFAULTS = {
  keys: [], lang: "fa", uiLang: "fa",
  origBefore: .3, origAfter: 0, dubVol: 1, autoMute: true,
  subsOn: true, subsOrig: false, subsSize: 26, subsPos: "bottom", subsGlass: true, subsOpacity: .46,
  syncPlayback: true, lagComp: false, rotate: true, autoStopMin: 5, model: DW_MODEL
};

function normModel(m) {
  m = String(m || "").trim();
  if (!m) return DW_MODEL;
  return m.startsWith("models/") ? m : "models/" + m;
}

function classify(text) {
  const t = String(text || "");
  if (/api key not valid|API_KEY_INVALID|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED|permission|\b40[13]\b/i.test(t)) return "invalid";
  if (/quota|exhaust|RESOURCE_EXHAUSTED|\b429\b|rate.?limit|too many requests/i.test(t)) return "limited";
  return "unknown";
}

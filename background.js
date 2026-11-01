importScripts("common.js", "i18n.js");

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- dubbed-tab bookkeeping (survives service-worker restarts) ---------- */
let dubTabId = null;
async function getDubTab() {
  if (dubTabId != null) return dubTabId;
  const { dubTabId: saved } = await chrome.storage.session.get("dubTabId");
  dubTabId = saved ?? null;
  return dubTabId;
}
async function setDubTab(id) {
  dubTabId = id;
  await chrome.storage.session.set({ dubTabId: id });
}

/* ---------- toolbar badge ---------- */
function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || "" });
    if (text) chrome.action.setBadgeBackgroundColor({ color: color || "#f5a623" });
  } catch {}
}
function flashBadge() {
  setBadge("!", "#f43f5e");
  setTimeout(() => setBadge(""), 4000);
}

/* ---------- subtitle overlay in the dubbed tab ---------- */
async function injectSubs(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (e) { return false; }
}
let lastReinject = 0;
// deliver a message to the dubbed tab; re-inject the overlay if it is missing (throttled)
async function sendSubToTab(payload) {
  const id = await getDubTab();
  if (id == null) return false;
  try { await chrome.tabs.sendMessage(id, payload); return true; }
  catch (e) {
    if (Date.now() - lastReinject < 3000) return false;
    lastReinject = Date.now();
    if (!(await injectSubs(id))) return false;
    try { await chrome.tabs.sendMessage(id, payload); return true; } catch { return false; }
  }
}
async function hideSubs() {
  const id = await getDubTab();
  if (id != null) {
    chrome.tabs.sendMessage(id, { type: "DW_SUB", on: false }).catch(() => {});
    chrome.tabs.sendMessage(id, { type: "DW_STOP" }).catch(() => {});
  }
}

/* ---------- offscreen document ---------- */
async function hasOffscreen() {
  const c = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return c.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture current tab audio and play translated audio."
  });
}
async function toOffscreen(msg) {
  let lastErr;
  for (let i = 0; i < 25; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
      if (r !== undefined) return r;
    } catch (e) { lastErr = e; }
    await sleep(150);
  }
  throw lastErr || new Error("offscreen did not respond");
}
async function isRunning() {
  if (!(await hasOffscreen())) return false;
  try { return !!(await toOffscreen({ type: "GET_STATUS" }))?.running; } catch { return false; }
}

/* ---------- start / stop ---------- */
async function startDub(tabId, settings) {
  try {
    await ensureOffscreen();
    const { keyState, rrNext } = await chrome.storage.local.get(["keyState", "rrNext"]);
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await setDubTab(tabId);
    const subsOk = await injectSubs(tabId);
    const r = await toOffscreen({
      type: "OFFSCREEN_START",
      streamId,
      settings: { ...settings, tabId, keyState: keyState || {}, rrNext: rrNext || 0 }
    });
    if (r?.ok) {
      setBadge("ON");
      if (settings.subs?.on && subsOk && settings.toasts?.ready)
        sendSubToTab({ type: "DW_TOAST", text: settings.toasts.ready });
    } else {
      await setDubTab(null);
      setBadge("");
    }
    return { ...r, subsOk };
  } catch (e) {
    await setDubTab(null);
    setBadge("");
    throw e;
  }
}
async function stopAll() {
  await hideSubs();
  await setDubTab(null);
  setBadge("");
  if (!(await hasOffscreen())) return { ok: true };
  return await toOffscreen({ type: "OFFSCREEN_STOP" });
}

// settings for the keyboard-shortcut path (popup is closed, so read them from storage)
async function settingsFromStorage() {
  const s = await chrome.storage.local.get(DW_DEFAULTS);
  const L = I18N[s.uiLang] ? s.uiLang : "fa";
  const tr = c => (I18N[L] && I18N[L][c]) ?? I18N.en[c] ?? c;
  const keys = [...new Set(Array.isArray(s.keys) ? s.keys : (s.key ? [s.key] : []))];
  return {
    keys, lang: s.lang,
    origBefore: s.origBefore, origAfter: s.origAfter, dubVol: s.dubVol, autoMute: s.autoMute !== false,
    syncPlayback: s.syncPlayback !== false, lagComp: !!s.lagComp, rotate: s.rotate !== false,
    autoStopMin: s.autoStopMin, model: s.model,
    subs: { on: !!s.subsOn, orig: !!s.subsOrig, size: s.subsSize, pos: s.subsPos, glass: s.subsGlass !== false, opacity: s.subsOpacity },
    toasts: { ready: tr("toastReady"), none: tr("toastNone") }
  };
}

/* ---------- API key check (opens a short Gemini Live session per key) ---------- */
function checkKey(key, model) {
  return new Promise(resolve => {
    let done = false, ws;
    const finish = status => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws && ws.close(); } catch {}
      resolve(status);
    };
    const timer = setTimeout(() => finish("error"), 9000);
    try { ws = new WebSocket(WS_BASE + encodeURIComponent(key)); } catch { return finish("error"); }
    ws.onopen = () => ws.send(JSON.stringify({
      setup: {
        model,
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: { targetLanguageCode: "en", echoTargetLanguage: false }
        }
      }
    }));
    ws.onmessage = async ev => {
      let text = ev.data;
      if (text instanceof Blob) text = await text.text();
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m.setupComplete !== undefined) return finish("ready");
      if (m.error) {
        const k = classify(m.error.message || JSON.stringify(m.error));
        return finish(k === "unknown" ? "error" : k);
      }
    };
    ws.onerror = () => finish("error");
    ws.onclose = e => finish(classify(e.reason) === "unknown" ? "error" : classify(e.reason));
  });
}

/* ---------- events ---------- */
// Re-inject subtitles automatically when the dubbed tab navigates or reloads
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  if ((await getDubTab()) === tabId) await injectSubs(tabId);
});

// Closing the dubbed tab stops the session (otherwise the API keeps being used)
chrome.tabs.onRemoved.addListener(async tabId => {
  if ((await getDubTab()) === tabId) stopAll().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => setBadge(""));

// Keyboard shortcut: start / stop dubbing on the active tab
chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== "toggle-dub") return;
  try {
    if (await isRunning()) { await stopAll(); return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return flashBadge();
    const settings = await settingsFromStorage();
    if (!settings.keys.length) return flashBadge();
    const r = await startDub(tab.id, settings);
    if (!r?.ok) flashBadge();
  } catch { flashBadge(); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target) return false;

  switch (msg.type) {
    case "TOAST":
      sendSubToTab({ type: "DW_TOAST", text: msg.text });
      return false;

    case "SUB":
      sendSubToTab({ type: "DW_SUB", on: msg.on, out: msg.out, inn: msg.inn, size: msg.size, glass: msg.glass, opacity: msg.opacity, pos: msg.pos });
      return false;

    case "LAG":
      sendSubToTab({ type: "DW_LAG", lag: msg.lag, off: !!msg.off });
      return false;

    case "SUBS_INJECT":
      injectSubs(msg.tabId).then(ok => sendResponse({ ok }));
      return true;

    case "KEY_STATE":
      chrome.storage.local.set({ keyState: msg.keyState || {} });
      return false;

    case "RR_NEXT":
      chrome.storage.local.set({ rrNext: msg.next || 0 });
      return false;

    case "SESSION_ENDED":      // offscreen stopped by itself (silence timeout / fatal error)
      (async () => { await hideSubs(); await setDubTab(null); setBadge(""); })();
      return false;

    case "CHECK_KEYS":
      (async () => {
        const keys = Array.isArray(msg.keys) ? msg.keys : [];
        const { keyState: old, model } = await chrome.storage.local.get(["keyState", "model"]);
        const res = await Promise.all(keys.map(k => checkKey(k, normModel(model))));
        const ks = { ...(old || {}) };
        const now = Date.now();
        keys.forEach((k, i) => {
          const s = res[i];
          if (s === "ready") delete ks[k];
          else ks[k] = { status: s, until: now + (s === "invalid" ? DW_COOL_INVALID : s === "limited" ? DW_COOL_LIMIT : DW_COOL_UNKNOWN) };
        });
        await chrome.storage.local.set({ keyState: ks });
        sendResponse({ ok: true, keyState: ks });
      })().catch(e => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;

    case "GET_STATUS":
      (async () => {
        try {
          if (!(await hasOffscreen())) return sendResponse({ ok: true, running: false });
          sendResponse(await toOffscreen({ type: "GET_STATUS" }));
        } catch (e) { sendResponse({ ok: true, running: false }); }
      })();
      return true;

    case "STOP":
      stopAll().then(sendResponse).catch(e => sendResponse({ ok: false, code: "e_generic", params: { msg: e?.message || String(e) } }));
      return true;

    case "START":
      startDub(msg.tabId, msg.settings)
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, code: "e_generic", params: { msg: e?.message || String(e) } }));
      return true;
  }
  return false;
});

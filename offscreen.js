const SETUP_TIMEOUT = 10000;

const st = {
  running: false, ws: null, ctx: null, stream: null, source: null,
  origGain: null, dubGain: null, node: null, sink: null,
  nextTime: 0, gotDub: false, settings: null,
  keys: [], active: -1, reconnecting: false, swapping: false,
  wsTr: false, trMode: null, subsUnsupported: false, trSeen: false, subOut: "", subIn: "", subLast: 0, subLastAt: 0, subQueue: [], subTimer: null,
  tabId: null, model: DW_MODEL, paused: false, pausedAt: 0, pausedTotal: 0,
  srcs: new Set(), log: [], cur: null, t0: 0, silentMs: 0, lagTimer: null,
  opts: { sync: true, lag: false, autoStopMin: 5, rotate: true },
  last: { code: "s_idle", params: {} }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mkErr = (code, params = {}, message = code) => Object.assign(new Error(message), { code, params });

function note(code, params) {
  if (code) st.last = { code, params: params || {} };
  chrome.runtime.sendMessage({ type: "STATUS", ...st.last, running: st.running, active: st.active }).catch(() => {});
}
function publishKeyState() {
  const keyState = {};
  for (const k of st.keys) if (k.until > Date.now()) keyState[k.key] = { until: k.until, status: k.status };
  chrome.runtime.sendMessage({ type: "KEY_STATE", keyState }).catch(() => {});
}

function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function toPCM16(f32) {
  const o = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    o[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return new Uint8Array(o.buffer);
}
function resampleTo16k(x, rate) {
  if (rate === 16000) return x;
  const ratio = rate / 16000, n = Math.max(1, Math.floor(x.length / ratio)), o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), z = Math.min(x.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < z; j++) sum += x[j];
    o[i] = z > a ? sum / (z - a) : x[Math.min(a, x.length - 1)];
  }
  return o;
}

function applyVolumes() {
  if (!st.ctx || !st.settings) return;
  const t = st.ctx.currentTime;
  const duck = st.settings.autoMute !== false;
  const orig = st.gotDub && duck ? st.settings.origAfter : st.settings.origBefore;
  st.origGain?.gain.setTargetAtTime(orig, t, 0.05);
  st.dubGain?.gain.setTargetAtTime(st.settings.dubVol, t, 0.05);
}

function playDub(b64) {
  if (!st.ctx || !st.running) return;
  const bytes = b64ToBytes(b64);
  const n = Math.floor(bytes.byteLength / 2);
  if (!n) return;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, n);
  const buf = st.ctx.createBuffer(1, n, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = samples[i] / 32768;

  if (!st.gotDub) {
    st.gotDub = true;
    applyVolumes();
    note("s_playing");
    setTimeout(() => {
      if (st.running && st.settings?.subs?.on && st.wsTr && !st.trSeen) {
        note("w_subsNone");
        if (st.settings.toasts?.none) chrome.runtime.sendMessage({ type: "TOAST", text: st.settings.toasts.none }).catch(() => {});
      }
    }, 25000);
  }
  const src = st.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(st.dubGain);
  st.srcs.add(src);
  src.onended = () => st.srcs.delete(src);
  const now = st.ctx.currentTime;
  if (st.nextTime < now) st.nextTime = now + 0.03;
  src.start(st.nextTime);
  st.nextTime += buf.duration;
}

const SUB_MAX = 150, SUB_CLEAR_MS = 4500;
function trimTail(t) {
  if (t.length <= SUB_MAX) return t;
  t = t.slice(-SUB_MAX);
  const sp = t.indexOf(" ");
  return sp > 0 && sp < 40 ? t.slice(sp + 1) : t;
}
function sendSub(on = true) {
  const s = st.settings?.subs || {};
  chrome.runtime.sendMessage({
    type: "SUB", on: on && !!s.on, out: st.subOut, inn: s.orig ? st.subIn : "", size: s.size || 26, glass: s.glass !== false, opacity: Number.isFinite(s.opacity) ? s.opacity : 0.46, pos: s.pos || "bottom"
  }).catch(() => {});
}
function queueSub(o, i, lagSec) {
  const at = Math.max(Date.now() + lagSec * 1000, st.subLastAt);
  st.subLastAt = at;
  st.subQueue.push({ at, o, i });
}
function pumpSubs() {
  if (st.paused) return;
  const now = Date.now();
  let changed = false;
  while (st.subQueue.length && st.subQueue[0].at <= now) {
    const q = st.subQueue.shift();
    if (q.o) st.subOut = trimTail(st.subOut + q.o);
    if (q.i) st.subIn = trimTail(st.subIn + q.i);
    st.subLast = now; changed = true;
  }
  if (!changed && st.subLast && now - st.subLast > SUB_CLEAR_MS && (st.subOut || st.subIn)) {
    st.subOut = st.subIn = ""; st.subLast = 0; changed = true;
  }
  if (changed) sendSub();
}
function clearSubs() {
  st.subOut = st.subIn = ""; st.subQueue = []; st.subLast = 0; st.subLastAt = 0;
}

function markKey(idx, kind) {
  const k = st.keys[idx];
  if (!k) return;
  if (kind === "invalid") { k.status = "invalid"; k.until = Date.now() + DW_COOL_INVALID; }
  else if (kind === "limited") { k.status = "limited"; k.until = Date.now() + DW_COOL_LIMIT; }
  else { k.status = "error"; k.until = Date.now() + DW_COOL_UNKNOWN; }
  publishKeyState();
}
const mask = k => k.slice(0, 4) + "…" + k.slice(-4);

function isConfigError(e) {
  if (classify(e?.message) !== "unknown") return false;
  return /unknown name|cannot find field|invalid json|invalid argument|invalid_argument|closed 100[37]\b/i.test(String(e?.message || ""));
}
function errDetail(e) {
  if (!e) return "";
  if (e.code === "e_server") return String(e.params?.msg || "").slice(0, 140);
  if (e.code === "e_closed") return `${e.params?.code} ${e.params?.reason || ""}`.trim().slice(0, 140);
  return e.code || String(e.message || "").slice(0, 140);
}

function handleServerMessage(m) {
  const sc = m.serverContent;
  const lag = st.ctx ? Math.max(0, Math.min(12, st.nextTime - st.ctx.currentTime)) : 0;
  const parts = sc?.modelTurn?.parts || [];
  for (const p of parts) {
    const d = p.inlineData?.data;
    if (d) playDub(d);
  }
  if (st.settings?.subs?.on) {
    let o = sc?.outputTranscription?.text ?? m.outputTranscription?.text;
    const i = sc?.inputTranscription?.text ?? m.inputTranscription?.text;
    if (!o) {
      const tp = parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");
      if (tp) o = tp;
    }
    if (o || i) { st.trSeen = true; queueSub(o, i, lag); logText(o, i, lag); }
  }
}

function connectGemini(key, lang, mode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + encodeURIComponent(key));
    let ready = false, done = false;
    const fail = err => { if (!done) { done = true; clearTimeout(timer); try { ws.close(); } catch {} reject(err); } };
    const timer = setTimeout(() => fail(mkErr("e_setupTimeout")), SETUP_TIMEOUT);

    ws.onopen = () => {
      const tx = { inputAudioTranscription: {}, outputAudioTranscription: {} };
      ws.send(JSON.stringify({
        setup: {
          model: st.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            ...(mode === 1 ? tx : {}),
            translationConfig: { targetLanguageCode: lang, echoTargetLanguage: false }
          },
          ...(mode === 2 ? tx : {})
        }
      }));
    };

    ws.onmessage = async ev => {
      let text = ev.data;
      if (text instanceof Blob) text = await text.text();
      let m;
      try { m = JSON.parse(text); } catch { return; }

      if (m.error) {
        const msg = m.error.message || JSON.stringify(m.error);
        if (!ready) return fail(mkErr("e_server", { msg }, msg));
        const kind = classify(msg);
        if (ws === st.ws && kind !== "unknown") markKey(st.active, kind);
        return;
      }
      if (m.setupComplete !== undefined) {
        if (!done) { ready = true; done = true; clearTimeout(timer); resolve(ws); }
        return;
      }
      if (m.goAway) { if (ws === st.ws) swapSession(); return; }
      if (ws === st.ws) handleServerMessage(m);
    };

    ws.onerror = () => fail(mkErr("e_ws"));
    ws.onclose = e => {
      const reason = e.reason || "";
      if (!ready) return fail(mkErr("e_closed", { code: e.code, reason }, `closed ${e.code} ${reason}`));
      if (ws === st.ws && st.running) onSessionClosed(e.code, reason);
    };
  });
}

async function openSession(start) {
  const n = st.keys.length;
  let lastErr = null;
  const wantSubs = !!st.settings.subs?.on && !st.subsUnsupported;
  const modes = wantSubs ? [...new Set([st.trMode ?? 1, 1, 2, 0])] : [0];
  for (let off = 0; off < n; off++) {
    const idx = (start + off) % n;
    const k = st.keys[idx];
    if (k.until > Date.now()) continue;
    note("s_connecting", { i: idx + 1, n, key: mask(k.key) });

    let ok = null, err = null;
    for (const mode of modes) {
      try { ok = { ws: await connectGemini(k.key, st.settings.lang, mode), mode }; break; }
      catch (e) { err = e; if (!isConfigError(e)) break; }
    }

    if (ok) {
      if (wantSubs) {
        st.trMode = ok.mode;
        if (ok.mode === 0) st.subsUnsupported = true;
      }
      k.status = "ready"; k.until = 0;
      publishKeyState();
      return { ws: ok.ws, idx, tr: ok.mode > 0 };
    }

    lastErr = err;
    const kind = isConfigError(err) ? "unknown" : classify(err.message);
    markKey(idx, kind);
    if (kind === "limited") note("s_keyLimited", { i: idx + 1 });
    else if (kind === "invalid") note("s_keyInvalid", { i: idx + 1 });
    else note("s_keyFailed", { i: idx + 1, why: errDetail(err) || String(err.message).slice(0, 90) });
  }
  const soonest = st.keys.reduce((a, k) => Math.min(a, k.until), Infinity);
  const detail = errDetail(lastErr);
  if (soonest > Date.now() && soonest !== Infinity)
    throw mkErr("e_allBadWait", { m: Math.ceil((soonest - Date.now()) / 60000), detail });
  throw mkErr("e_allBad", { detail });
}

function hardBad() {
  return st.keys.length > 0 && st.keys.every(k => k.until > Date.now() && (k.status === "limited" || k.status === "invalid"));
}
async function onSessionClosed(code, reason) {
  if (st.reconnecting) return;
  st.reconnecting = true;
  try {
    const kind = classify(reason);
    if (kind !== "unknown") markKey(st.active, kind);
    const start = kind === "unknown" ? st.active : st.active + 1;
    const delays = [0, 2000, 4000, 8000, 15000, 15000];
    let lastErr = null;
    for (let a = 0; a < delays.length; a++) {
      if (!st.running) return;
      if (delays[a]) await sleep(delays[a]);
      if (!st.running) return;
      note("s_reconnecting", { code: a ? `${code} (#${a + 1})` : code });
      for (const k of st.keys) if (k.status === "error") k.until = 0;   // soft errors are retried
      try {
        const r = await openSession(Math.max(0, start));
        if (!st.running) { try { r.ws.close(); } catch {} return; }
        st.ws = r.ws; st.active = r.idx; st.wsTr = r.tr;
        note("s_reconnected");
        return;
      } catch (e) {
        lastErr = e;
        if (hardBad()) break;      // every key is limited/invalid: retrying is pointless
      }
    }
    throw lastErr || mkErr("e_generic", { msg: "reconnect failed" });
  } catch (e) {
    note(e.code || "e_generic", e.params || { msg: e.message });
    await stop();
    note();
    endSession();
  } finally {
    st.reconnecting = false;
  }
}

async function swapSession() {
  if (st.swapping || st.reconnecting || !st.running) return;
  st.swapping = true;
  try {
    const old = st.ws;
    const base = st.opts.rotate && st.keys.length > 1 ? st.active + 1 : st.active;
    const r = await openSession(Math.max(0, base));
    if (!st.running) { try { r.ws.close(); } catch {} return; }
    st.ws = r.ws; st.active = r.idx; st.wsTr = r.tr;
    note("s_renewed");
    setTimeout(() => { try { old?.close(); } catch {} }, 1500);
  } catch (e) {
  } finally {
    st.swapping = false;
  }
}

function sendAudio(f32, rate) {
  const ws = st.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const pcm = toPCM16(resampleTo16k(f32, rate));
  ws.send(JSON.stringify({
    realtimeInput: { audio: { data: bytesToB64(pcm), mimeType: "audio/pcm;rate=16000" } }
  }));
}

async function getTabStream(streamId) {
  const constraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false
  };
  try { return await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) { await sleep(500); return await navigator.mediaDevices.getUserMedia(constraints); }
}

async function start(settings, streamId) {
  await stop();
  st.settings = settings;
  st.settings.subs = settings.subs || { on: false, orig: false, size: 26 };
  st.trMode = null; st.subsUnsupported = false; st.trSeen = false;
  st.gotDub = false;
  clearSubs();
  st.reconnecting = false; st.swapping = false;
  st.log = []; st.cur = null; st.t0 = Date.now(); st.pausedTotal = 0; st.pausedAt = 0; st.paused = false;
  st.silentMs = 0; st.srcs.clear();
  st.tabId = settings.tabId ?? null;
  st.model = normModel(settings.model);
  st.opts = {
    sync: settings.syncPlayback !== false,
    lag: !!settings.lagComp,
    autoStopMin: Number.isFinite(+settings.autoStopMin) ? +settings.autoStopMin : 5,
    rotate: settings.rotate !== false
  };

  st.keys = settings.keys.map(key => {
    const s = settings.keyState?.[key];
    const until = s && s.until > Date.now() ? s.until : 0;
    return { key, until, status: until ? s.status : "ready" };
  });
  if (!st.keys.length) throw mkErr("e_noKeys");

  st.ctx = new AudioContext();
  await st.ctx.resume();
  await st.ctx.audioWorklet.addModule(chrome.runtime.getURL("capture-worklet.js"));

  st.stream = await getTabStream(streamId);
  st.source = st.ctx.createMediaStreamSource(st.stream);

  st.origGain = st.ctx.createGain();
  st.origGain.gain.value = settings.origBefore;
  st.source.connect(st.origGain).connect(st.ctx.destination);

  st.dubGain = st.ctx.createGain();
  st.dubGain.gain.value = settings.dubVol;
  st.dubGain.connect(st.ctx.destination);

  st.node = new AudioWorkletNode(st.ctx, "capture", {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit"
  });
  st.sink = st.ctx.createGain();
  st.sink.gain.value = 0;
  st.source.connect(st.node);
  st.node.connect(st.sink).connect(st.ctx.destination);
  st.node.port.onmessage = e => { if (!st.running) return; checkSilence(e.data); if (st.running) sendAudio(e.data, st.ctx.sampleRate); };

  const n0 = st.keys.length;
  const rot = st.opts.rotate && n0 > 1;
  const r = await openSession(rot ? (settings.rrNext || 0) % n0 : 0);
  if (rot) chrome.runtime.sendMessage({ type: "RR_NEXT", next: (r.idx + 1) % n0 }).catch(() => {});
  st.ws = r.ws; st.active = r.idx; st.wsTr = r.tr;
  st.running = true;
  st.nextTime = st.ctx.currentTime + 0.05;
  st.subTimer = setInterval(pumpSubs, 100);
  st.lagTimer = setInterval(() => {
    if (!st.opts.lag || !st.running || st.paused || !st.ctx) return;
    chrome.runtime.sendMessage({ type: "LAG", lag: Math.max(0, st.nextTime - st.ctx.currentTime) }).catch(() => {});
  }, 1000);
  note(st.subsUnsupported && st.settings.subs.on ? "w_subsApi" : "s_started");
}

async function stop() {
  st.running = false;
  clearInterval(st.subTimer); st.subTimer = null;
  clearInterval(st.lagTimer); st.lagTimer = null;
  for (const x of st.srcs) { try { x.stop(); } catch {} }
  st.srcs.clear(); st.paused = false;
  clearSubs(); sendSub(false);
  try { if (st.node) st.node.port.onmessage = null; } catch {}
  try { st.ws?.close(); } catch {}
  try { st.stream?.getTracks().forEach(t => t.stop()); } catch {}
  try { await st.ctx?.close(); } catch {}
  st.ws = st.stream = st.source = st.node = st.sink = st.origGain = st.dubGain = st.ctx = null;
  st.nextTime = 0; st.active = -1;
}

function syncKeys(newKeys) {
  const old = new Map(st.keys.map(k => [k.key, k]));
  const cur = st.keys[st.active]?.key;
  st.keys = newKeys.map(key => old.get(key) || { key, until: 0, status: "ready" });
  st.active = cur ? st.keys.findIndex(k => k.key === cur) : -1;
  publishKeyState();
  note();
}

/* ---------- playback sync (pause / seek) ---------- */
function flushDub() {
  for (const x of st.srcs) { try { x.stop(); } catch {} }
  st.srcs.clear();
  if (st.ctx) st.nextTime = st.ctx.currentTime + 0.03;
  clearSubs(); sendSub();
}
async function setPaused(p) {
  if (!st.ctx || !st.running || st.paused === p) return;
  st.paused = p;
  const now = Date.now();
  if (p) {
    st.pausedAt = now;
    try { await st.ctx.suspend(); } catch {}
  } else {
    const d = st.pausedAt ? now - st.pausedAt : 0;
    st.pausedAt = 0; st.pausedTotal += d;
    for (const q of st.subQueue) q.at += d;
    st.subLastAt += d; if (st.subLast) st.subLast = now;
    try { await st.ctx.resume(); } catch {}
  }
}

/* ---------- transcript (for SRT export) ---------- */
function elapsed() {
  const now = Date.now();
  return (now - st.t0 - st.pausedTotal - (st.paused && st.pausedAt ? now - st.pausedAt : 0)) / 1000;
}
function logText(o, i, lag) {
  const t = elapsed() + lag;
  let s = st.cur;
  if (!s || t - s.end > 1.8 || s.out.length > 140) {
    s = st.cur = { start: t, end: t, out: "", inn: "" };
    st.log.push(s);
    if (st.log.length > 4000) st.log.shift();
  }
  if (o) s.out += o;
  if (i) s.inn += i;
  s.end = t;
}

/* ---------- silence auto-stop ---------- */
function checkSilence(f) {
  let sum = 0, n = 0;
  for (let k = 0; k < f.length; k += 4) { sum += f[k] * f[k]; n++; }
  if (n && Math.sqrt(sum / n) > 0.002) { st.silentMs = 0; return; }
  st.silentMs += f.length / st.ctx.sampleRate * 1000;
  const lim = (st.opts.autoStopMin || 0) * 60000;
  if (lim && st.silentMs >= lim) autoStop();
}
async function autoStop() {
  if (!st.running) return;
  await stop();
  note("s_autostopped");
  endSession();
}
function endSession() {
  chrome.runtime.sendMessage({ type: "SESSION_ENDED" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  switch (msg.type) {
    case "OFFSCREEN_START":
      start(msg.settings, msg.streamId)
        .then(() => sendResponse({ ok: true }))
        .catch(async e => {
          await stop();
          sendResponse({ ok: false, code: e.code || "e_generic", params: e.params || { msg: e?.message || String(e) } });
        });
      return true;
    case "OFFSCREEN_STOP":
      stop().then(() => { note("s_stopped"); sendResponse({ ok: true }); });
      return true;
    case "GET_STATUS":
      sendResponse({ ok: true, running: st.running, active: st.active, ...st.last });
      return false;
    case "SET_VOLUMES":
      if (st.settings) {
        st.settings.origBefore = msg.origBefore; st.settings.origAfter = msg.origAfter; st.settings.dubVol = msg.dubVol;
        if (typeof msg.autoMute === "boolean") st.settings.autoMute = msg.autoMute;
        applyVolumes();
      }
      sendResponse({ ok: true });
      return false;
    case "SET_SUBS":
      if (st.settings) {
        const wasOn = !!st.settings.subs?.on;
        st.settings.subs = { on: !!msg.on, orig: !!msg.orig, size: msg.size || 26, glass: msg.glass !== false, opacity: Number.isFinite(msg.opacity) ? msg.opacity : 0.46, pos: ["top", "center", "bottom"].includes(msg.pos) ? msg.pos : "bottom" };
        if (!st.settings.subs.on) { clearSubs(); sendSub(false); }
        else {
          if (!wasOn && st.running && !st.wsTr && !st.subsUnsupported) swapSession();
          sendSub();
        }
      }
      sendResponse({ ok: true });
      return false;
    case "SET_OPTS": {
      const prevLag = st.opts.lag;
      st.opts = {
        sync: msg.syncPlayback !== false,
        lag: !!msg.lagComp,
        autoStopMin: Number.isFinite(+msg.autoStopMin) ? +msg.autoStopMin : 5,
        rotate: msg.rotate !== false
      };
      if (!st.opts.sync && st.paused) setPaused(false);
      if (prevLag && !st.opts.lag) chrome.runtime.sendMessage({ type: "LAG", lag: 0, off: true }).catch(() => {});
      st.silentMs = 0;
      sendResponse({ ok: true });
      return false;
    }
    case "VIDEO_EVENT":
      if (st.running && st.opts.sync && sender?.tab?.id === st.tabId) {
        if (msg.ev === "pause") setPaused(true);
        else if (msg.ev === "play") setPaused(false);
        else if (msg.ev === "seek") flushDub();
      }
      return false;
    case "GET_TRANSCRIPT":
      sendResponse({ ok: true, log: st.log.filter(x => x.out || x.inn).map(({ start, end, out, inn }) => ({ start, end, out, inn })) });
      return false;
    case "SET_KEYS":
      if (st.running) syncKeys(msg.keys || []);
      sendResponse({ ok: true });
      return false;
  }
  return false;
});

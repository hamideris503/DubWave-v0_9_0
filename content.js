(() => {
  if (window.__dubwaveSubs) return;

  const host = document.createElement("div");
  host.style.cssText =
    "all:initial;position:fixed;left:0;right:0;bottom:8%;z-index:2147483647;display:flex;" +
    "flex-direction:column;align-items:center;gap:6px;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent =
    ".box,.toast{display:none;max-width:86%;text-align:center;color:#fff;border-radius:12px;" +
    "font-family:'Vazirmatn','Segoe UI',Tahoma,Arial,sans-serif;text-shadow:0 1px 3px #000;box-shadow:0 4px 18px rgba(0,0,0,.45)}" +
    ".box{background:rgba(5,10,20,.46);padding:8px 18px;line-height:1.6;border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px) saturate(1.3);-webkit-backdrop-filter:blur(10px) saturate(1.3)}" +
    ".toast{background:rgba(79,70,229,.92);padding:6px 14px;font-size:14px}" +
    ".orig{color:#cbd5e1;font-size:.7em;margin-bottom:3px;unicode-bidi:plaintext}" +
    ".out{unicode-bidi:plaintext}";
  const toast = document.createElement("div"); toast.className = "toast"; toast.setAttribute("dir", "auto");
  const box = document.createElement("div"); box.className = "box";
  const orig = document.createElement("div"); orig.className = "orig"; orig.setAttribute("dir", "auto");
  const out = document.createElement("div"); out.className = "out"; out.setAttribute("dir", "auto");
  box.appendChild(orig); box.appendChild(out);
  root.appendChild(style); root.appendChild(toast); root.appendChild(box);

  /* --- placement: bottom-center of the biggest visible <video>, else bottom of the window --- */
  function findVideo() {
    let best = null, bestEl = null, bestArea = 0;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const list = fsEl && fsEl.tagName === "VIDEO" ? [fsEl] : (fsEl || document).querySelectorAll("video");
    for (const v of list) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width > 100 && r.height > 60 && area > bestArea) { best = r; bestEl = v; bestArea = area; }
    }
    return best ? { r: best, el: bestEl } : null;
  }

  let pos = "bottom";
  function layout() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = (fsEl && fsEl.tagName !== "VIDEO" ? fsEl : null) || document.body || document.documentElement;
    if (host.parentNode !== parent) {
      try { parent.appendChild(host); } catch (e) {}
    }
    const f = findVideo();
    const r = f && f.r;
    const set = (k, v) => host.style.setProperty(k, v);
    let top = 0, h = window.innerHeight;
    if (r) {
      top = Math.max(0, r.top);
      h = Math.max(0, Math.min(r.bottom, window.innerHeight) - top);
      set("left", Math.max(0, r.left) + "px");
      set("width", r.width + "px");
      set("right", "auto");
    } else {
      set("left", "0"); set("width", "auto"); set("right", "0");
    }
    if (pos === "top") {
      set("top", (top + h * 0.1) + "px"); set("bottom", "auto"); set("transform", "none");
    } else if (pos === "center") {
      set("top", (top + h / 2) + "px"); set("bottom", "auto"); set("transform", "translateY(-50%)");
    } else {
      set("top", "auto"); set("transform", "none");
      if (r) set("bottom", Math.max(8, window.innerHeight - Math.min(r.bottom, window.innerHeight) + r.height * 0.12) + "px");
      else set("bottom", "8%");
    }
  }

  // layout is only polled while something is visible (no page-wide MutationObserver any more)
  let timer = null;
  function refreshTimer() {
    const visible = box.style.display === "block" || toast.style.display === "block";
    if (visible && !timer) { layout(); timer = setInterval(layout, 300); }
    if (!visible && timer) { clearInterval(timer); timer = null; }
  }

  document.addEventListener("fullscreenchange", layout);
  window.addEventListener("resize", layout);
  window.addEventListener("scroll", layout);
  window.addEventListener("yt-navigate-finish", () => { layout(); refreshTimer(); });
  layout();

  let toastTimer = null;
  function showToast(text) {
    toast.textContent = text;
    toast.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = "none"; refreshTimer(); }, 5000);
    refreshTimer();
  }

  /* --- keep the dub in sync with the video: report pause / play / seek to the offscreen page --- */
  function area(e) { const r = e.getBoundingClientRect(); return r.width * r.height; }
  function isMain(v) {
    if (v.muted) return false;
    if (v.tagName === "VIDEO") {
      let max = 0;
      for (const x of document.querySelectorAll("video")) max = Math.max(max, area(x));
      return area(v) >= max * 0.5;
    }
    return !document.querySelector("video");   // <audio>-only pages
  }
  function sendVideo(ev) {
    try { chrome.runtime.sendMessage({ target: "offscreen", type: "VIDEO_EVENT", ev }).catch(() => {}); } catch (e) {}
  }
  function onMedia(e) {
    const v = e.target;
    if (!(v instanceof HTMLMediaElement) || !isMain(v)) return;
    if (e.type === "pause") { if (!v.ended) sendVideo("pause"); }
    else if (e.type === "seeking") sendVideo("seek");
    else sendVideo("play");
  }
  for (const ev of ["pause", "play", "playing", "seeking"]) document.addEventListener(ev, onMedia, true);

  /* --- optional lag compensation: slow the video slightly while the dub is far behind --- */
  let baseRate = null, ourRate = null;
  function restoreRate(v) {
    if (v && baseRate != null && ourRate != null && Math.abs(v.playbackRate - ourRate) < 0.001) v.playbackRate = baseRate;
    baseRate = ourRate = null;
  }
  function applyLag(m) {
    const f = findVideo();
    const v = f && f.el;
    if (m.off) { restoreRate(v); return; }
    if (!v) return;
    const cur = v.playbackRate;
    // the page/user changed the speed behind our back: forget our adjustment
    if (ourRate != null && Math.abs(cur - ourRate) > 0.001) baseRate = ourRate = null;
    const lag = m.lag || 0;
    const target = lag > 6 ? 0.88 : lag > 3.5 ? 0.94 : null;
    if (target != null) {
      if (baseRate == null) baseRate = cur;
      const want = Math.max(0.25, +(baseRate * target).toFixed(3));
      if (Math.abs(cur - want) > 0.001) { v.playbackRate = want; ourRate = v.playbackRate; }
      else if (ourRate == null) ourRate = cur;
    } else if (lag < 1.2) {
      restoreRate(v);
    }
  }

  chrome.runtime.onMessage.addListener(m => {
    if (!m) return;
    if (m.type === "DW_TOAST") { if (m.text) showToast(m.text); return; }
    if (m.type === "DW_LAG") { applyLag(m); return; }
    if (m.type === "DW_STOP") {
      const f = findVideo(); restoreRate(f && f.el);
      box.style.display = "none"; toast.style.display = "none"; refreshTimer();
      return;
    }
    if (m.type !== "DW_SUB") return;
    if (!m.on || (!m.out && !m.inn)) { box.style.display = "none"; refreshTimer(); return; }
    box.style.fontSize = (m.size || 26) + "px";
    const newPos = ["top", "center", "bottom"].includes(m.pos) ? m.pos : "bottom";
    if (newPos !== pos) { pos = newPos; layout(); }
    const op = Number.isFinite(m.opacity) ? m.opacity : .46;
    box.style.background = m.glass === false ? "transparent" : `rgba(5,10,20,${op})`;
    box.style.border = m.glass === false ? "0" : "1px solid rgba(255,255,255,.12)";
    box.style.backdropFilter = m.glass === false ? "none" : "blur(10px) saturate(1.3)";
    box.style.webkitBackdropFilter = m.glass === false ? "none" : "blur(10px) saturate(1.3)";
    out.textContent = m.out || "";
    out.style.display = m.out ? "" : "none";
    orig.textContent = m.inn || "";
    orig.style.display = m.inn ? "" : "none";
    box.style.display = "block";
    refreshTimer();
  });

  window.__dubwaveSubs = true;
})();

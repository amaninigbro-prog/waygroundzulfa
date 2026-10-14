/* zulfa-googleform — bookmarklet assistant (Google Forms)
 * Baca soal dari Google Form, jawab via AI, isi otomatis (submit manual).
 * Jalan di konteks halaman saat bookmark diklik. Tanpa extension.
 *
 * Pakai:
 *   1) Buat bookmark. Nama: zulfa
 *   2) URL: tempel isi file ini dgn prefix "javascript:" (atau hasil build).
 *   3) Buka Google Form (viewform), klik bookmark.
 */
(() => {
  "use strict";
  if (window.__zulfaLoaded) { window.__zulfaShow && window.__zulfaShow(); return; }
  window.__zulfaLoaded = true;

  /* ================= storage (localStorage) ================= */
  const LS = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const getKey = () => LS.get("zulfa_geminiKey") || "";
  const setKey = (v) => LS.set("zulfa_geminiKey", v);
  const getProvider = () => LS.get("zulfa_provider") || "gemini";
  const setProvider = (v) => LS.set("zulfa_provider", v);
  const getTsKey = () => LS.get("zulfa_ts_key") || "";
  const getTsBase = () => (LS.get("zulfa_ts_base") || "https://api.thirtystore.com/v1").replace(/\/+$/, "");
  const getTsModel = () => LS.get("zulfa_ts_model") || "deepseek-v4.1-flash";
  const activeKey = () => (getProvider() === "thirtystore" ? getTsKey() : getKey());
  const getAutoAnswer = () => LS.get("zulfa_auto") === "1";
  const getAutoDelay = () => { const n = parseFloat(LS.get("zulfa_auto_delay")); return Number.isFinite(n) && n >= 0 ? n : 3; };

  /* ================= helpers ================= */
  const state = { items: [], highlight: true, minimized: false, userHidden: false, solving: false, formTitle: "", autoAnswer: false, autoDelay: 3, lastAutoQ: "" };

  const katexToText = (root) => {
    try {
      root.querySelectorAll("katex").forEach((n) => n.replaceWith(document.createTextNode(n.getAttribute("latex") || "")));
      root.querySelectorAll('script[type="math/tex"], script[type="math/asciimath"]').forEach((n) => n.replaceWith(document.createTextNode(n.textContent || "")));
    } catch {}
  };
  const stripHtml = (html) => {
    if (!html) return "";
    const d = document.createElement("div");
    d.innerHTML = String(html);
    katexToText(d);
    d.querySelectorAll("script, style, blank").forEach((n) => n.remove());
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  };
  const cleanHtml = (html) => {
    if (!html) return "";
    const d = document.createElement("div");
    d.innerHTML = String(html);
    try {
      d.querySelectorAll("katex").forEach((n) => { const c = document.createElement("code"); c.textContent = n.getAttribute("latex") || ""; n.replaceWith(c); });
      d.querySelectorAll('script[type="math/tex"], script[type="math/asciimath"]').forEach((n) => n.replaceWith(document.createTextNode(n.textContent || "")));
      d.querySelectorAll("blank").forEach((n) => n.replaceWith(document.createTextNode("___")));
    } catch {}
    return d.innerHTML;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const normQ = (t) => stripHtml(t).toLowerCase().replace(/\s+/g, " ").slice(0, 140);

  /* ================= panel UI ================= */
  let els = {};
  const CSS = `
  #zulfa-frame{position:fixed!important;top:20px!important;right:20px!important;width:320px!important;max-width:calc(100vw - 40px)!important;height:480px!important;max-height:80vh!important;background:rgba(16,18,22,.96)!important;border:1px solid #262b33!important;border-radius:10px!important;box-shadow:0 4px 16px rgba(0,0,0,.5)!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;font-family:Inter,system-ui,sans-serif!important;font-size:12px!important;color:#c3c9d4!important;opacity:.97!important}
  #zulfa-header{display:flex!important;align-items:center!important;justify-content:space-between!important;background:#1c2027!important;color:#8b93a1!important;padding:6px 8px!important;cursor:move!important;user-select:none!important;flex-shrink:0!important;border-bottom:1px solid #262b33!important}
  #zulfa-title{font-weight:600!important;font-size:12px!important;letter-spacing:.02em!important}
  #zulfa-title small{font-weight:400!important;opacity:.6!important;font-size:10px!important}
  #zulfa-header button{background:#2a2f38!important;border:none!important;color:#9ca3af!important;width:22px!important;height:22px!important;flex:0 0 auto!important;min-width:0!important;box-sizing:border-box!important;border-radius:6px!important;cursor:pointer!important;font-weight:700!important;font-size:12px!important;line-height:1!important;pointer-events:auto!important;position:relative!important;z-index:2!important}
  #zulfa-header button:hover{background:#353b47!important;color:#e5e7eb!important}
  #zulfa-body{display:flex!important;flex-direction:column!important;flex:1!important;min-height:0!important}
  #zulfa-status{padding:7px 9px!important;font-size:11px!important;background:#14161b!important;border-bottom:1px solid #20252d!important;color:#8b93a1!important}
  #zulfa-status[data-kind="ok"]{color:#6ee7a0!important}
  #zulfa-status[data-kind="warn"]{color:#d9a648!important}
  #zulfa-status[data-kind="err"]{color:#e06868!important}
  #zulfa-keyrow input{flex:1 1 auto!important;min-width:0!important;box-sizing:border-box!important;padding:7px 9px!important;border:1px solid #2e3440!important;border-radius:7px!important;font-size:12px!important;outline:none!important;color:#d1d5db!important;background:#1a1e24!important}
  #zulfa-keyrow button{flex:0 0 auto!important;padding:7px 10px!important;border:1px solid #2e3440!important;border-radius:7px!important;background:#2a2f38!important;color:#c3c9d4!important;cursor:pointer!important;font-size:12px!important}
  #zulfa-searchrow{display:flex!important;gap:0!important;padding:7px!important;align-items:stretch!important}
  #zulfa-search{flex:1 1 auto!important;min-width:0!important;width:auto!important;box-sizing:border-box!important;padding:7px 9px!important;border:1px solid #2e3440!important;border-right:none!important;border-radius:7px 0 0 7px!important;font-size:12px!important;outline:none!important;color:#d1d5db!important;background:#1a1e24!important}
  #zulfa-search::placeholder{color:#525a68!important}
  #zulfa-clear{flex:0 0 auto!important;min-width:0!important;width:auto!important;box-sizing:border-box!important;font-size:12px!important;line-height:1!important;border:1px solid #2e3440!important;background:#1a1e24!important;color:#8b93a1!important;border-radius:0 7px 7px 0!important;padding:0 9px!important;cursor:pointer!important}
  #zulfa-hlrow{display:flex!important;align-items:center!important;gap:6px!important;padding:0 9px 6px!important;font-size:11px!important;color:#7d8592!important}
  #zulfa-hlrow input{width:auto!important;flex:0 0 auto!important;accent-color:#4b5563!important}
  #zulfa-results{flex:1!important;overflow-y:auto!important;padding:7px!important;display:flex!important;flex-direction:column!important;gap:6px!important;background:#101216!important}
  #zulfa-results::-webkit-scrollbar{width:6px!important}
  #zulfa-results::-webkit-scrollbar-thumb{background:#2a2f38!important;border-radius:3px!important}
  #zulfa-debug{padding:3px 9px!important;font-size:9px!important;color:#4b5261!important;background:#101216!important;border-top:1px solid #1c2027!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;flex-shrink:0!important}
  .zulfa-card{background:#1a1e24!important;border:1px solid #232833!important;border-left:3px solid #3b4252!important;border-radius:7px!important;padding:7px!important}
  .zulfa-qhead{display:flex!important;align-items:center!important;gap:6px!important;margin-bottom:3px!important;color:#7d8592!important;font-size:11px!important}
  .zulfa-tag{background:#232833!important;color:#8b93a1!important;font-size:9px!important;font-weight:700!important;padding:1px 6px!important;border-radius:4px!important;letter-spacing:.03em!important}
  .zulfa-q{font-weight:500!important;margin-bottom:5px!important;line-height:1.4!important;color:#d1d5db!important}
  .zulfa-qimg,.zulfa-aimg{max-width:100%!important;border-radius:6px!important;margin-top:4px!important;opacity:.9!important}
  .zulfa-ans{background:#14201a!important;border:1px solid #1e3a2c!important;color:#7ee2a8!important;font-weight:600!important;border-radius:6px!important;padding:5px 7px!important;margin-top:4px!important;line-height:1.4!important}
  .zulfa-pending{background:#221d12!important;border-color:#3d3220!important;color:#c9a45c!important}
  .zulfa-none{background:transparent!important;border-color:#232833!important;color:#525a68!important}
  .zulfa-empty{text-align:center!important;color:#525a68!important;padding:20px!important}
  .zulfa-mark{position:absolute!important;top:6px!important;left:10px!important;color:#22c55e!important;font-size:22px!important;font-weight:900!important;pointer-events:none!important;z-index:10!important}
  #zulfa-fab{position:fixed!important;bottom:14px!important;left:14px!important;width:12px!important;height:12px!important;border-radius:50%!important;border:none!important;background:#9ca3af!important;opacity:.45!important;padding:0!important;font-size:0!important;line-height:0!important;cursor:pointer!important;z-index:2147483647!important;display:block!important;box-shadow:none!important;transition:opacity .15s,transform .15s!important}
  #zulfa-fab:hover{opacity:1!important;transform:scale(1.6)!important;background:#6b7280!important}
  #zulfa-resize{position:absolute!important;right:0!important;bottom:0!important;width:16px!important;height:16px!important;cursor:nwse-resize!important;z-index:5!important;background:linear-gradient(135deg,transparent 50%,#4b5563 50%)!important;border-bottom-right-radius:10px!important}
  #zulfa-resize:hover{background:linear-gradient(135deg,transparent 50%,#8b93a1 50%)!important}
  @media (max-width:480px){#zulfa-frame{left:10px!important;right:10px!important;width:auto!important}}
  `;
  function injectCSS() {
    if (document.getElementById("zulfa-style")) return;
    const s = document.createElement("style");
    s.id = "zulfa-style";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function buildUI() {
    if (document.getElementById("zulfa-frame")) { bindPanel(); return; }
    const wrap = document.createElement("div");
    wrap.id = "zulfa-frame";
    wrap.innerHTML = `
      <div id="zulfa-header">
        <span id="zulfa-title">zulfa-googleform <small id="zulfa-sub"></small></span>
        <span style="display:flex;gap:6px">
          <button type="button" id="zulfa-min" title="Perkecil ke tombol">—</button>
        </span>
      </div>
      <div id="zulfa-body">
        <div id="zulfa-status">Buka Google Form — soal dibaca dari halaman lalu diselesaikan AI.</div>
        <div id="zulfa-providerrow" style="display:flex;gap:6px;padding:7px 7px 0;align-items:center">
          <label style="flex:0 0 auto;color:#8b93a1;font-size:11px">Provider</label>
          <select id="zulfa-provider" style="flex:1;min-width:0;box-sizing:border-box;padding:6px 8px;border:1px solid #2e3440;border-radius:7px;background:#1a1e24;color:#d1d5db;font-size:12px;outline:none">
            <option value="gemini">Google Gemini</option>
            <option value="thirtystore">ThirtyStore (OpenAI-compat)</option>
          </select>
        </div>
        <div id="zulfa-keyrow" style="display:flex;gap:6px;padding:7px 7px 0">
          <input id="zulfa-key" type="password" placeholder="API key…" style="flex:1;min-width:0" />
          <button id="zulfa-savekey" type="button">Simpan</button>
        </div>
        <div id="zulfa-tsrow" style="display:none;flex-direction:column;gap:6px;padding:7px 7px 0">
          <input id="zulfa-ts-base" type="text" placeholder="Base URL" />
          <input id="zulfa-ts-model" type="text" placeholder="Model (deepseek-v4.1-flash)" />
        </div>
        <div id="zulfa-searchrow">
          <input id="zulfa-search" type="text" placeholder="Cari soal..." />
          <button id="zulfa-clear" type="button" title="Hapus">×</button>
        </div>
        <label id="zulfa-hlrow"><input type="checkbox" id="zulfa-hl" checked /> Highlight jawaban di halaman</label>
        <label id="zulfa-autorow" style="display:flex;align-items:center;gap:6px;padding:0 9px 6px;font-size:11px;color:#7d8592">
          <input type="checkbox" id="zulfa-auto" style="width:auto;flex:0 0 auto;accent-color:#4b5563" /> Auto isi
          <span style="flex:0 0 auto">delay</span>
          <input type="number" id="zulfa-autodelay" min="0" step="1" value="3" style="width:52px;box-sizing:border-box;padding:3px 6px;border:1px solid #2e3440;border-radius:6px;background:#1a1e24;color:#d1d5db;font-size:11px;outline:none" />
          <span style="flex:0 0 auto">dtk</span>
        </label>
        <div id="zulfa-results"></div>
        <div id="zulfa-debug"></div>
      </div>
      <div id="zulfa-resize" title="Tarik untuk ubah ukuran"></div>`;
    document.documentElement.appendChild(wrap);
    const fab = document.createElement("button");
    fab.id = "zulfa-fab";
    fab.title = "zulfa-googleform (Alt+H)";
    document.documentElement.appendChild(fab);
    bindPanel();
  }

  function bindPanel() {
    els.frame = document.getElementById("zulfa-frame");
    els.sub = document.getElementById("zulfa-sub");
    els.status = document.getElementById("zulfa-status");
    els.search = document.getElementById("zulfa-search");
    els.clear = document.getElementById("zulfa-clear");
    els.results = document.getElementById("zulfa-results");
    els.debug = document.getElementById("zulfa-debug");
    els.hl = document.getElementById("zulfa-hl");
    els.auto = document.getElementById("zulfa-auto");
    els.autoDelay = document.getElementById("zulfa-autodelay");
    els.fab = document.getElementById("zulfa-fab");
    els.key = document.getElementById("zulfa-key");
    els.provider = document.getElementById("zulfa-provider");
    els.tsrow = document.getElementById("zulfa-tsrow");
    els.tsBase = document.getElementById("zulfa-ts-base");
    els.tsModel = document.getElementById("zulfa-ts-model");
    if (els.key) els.key.value = getKey();
    if (els.provider) els.provider.value = getProvider();
    if (els.tsBase) els.tsBase.value = getTsBase();
    if (els.tsModel) els.tsModel.value = getTsModel();

    const syncProvider = () => {
      const ts = getProvider() === "thirtystore";
      if (els.tsrow) els.tsrow.style.setProperty("display", ts ? "flex" : "none", "important");
      if (els.key) els.key.placeholder = ts ? "ThirtyStore API key…" : "Gemini API key…";
      els.key && (els.key.value = ts ? getTsKey() : getKey());
    };
    syncProvider();
    if (els.provider) els.provider.onchange = () => { setProvider(els.provider.value); syncProvider(); };
    const autoSaveKey = () => {
      const k = (els.key?.value || "").trim();
      if (!k) return;
      if (getProvider() === "thirtystore") {
        LS.set("zulfa_ts_key", k);
        if (els.tsBase?.value.trim()) LS.set("zulfa_ts_base", els.tsBase.value.trim());
        if (els.tsModel?.value.trim()) LS.set("zulfa_ts_model", els.tsModel.value.trim());
      } else setKey(k);
    };
    if (els.key) els.key.oninput = autoSaveKey;
    [els.tsBase, els.tsModel].forEach((el) => el && (el.oninput = autoSaveKey));

    const minBtn = document.getElementById("zulfa-min");
    const doMin = (e) => { e?.stopImmediatePropagation?.(); e?.stopPropagation(); e?.preventDefault(); state.minimized = true; hidePanel(); };
    minBtn.addEventListener("click", doMin, true);
    els.fab.onclick = () => showPanel();
    els.clear.onclick = () => { els.search.value = ""; render(); };
    els.search.oninput = () => render(els.search.value);
    els.hl.onchange = () => { state.highlight = els.hl.checked; if (state.highlight) highlightInPage(); else document.querySelectorAll(".zulfa-mark").forEach((n) => n.remove()); };
    if (els.auto) {
      els.auto.checked = getAutoAnswer();
      els.autoDelay.value = getAutoDelay();
      state.autoAnswer = els.auto.checked;
      state.autoDelay = getAutoDelay();
      els.auto.onchange = () => { state.autoAnswer = els.auto.checked; LS.set("zulfa_auto", els.auto.checked ? "1" : "0"); setStatus(els.auto.checked ? `Auto isi ON • delay ${state.autoDelay} dtk` : "Auto isi OFF", els.auto.checked ? "ok" : ""); };
      els.autoDelay.oninput = () => { const n = parseFloat(els.autoDelay.value); state.autoDelay = Number.isFinite(n) && n >= 0 ? n : 0; LS.set("zulfa_auto_delay", String(state.autoDelay)); };
    }
    document.getElementById("zulfa-savekey").onclick = () => {
      const k = els.key.value.trim();
      if (getProvider() === "thirtystore") {
        if (!k) return setStatus("Isi API key dulu.", "err");
        LS.set("zulfa_ts_key", k);
        if (els.tsBase.value.trim()) LS.set("zulfa_ts_base", els.tsBase.value.trim());
        if (els.tsModel.value.trim()) LS.set("zulfa_ts_model", els.tsModel.value.trim());
        setStatus(`ThirtyStore tersimpan • ${getTsModel()} ✅`, "ok");
      } else {
        if (!k) return setStatus("Isi key dulu.", "err");
        setKey(k);
        setStatus("Key tersimpan di localStorage ✅", "ok");
      }
      const pend = state.items.filter((x) => !x.answers?.length);
      if (pend.length) ensureSolved(k, "key");
    };

    const header = document.getElementById("zulfa-header");
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    const moveTo = (cx, cy) => {
      const r = els.frame.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - r.width);
      const maxY = Math.max(0, window.innerHeight - r.height);
      const nx = Math.min(maxX, Math.max(0, ox + cx - sx));
      const ny = Math.min(maxY, Math.max(0, oy + cy - sy));
      els.frame.style.left = nx + "px";
      els.frame.style.top = ny + "px";
      els.frame.style.right = "auto";
    };
    const start = (cx, cy) => {
      drag = true; sx = cx; sy = cy;
      const r = els.frame.getBoundingClientRect(); ox = r.left; oy = r.top;
    };
    header.addEventListener("mousedown", (e) => {
      if (e.target?.closest?.("button,input,select,a")) return;
      start(e.clientX, e.clientY); e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => { if (drag) moveTo(e.clientX, e.clientY); });
    window.addEventListener("mouseup", () => (drag = false));
    header.addEventListener("touchstart", (e) => {
      if (e.target?.closest?.("button,input,select,a")) return;
      const t = e.touches[0]; if (!t) return; start(t.clientX, t.clientY);
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (!drag) return;
      const t = e.touches[0]; if (!t) return; moveTo(t.clientX, t.clientY); e.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", () => (drag = false));
    window.addEventListener("resize", () => {
      if (!els.frame) return;
      const r = els.frame.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - r.width);
      const maxY = Math.max(0, window.innerHeight - r.height);
      els.frame.style.left = Math.min(maxX, Math.max(0, r.left)) + "px";
      els.frame.style.top = Math.min(maxY, Math.max(0, r.top)) + "px";
      els.frame.style.right = "auto";
    });

    const rz = document.getElementById("zulfa-resize");
    let rx = 0, ry = 0, rw = 0, rh = 0, rsz = false;
    const RMIN_W = 240, RMIN_H = 200;
    const resizeTo = (cx, cy) => {
      const maxW = Math.max(RMIN_W, window.innerWidth - els.frame.getBoundingClientRect().left);
      const maxH = Math.max(RMIN_H, window.innerHeight - els.frame.getBoundingClientRect().top);
      els.frame.style.width = Math.min(maxW, Math.max(RMIN_W, rw + cx - rx)) + "px";
      els.frame.style.height = Math.min(maxH, Math.max(RMIN_H, rh + cy - ry)) + "px";
      els.frame.style.maxWidth = "none"; els.frame.style.maxHeight = "none";
    };
    const rStart = (cx, cy) => { rsz = true; rx = cx; ry = cy; rw = els.frame.offsetWidth; rh = els.frame.offsetHeight; };
    if (rz) {
      rz.addEventListener("mousedown", (e) => { rStart(e.clientX, e.clientY); e.preventDefault(); e.stopPropagation(); });
      window.addEventListener("mousemove", (e) => { if (rsz) resizeTo(e.clientX, e.clientY); });
      window.addEventListener("mouseup", () => (rsz = false));
      rz.addEventListener("touchstart", (e) => { const t = e.touches[0]; if (t) { rStart(t.clientX, t.clientY); e.stopPropagation(); } }, { passive: true });
      window.addEventListener("touchmove", (e) => { if (!rsz) return; const t = e.touches[0]; if (t) { resizeTo(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
      window.addEventListener("touchend", () => (rsz = false));
    }
  }

  function showPanel() { els.frame && els.frame.style.setProperty("display", "flex", "important"); els.fab && els.fab.style.setProperty("display", "none", "important"); state.userHidden = false; state.minimized = false; }
  function hidePanel() { els.frame && els.frame.style.setProperty("display", "none", "important"); els.fab && els.fab.style.setProperty("display", "block", "important"); state.userHidden = true; }
  window.__zulfaShow = showPanel;

  window.addEventListener("keydown", (e) => {
    try {
      const hot = (e.altKey && (e.key === "h" || e.key === "H")) || (e.ctrlKey && e.shiftKey && (e.key === "h" || e.key === "H"));
      if (!hot) return;
      const t = e.target;
      const inPanel = t?.closest?.("#zulfa-frame");
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !inPanel;
      if (typing) return;
      e.preventDefault();
      if (!els.frame || els.frame.style.getPropertyValue("display") === "none") showPanel(); else hidePanel();
    } catch {}
  });

  function setStatus(text, kind = "") { if (!els.status) return; els.status.textContent = text; els.status.dataset.kind = kind; if (els.sub) els.sub.textContent = state.formTitle ? "• " + state.formTitle : ""; }
  function dbg(t) { try { if (els.debug) els.debug.textContent = "form: " + t; } catch {} }

  function render(filter = "") {
    if (!els.results) return;
    const f = (filter || els.search?.value || "").toLowerCase();
    let list = state.items;
    if (f) list = list.filter((it) => {
      const q = stripHtml(it.question).toLowerCase();
      const a = [...(it.answers || []).map((x) => stripHtml(x.text)), ...(it.options || [])].join(" ").toLowerCase();
      return q.includes(f) || a.includes(f);
    });
    if (!list.length) { els.results.innerHTML = `<div class="zulfa-empty">${state.items.length ? "Tidak cocok." : "Belum ada soal. Buka Google Form."}</div>`; return; }
    els.results.innerHTML = list.map((it, i) => {
      const qMedia = it.questionMedia ? `<br><img class="zulfa-qimg" src="${esc(it.questionMedia)}" loading="lazy" />` : "";
      const tag = it.ai ? "AI ✨" : esc(it.tag || it.type || "");
      const ans = it.pending && !it.answers.length ? `<div class="zulfa-ans zulfa-pending">⏳ menunggu AI…</div>`
        : it.answers.length ? it.answers.map((a) => { const img = a.mediaUrl ? `<br><img class="zulfa-aimg" src="${esc(a.mediaUrl)}" loading="lazy" />` : ""; return `<div class="zulfa-ans">${it.ai ? "✨ " : ""}${cleanHtml(a.text)}${img}</div>`; }).join("")
        : `<div class="zulfa-ans zulfa-none">—</div>`;
      return `<div class="zulfa-card"><div class="zulfa-qhead"><b>${i + 1}.</b> <span class="zulfa-tag">${tag}</span></div><div class="zulfa-q">${cleanHtml(it.question) || "<i>(soal gambar)</i>"}${qMedia}</div>${ans}</div>`;
    }).join("");
    els.results.querySelectorAll("img").forEach((img) => { img.referrerPolicy = "no-referrer"; });
  }

  /* ================= Google Forms: deteksi & scrape ================= */
  const GF = {
    root: () => document.querySelector('form[action*="formResponse"]') || document.querySelector("form"),
    itemSel: '[role="listitem"], .freebirdFormviewerViewItemsItemItem',
    qText: ".M7eMe, .freebirdFormviewerViewItemsItemItemTitle, [role='heading']",
    optLabel: ".docssharedWizToggleLabeledContainer, [role='radio'], [role='checkbox'], label",
    optText: ".aDTYNe, .docssharedWizToggleLabeledLabelText, .freebirdFormviewerViewItemsItemControlLabel, span",
    textInput: 'input[type="text"], input[type="email"], input[type="url"], input[type="number"], textarea, input[type="date"], input[type="time"]',
    listbox: '[role="listbox"], [role="combobox"]',
    optionBox: '[role="option"], .quantumWizMenuPaperselectOption',
  };
  const isRadioInput = () => { try { return location.pathname.includes("viewform") || location.pathname.includes("formResponse") || !!GF.root(); } catch { return false; } };

  function gfItems() {
    const root = GF.root();
    if (!root) return [];
    let nodes = [...root.querySelectorAll(GF.itemSel)];
    nodes = nodes.filter((n) => !n.closest("#zulfa-frame"));
    if (!nodes.length) nodes = [...root.querySelectorAll('[role="listitem"]')];
    return nodes;
  }

  // Kumpulkan pertanyaan unik per string (dedupe)
  function gfScrape() {
    const out = [];
    for (const node of gfItems()) {
      const titleEl = node.querySelector(".M7eMe, .freebirdFormviewerViewItemsItemItemTitle") || node.querySelector('[role="heading"]');
      const title = stripHtml(titleEl?.innerText || titleEl?.textContent || "");
      const questionMedia = node.querySelector('img[src], [data-image-url]');
      const qMedia = questionMedia?.getAttribute("src") || questionMedia?.getAttribute("data-image-url") || null;

      const radios = [...node.querySelectorAll('[role="radio"], [role="checkbox"]')];
      const options = radios.map((r) => stripHtml(r.getAttribute("aria-label") || r.getAttribute("data-answer-value") || r.innerText || "").replace(/^\s*/, "")).filter(Boolean);
      const type = radios.some((r) => r.getAttribute("role") === "checkbox") ? "CHECKBOX" : (radios.length ? "MCQ" : (node.querySelector(GF.textInput) ? "TEXT" : (node.querySelector(GF.listbox) ? "DROPDOWN" : "UNKNOWN")));
      if (!title && !options.length) continue;
      out.push({ node, title, options, type, qMedia, els: { radios } });
    }
    return out;
  }

  // convert to internal item format
  function gfToItem(s) {
    return { question: s.title, questionMedia: s.qMedia, answers: [], options: s.options, type: s.type, tag: s.type, ai: false, pending: true, _gf: s };
  }

  let lastScrapeSig = "";
  let lastScrapeCount = 0;
  function scrapeForm() {
    try {
      const found = gfScrape();
      if (!found.length) return;
      const formT = stripHtml((document.querySelector(".F9yp7e, .freebirdFormviewerViewHeaderTitle")||{}).innerText || document.title || "");
      if (formT) state.formTitle = formT.slice(0, 60);
      const items = found.map(gfToItem);
      const sig = items.map((it) => normQ(it.question) + "|" + (it.options || []).join("|")).join("¦");
      if (sig === lastScrapeSig && items.length === lastScrapeCount) return;
      lastScrapeSig = sig; lastScrapeCount = items.length;
      // pertahankan jawaban/status yang sudah ada dari daftar lama
      const prev = new Map(state.items.map((it) => [normQ(it.question) + "|" + (it.options || []).join("|"), it]));
      items.forEach((it) => {
        const k = normQ(it.question) + "|" + (it.options || []).join("|");
        const ex = prev.get(k);
        if (ex) { it.answers = ex.answers || []; it.ai = ex.ai; it.tag = ex.tag; it.pending = ex.pending; it.qhash = ex.qhash; it._filled = ex._filled; }
      });
      trackFullList(items, { source: "form" });
      dbg(found.length + " soal • " + items.map((i) => i.type).join(","));
    } catch (e) { dbg("err " + e.message); }
  }

  /* ================= merge / set ================= */
  function mergeItems(items, source) {
    if (!items?.length) return;
    const seen = new Map(state.items.map((it) => [normQ(it.question) || ("#opts:" + (it.options || []).join("|").slice(0, 80)), it]));
    for (const it of items) {
      const k = normQ(it.question) || ("#opts:" + (it.options || []).join("|").slice(0, 80));
      const ex = seen.get(k);
      if (!ex) { state.items.push(it); seen.set(k, it); }
      else if (!ex.answers?.length && it.answers?.length) { ex.answers = it.answers; ex.pending = false; }
      if (ex && it._gf) ex._gf = it._gf;
      if (ex && !it._gf) it._gf = it._gf;
    }
    render();
    if (state.highlight) highlightSoon(2000);
    const key = activeKey();
    if (key) ensureSolved(key, source);
    else setStatus(`${state.items.length} soal ketangkep • isi API key di panel ✨`, "warn");
  }

  function trackFullList(items, { source } = {}) {
    state.items = items;
    render();
    setStatus(`${items.length} soal ketangkep • ${source} • menyelesaikan via AI…`, "");
    if (state.highlight) highlightSoon(2000);
    const key = activeKey();
    if (key) ensureSolved(key, source);
    else setStatus(`${items.length} soal ketangkep • isi API key di panel ✨`, "warn");
  }

  /* ================= highlight & fill di Google Form ================= */
  const normMatch = (s) => stripHtml(s).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const splitAns = (txt) => String(stripHtml(txt)).split("||").map((t) => normMatch(t)).filter(Boolean);
  const QS = (node) => ({ radios: [...node.querySelectorAll('[role="radio"], [role="checkbox"]')], text: [...node.querySelectorAll(GF.textInput)], listbox: node.querySelector(GF.listbox) });

  let hlDeadline = 0, hlTimer = null;
  function highlightSoon(ms = 3000) { if (!state.highlight) return; hlDeadline = Date.now() + ms; if (hlTimer) return; hlTimer = setInterval(() => { if (Date.now() >= hlDeadline) { clearInterval(hlTimer); hlTimer = null; return; } highlightInPage(); }, 500); }

  function markEl(el, ok) {
    try { el.style.outline = ok ? "3px solid #22c55e" : ""; if (ok) el.style.outlineOffset = "1px"; } catch {}
  }
  function answerCands(it) {
    const cands = new Set();
    (it.answers || []).forEach((a) => splitAns(a.text).forEach((t) => cands.add(t)));
    return cands;
  }
  function highlightInPage() {
    if (!els.frame) return;
    try {
      state.items.forEach((it) => {
        const s = it._gf; if (!s?.node) return;
        const cands = answerCands(it);
        if (!cands.size) return;
        s.els.radios.forEach((r) => {
          const t = normMatch(r.getAttribute("aria-label") || r.getAttribute("data-answer-value") || r.innerText || "");
          markEl(r, isHit(t, cands));
        });
      });
    } catch {}
  }
  function isHit(t, cands) {
    if (!t) return false;
    if (cands.has(t)) return true;
    if (t.length < 4) return false;
    for (const c of cands) if (c.length >= 4 && (t.includes(c) || c.includes(t))) return true;
    return false;
  }

  // klik elemen pilihan via label (Google Form pakai div[role=radio], bukan input)
  function clickChoice(el) {
    try {
      const label = el.closest("label") || el;
      const input = el.querySelector?.("input") || label.querySelector?.("input");
      if (input) {
        const want = true;
        if (input.checked !== want) {
          input.checked = want;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      // div role=radio/checkbox: dispatch click sekali
      const target = el.closest('[role="radio"],[role="checkbox"]') || label;
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch {}
  }
  function setTextInput(input, val) {
    try {
      const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      input.focus();
      setter ? setter.call(input, val) : (input.value = val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    } catch {}
  }

  let autoTimer = null;
  function autoFill() {
    if (!state.autoAnswer) return;
    try {
      state.items.forEach((it) => {
        if (!it.answers?.length || !it._gf?.node) return;
        const n = it._gf.node;
        const q = normQ(it.question);
        if (state.lastAutoQ === q && it._filled) return;
        const cands = answerCands(it);
        if (!cands.size) return;
        const acc = QS(n);
        let acted = false;
        if (acc.radios.length) {
          for (const r of acc.radios) {
            const t = normMatch(r.getAttribute("aria-label") || r.getAttribute("data-answer-value") || r.innerText || "");
            if (isHit(t, cands)) { markEl(r, true); clickChoice(r); acted = true; }
          }
        } else if (acc.text.length) {
          setTextInput(acc.text[0], stripHtml(it.answers[0].text));
          acted = true;
        } else if (acc.listbox) {
          // dropdown: klik listbox lalu opsi
          const opts = [...acc.listbox.querySelectorAll(GF.optionBox)];
          const hit = opts.find((o) => isHit(normMatch(o.innerText || ""), cands));
          if (hit) { acc.listbox.click?.(); hit.click?.(); acted = true; }
        }
        if (acted) { it._filled = true; state.lastAutoQ = q; }
      });
    } catch (e) { setStatus("Auto isi gagal: " + e.message, "err"); }
  }
  setInterval(() => {
    if (!state.highlight) return;
    if (state.items.length) highlightInPage();
    scrapeForm();
  }, 1200);
  setInterval(() => { if (state.autoAnswer) autoFill(); }, 900);

  /* ================= AI providers ================= */
  const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
  const BASE = "https://generativelanguage.googleapis.com";
  const KNOWN_BAD_MODEL = /3\.5|lite|preview|exp|rc|image|tts|embedding|aqa|veo|learnlm/i;
  const MODEL_RE = /^gemini-[a-z0-9.\-]+$/i;

  async function listGeminiModels(apiKey) {
    const cached = LS.get("zulfa_models_cache");
    if (cached) { try { const c = JSON.parse(cached); if (c && Date.now() - c.at < 6 * 3600e3) return c.names || []; } catch {} }
    for (const ver of ["v1beta", "v1"]) {
      const res = await fetch(`${BASE}/${ver}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`);
      if (res.status === 404) continue;
      if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`ListModels HTTP ${res.status} ${t.slice(0, 200)}`); }
      const data = await res.json();
      const names = (data?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name || "").replace(/^models\//, "")).filter(Boolean);
      if (names.length) { LS.set("zulfa_models_cache", JSON.stringify({ at: Date.now(), names })); return names; }
    }
    return [];
  }
  const modelScore = (n) => { const s = String(n); const m = s.match(/(\d+)\.(\d+)/); const pro = /pro/i.test(s) ? 1e9 : 0; const stable = /exp|preview|rc|lite/i.test(s) ? 0 : 1; return pro + stable * 1e6 + (m ? +m[1] * 1e3 + +m[2] : 0); };
  const isThinking = (n) => { const s = String(n); return /pro|thinking/i.test(s) && !/image|tts|embedding|aqa|lite/i.test(s); };
  const isValidModel = (n) => { const s = String(n); return (MODEL_RE.test(s) || s === "gemini-flash-latest") && !KNOWN_BAD_MODEL.test(s); };

  function buildPrompt(questions) {
    const list = questions.map((q, i) => { const opts = q.options.length ? q.options.join(" | ") : "(isian — tulis jawaban singkat)"; return `${i + 1}. ${q.question}\n   Opsi: ${opts}`; }).join("\n");
    const sys = [
      "Kamu seorang PROFESOR POLYMATH dengan pengalaman puluhan tahun mengajar & meneliti di SEMUA bidang: matematika, fisika, kimia, biologi, kedokteran, farmasi, teknik (sipil/mesin/elektro/informatika/kimia), ekonomi, akuntansi, manajemen, hukum, psikologi, sosiologi, filsafat, sejarah, sastra & bahasa (Indonesia/Inggris/asing), agama, pendidikan (PGSD/PAUD), pertanian, kesehatan masyarakat, ilmu komputer/AI, statistik, dan bidang lain. Kamu menguasai kedalaman konsep, bukan sekadar hafalan — paham 'mengapa', bukan cuma 'apa'.",
      "SIKAP: teliti, skeptis pada jawaban sendiri, anti-halusinasi. Kerja internal; JANGAN tampilkan langkah/reasoning di output.",
      "CARA BERPIKIR (internal, tiap soal):",
      "A. Identifikasi bidang & jenis soal (definisi, hitungan, analisis, kasus/evaluasi, hafalan terapan).",
      "B. Kumpulkan fakta/teori/hukum yang relevan & PASTI kamu yakini benar. Jangan mengarang data, angka, tahun, nama, rumus, atau dalil yang tak kamu kuasai.",
      "C. Jawab dari prinsip dulu (derivasi/analisis), baru cocokkan ke opsi. Hitungan: kerjakan bertahap, cek ulang, jaga tanda, satuan, satuan turunan, dan presisi/angka penting.",
      "D. VERIFIKASI SILANG: uji jawaban — masuk akal? konsisten dengan hukum/dalil? satuan benar? Untuk kasus (hukum/kedokteran/ekonomi): terapkan prinsip pokok & uji setiap opsi, buang yang melanggar asas.",
      "E. Jika benar-benar RAGU dan opsi tersedia: pilih yang paling didukung fakta/kaidah ilmiah. Jangan menebak acak. Untuk isian tanpa opsi dan kamu tak yakin: tulis jawaban paling ilmiah yang kamu yakini, jangan 'tidak tahu'.",
      "ATURAN PER SOAL (WAJIB):",
      "1. Baca soal & SEMUA opsi sampai habis. Waspadai: 'BUKAN', 'kecuali', 'paling tepat/benar', 'semua benar/salah', negasi ganda, kata kunci mutlak ('selalu','tak pernah'), satuan, dan angka mirip.",
      "2. MCQ: jawab = teks opsi terpilih, DISALIN PERSIS karakter demi karakter (tanda baca, spasi, simbol, diakritik, huruf/angka). Jangan parafrase, jangan tambah 'A.' atau sejenisnya.",
      "3. Jika >1 jawaban benar: gabung teks tiap opsi benar dipisah ' || ' (mis. \"A || B\"). Jika soal minta 'semua benar' dan opsi berupa daftar, ikuti apa adanya.",
      "4. True/False & Benar/Salah → tulis persis \"True\" atau \"False\".",
      "5. Isian/hitungan tanpa opsi: tulis jawaban singkat paling tepat. Hitungan: angka saja tanpa satuan kecuali satuan bagian dari jawaban; gunakan format angka biasa (mis. '3.5', '1/2', 'x^2').",
      "6. Soal berbahasa Indonesia dijawab istilah/teks sesuai bahasa soal; soal berbahasa Inggris/bahasa asing dijawab sesuai bahasa opsi yang diberikan.",
      "7. WAJIB: jawaban MCQ harus SAMA dengan salah satu teks opsi. Jika tak ada yang persis cocok, pilih opsi paling mendekati secara makna/angka — JANGAN mengarang opsi baru.",
      'FORMAT: balas HANYA JSON array valid [{"index":<nomor soal>,"answer":"<teks>"}]. Satu objek per soal, urut naik, semua soal terjawab. Tanpa markdown, tanpa penjelasan, tanpa teks lain.',
      'CONTOH: soal "Ibu kota Prancis? Opsi: Berlin | Paris | Roma" → {"index":1,"answer":"Paris"} — disalin persis, bukan "A. Paris". Soal hitungan "2+3?" → {"index":2,"answer":"5"}.',
    ].join("\n");
    return sys + "\n\nSOAL:\n" + list;
  }
  function parseGeminiJson(text) {
    const clean = String(text || "").replace(/```json|```/g, "").trim();
    const m = clean.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("Respon AI tidak bisa diparse.");
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) throw new Error("Respon AI bukan array.");
    return arr.filter((x) => x && typeof x === "object" && Number.isFinite(Number(x.index)) && x.answer != null && String(x.answer).trim() !== "");
  }
  function pickOption(rawAnswer, options) {
    const a = stripHtml(String(rawAnswer ?? "")).trim();
    if (!a || !options?.length) return a;
    const na = normMatch(a);
    const exact = options.find((o) => stripHtml(o).trim() === a);
    if (exact) return exact;
    const matched = options.find((o) => normMatch(o) === na);
    if (matched) return matched;
    const loose = options.find((o) => { const no = normMatch(o); return no && (no.includes(na) || na.includes(no)); });
    return loose || a;
  }
  async function tryModel(apiKey, model, prompt, thinking = false) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    const gen = { temperature: 0.1, maxOutputTokens: 8192 };
    if (thinking) gen.thinkingConfig = { thinkingBudget: 8192 };
    const doFetch = (cfg) => fetch(`${BASE}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: cfg }),
    });
    try {
      let res = await doFetch(gen);
      if (res.status === 400 && gen.thinkingConfig) {
        try {
          const t = await res.text();
          if (/thinking/i.test(t)) {
            const bare = { temperature: 0.1, maxOutputTokens: 8192 };
            res = await doFetch(bare);
          }
        } catch {}
      }
      if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Gemini [${model}] HTTP ${res.status} ${t.slice(0, 200)}`); }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "";
      if (!text) throw new Error(`Gemini [${model}] respon kosong.`);
      return { text, model };
    } catch (e) { if (e?.name === "AbortError") throw new Error(`Gemini [${model}] timeout 120 dtk`); throw e; }
    finally { clearTimeout(timer); }
  }
  async function callGemini(apiKey, prompt) {
    const candidates = [];
    const stored = LS.get("zulfa_model");
    if (stored && isValidModel(stored)) candidates.push(stored);
    else if (stored) LS.set("zulfa_model", "");
    try {
      const names = await listGeminiModels(apiKey);
      const usable = names.filter(isValidModel);
      for (const n of [...new Set(usable)].sort((a, b) => modelScore(b) - modelScore(a))) if (!candidates.includes(n)) candidates.push(n);
    } catch (e) { if (/ListModels HTTP (400|401|403|429)/.test(e.message)) throw e; }
    for (const m of GEMINI_MODELS) if (!candidates.includes(m)) candidates.push(m);
    let lastErr = null;
    const ordered = candidates.filter(isValidModel).slice(0, 8);
    for (const model of (ordered.length ? ordered : GEMINI_MODELS)) {
      const thinking = isThinking(model);
      try { const out = await tryModel(apiKey, model, prompt, thinking); LS.set("zulfa_model", model); return { ...out, thinking }; }
      catch (e) {
        lastErr = e;
        if (/HTTP (401|403|429|400)/.test(e.message)) { LS.set("zulfa_model", ""); continue; }
        if (/HTTP 404/.test(e.message)) continue;
      }
    }
    throw lastErr || new Error("Semua model Gemini gagal.");
  }
  async function callThirtystore(apiKey, prompt) {
    const base = getTsBase();
    const model = getTsModel();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 8192, stream: false }),
      });
      if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`ThirtyStore [${model}] HTTP ${res.status} ${t.slice(0, 200)}`); }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "";
      if (!text) throw new Error(`ThirtyStore [${model}] respon kosong.`);
      return { text, model, thinking: true };
    } catch (e) { if (e?.name === "AbortError") throw new Error(`ThirtyStore [${model}] timeout 120 dtk`); throw e; }
    finally { clearTimeout(timer); }
  }
  async function solveWithAI(apiKey, questions) {
    const call = getProvider() === "thirtystore" ? callThirtystore : callGemini;
    const qs = questions;
    const out = [];
    const SIZE = 10;
    const CONC = 4;
    const chunks = [];
    for (let s = 0; s < qs.length; s += SIZE) chunks.push({ s, chunk: qs.slice(s, s + SIZE) });
    const results = [];
    for (let i = 0; i < chunks.length; i += CONC) {
      const wave = chunks.slice(i, i + CONC).map(({ s, chunk }) =>
        call(apiKey, buildPrompt(chunk)).then(({ text }) => ({ s, arr: parseGeminiJson(text) }))
      );
      results.push(...await Promise.all(wave));
    }
    for (const { s, arr } of results) {
      arr.forEach((a) => {
        const local = Number(a.index) - 1;
        if (local < 0 || local >= qs.length - s) return;
        const idx = local + s;
        if (!qs[idx]) return;
        out.push({ index: idx + 1, answer: pickOption(a.answer, questions[idx]?.options) });
      });
    }
    return out;
  }

  /* ================= solve queue + cache ================= */
  function requestSolve(source = "AI") {
    requestSolve.retries = requestSolve.retries || 0;
    const key = activeKey();
    if (!key) { setStatus(`${state.items.length} soal ketangkep • isi API key di panel ✨`, "warn"); return; }
    ensureSolved(key, source).then((r) => {
      if (!r?.ok && /Masih menyelesaikan/.test(r?.error || "")) {
        if (requestSolve.retries < 3) { requestSolve.retries++; setTimeout(() => requestSolve(source), 4000); }
        else { requestSolve.retries = 0; setStatus(`AI sibuk • klik lagi buat retry`, "warn"); }
      } else requestSolve.retries = 0;
    });
  }

  let solveDirty = false;
  async function ensureSolved(apiKey, source = "AI") {
    if (!state.items.length) return { ok: false, error: "Belum ada soal ketangkep." };
    if (!apiKey) return { ok: false, error: "Isi API key di panel dulu." };
    if (state.solving) { solveDirty = true; return { ok: false, error: "Masih menyelesaikan, tunggu…" }; }
    state.solving = true;
    try {
      do {
        solveDirty = false;
        const pending = state.items.filter((x) => !x.answers?.length);
        if (!pending.length) { render(); if (state.highlight) highlightSoon(4000); setStatus(`${state.items.length} soal di panel ✨ • ${source} • ${activeKey() ? "model: " + (getProvider() === "thirtystore" ? getTsModel() : (LS.get("zulfa_model") || "auto")) + " 🧠" : ""} • AI bisa salah, cek ulang`, "ok"); return { ok: true, count: state.items.length, cached: true }; }
        const need = [];
        for (const it of pending) {
          const h = hashStr(normQ(it.question) + "|" + (it.options || []).join("|"));
          it.qhash = h;
          let hit = null; try { hit = JSON.parse(LS.get("zulfa_q_" + h) || "null"); } catch {}
          if (hit?.answer) { it.answers = [{ text: hit.answer, mediaUrl: null }]; it.ai = true; it.tag = "AI ✨"; it.pending = false; }
          else need.push(it);
        }
        if (need.length) {
          const BS = 10;
          const nb = Math.ceil(need.length / BS);
          const t0 = Date.now();
          let failed = 0, lastErr = null;
          for (let b = 0; b < nb; b++) {
            const chunk = need.slice(b * BS, b * BS + BS);
            const el = Math.round((Date.now() - t0) / 1000);
            setStatus(`Menyelesaikan batch ${b + 1}/${nb} (${chunk.length} soal, ${el} dtk)…`, "");
            try {
              const cleaned = chunk.map((x) => ({ question: stripHtml(x.question), options: x.options || [] }));
              const answers = await solveWithAI(apiKey, cleaned);
              const map = new Map(answers.map((a) => [Number(a.index), String(a.answer ?? "")]));
              chunk.forEach((it, i) => {
                const a = map.get(i + 1);
                if (a) { it.answers = [{ text: a, mediaUrl: null }]; it.ai = true; it.tag = "AI ✨"; LS.set("zulfa_q_" + it.qhash, JSON.stringify({ answer: a, at: Date.now() })); }
                it.pending = false;
              });
            } catch (e) {
              if (/HTTP (400|401|403|429)/.test(e.message || "")) throw e;
              lastErr = e; failed += chunk.length; chunk.forEach((it) => { it.pending = true; });
            }
            render();
            if (state.highlight) highlightSoon(4000);
          }
          if (failed > 0 && failed === need.length) throw lastErr || new Error("Semua batch gagal");
          if (failed > 0) {
            render(); highlightInPage();
            setStatus(`${state.items.length - failed}/${state.items.length} selesai ✨ • ${failed} gagal (timeout) — menunggu retry`, "warn");
            return { ok: true, count: state.items.length - failed, partial: failed };
          }
        }
        render(); if (state.highlight) highlightSoon(4000);
        setStatus(`${state.items.length} soal di panel ✨ • ${source} • ${activeKey() ? "model: " + (getProvider() === "thirtystore" ? getTsModel() : (LS.get("zulfa_model") || "auto")) + " 🧠" : ""} • AI bisa salah, cek ulang`, "ok");
        return { ok: true, count: state.items.length, cached: false };
      } while (solveDirty);
      return { ok: true, count: state.items.length, cached: true };
    } catch (e) { setStatus(`AI gagal: ${e.message}`, "err"); return { ok: false, error: e.message }; }
    finally { state.solving = false; }
  }

  /* ================= init ================= */
  function boot() {
    injectCSS();
    buildUI();
    if (!activeKey()) setStatus("Pilih provider & isi API key di panel atas (sekali saja, tersimpan lokal).", "warn");
    scrapeForm();
    console.log("%c[zulfa-googleform] ready", "color:#6b7280;font-weight:bold");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

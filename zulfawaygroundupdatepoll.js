/* zulfawayground — bookmarklet study assistant (Wayground / Quizizz / Kahoot)
 * Gabungan penuh: hook trafik (main world) + panel UI + Gemini solve.
 * Jalan di konteks halaman saat bookmark diklik. Tanpa extension, tanpa bot join.
 *
 * Pakai:
 *   1) Buat bookmark baru. Nama: zulfawayground
 *   2) URL: tempel hasil dari build.js (isi javascript:...) atau
 *      tempel isi file ini dgn prefix "javascript:" lalu minify manual.
 *   3) Buka tab game, join seperti biasa, klik bookmark.
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
  const state = { items: [], highlight: true, minimized: false, userHidden: false, solving: false, roomName: "", autoAnswer: false, autoDelay: 3, lastAutoQ: "" };

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
  const optText = (o) => stripHtml(typeof o === "string" ? o : (o?.text || o?.answer || ""));

  /* ================= normalisasi soal ================= */
  function fromWaygroundQuestions(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.map((q) => {
      const st = q.structure || {};
      const query = st.query || {};
      const qText = query.text || q.question || "";
      const qMedia = query.media?.[0]?.url || query.image || st.image || null;
      const opts = st.options || q.options || q.answers || [];
      const options = opts.map(optText).filter(Boolean);
      const ans = st.answer ?? q.answer;
      let answers = [];
      if (ans !== undefined) {
        const idx = Array.isArray(ans) ? ans : [ans];
        answers = idx.map((i) => {
          if (typeof i === "number") { const o = opts[i]; return o ? { text: optText(o), mediaUrl: o.media?.[0]?.url || o.image || null } : null; }
          return { text: String(i), mediaUrl: null };
        }).filter(Boolean);
      }
      return { question: qText, questionMedia: qMedia, answers, options, type: q.type || st.kind || "MCQ", tag: "MCQ", ai: false, pending: !answers.length };
    }).filter((x) => stripHtml(x.question) || x.options.length);
  }
  const fromRoomObject = (obj) => (obj && typeof obj === "object" && !Array.isArray(obj)) ? fromWaygroundQuestions(Object.values(obj)) : null;

  function fromKahoot(arr) {
    if (!Array.isArray(arr)) return null;
    return arr.map((q) => {
      const choices = (q.choices || []).map((c) => c.answer || "");
      const correct = (q.choices || []).filter((c) => c.correct);
      return { question: q.question || "", questionMedia: q.image || q.video?.fullUrl || null, answers: correct.map((c) => ({ text: c.answer || "", mediaUrl: c.image || null })), options: choices, type: q.type || "quiz", tag: "KAHOOT", ai: false, pending: !correct.length };
    }).filter((x) => stripHtml(x.question) || x.options.length);
  }

  function normalizeLoose(q) {
    if (!q || typeof q !== "object") return null;
    if (q.structure?.query) return fromWaygroundQuestions([q])?.[0] || null;
    const qText = typeof q.question === "string" ? q.question : (q.text || q.title || "");
    const rawOpts = q.options || q.choices || [];
    const options = (Array.isArray(rawOpts) ? rawOpts : []).map(optText).filter(Boolean);
    if (!stripHtml(qText) && !options.length) return null;
    return { question: qText, questionMedia: q.image || q.media || null, answers: [], options, type: q.type || "MCQ", tag: "MCQ", ai: false, pending: true };
  }

  function extractQuizInfo(raw) {
    const cands = [raw?.data?.questions, raw?.data?.quiz?.questions, raw?.data?.quiz?.info?.questions, raw?.questions, raw?.data?.items, raw?.data?.quiz, raw?.data];
    for (const c of cands) {
      if (!c) continue;
      if (Array.isArray(c)) { const a = fromWaygroundQuestions(c); if (a?.length) return a; const k = fromKahoot(c); if (k?.length) return k; }
      else if (typeof c === "object" && !c.structure) {
        const vals = Object.values(c);
        if (vals.length && vals.every((v) => v && typeof v === "object" && (v.structure || v.question))) { const a = fromRoomObject(c); if (a?.length) return a; }
      }
    }
    const one = normalizeLoose(raw?.data || raw);
    return one ? [one] : null;
  }
  const itemsHaveAnswers = (items) => items?.some((x) => x.answers?.length);

  /* ================= panel UI (inline style + CSS) ================= */
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
        <span id="zulfa-title">zulfawayground <small id="zulfa-sub"></small></span>
        <span style="display:flex;gap:6px">
          <button type="button" id="zulfa-min" title="Perkecil ke tombol">—</button>
        </span>
      </div>
      <div id="zulfa-body">
        <div id="zulfa-status">Join game seperti biasa — soal dibaca dari tabmu lalu diselesaikan AI.</div>
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
          <input type="checkbox" id="zulfa-auto" style="width:auto;flex:0 0 auto;accent-color:#4b5563" /> Auto jawab
          <span style="flex:0 0 auto">delay</span>
          <input type="number" id="zulfa-autodelay" min="0" step="1" value="3" style="width:52px;box-sizing:border-box;padding:3px 6px;border:1px solid #2e3440;border-radius:6px;background:#1a1e24;color:#d1d5db;font-size:11px;outline:none" />
          <span style="flex:0 0 auto">dtk</span>
        </label>
        <label id="zulfa-verifyrow" style="display:flex;align-items:center;gap:6px;padding:0 9px 6px;font-size:11px;color:#7d8592">
          <input type="checkbox" id="zulfa-verify" style="width:auto;flex:0 0 auto;accent-color:#4b5563" /> Verifikasi 2-pass (lebih akurat, sedikit lebih lama)
        </label>
        <div id="zulfa-results"></div>
        <div id="zulfa-debug"></div>
      </div>
      <div id="zulfa-resize" title="Tarik untuk ubah ukuran"></div>`;
    document.documentElement.appendChild(wrap);
    const fab = document.createElement("button");
    fab.id = "zulfa-fab";
    fab.title = "zulfawayground (Alt+H)";
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
      els.auto.onchange = () => { state.autoAnswer = els.auto.checked; LS.set("zulfa_auto", els.auto.checked ? "1" : "0"); setStatus(els.auto.checked ? `Auto jawab ON • delay ${state.autoDelay} dtk` : "Auto jawab OFF", els.auto.checked ? "ok" : ""); };
      els.autoDelay.oninput = () => { const n = parseFloat(els.autoDelay.value); state.autoDelay = Number.isFinite(n) && n >= 0 ? n : 0; LS.set("zulfa_auto_delay", String(state.autoDelay)); };
    }
    const verifyEl = document.getElementById("zulfa-verify");
    if (verifyEl) {
      verifyEl.checked = LS.get("zulfa_verify") !== "0";
      verifyEl.onchange = () => LS.set("zulfa_verify", verifyEl.checked ? "1" : "0");
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
      els.frame.style.setProperty("left", nx + "px", "important");
      els.frame.style.setProperty("top", ny + "px", "important");
      els.frame.style.setProperty("right", "auto", "important");
    };
    const start = (cx, cy) => {
      drag = true; sx = cx; sy = cy;
      const r = els.frame.getBoundingClientRect(); ox = r.left; oy = r.top;
    };
    const onDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.target?.closest?.("button,input,select,a,textarea")) return;
      start(e.clientX, e.clientY);
      try { header.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault(); e.stopPropagation();
    };
    header.addEventListener("pointerdown", onDown, true);
    header.addEventListener("mousedown", (e) => { if (!drag) onDown(e); }, true);
    header.addEventListener("touchstart", (e) => {
      if (drag) return;
      if (e.target?.closest?.("button,input,select,a,textarea")) return;
      const t = e.touches[0]; if (!t) return; start(t.clientX, t.clientY);
    }, { passive: true, capture: true });
    const onMove = (e) => {
      if (!drag) return;
      if (e.touches) { const t = e.touches[0]; if (t) moveTo(t.clientX, t.clientY); }
      else moveTo(e.clientX, e.clientY);
      if (e.cancelable) e.preventDefault();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("touchmove", onMove, { passive: false, capture: true });
    const onUp = () => (drag = false);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("touchend", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("blur", onUp);
    window.addEventListener("resize", () => {
      if (!els.frame) return;
      const r = els.frame.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - r.width);
      const maxY = Math.max(0, window.innerHeight - r.height);
      els.frame.style.setProperty("left", Math.min(maxX, Math.max(0, r.left)) + "px", "important");
      els.frame.style.setProperty("top", Math.min(maxY, Math.max(0, r.top)) + "px", "important");
      els.frame.style.setProperty("right", "auto", "important");
    });

    const rz = document.getElementById("zulfa-resize");
    let rx = 0, ry = 0, rw = 0, rh = 0, rsz = false;
    const RMIN_W = 240, RMIN_H = 200;
    const resizeTo = (cx, cy) => {
      const r = els.frame.getBoundingClientRect();
      const maxW = Math.max(RMIN_W, window.innerWidth - r.left);
      const maxH = Math.max(RMIN_H, window.innerHeight - r.top);
      const w = Math.round(Math.min(maxW, Math.max(RMIN_W, rw + cx - rx)));
      const h = Math.round(Math.min(maxH, Math.max(RMIN_H, rh + cy - ry)));
      els.frame.style.setProperty("width", w + "px", "important");
      els.frame.style.setProperty("height", h + "px", "important");
      els.frame.style.setProperty("max-width", "none", "important");
      els.frame.style.setProperty("max-height", "none", "important");
    };
    const rStart = (cx, cy) => { rsz = true; rx = cx; ry = cy; rw = els.frame.offsetWidth; rh = els.frame.offsetHeight; };
    if (rz) {
      rz.addEventListener("pointerdown", (e) => {
        if (e.button != null && e.button !== 0) return;
        rStart(e.clientX, e.clientY);
        try { rz.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault(); e.stopPropagation();
      }, true);
      rz.addEventListener("mousedown", (e) => { if (!rsz) { rStart(e.clientX, e.clientY); e.preventDefault(); e.stopPropagation(); } }, true);
      rz.addEventListener("touchstart", (e) => { if (rsz) return; const t = e.touches[0]; if (t) rStart(t.clientX, t.clientY); e.stopPropagation(); }, { passive: true, capture: true });
      const rMove = (e) => {
        if (!rsz) return;
        if (e.touches) { const t = e.touches[0]; if (t) resizeTo(t.clientX, t.clientY); }
        else resizeTo(e.clientX, e.clientY);
        if (e.cancelable) e.preventDefault();
      };
      window.addEventListener("pointermove", rMove, true);
      window.addEventListener("mousemove", rMove, true);
      window.addEventListener("touchmove", rMove, { passive: false, capture: true });
      const rUp = () => (rsz = false);
      window.addEventListener("pointerup", rUp, true);
      window.addEventListener("mouseup", rUp, true);
      window.addEventListener("touchend", rUp, true);
      window.addEventListener("pointercancel", rUp, true);
      window.addEventListener("blur", rUp);
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

  function setStatus(text, kind = "") { if (!els.status) return; els.status.textContent = text; els.status.dataset.kind = kind; if (els.sub) els.sub.textContent = state.roomName ? "• " + state.roomName : ""; }
  function dbg(t) { try { if (els.debug) els.debug.textContent = "net: " + t; } catch {} }

  function render(filter = "") {
    if (!els.results) return;
    const f = (filter || els.search?.value || "").toLowerCase();
    let list = state.items;
    if (f) list = list.filter((it) => {
      const q = stripHtml(it.question).toLowerCase();
      const a = [...(it.answers || []).map((x) => stripHtml(x.text)), ...(it.options || [])].join(" ").toLowerCase();
      return q.includes(f) || a.includes(f);
    });
    if (!list.length) { els.results.innerHTML = `<div class="zulfa-empty">${state.items.length ? "Tidak cocok." : "Belum ada soal. Join game dulu."}</div>`; return; }
    els.results.innerHTML = list.map((it, i) => {
      const qMedia = it.questionMedia ? `<br><img class="zulfa-qimg" src="${esc(it.questionMedia)}" loading="lazy" />` : "";
      const tag = it.ai ? "AI ✨" : esc(it.tag || it.type || "");
      const ans = it.pending && !it.answers.length ? `<div class="zulfa-ans zulfa-pending">⏳ menunggu AI…</div>`
        : it.answers.length ? it.answers.map((a) => { const img = a.mediaUrl ? `<br><img class="zulfa-aimg" src="${esc(a.mediaUrl)}" loading="lazy" />` : ""; return `<div class="zulfa-ans">${it.ai ? "✨ " : ""}${cleanHtml(a.text)}${img}</div>`; }).join("")
        : `<div class="zulfa-ans zulfa-none">—</div>`;
      return `<div class="zulfa-card"><div class="zulfa-qhead"><b>${i + 1}.</b> <span class="zulfa-tag">${tag}</span></div><div class="zulfa-q">${cleanHtml(it.question) || "<i>(soal gambar — lihat highlight)</i>"}${qMedia}</div>${ans}</div>`;
    }).join("");
    els.results.querySelectorAll("img").forEach((img) => { img.referrerPolicy = "no-referrer"; });
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
    }
    render();
    if (state.highlight) highlightSoon(2000);
    const key = activeKey();
    if (key) ensureSolved(key, source);
    else setStatus(`${state.items.length} soal ketangkep • isi API key di panel ✨`, "warn");
  }

  function trackFullList(items, { roomName, source } = {}) {
    if (roomName) state.roomName = roomName;
    state.items = items;
    render();
    if (itemsHaveAnswers(items)) setStatus(`${items.length} soal • kunci publik ✅ • ${source}`, "ok");
    else setStatus(`${items.length} soal ketangkep • ${source} • menyelesaikan via AI…`, "");
    if (state.highlight) highlightSoon(2000);
    const key = activeKey();
    if (key && !itemsHaveAnswers(items)) ensureSolved(key, source);
    else if (!key) setStatus(`${items.length} soal ketangkep • isi API key di panel ✨`, "warn");
  }

  /* ================= highlight di halaman ================= */
  const KAHOOT_Q_SEL = '[data-functional-selector="question-title"],[data-functional-selector="block-title"],[data-functional-selector*="question-title"]';
  const OPT_SEL = '[data-cy^="option-"],[data-functional-selector="answer-option"],[data-functional-selector^="question-choice"],button[data-functional-selector*="answer"],button[data-functional-selector*="choice"]';
  const normMatch = (s) => { let t = stripHtml(s).replace(/−/g, "-"); t = t.replace(/\^?\\circ/g, "°").replace(/\\mathrm\{([^}]*)\}/g, "$1"); t = t.replace(/[\\${}]/g, ""); return t.toLowerCase().replace(/\s+/g, ""); };
  function btnText(btn) {
    try {
      const anns = [...btn.querySelectorAll("annotation")].map((a) => (a.textContent || "").trim()).filter(Boolean);
      if (anns.length) return normMatch(anns.join(" "));
      const kh = btn.querySelector(".katex-html");
      if (kh && (kh.innerText || "").trim()) return normMatch(kh.innerText);
      return normMatch(btn.innerText || "");
    } catch { return ""; }
  }
  const Q_SEL = '[data-quesid] .question-text,[data-quesid],[class*="question-text"],h2[class*="question"],div[class*="question-text"]';
  function screenQuestion() {
    try {
      for (const el of document.querySelectorAll(Q_SEL)) {
        const t = stripHtml(el.innerText || "").trim();
        if (t.length >= 4) return t;
      }
    } catch {}
    return "";
  }
  function screenOptions() {
    return [...document.querySelectorAll(OPT_SEL)].map((b) => btnText(b)).filter(Boolean);
  }
  function currentItem() {
    try {
      const btns = screenOptions();
      const sQ = normQ(screenQuestion());
      if (!btns.length && !sQ) return null;
      let best = null, bestScore = 0;
      for (const it of state.items) {
        const opts = new Set((it.options || []).map(normMatch).filter(Boolean));
        let score = 0;
        if (sQ && normQ(it.question) === sQ) score += 100;
        if (opts.size) score += btns.filter((t) => opts.has(t)).length;
        if (score > bestScore) { bestScore = score; best = it; }
      }
      return bestScore > 0 ? best : null;
    } catch { return null; }
  }
  function markHit(btn) {
    btn.style.outline = "3px solid #22c55e";
  }
  let hlRafId = 0;
  let hlDeadline = 0;
  function highlightSoon(ms = 3000) {
    if (!state.highlight) return;
    hlDeadline = Date.now() + ms;
    if (hlRafId) return;
    const tick = () => {
      hlRafId = 0;
      if (Date.now() >= hlDeadline) return;
      highlightInPage();
      hlRafId = requestAnimationFrame(tick);
    };
    hlRafId = requestAnimationFrame(tick);
  }
  function isHit(t, cands) {
    if (cands.has(t)) return true;
    if (t.length < 6) return false;
    for (const c of cands) if (c.length >= 6 && (t.includes(c) || c.includes(t))) return true;
    return false;
  }
  function highlightInPage() {
    document.querySelectorAll(".zulfa-mark").forEach((n) => n.remove());
    if (!state.items.length) return;
    try {
      const cur = currentItem();
      const pool = cur ? [cur] : state.items;
      const cands = new Set();
      pool.forEach((it) => (it.answers || []).forEach((a) => { const t = normMatch(a.text); if (t) cands.add(t); }));
      if (!cands.size) return;
      const strict = !cur;
      document.querySelectorAll(OPT_SEL).forEach((btn) => {
        const t = btnText(btn);
        if (!t) return;
        const hit = strict ? cands.has(t) : isHit(t, cands);
        if (hit) markHit(btn);
      });
    } catch {}
  }
  function clickOpt(btn) {
    try {
      const target = btn.closest("button") || btn;
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      if (typeof target.click === "function" && !target.disabled) target.click();
    } catch {}
  }
  let autoTimer = null;
  function autoAnswer() {
    if (!state.autoAnswer) return;
    try {
      const sQ = normQ(screenQuestion());
      if (!sQ) return;
      if (state.lastAutoQ === sQ) return;
      const cur = currentItem();
      if (!cur || !cur.answers?.length) return;
      const btns = [...document.querySelectorAll(OPT_SEL)];
      if (!btns.length) return;
      const cands = new Set((cur.answers || []).map((a) => normMatch(a.text)).filter(Boolean));
      if (!cands.size) return;
      let bestBtn = null, bestT = "";
      for (const btn of btns) {
        const t = btnText(btn);
        if (!t) continue;
        if (cands.has(t) || isHit(t, cands)) { if (t.length > bestT.length) { bestBtn = btn; bestT = t; } }
      }
      if (!bestBtn) return;
      state.lastAutoQ = sQ;
      markHit(bestBtn);
      const delay = Math.max(0, state.autoDelay) * 1000;
      setStatus(`Auto jawab dalam ${state.autoDelay} dtk…`, "");
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        try { clickOpt(bestBtn); setStatus(`Auto jawab ✅ • ${stripHtml(bestT).slice(0, 40)}`, "ok"); }
        catch (e) { setStatus(`Auto jawab gagal: ${e.message}`, "err"); }
      }, delay);
    } catch {}
  }
  setInterval(() => {
    if (!state.highlight) return;
    if (state.items.length) highlightInPage();
    scrapeVisible();
  }, 1000);
  setInterval(() => { if (state.autoAnswer) autoAnswer(); }, 800);
  let autoSolveTried = new Set();
  setInterval(() => {
    if (state.solving || !state.items.length) return;
    const key = activeKey();
    if (!key) return;
    const pend = state.items.filter((x) => !x.answers?.length);
    if (!pend.length) return;
    const sig = pend.map((x) => normQ(x.question)).join("¦");
    if (autoSolveTried.has(sig)) return;
    autoSolveTried.add(sig);
    if (autoSolveTried.size > 50) autoSolveTried = new Set([sig]);
    ensureSolved(key, "auto");
  }, 2500);

  let lastScrapeQ = "";
  function scrapeVisible() {
    try {
      const qText = screenQuestion();
      if (!qText) return;
      const nq = normQ(qText);
      if (!nq || state.items.some((it) => normQ(it.question) === nq)) return;
      const opts = [...document.querySelectorAll(OPT_SEL)];
      if (opts.length < 2) return;
      if (nq === lastScrapeQ) return;
      lastScrapeQ = nq;
      const rawOpts = opts.map((b) => b.innerText || "").filter(Boolean);
      const item = { question: qText, questionMedia: null, answers: [], options: rawOpts, type: "MCQ", tag: "MCQ", ai: false, pending: true };
      mergeItems([item], "layar");
    } catch {}
  }

  /* ================= hook trafik (jalan di main world) ================= */
  function installHook() {
    try {
      const BLOCK = ["blur", "focus", "visibilitychange", "focusin", "focusout", "fullscreenchange", "fullscreenerror", "contextmenu"];
      const wAdd = window.addEventListener.bind(window);
      const dAdd = document.addEventListener.bind(document);
      const etAdd = EventTarget.prototype.addEventListener;
      window.addEventListener = (t, l, o) => (BLOCK.includes(t) ? undefined : wAdd(t, l, o));
      document.addEventListener = (t, l, o) => (BLOCK.includes(t) ? undefined : dAdd(t, l, o));
      EventTarget.prototype.addEventListener = function (t, l, o) { if (BLOCK.includes(t)) return undefined; return etAdd.call(this, t, l, o); };
      Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      if (Element.prototype.requestFullscreen) Element.prototype.requestFullscreen = () => Promise.reject(new Error("blocked"));
      if (document.exitFullscreen) document.exitFullscreen = () => Promise.resolve();
    } catch {}

    const emit = (url, body, text) => {
      try {
        if (SOCKETPOLL.test(url)) { sniffWs(text); return; }
        const mRes = url.match(KAHOOT_RESERVE);
        if (mRes) { state.roomName = "Kahoot PIN " + mRes[1]; setStatus(`Kahoot PIN ${mRes[1]} ketangkep • nunggu soal…`, ""); dbg("pin " + mRes[1]); return; }
        if (SOLO.test(url)) { try { const b = JSON.parse(body); if (b?.quizId) fetchPublicQuiz(b.quizId, "solo"); } catch {} return; }
        const data = JSON.parse(text);
        if (JOIN.test(url) && data?.room) handleRoom(data.room, "join");
        else if (REJOIN.test(url) && data?.data?.room) handleRoom(data.data.room, "rejoin");
        else if (REJOIN.test(url)) handleRejoinRaw(data);
        else if (QUIZINFO.test(url)) { const items = extractQuizInfo(data); if (items?.length) mergeItems(items, "quiz-info"); }
        else if (ATTEMPT.test(url) && data?.data?.quizInfo?.quizId) fetchPublicQuiz(data.data.quizInfo.quizId, "attempt");
        else if (QUIZAPI.test(url)) { const m = url.match(QUIZAPI); const qs = data?.data?.quiz?.info?.questions; if (qs?.length) handleRawWayground(qs, m[1], "quiz-api"); }
      } catch {}
    };

    const JOIN = /play-api\/v5\/join/;
    const REJOIN = /_gameapi\/main\/public\/v1\/games\/([a-f0-9]+)\/rejoin/;
    const QUIZINFO = /_gameapi\/main\/public\/v1\/games\/([a-f0-9]+)\/quiz-info/;
    const SOLO = /play-api\/v4\/soloJoin/;
    const ATTEMPT = /_gameapi\/main\/public\/v1\/students\/attempts\/([a-f0-9]{24})/;
    const QUIZAPI = /\/api\/main\/quiz\/([^/?#]+)/;
    const SOCKETPOLL = /socket\.io|_gsocket/;
    const KAHOOT_RESERVE = /kahoot\.it\/reserve\/session\/(\d+)/;

    function sniffKahootWs(text) {
      try {
        if (typeof text !== "string") return false;
        const s = text.trim();
        if (!s || s[0] !== "[") return false;
        let arr; try { arr = JSON.parse(s); } catch { return false; }
        if (!Array.isArray(arr) || !arr.length) return false;
        if (!arr.some((m) => m && typeof m.channel === "string" && (m.channel.indexOf("/service/") === 0 || m.channel.indexOf("/meta/") === 0))) return false;
        for (const m of arr) {
          try {
            const d = m.data; if (!d || d.content == null) continue;
            const raw = d.content;
            const content = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (!content || typeof content !== "object") continue;
            const qi = typeof content.questionIndex === "number" ? content.questionIndex : (typeof content.questionNumber === "number" ? content.questionNumber : null);
            if (content.type === "quiz" && content.title && Array.isArray(content.choices) && content.choices.length) {
              handleKahootLive({ title: String(content.title), choices: content.choices.map((c) => (typeof c === "string" ? c : (c && c.answer) || "")).filter(Boolean), questionIndex: qi });
            } else if (qi !== null && (d.id === 1 || d.id === 2)) {
              const n = qi + 1; dbg("kahoot soal #" + n); setStatus(`Kahoot soal #${n} mulai…`, "");
              const sc = scrapeKahootVisible(); if (sc) handleKahootLive({ ...sc, questionIndex: qi });
            }
          } catch {}
        }
        return true;
      } catch { return false; }
    }

    let lastWsPost = 0;
    function sniffWs(text) {
      try {
        if (typeof text !== "string" || text.length < 20 || text.length > 500000) return;
        const s = text.replace(/^\d+/, "");
        if (!s || (s[0] !== "{" && s[0] !== "[")) return;
        let obj; try { obj = JSON.parse(s); } catch { return; }
        const found = [];
        const CAP = 200;
        const visit = (n, d) => {
          if (!n || d > 5 || found.length >= CAP) return;
          if (Array.isArray(n)) {
            if (n.length && n.every((x) => x && typeof x === "object" && (x.question || x.query || x.structure))) { found.push(...n.slice(0, CAP)); return; }
            for (const x of n) visit(x, d + 1); return;
          }
          if (typeof n === "object") {
            if (typeof n.question === "string" && (n.options || n.choices)) { found.push(n); return; }
            if (n.structure && n.structure.query) { found.push(n); return; }
            for (const k in n) { if (k === "room" || k === "player" || k === "players") continue; visit(n[k], d + 1); if (found.length >= CAP) return; }
          }
        };
        visit(obj, 0);
        if (!found.length) return;
        const now = Date.now(); if (now - lastWsPost < 2000) return; lastWsPost = now;
        const items = found.slice(0, CAP).map(normalizeLoose).filter(Boolean);
        if (items.length) mergeItems(items, "live");
      } catch {}
    }

    const KH_URL = (u) => JOIN.test(u) || REJOIN.test(u) || QUIZINFO.test(u) || ATTEMPT.test(u) || QUIZAPI.test(u) || SOLO.test(u) || SOCKETPOLL.test(u) || KAHOOT_RESERVE.test(u);

    const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { try { this._zfUrl = String(u); } catch {} return oOpen.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.send = function (b) {
      try { const url = this._zfUrl || ""; if (KH_URL(url)) this.addEventListener("load", function () { try { emit(url, b, this.responseText); } catch {} }); } catch {}
      return oSend.call(this, b);
    };

    const oFetch = window.fetch;
    window.fetch = async function (...a) {
      const res = await oFetch.apply(this, a);
      try { const url = String((a[0] && a[0].url) || a[0] || ""); if (KH_URL(url)) res.clone().text().then((t) => emit(url, null, t)).catch(() => {}); } catch {}
      return res;
    };

    try {
      const OWS = window.WebSocket;
      window.WebSocket = new Proxy(OWS, {
        construct(t, args) {
          const ws = new t(...args);
          try { ws.addEventListener("message", (ev) => { try { if (sniffKahootWs(ev.data)) return; sniffWs(ev.data); } catch {} }); } catch {}
          return ws;
        },
      });
    } catch {}
  }

  /* ================= Gemini (fetch langsung, CORS diizinkan Google) ================= */
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
      "IDENTITAS: Kamu seorang DOSEN UNIVERSITAS senior sekaligus KEPALA INSPEKTUR TEKNIK SIPIL/KONSTRUKSI berpengalaman 30 tahun. Kamu mengoreksi lembar ujian: jawaban salah bisa membuat bangunan roboh atau nilai mahasiswa hancur. Kamu tidak pernah asal jawab.",
      "PRINSIP: Kerja seperti pemeriksa yang teliti dan jujur. Setiap jawaban harus 100% benar dan bisa dipertanggungjawabkan. Kalau bukti tidak cukup untuk memastikan, pilih jawaban yang paling kuat dasarnya, TIDAK menebak acak.",
      "CARA KERJA per soal (lakukan di dalam kepalamu, jangan tulis):",
      "1. Baca soal & SEMUA opsi sampai habis, dua kali. Tandai kata kunci: 'BUKAN', 'kecuali', 'paling tepat/benar', 'semua benar/salah', negasi ganda, perintah hitung, satuan, dan angka yang mirip jebakan.",
      "2. Tentukan jawaban dari fakta/teori/hitunganmu SENDIRI dulu — jangan lihat opsi dulu. Baru setelah itu cocokkan ke opsi.",
      "3. Matematika/fisika/kimia/konstruksi/teknik: tulis langkah logis, cek satuan, cek tanda (+/−), cek pembulatan. Verifikasi ulang hasil minimal satu kali dengan cara berbeda bila mungkin.",
      "4. Waspadai jebakan umum: satuan beda (cm vs m, kJ vs J), 'kecuali' yang menjungkirkan jawaban, opsi 'semua benar', dua angka yang cuma beda koma, kata mutlak ('selalu', 'tidak pernah').",
      "5. Bandingkan setiap opsi dengan hasilmu. Pilih yang benar-benar cocok, bukan yang paling panjang/paling keren.",
      "ATURAN OUTPUT:",
      "A. MCQ: jawab = teks opsi terpilih, DISALIN PERSIS karakter demi karakter (tanda baca, spasi, simbol, huruf, satuan sama). Jangan parafrase, jangan tambah 'A.' atau penjelasan.",
      "B. Bila >1 opsi benar: gabung teks tiap opsi benar dipisah ' || ' (mis. \"Hidrogen || Oksigen\").",
      "C. True/False: tulis persis \"True\" atau \"False\".",
      "D. Isian (tanpa opsi): tulis jawaban paling tepat & singkat; hitungan = angka saja (sertakan satuan hanya bila satuan bagian dari jawaban yang diminta).",
      "E. WAJIB: jawaban MCQ HARUS salah satu dari teks opsi yang diberikan. Jika tak ada yang persis cocok, pilih yang paling mendekati secara makna & angka — JANGAN mengarang opsi baru.",
      'F. FORMAT: balas HANYA JSON array valid [{"index":<nomor>,"answer":"<teks>"}]. Satu objek per soal, urut naik, semua soal terjawab. Tanpa markdown, tanpa penjelasan, tanpa teks lain.',
      'CONTOH BENAR: soal "Ibu kota Prancis? Opsi: Berlin | Paris | Roma" → {"index":1,"answer":"Paris"} (disalin persis, bukan "A. Paris").',
      'CONTOH JEBAKAN: soal "Mana BUKAN bilangan prima? Opsi: 2 | 3 | 4 | 5" → {"index":1,"answer":"4"} (karena "BUKAN", bukan pilih 2).',
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
      const budget = thinking ? 8192 : 0;
      try { const out = await tryModel(apiKey, model, prompt, thinking); LS.set("zulfa_model", model); return { ...out, thinking, budget }; }
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
  function buildArbiterPrompt(questions) {
    const list = questions.map((q, i) => {
      const opts = q.options?.length ? q.options.join(" | ") : "(isian)";
      return `${i + 1}. ${q.question}\n   Opsi: ${opts}\n   Jawaban usulan: A) ${q._a || "-"}   B) ${q._b || "-"}`;
    }).join("\n");
    return [
      "IDENTITAS: Kamu HAKIM PENENTU tingkat akhir — profesor emeritus + inspektur kepala konstruksi. Dua penilai berbeda menghasilkan jawaban di bawah.",
      "TUGAS: Untuk tiap soal, putuskan jawaban yang 100% BENAR. Boleh memilih A, memilih B, atau menulis jawaban ketiga bila keduanya salah.",
      "METODE: Hitung/analisis sendiri dari nol untuk soal hitungan. Cek satuan, tanda, kata 'BUKAN'/'kecuali', negasi. Jangan ikut-ikutan hanya karena salah satu usulan terlihat meyakinkan.",
      "ATURAN: MCQ → jawaban HARUS salah satu teks opsi persis. Isian → jawaban singkat tepat.",
      'FORMAT: balas HANYA JSON array [{"index":<nomor>,"answer":"<teks>"}]. Tanpa penjelasan, tanpa markdown.',
      "",
      "SOAL:",
      list,
    ].join("\n");
  }
  async function askBatch(call, apiKey, chunk) {
    const { text } = await call(apiKey, buildPrompt(chunk));
    const arr = parseGeminiJson(text);
    const m = new Map();
    arr.forEach((a) => { const i = Number(a.index); if (Number.isFinite(i)) m.set(i - 1, String(a.answer ?? "")); });
    return m;
  }
  async function solveWithAI(apiKey, questions, opts = {}) {
    const call = getProvider() === "thirtystore" ? callThirtystore : callGemini;
    const verify = opts.verify !== false;
    const qs = questions;
    const out = [];
    const SIZE = 10;
    const CONC = 4;
    const chunks = [];
    for (let s = 0; s < qs.length; s += SIZE) chunks.push({ s, chunk: qs.slice(s, s + SIZE) });
    const runWaves = async (fn) => {
      const res = [];
      for (let i = 0; i < chunks.length; i += CONC) {
        const wave = chunks.slice(i, i + CONC).map(({ s, chunk }) => fn(s, chunk));
        res.push(...await Promise.all(wave));
      }
      return res;
    };
    const pass1 = await runWaves((s, chunk) => askBatch(call, apiKey, chunk).then((m) => ({ s, m })).catch((e) => ({ s, m: new Map(), err: e })));
    if (!verify) {
      for (const { s, m } of pass1) m.forEach((ans, local) => { const idx = local + s; if (qs[idx]) out.push({ index: idx + 1, answer: pickOption(ans, qs[idx].options) }); });
      return out;
    }
    const pass2 = await runWaves((s, chunk) => askBatch(call, apiKey, chunk).then((m) => ({ s, m })).catch((e) => ({ s, m: new Map(), err: e })));
    const p1 = new Map(), p2 = new Map();
    for (const { s, m } of pass1) m.forEach((v, local) => p1.set(local + s, v));
    for (const { s, m } of pass2) m.forEach((v, local) => p2.set(local + s, v));
    const agree = (a, b) => { if (a == null || b == null) return false; return normMatch(a) === normMatch(b); };
    const contested = [];
    const finalMap = new Map();
    qs.forEach((q, idx) => {
      const a = p1.get(idx), b = p2.get(idx);
      if (agree(a, b)) finalMap.set(idx, pickOption(a, q.options));
      else contested.push({ idx, a, b, q });
    });
    if (contested.length) {
      const CSIZE = 10;
      for (let s = 0; s < contested.length; s += CSIZE) {
        const batch = contested.slice(s, s + CSIZE).map((c) => ({ question: stripHtml(c.q.question), options: c.q.options || [], _a: c.a || "", _b: c.b || "" }));
        try {
          const { text } = await call(apiKey, buildArbiterPrompt(batch));
          const arr = parseGeminiJson(text);
          const m = new Map();
          arr.forEach((x) => { const i = Number(x.index); if (Number.isFinite(i)) m.set(i - 1, String(x.answer ?? "")); });
          batch.forEach((_, i) => {
            const c = contested[s + i];
            const ans = m.get(i);
            finalMap.set(c.idx, pickOption(ans != null ? ans : (c.a || c.b || ""), c.q.options));
          });
        } catch {
          batch.forEach((_, i) => { const c = contested[s + i]; finalMap.set(c.idx, pickOption(c.a || c.b || "", c.q.options)); });
        }
      }
    }
    finalMap.forEach((ans, idx) => { if (qs[idx]) out.push({ index: idx + 1, answer: ans }); });
    return out;
  }

  /* ================= fetch quiz publik (langsung; kalau CORS block, fallback trafik) ================= */
  async function fetchWaygroundQuiz(quizId) {
    const id = String(quizId).trim();
    const urls = [`https://wayground.com/api/main/quiz/${encodeURIComponent(id)}`, `https://quizizz.com/api/main/quiz/${encodeURIComponent(id)}`];
    const errors = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) { errors.push(`${url} -> HTTP ${res.status}`); continue; }
        const data = await res.json();
        const questions = data?.data?.quiz?.info?.questions || data?.data?.quizInfo?.questions || data?.data?.questions || null;
        if (questions?.length) return { ok: true, questions };
        errors.push(`${url} -> kosong`);
      } catch (e) { errors.push(`${url} -> ${e.message}`); }
    }
    return { ok: false, error: "Quiz publik tidak ditemukan. " + errors.join(" | ") };
  }
  async function fetchKahootQuiz(kahootId) {
    const id = String(kahootId).trim();
    const urls = [`https://kahoot.it/rest/kahoots/${encodeURIComponent(id)}`, `https://create.kahoot.it/rest/kahoots/${encodeURIComponent(id)}/card/?includeKahoot=true`];
    const errors = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) { errors.push(`${url} -> HTTP ${res.status}`); continue; }
        const data = await res.json();
        const questions = data?.questions || data?.kahoot?.questions || null;
        if (questions?.length) return { ok: true, questions };
        errors.push(`${url} -> kosong`);
      } catch (e) { errors.push(`${url} -> ${e.message}`); }
    }
    return { ok: false, error: "Kahoot tidak ditemukan. " + errors.join(" | ") };
  }

  async function fetchPublicQuiz(quizId, source = "publik") {
    setStatus(`Mengambil soal quiz ${quizId}…`, "");
    const r = await fetchWaygroundQuiz(quizId);
    if (r?.ok) handleRawWayground(r.questions, quizId, source);
    else setStatus(`Gagal: ${r?.error || "unknown"}`, "err");
  }
  function handleRawWayground(rawQuestions, quizId, source) {
    const items = fromWaygroundQuestions(rawQuestions);
    if (items?.length) { autoShow(); trackFullList(items, { source }); }
    else setStatus("Quiz ketemu tapi soalnya kosong.", "warn");
  }

  /* ================= handler live ================= */
  function handleRoom(room, source) {
    if (!room) return;
    if (room.name) state.roomName = room.name;
    const items = fromRoomObject(room.questions);
    if (items?.length) { trackFullList(items, { roomName: room.name || "", source: source + " • live" }); return; }
    const quizId = room.quizId || room.quizID || null;
    if (quizId) { fetchPublicQuiz(quizId, source); return; }
    setStatus(`Masuk: ${room.name || "lobby"} • nunggu soal…`, "");
  }
  function handleRejoinRaw(raw) {
    const room = raw?.data?.room;
    if (room && (room.questions || room.quizId || room.quizID || room.name)) { handleRoom(room, "rejoin"); return; }
    const items = extractQuizInfo(raw);
    if (items?.length) mergeItems(items, "rejoin");
    else if (room?.name) { state.roomName = room.name; setStatus(`Masuk lobby: ${room.name} • nunggu soal…`, ""); }
  }

  function handleKahootLive(p) {
    const title = stripHtml(p.title || "");
    const choices = (p.choices || []).map((c) => stripHtml(typeof c === "string" ? c : (c?.answer || ""))).filter(Boolean);
    if (!title && !choices.length) return;
    autoShow();
    const item = { question: p.title || "", questionMedia: null, answers: [], options: p.choices || [], type: "quiz", tag: "KAHOOT", ai: false, pending: true, qindex: (p.questionIndex ?? null) !== null ? p.questionIndex : null };
    const nq = normQ(title);
    let ex = null;
    if (item.qindex !== null) ex = state.items.find((it) => (it.qindex ?? null) === item.qindex);
    if (!ex && nq) ex = state.items.find((it) => normQ(it.question) === nq);
    if (ex) {
      if ((ex.qindex ?? null) === null && item.qindex !== null) ex.qindex = item.qindex;
      if (!ex.options?.length && choices.length) { ex.question = item.question; ex.options = item.options; render(); }
      else return;
    } else { state.items.push(item); render(); }
    setStatus(`Kahoot soal ketangkep • menyelesaikan via AI…`, "");
    if (state.highlight) highlightInPage();
    requestSolve("kahoot-live");
  }
  function scrapeKahootVisible() {
    try {
      const t = document.querySelector(KAHOOT_Q_SEL);
      const title = (t?.innerText || "").trim();
      const opts = [...document.querySelectorAll('[data-functional-selector="answer-option"],[data-functional-selector^="question-choice"]')].map((b) => (b.innerText || "").trim()).filter(Boolean);
      if (title && opts.length >= 2) return { title, choices: opts };
    } catch {}
    return null;
  }

  function autoShow() { if (!state.userHidden) showPanel(); }

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
    if (!state.items.length) return { ok: false, error: "Belum ada soal ketangkep. Join game dulu." };
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
            const verifyOn = LS.get("zulfa_verify") !== "0";
            if (verifyOn) setStatus(`Batch ${b + 1}/${nb}: verifikasi 2-pass (${chunk.length} soal)…`, "");
            const answers = await solveWithAI(apiKey, cleaned, { verify: verifyOn });
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
    installHook();
    if (!activeKey()) setStatus("Pilih provider & isi API key di panel atas (sekali saja, tersimpan lokal).", "warn");
    console.log("%c[zulfawayground] ready", "color:#6b7280;font-weight:bold");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

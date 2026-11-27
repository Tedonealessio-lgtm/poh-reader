/* POH Reader · Systems (v1.1.5)
 * Self-contained module. Shows a "Systems" button only when the open manual is a
 * PC-12 NGX (Report 02406) or PC-12 NG (Report 02277) POH, gates it behind PRO,
 * and opens the system page full screen in an overlay.
 *
 * Hook-up (3 calls, see INTEGRATION.md):
 *   POHSystems.configure({ isPro: () => <bool>, showPaywall: () => <open paywall> });
 *   POHSystems.setManual(textOrPagesArray);   // after a manual's text is available
 *   POHSystems.clearManual();                 // when the manual is closed / switched
 */
(function () {
  "use strict";

  const SYSTEMS = [
    { id: "electrical", title: "Electrical", file: "systems/electrical.html", variants: ["NGX", "NG"] }
  ];

  let cfg = { isPro: () => false, showPaywall: () => {}, onEvent: () => {} };
  let variant = null;   // "NGX" | "NG" | null
  let btn = null, overlay = null, menu = null, mountEl = null;

  // ---------- detection ----------
  function detect(input) {
    const text = Array.isArray(input) ? input.join("\n") : String(input || "");
    if (!text) return null;
    const count = re => (text.match(re) || []).length;
    const ngx = count(/\b02406\b/g);
    const ng = count(/\b02277\b/g);
    const pc12 = /PC-?12/i.test(text);
    if (!pc12) return null;
    if (ngx >= 3 && ngx >= ng) return "NGX";
    if (ng >= 3) return "NG";
    return null;
  }

  // ---------- styles ----------
  function injectCss() {
    if (document.getElementById("pohsys-css")) return;
    const st = document.createElement("style");
    st.id = "pohsys-css";
    st.textContent = `
      .pohsys-btn { position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: calc(88px + env(safe-area-inset-bottom));
        z-index: 9000; display: none; align-items: center; gap: 6px; padding: 11px 16px; border-radius: 999px; border: 0;
        font: 600 15px -apple-system, system-ui, sans-serif; color: #fff; background: #1F5FA8; box-shadow: 0 6px 18px rgba(0,0,0,.25); cursor: pointer; }
      .pohsys-btn.mounted { position: static; box-shadow: none; }
      .pohsys-btn .pro { font-size: 10px; font-weight: 700; letter-spacing: .06em; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,.22); }
      .pohsys-menu { position: fixed; right: max(16px, env(safe-area-inset-right)); bottom: calc(140px + env(safe-area-inset-bottom)); z-index: 9001;
        background: #fff; color: #111; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.25); padding: 6px; min-width: 210px; display: none; }
      .pohsys-menu button { display: block; width: 100%; text-align: left; border: 0; background: none; padding: 12px 14px; border-radius: 8px;
        font: 500 16px -apple-system, system-ui, sans-serif; color: inherit; cursor: pointer; }
      .pohsys-menu button:active { background: rgba(0,0,0,.06); }
      .pohsys-ov { position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; background: #F4F5F7; }
      .pohsys-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: calc(10px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left));
        background: #fff; border-bottom: 1px solid rgba(0,0,0,.12); font: 600 16px -apple-system, system-ui, sans-serif; color: #111; }
      .pohsys-bar button { border: 0; background: none; font: 600 16px -apple-system, system-ui, sans-serif; color: #1F5FA8; padding: 6px 2px; cursor: pointer; }
      .pohsys-ov iframe { flex: 1; width: 100%; border: 0; background: transparent; }
      @media (prefers-color-scheme: dark) {
        .pohsys-menu { background: #2A2D31; color: #F1F3F5; }
        .pohsys-menu button:active { background: rgba(255,255,255,.08); }
        .pohsys-ov { background: #14171A; }
        .pohsys-bar { background: #1C1F23; color: #F1F3F5; border-bottom-color: rgba(255,255,255,.12); }
        .pohsys-bar button { color: #6FA8E8; }
      }`;
    document.head.appendChild(st);
  }

  // ---------- button + menu ----------
  function ensureButton() {
    if (btn) return;
    injectCss();
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pohsys-btn";
    btn.innerHTML = `<span>Systems</span><span class="pro">PRO</span>`;
    btn.addEventListener("click", onButton);
    (mountEl || document.body).appendChild(btn);
    if (mountEl) btn.classList.add("mounted");
    menu = document.createElement("div");
    menu.className = "pohsys-menu";
    document.body.appendChild(menu);
    document.addEventListener("click", e => {
      if (menu.style.display === "block" && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) menu.style.display = "none";
    });
  }

  function available() {
    return variant ? SYSTEMS.filter(s => s.variants.includes(variant)) : [];
  }

  function updateButton() {
    ensureButton();
    const list = available();
    btn.style.display = list.length ? "inline-flex" : "none";
    btn.querySelector(".pro").style.display = cfg.isPro() ? "none" : "";
    if (!list.length) { menu.style.display = "none"; closeOverlay(); }
  }

  function onButton() {
    cfg.onEvent("systems_button", { variant });
    if (!cfg.isPro()) { cfg.onEvent("systems_paywall", { variant }); cfg.showPaywall(); return; }
    const list = available();
    if (list.length === 1) { open(list[0].id); return; }
    menu.innerHTML = list.map(s => `<button type="button" data-id="${s.id}">${s.title}</button>`).join("");
    menu.querySelectorAll("button").forEach(b => b.addEventListener("click", () => { menu.style.display = "none"; open(b.dataset.id); }));
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  }

  // ---------- overlay ----------
  let prevOverflow = "";
  function open(id) {
    const sys = SYSTEMS.find(s => s.id === id);
    if (!sys || !variant || !sys.variants.includes(variant)) return;
    if (!cfg.isPro()) { cfg.showPaywall(); return; }
    closeOverlay();
    injectCss();
    overlay = document.createElement("div");
    overlay.className = "pohsys-ov";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", `PC-12 ${variant} ${sys.title}`);
    const bar = document.createElement("div");
    bar.className = "pohsys-bar";
    bar.innerHTML = `<span>PC-12 ${variant} · ${sys.title}</span><button type="button">Done</button>`;
    bar.querySelector("button").addEventListener("click", closeOverlay);
    const fr = document.createElement("iframe");
    fr.title = `PC-12 ${variant} ${sys.title}`;
    fr.src = `${sys.file}?app=1&v=${variant.toLowerCase()}`;
    overlay.appendChild(bar);
    overlay.appendChild(fr);
    document.body.appendChild(overlay);
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cfg.onEvent("systems_open", { id, variant });
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.style.overflow = prevOverflow;
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeOverlay(); });

  // ---------- public API ----------
  window.POHSystems = {
    configure(o) { cfg = Object.assign(cfg, o || {}); if (btn) updateButton(); },
    mount(el) { mountEl = el; if (btn) { el.appendChild(btn); btn.classList.add("mounted"); } },
    setManual(textOrPages) { variant = detect(textOrPages); updateButton(); return variant; },
    clearManual() { variant = null; updateButton(); },
    refresh() { if (btn) updateButton(); },   // call after a purchase/restore
    open, close: closeOverlay, detect,
    get variant() { return variant; }
  };
})();

import * as pdfjsLib from "./pdf.mjs";

// pdf.js worker served from /docs (GitHub Pages root)
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

const bs = document.getElementById("buildStamp");
if (bs) bs.textContent = "build: " + new Date().toISOString();

// =====================================================
// IndexedDB (POH Library)
// =====================================================
const DB_NAME = "poh_reader_db";
const DB_VERSION = 1;
const STORE_PDFS = "pdfs";
const STORE_META = "meta";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PDFS)) {
        db.createObjectStore(STORE_PDFS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function savePdfToLibrary({ id, name, size, lastModified, buffer }) {
  await idbPut(STORE_PDFS, {
    id,
    name,
    size,
    lastModified,
    buffer, // ArrayBuffer
    savedAt: Date.now(),
  });
  await idbPut(STORE_META, { key: "lastPdfId", value: id });
  return id;
}

async function loadPdfFromLibrary(id) {
  return await idbGet(STORE_PDFS, id);
}

async function deletePdfFromLibrary(id) {
  await idbDelete(STORE_PDFS, id);
  const meta = await idbGet(STORE_META, "lastPdfId");
  if (meta?.value === id) {
    await idbPut(STORE_META, { key: "lastPdfId", value: "" });
  }
}

async function clearLibrary() {
  await idbClear(STORE_PDFS);
  await idbPut(STORE_META, { key: "lastPdfId", value: "" });
}

async function getLastPdfFromLibrary() {
  const meta = await idbGet(STORE_META, "lastPdfId");
  if (!meta?.value) return null;
  return await loadPdfFromLibrary(meta.value);
}

// =====================================================
// UI refs (MATCH YOUR index.html IDs)
// =====================================================
const fileInput = $("file");
const uploadBtn = $("uploadBtn");
const canvas = $("canvas");
const ctx = canvas?.getContext("2d");

const prevBtn = $("prev");
const nextBtn = $("next");
const resumeReadBtn = $("resumeReadBtn");
const pageInfo = $("pageInfo");

const librarySelect = $("librarySelect");
const openFromLibraryBtn = $("openFromLibraryBtn");
const deleteFromLibraryBtn = $("deleteFromLibraryBtn");
const clearLibraryBtn = $("clearLibraryBtn");
const libraryStatus = $("libraryStatus");

const feedbackBtn = $("feedbackBtn");
const feedbackStatus = $("feedbackStatus");

const sectionsBox = $("sections");
const sectionFilter = $("sectionFilter"); // <input> filter

const searchInput = $("search");
const searchBtn = $("searchBtn");
const readHitsBtn = $("readHitsBtn");
const searchResults = $("searchResults");

const askInput = $("question");
const askBtn = $("askBtn");
const askOutput = $("answer");

const micBtn = $("micBtn");
const micStatus = $("micStatus");

const readPageBtn = $("readPageBtn");
const readSectionBtn = $("readSectionBtn");
const stopReadBtn = $("stopReadBtn");
const ttsRate = $("ttsRate");
const voiceSelect = $("voiceSelect");

// =====================================================
// State
// =====================================================
let pdfDoc = null;
let pageNum = 1;
let pageCount = 0;
let renderTask = null;

if (window.setEmptyStateVisible) window.setEmptyStateVisible(true);

let currentPdfId = null;
let currentPdfName = "";
let restoredOnStartuped = false; // keep this name

let outlineItems = []; // {title, page, level}
let sectionRanges = []; // [{title, start, end, level}]
let currentSectionIndex = -1;

let pageTextCache = new Map(); // raw text cache (search)
let pageTtsCache = new Map(); // cleaned text cache (audio)

let lastSearchHits = []; // [{page, text, context}]
let searchCancelToken = { cancel: false };

// TTS
let voices = [];
let ttsSpeaking = false;
let ttsStartedByRead = false;

// For resume (chunked)
let lastReadProgress = null; // { page, key, offset, label, started? }
if (resumeReadBtn) resumeReadBtn.disabled = true;

// Stop/cancel tracking (so Stop keeps progress)
let ttsWasCancelled = false;
let ttsKeepProgressOnCancel = false;

// ====================================================
// Helpers / UI
// =====================================================
function setLibraryStatus(msg) {
  if (libraryStatus) libraryStatus.textContent = msg || "";
}

function setFeedbackStatus(msg) {
  if (feedbackStatus) feedbackStatus.textContent = msg || "";
}

function setMicStatus(msg) {
  if (micStatus) micStatus.textContent = msg || "";
}

function setPageInfo() {
  if (pageInfo) pageInfo.textContent = pdfDoc ? `Page: ${pageNum} / ${pageCount}` : "Page: – / –";
}

function updateResumeBtnState() {
  if (!resumeReadBtn) return;
  resumeReadBtn.disabled = !(
    lastReadProgress &&
    (lastReadProgress.offset || 0) > 0
  );
}

function refreshResumeBtn() {
  updateResumeBtnState();
}

function cancelTtsSilently() {
  try {
    // cancel current speech without touching resume flags/state
    if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
      window.speechSynthesis.cancel();
    }
  } catch {}
}

function enableCoreInputs() {
  if (askInput) askInput.disabled = false;
  if (askBtn) askBtn.disabled = false;
}

function enablePdfDependentControls(enabled) {
  if (prevBtn) prevBtn.disabled = !enabled;
  if (nextBtn) nextBtn.disabled = !enabled;

  if (sectionFilter) sectionFilter.disabled = !enabled;
  if (searchInput) searchInput.disabled = !enabled;
  if (searchBtn) searchBtn.disabled = !enabled;

  if (readPageBtn) readPageBtn.disabled = !enabled;
  if (readSectionBtn) readSectionBtn.disabled = !enabled;
  if (stopReadBtn) stopReadBtn.disabled = !enabled;
  if (ttsRate) ttsRate.disabled = !enabled;
  if (voiceSelect) voiceSelect.disabled = !enabled;

  if (readHitsBtn) readHitsBtn.disabled = !enabled || lastSearchHits.length === 0;

  // Always compute Resume from real rule
  refreshResumeBtn();
}

function renderBestPlaces(places) {
  window.renderBestPlaces = renderBestPlaces;
  const wrap = document.getElementById("bestPlacesWrap");
  const box = document.getElementById("bestPlaces");
  if (!wrap || !box) return;

  // places can be: [ {page, title?, score?}, ... ]  OR  [pageNumber, ...]
  const norm = (places || [])
    .map(p => {
      if (typeof p === "number") return { page: p };
      if (typeof p === "string") return { page: parseInt(p, 10) };
      return { ...p, page: parseInt(p.page, 10) };
    })
    .filter(p => Number.isFinite(p.page));

  // Stable ordering (avoid “random looking” changes)
  norm.sort((a, b) => {
    const as = Number.isFinite(a.score) ? a.score : 0;
    const bs = Number.isFinite(b.score) ? b.score : 0;
    if (bs !== as) return bs - as;     // score desc
    return a.page - b.page;            // page asc as tie-break
  });

  // Deduplicate pages
  const seen = new Set();
  const finalList = [];
  for (const p of norm) {
    if (seen.has(p.page)) continue;
    seen.add(p.page);
    finalList.push(p);
  }

  if (finalList.length === 0) {
    box.innerHTML = `<div class="sectionMeta">No strong matches found.</div>`;
    return;
  }

  // Render clickable rows
  box.innerHTML = finalList
    .slice(0, 8) // keep it readable on mobile
    .map((p, idx) => {
      const label = p.title ? `${p.title} (p.${p.page})` : `Page ${p.page}`;
      return `
       <button
  class="hitCard"
  type="button"
  data-action="jump"
  data-page="${p.page}"
  style="
    width:100%;
    display:block;
    text-align:left;
    background:none;
    border:none;
    padding:12px;
    margin-top:8px;
  "
>

// Bind handlers directly to the rendered Best Places buttons (iOS reliable)
const bestBtns = box.querySelectorAll('button.hitCard[data-page]');
bestBtns.forEach((btn) => {
  // Visual proof you are running the new code (remove later)
  btn.style.outline = "1px solid rgba(255,255,255,0.15)";

  const go = async (e) => {
    // stop iOS turning tap into text selection / scroll gesture
    e.preventDefault();
    e.stopPropagation();

    if (!pdfDoc) return;

    const action = btn.dataset.action || "jump";
    const page = Number(btn.dataset.page);
    if (!Number.isFinite(page)) return;

    pageNum = Math.max(1, Math.min(page, pageCount));
    await renderPage(pageNum);

    if (action === "jump") updateCurrentSectionFromPage();
    if (action === "read") {
      // later: hook TTS from here
    }
  };

  // touchend is the key for iOS
  btn.addEventListener("touchend", go, { passive: false });
  // click as fallback for desktop
  btn.addEventListener("click", go);
});

        </button>
      `;
    })
    .join("");
}

function isRenderingCancelled(err) {
  return (
    err &&
    (err.name === "RenderingCancelledException" ||
      String(err.message || err).toLowerCase().includes("rendering cancelled"))
  );
}

async function cancelOngoingRender() {
  if (!renderTask) return;
  try {
    renderTask.cancel();
    await renderTask.promise.catch(() => {});
  } catch {}
  renderTask = null;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================================================
// Sections filter
// =====================================================
function applySectionsFilter() {
  if (!sectionsBox) return;
  const q = (sectionFilter?.value || "").trim().toLowerCase();
  const btns = sectionsBox.querySelectorAll("button.sectionBtn");

  btns.forEach((btn) => {
    const text = (btn.textContent || "").toLowerCase();
    btn.style.display = !q || text.includes(q) ? "" : "none";
  });
}

// =====================================================
// PDF Rendering
// =====================================================
async function renderPage(num) {
  if (!pdfDoc || !canvas || !ctx) return;

  await cancelOngoingRender();

  const page = await pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: 1.5 });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await renderTask.promise;
  } finally {
    renderTask = null;
  }

  setPageInfo();
}

async function goToPage(p) {
  if (!pdfDoc) return;
  pageNum = Math.max(1, Math.min(pageCount, p));
  await renderPage(pageNum);
  updateCurrentSectionFromPage();

  if (lastReadProgress && lastReadProgress.page !== pageNum) {
    refreshResumeBtn();
  }
}

// =====================================================
// Text extraction (raw for search)
// =====================================================
async function getPageText(pageNumber1Based) {
  if (!pdfDoc) return "";

  const page = await pdfDoc.getPage(pageNumber1Based);
  const tc = await page.getTextContent({ includeMarkedContent: true });

  const items = (tc.items || [])
    .map(it => {
      const str = (it.str || "").replace(/\s+/g, " ").trim();
      if (!str) return null;

      const t = it.transform || [];
      const x = t[4] ?? 0;
      const y = t[5] ?? 0;

      return { str, x, y };
    })
    .filter(Boolean);

  if (!items.length) return "";

  // Sort: top → bottom, left → right
  items.sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1.5) return dy;
    return a.x - b.x;
  });

  // Group into visual lines
  const lines = [];
  let current = [];
  let currentY = items[0].y;

  const sameLine = (y1, y2) => Math.abs(y1 - y2) <= 2.5;

  for (const it of items) {
    if (!sameLine(it.y, currentY)) {
      current.sort((a, b) => a.x - b.x);
      lines.push(current.map(w => w.str).join(" "));
      current = [];
      currentY = it.y;
    }
    current.push(it);
  }

  if (current.length) {
    current.sort((a, b) => a.x - b.x);
    lines.push(current.map(w => w.str).join(" "));
  }

  return lines.join("\n");
}

// =====================================================
// TTS cleaning (Pilatus-friendly)
// =====================================================
function cleanTtsText(text) {
  if (!text) return "";

  let t = String(text);

  // Normalize spaces
  t = t.replace(/\s+/g, " ").trim();

  // Remove common boilerplate patterns (Pilatus PC-12 footer style)
  const patterns = [
    /\bissued\b\s*[:\-]?\s*[a-z]{3,9}\s+\d{1,2},\s+\d{4}/gi,              // Issued: September 15, 2006
    /\brevision\b\s*\d+\s*[:\-]?\s*[a-z]{3,9}\s+\d{1,2},\s+\d{4}/gi,      // Revision 15: Nov 06, 2015
    /\brevision\b\s*[:\-]?\s*\d{1,3}/gi,                                  // Revision: 15
    /\brev\.?\b\s*[:\-]?\s*\d{1,3}/gi,                                    // Rev. 15
    /\breport\s*(no|number)\b\s*[:\-]?\s*[0-9a-z\-/. ]{1,20}/gi,          // Report No: 02277
    /\bdoc(ument)?\s*(no|number)\b\s*[:\-]?\s*[0-9a-z\-/. ]{1,25}/gi,     // Document No: ...
    /\beffective\s*date\b\s*[:\-]?\s*[0-9a-z.,/ ]{1,25}/gi,               // Effective Date ...
    /\bprint(ed)?\s*date\b\s*[:\-]?\s*[0-9a-z.,/ ]{1,25}/gi,              // Printed Date ...

    // Page markers
    /\bpage\s+\d+\s*(of\s+\d+)?\b/gi,                                     // Page 1 of 5
    /\b\d{1,4}\s*[-–]\s*\d{1,4}\b/g,                                      // 1-5
  ];

  for (const rx of patterns) t = t.replace(rx, " ");

  return t.replace(/\s{2,}/g, " ").trim();
}

async function getPageTextForTts(pageNumber1Based) {
  if (!pdfDoc) return "";
  if (pageTtsCache.has(pageNumber1Based)) return pageTtsCache.get(pageNumber1Based);

  const raw = await getPageText(pageNumber1Based);
  const cleaned = cleanTtsText(raw);

  pageTtsCache.set(pageNumber1Based, cleaned);
  return cleaned;
}

// =====================================================
// Outline -> Sections UI
// =====================================================
async function buildOutlineAndSections() {
  outlineItems = [];
  sectionRanges = [];
  currentSectionIndex = -1;

  if (!pdfDoc) return;

  let outline = null;
  try {
    outline = await pdfDoc.getOutline();
  } catch {
    outline = null;
  }

  if (!outline || !outline.length) {
    if (sectionsBox) {
      sectionsBox.innerHTML = `<div style="opacity:.7;font-size:12px;">No outline found in this PDF.</div>`;
    }
    return;
  }

  async function resolveDestToPage(dest) {
    try {
      const resolved = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
      if (!resolved || !resolved[0]) return null;
      const pageIndex = await pdfDoc.getPageIndex(resolved[0]); // 0-based
      return pageIndex + 1; // 1-based
    } catch {
      return null;
    }
  }

  async function walk(items, level = 0) {
    for (const it of items) {
      const title = (it.title || "").trim() || "(Untitled)";
      const page = it.dest ? await resolveDestToPage(it.dest) : null;
      if (page) outlineItems.push({ title, page, level });
      if (it.items && it.items.length) await walk(it.items, level + 1);
    }
  }

  await walk(outline, 0);

  // Sort by page to make ranges
  outlineItems.sort((a, b) => a.page - b.page);

  // Build ranges
  for (let i = 0; i < outlineItems.length; i++) {
    const start = outlineItems[i].page;
    const end = i < outlineItems.length - 1 ? outlineItems[i + 1].page - 1 : pageCount;
    sectionRanges.push({
      title: outlineItems[i].title,
      start,
      end: Math.max(start, end),
      level: outlineItems[i].level,
    });
  }

  // Render Sections list
  if (sectionsBox) {
    sectionsBox.innerHTML = "";
    for (let i = 0; i < sectionRanges.length; i++) {
      const s = sectionRanges[i];
      const btn = document.createElement("button");
      btn.style.width = "100%";
      btn.style.textAlign = "left";
      btn.style.margin = "6px 0";
      btn.style.padding = "10px";
      btn.style.borderRadius = "10px";
      btn.style.cursor = "pointer";
      btn.className = "sectionBtn";

      const indent = s.level ? "&nbsp;".repeat(Math.min(6, s.level) * 2) : "";
      btn.innerHTML = `${indent}${escapeHtml(s.title)} <span style="opacity:.7;">(p.${s.start})</span>`;

      btn.addEventListener("click", async () => {
        currentSectionIndex = i;
        await goToPage(s.start);
      });

      sectionsBox.appendChild(btn);
    }

    applySectionsFilter();
  }

  updateCurrentSectionFromPage();
}

function updateCurrentSectionFromPage() {
  if (!sectionRanges.length || !pdfDoc) return;
  const idx = sectionRanges.findIndex((s) => pageNum >= s.start && pageNum <= s.end);
  currentSectionIndex = idx;
}

function getSectionForPage(p) {
  if (!sectionRanges?.length) return "";
  const s = sectionRanges.find((x) => p >= x.start && p <= x.end);
  return s?.title || "";
}

// =====================================================
// Search
// =====================================================
function clearSearchUI() {
  lastSearchHits = [];
  if (searchResults) searchResults.innerHTML = "";
  if (readHitsBtn) readHitsBtn.disabled = true;
}

async function runSearch(query) {
  if (!pdfDoc) return;
  const q = (query || "").trim();
  if (!q) return;

  clearSearchUI();
  searchCancelToken.cancel = false;

  const startPage = 1;
  const endPage = pageCount;

  const maxHits = 60;
  const hits = [];

  if (searchResults) {
    searchResults.innerHTML = `<div style="opacity:.7;font-size:12px;">Searching pages ${startPage}–${endPage}…</div>`;
  }

  for (let p = startPage; p <= endPage; p++) {
    if (searchCancelToken.cancel) break;

    const text = await getPageText(p);
    if (text) {
      const pos = text.toLowerCase().indexOf(q.toLowerCase());
      if (pos >= 0) {
        const left = Math.max(0, pos - 80);
        const right = Math.min(text.length, pos + q.length + 120);
        const context = text.slice(left, right);
        hits.push({ page: p, context, text });
        if (hits.length >= maxHits) break;
      }
    }

    if (p % 10 === 0) {
      if (searchResults) {
        searchResults.innerHTML = `<div style="opacity:.7;font-size:12px;">Searching… page ${p}/${endPage}</div>`;
      }
      await sleep(0);
    }
  }

  lastSearchHits = hits;

  if (!searchResults) return;

  if (!hits.length) {
    searchResults.innerHTML = `<div style="opacity:.7;font-size:12px;">No hits found.</div>`;
    if (readHitsBtn) readHitsBtn.disabled = true;
    return;
  }

  const wrap = document.createElement("div");
  for (const h of hits) {
    const item = document.createElement("div");
    item.style.padding = "10px";
    item.style.borderRadius = "10px";
    item.style.margin = "8px 0";
    item.style.cursor = "pointer";
    item.style.border = "1px solid rgba(255,255,255,.08)";
    item.innerHTML = `<div style="font-weight:600;">Page ${h.page}</div>
      <div style="opacity:.8;font-size:12px;margin-top:6px;">${escapeHtml(h.context)}</div>`;

    item.addEventListener("click", async () => {
      await goToPage(h.page);
    });

    wrap.appendChild(item);
  }

  searchResults.innerHTML = "";
  searchResults.appendChild(wrap);

  if (readHitsBtn) readHitsBtn.disabled = false;
}

// =====================================================
// TTS (Voice Read) + REAL RESUME (chunked)
// =====================================================
// =====================================================
// Voice mode + language detection (conservative)
// =====================================================
let voiceMode = "english"; // "english" | "auto" | "manual"
// Recommendation: keep "english" as default because POHs are English.

function detectLangFast(text) {
  const t = (text || "").toLowerCase();

  // Strong German signals
  const umlauts = (t.match(/[äöüß]/g) || []).length;
  if (umlauts >= 3) return "de";

  // Token-based hints (conservative)
  const words = t.split(/\s+/).filter(Boolean);
  const sample = words.slice(0, 250);
  if (sample.length < 40) return "en"; // too short -> don’t flip

  const germanSet = new Set([
    "und","der","die","das","nicht","mit","für","ist","sind","ein","eine",
    "bei","auf","zum","zur","im","am","aus","wird","werden"
  ]);

  const englishSet = new Set([
    "the","and","of","to","in","for","is","are","with","on","as","be","by",
    "this","that","from"
  ]);

  let de = 0, en = 0;
  for (const w of sample) {
    if (germanSet.has(w)) de++;
    if (englishSet.has(w)) en++;
  }

  // Switch to German ONLY if clearly German (won’t trigger on POHs)
  if (de >= 6 && de >= en * 2) return "de";

  return "en";
}

function pickBestVoiceForLang(lang) {
  const l = (lang || "en").toLowerCase();
  const candidates = voices.filter(v => (v.lang || "").toLowerCase().startsWith(l));
  const pool = candidates.length ? candidates : voices;

  const prefer = (rx) => pool.find(v => rx.test((v.name || "").toLowerCase()));

  // Warmest first
  return (
    prefer(/siri/) ||
    prefer(/enhanced|premium|neural|natural/) ||
    pool[0] ||
    null
  );
}

function getSelectedVoice() {
  const name = voiceSelect?.value || "";
  return voices.find((v) => v.name === name) || null;
}

function refreshVoices() {
  voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voiceSelect) return;

  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  }

  // Pick the most human-sounding voice we can find (English)
  const best = pickBestVoiceForLang("en");
  if (best) voiceSelect.value = best.name;
}

// stop speech; keepProgress=true allows next "Read" to resume
function stopTts({ keepProgress = true } = {}) {
  try {
    // Mark this as an intentional cancel (important for iOS)
    ttsWasCancelled = true;
    ttsKeepProgressOnCancel = keepProgress;

    window.speechSynthesis.cancel();
  } catch {}

  ttsSpeaking = false;

  if (!keepProgress) {
    lastReadProgress = null;
  }

  updateResumeBtnState();
}

function makeTextKey(text) {
  const s = String(text || "");
  return `${s.length}:${s.slice(0, 40)}:${s.slice(-40)}`;
}

function chunkText(text, maxLen = 220) {
  const s = String(text || "").trim();
  if (!s) return [];

  const chunks = [];
  let i = 0;

  while (i < s.length) {
    let end = Math.min(i + maxLen, s.length);

    // try not to cut in the middle of a word
    if (end < s.length) {
      const lastSpace = s.lastIndexOf(" ", end);
      if (lastSpace > i + 80) end = lastSpace;
    }

    chunks.push(s.slice(i, end).trim());
    i = end;
  }

  return chunks.filter(Boolean);
}

async function speakChunked(text, { page, label } = {}, { resume = false } = {}) {
  // Stop any current speech (keep progress)

  const cleaned = String(text || "").trim();
  if (!cleaned) return;

  const key = makeTextKey(cleaned);

  let offset = 0;
  if (resume && lastReadProgress && lastReadProgress.page === page && lastReadProgress.key === key) {
    offset = Math.max(0, lastReadProgress.offset || 0);
  }

  const remaining = cleaned.slice(offset);
  const chunks = chunkText(remaining, 220);
  if (!chunks.length) return;

  ttsSpeaking = true;
  lastReadProgress = { page, key, offset, label, started: false };
  refreshResumeBtn();

  let v = null;

  if (voiceMode === "manual") {
    v = getSelectedVoice();
  } else if (voiceMode === "english") {
    v = pickBestVoiceForLang("en");
  } else {
    // auto (conservative)
    const lang = detectLangFast(cleaned);
    v = pickBestVoiceForLang(lang === "de" ? "de" : "en");
  }

  const rate = Number(ttsRate?.value || 1.0);

  const speakNext = () => {
    if (!chunks.length) {
      ttsSpeaking = false;
      refreshResumeBtn();
      return;
    }

    const chunk = chunks.shift();

    const u = new SpeechSynthesisUtterance(chunk);
    if (v) u.voice = v;
    u.rate = Number.isFinite(rate) ? rate : 1.0;

    // IMPORTANT:
    // Resume should become available even if user stops early,
    // so we bump offset right when speaking starts (iOS/Chrome safe).
    u.onstart = () => {
  // Mark that speech actually started (so Resume can be enabled)
  if (lastReadProgress) {
    lastReadProgress.started = true;

    // Ensure Resume becomes available, but do NOT advance offset here
    if ((lastReadProgress.offset || 0) === 0) {
      lastReadProgress.offset = 1;
    }

    refreshResumeBtn();
  }
};

    u.onend = () => {
      // iOS Safari: cancel() still fires onend
      if (ttsWasCancelled) {
        ttsWasCancelled = false;

        // If stop was pressed, keep progress
        if (!ttsKeepProgressOnCancel) {
          lastReadProgress = null;
        }

        refreshResumeBtn();
        return;
      }

      // normal end → advance offset
      if (lastReadProgress) {
        lastReadProgress.offset += chunk.length;
      }
      refreshResumeBtn();
      speakNext();
    };

    u.onerror = () => {
      ttsSpeaking = false;
      refreshResumeBtn();
    };

    // Enable Resume immediately even if user stops before onstart fires
if (lastReadProgress && (lastReadProgress.offset || 0) === 0) {
  lastReadProgress.offset = 1;
  refreshResumeBtn();
}

    window.speechSynthesis.speak(u);
  };

  speakNext();
}

async function resumeTts() {
  if (!pdfDoc || !lastReadProgress) return;

  const p = lastReadProgress.page;
  await goToPage(p);

  const text = await getPageTextForTts(p);
  const keyNow = makeTextKey(text);

  // Strict safety: only resume if the text key matches
  const canResume =
    lastReadProgress &&
    lastReadProgress.page === p &&
    lastReadProgress.key === keyNow &&
    (lastReadProgress.offset || 0) > 0;

  await speakChunked(
    text || "No readable text found on this page.",
    { page: p, label: lastReadProgress.label || "page" },
    { resume: !!canResume }
  );

  // If we couldn't resume safely, reset progress to avoid confusion
  if (!canResume && lastReadProgress) {
    lastReadProgress.offset = 0;
  }

  refreshResumeBtn();
}

async function readCurrentPage() {
  if (!pdfDoc) return;
  const text = await getPageTextForTts(pageNum);

  const canResume =
    lastReadProgress &&
    lastReadProgress.page === pageNum &&
    lastReadProgress.key === makeTextKey(text) &&
    (lastReadProgress.offset || 0) > 0;

  ttsStartedByRead = true;

  await speakChunked(
    text || "No readable text found on this page.",
    { page: pageNum, label: "page" },
    { resume: !!canResume }
  );
}

async function readCurrentSection() {
  if (!pdfDoc) return;

  let idx = currentSectionIndex;
  if (idx < 0 || !sectionRanges[idx]) {
    await readCurrentPage();
    return;
  }

  const s = sectionRanges[idx];

  // Safety cap for section reading
  const maxPages = 6;
  const end = Math.min(s.end, s.start + maxPages - 1);

  let combined = `Section: ${s.title}. Pages ${s.start} to ${end}. `;
  for (let p = s.start; p <= end; p++) {
    const t = await getPageTextForTts(p);
    if (t) combined += " " + t;
    await sleep(0);
  }

  await speakChunked(combined.trim(), { page: s.start, label: "section" }, { resume: false });
}

async function readSearchHits() {
  if (!lastSearchHits.length) return;

  let combined = `Reading ${Math.min(lastSearchHits.length, 10)} search hits. `;
  const limit = Math.min(lastSearchHits.length, 10);
  for (let i = 0; i < limit; i++) {
    const h = lastSearchHits[i];
    combined += ` Hit ${i + 1}, page ${h.page}. ${cleanTtsText(h.context)}. `;
  }

  await speakChunked(combined.trim(), { page: lastSearchHits[0].page, label: "hits" }, { resume: false });
}

// Hint user when returning from background
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && lastReadProgress?.page) {
    setLibraryStatus(`Audio paused. Press Read again to resume (page ${lastReadProgress.page}).`);
  }
});

// =====================================================
// Mic (Hold-to-talk)
// =====================================================
let recognition = null;
let micReady = false;
let isHolding = false;

async function ensureMicPermission() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch {
    return false;
  }
}

function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setMicStatus("Mic not supported in this browser.");
    if (micBtn) micBtn.disabled = true;
    return;
  }

  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false; // iOS-safe

  recognition.onstart = () => setMicStatus("Listening…");
  recognition.onend = () => setMicStatus("Mic ready. Hold to talk.");
  recognition.onerror = (e) => setMicStatus(`Mic error: ${e?.error || "unknown"}`);

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    transcript = transcript.trim();
    if (!transcript) return;

    const last = event.results[event.results.length - 1];
    if (last.isFinal) {
      if (askInput) {
        askInput.value = transcript;
        askInput.focus();
      }
      setMicStatus(`Heard: "${transcript}"`);
    } else {
      setMicStatus(`Listening… "${transcript}"`);
    }
  };

  micReady = true;
}

function startListening() {
  if (!recognition) return;
  try {
    recognition.start();
  } catch {}
}

function stopListening() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch {}
}

// =====================================================
// "Ask" (Local mode) — FAST on 1300+ pages (incremental scan)
// =====================================================
const STOPWORDS = new Set([
  "the","a","an","and","or","to","of","in","on","for","with","at","from","by",
  "is","are","was","were","be","been","it","this","that","these","those","as",
  "i","you","we","they","my","your","our","their","me","us","them",
  "what","where","when","why","how","which","who","can","could","should","would",
  "do","does","did"
]);

function tokenizeQuestion(q) {
  return (q || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 10);
}

function makeExcerpt(text, hitIndex, hitLen, windowSize = 140) {
  if (!text) return "";
  const left = Math.max(0, hitIndex - windowSize);
  const right = Math.min(text.length, hitIndex + hitLen + windowSize);
  return text.slice(left, right).trim();
}

function countTokenHits(textLower, tokens) {
  let score = 0;
  for (const t of tokens) {
    let idx = 0;
    while (true) {
      idx = textLower.indexOf(t, idx);
      if (idx < 0) break;
      score += 1;
      idx += t.length;
      if (score > 200) break;
    }
    if (score > 200) break;
  }
  return score;
}

let askScanState = null;
// { qKey, nextPage, results: [], titleScores: Map }

async function runLocalAskIncremental(question, { timeBudgetMs = 1200, maxReturn = 7 } = {}) {
  if (!pdfDoc) return { hits: [], done: true };

  const tokens = tokenizeQuestion(question);
  if (!tokens.length) return { hits: [], done: true };

  const qKey = tokens.join("|");

  // Reset scan if new question
  if (!askScanState || askScanState.qKey !== qKey) {
    const titleScores = new Map();
    for (const s of (sectionRanges || [])) {
      const tl = (s.title || "").toLowerCase();
      let score = 0;
      for (const t of tokens) if (tl.includes(t)) score += 6;
      if (score > 0) titleScores.set(s.start, (titleScores.get(s.start) || 0) + score);
    }

    askScanState = {
      qKey,
      nextPage: 1,
      results: [],
      titleScores,
    };

    // Add title-only results immediately
    for (const [p, s] of titleScores.entries()) {
      askScanState.results.push({
        page: p,
        score: s,
        excerpt: "",
        sectionTitle: getSectionForPage(p),
      });
    }
  }

  const start = performance.now();
  const endPage = pageCount;

  while (askScanState.nextPage <= endPage) {
    const p = askScanState.nextPage++;

    const text = await getPageText(p); // raw for matching
    if (text) {
      const tl = text.toLowerCase();
      const tokenScore = countTokenHits(tl, tokens);
      const titleBoost = askScanState.titleScores.get(p) || 0;

      if (tokenScore > 0 || titleBoost > 0) {
        let bestHit = { idx: -1, len: 0 };
        for (const t of tokens) {
          const idx = tl.indexOf(t);
          if (idx >= 0 && (bestHit.idx < 0 || idx < bestHit.idx)) {
            bestHit = { idx, len: t.length };
          }
        }
        const excerpt = bestHit.idx >= 0 ? makeExcerpt(text, bestHit.idx, bestHit.len) : "";
        const score = tokenScore * 2 + titleBoost;

        askScanState.results.push({
          page: p,
          score,
          excerpt,
          sectionTitle: getSectionForPage(p),
        });
      }
    }

    if (p % 12 === 0) await sleep(0);
    if (performance.now() - start > timeBudgetMs) break;
  }

  const sorted = [...askScanState.results].sort((a, b) => b.score - a.score);

  // de-dup close pages
  const final = [];
  for (const r of sorted) {
    if (final.length >= maxReturn) break;
    if (final.some((x) => Math.abs(x.page - r.page) <= 1)) continue;
    final.push(r);
  }

  const done = askScanState.nextPage > endPage;
  return { hits: final, done };
}

// Click delegation for Ask result buttons
askOutput?.addEventListener("click", async (e) => {
  const btn = e.target?.closest?.("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const page = Number(btn.dataset.page || "0");

  if (action === "ask-more") {
    await handleAsk(); // continues scan
    return;
  }

  if (!page || !pdfDoc) return;

  if (action === "jump") {
    await goToPage(page);
    return;
  }

  if (action === "read") {
    const t = await getPageTextForTts(page);
    await speakChunked(`Page ${page}. ${t || "No readable text found on this page."}`, { page, label: "ask-hit" }, { resume: false });
    return;
  }
});

async function handleAsk() {
  const q = (askInput?.value || "").trim();
  if (!q) return;

  if (!pdfDoc) {
    if (askOutput) askOutput.textContent = "Load a PDF first.";
    return;
  }

  if (askOutput) askOutput.innerHTML = `<div style="opacity:.85;">Searching your POH/AFM offline…</div>`;

  const { hits, done } = await runLocalAskIncremental(q, { timeBudgetMs: 1200, maxReturn: 7 });

  if (!hits.length) {
    if (askOutput) {
      askOutput.innerHTML =
        `<div style="font-weight:700;">No strong matches found.</div>
         <div style="opacity:.8;margin-top:8px;">Try shorter keywords (e.g., “Vref”, “105”, “oil pressure”, “takeoff”).</div>
         <div style="opacity:.75;margin-top:10px;">Safety: Always verify in the official POH/AFM.</div>`;
    }
    return;
  }

  const header =
    `<div style="font-weight:800;">Best places to look</div>
     <div style="opacity:.8;margin-top:6px;">Offline mode: I’m pointing you to the most relevant pages.</div>
     <div style="opacity:.75;margin-top:6px;">Question: ${escapeHtml(q)}</div>`;

  const cards = hits
    .map((h, idx) => {
      const title = h.sectionTitle ? escapeHtml(h.sectionTitle) : "Relevant page";
      const excerpt = h.excerpt ? escapeHtml(h.excerpt) : "";
      return `
        <div style="margin-top:12px;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.10);">
          <div style="font-weight:700;">${idx + 1}. ${title} <span style="opacity:.75;">(p.${h.page})</span></div>
          ${excerpt ? `<div style="opacity:.85;font-size:12px;margin-top:8px;white-space:pre-wrap;">"${excerpt}"</div>` : ``}
          <div style="display:flex;gap:10px;margin-top:10px;">
            <button data-action="jump" data-page="${h.page}">Jump</button>
            <button data-action="read" data-page="${h.page}">Read from here</button>
          </div>
        </div>
      `;
    })
    .join("");

  const moreBtn = done
    ? ""
    : `<div style="margin-top:12px;display:flex;align-items:center;gap:10px;">
         <button data-action="ask-more">Search more</button>
         <span style="opacity:.75;font-size:12px;">Scanning… ${Math.min(askScanState?.nextPage || 1, pageCount)}/${pageCount}</span>
       </div>`;

  const footer = `<div style="opacity:.75;margin-top:12px;">Safety: Always verify in the official POH/AFM.</div>`;

  if (askOutput) {
     askOutput.innerHTML = header + cards + moreBtn + footer;
  }
     renderBestPlaces(hits);
}

// =====================================================
// Library UI
// =====================================================
async function refreshLibrarySelectUI() {
  if (!librarySelect) return;

  let items = [];
  try {
    items = await idbGetAll(STORE_PDFS);
  } catch (e) {
    console.warn("Could not read library:", e);
    return;
  }

  librarySelect.innerHTML = "";

  if (!items.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(No saved PDFs yet)";
    librarySelect.appendChild(opt);
    return;
  }

  items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.id;
    opt.textContent = it.name || it.id;
    librarySelect.appendChild(opt);
  }

  if (currentPdfId && items.some((x) => x.id === currentPdfId)) {
    librarySelect.value = currentPdfId;
  }
}

// =====================================================
// PDF Loading (robust + iOS friendly)
// =====================================================
async function loadPdfFromBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const task = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: "./standard_fonts/", // GitHub Pages-safe
  });

  pdfDoc = await task.promise;

  if (window.setEmptyStateVisible) window.setEmptyStateVisible(false);

  pageCount = pdfDoc.numPages;
  pageNum = 1;

  pageTextCache.clear();
  pageTtsCache.clear();
  clearSearchUI();

  // Reset Ask scan state + Resume progress whenever a new PDF loads
  askScanState = null;
  lastReadProgress = null;

  enablePdfDependentControls(true);
  setPageInfo();
  await renderPage(pageNum);

  await buildOutlineAndSections();

  setLibraryStatus("Loaded ✅");

  if (askOutput) {
    askOutput.textContent =
      `Loaded ✅\n\n${currentPdfName || currentPdfId || ""}\n\nSafety: Always verify in the official POH/AFM.`;
  }
}

async function openWithRetries(bytes, { tries = 3, delayMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await loadPdfFromBytes(bytes);
      return;
    } catch (err) {
      if (isRenderingCancelled(err)) return;
      lastErr = err;
      await sleep(delayMs);
    }
  }
  console.error("openWithRetries failed:", lastErr);
  throw lastErr;
}

async function loadPdfFromFileAndSave(file) {
  currentPdfId = `${file.name}_${file.size}_${file.lastModified}`;
  currentPdfName = file.name;

  const buffer = await file.arrayBuffer();
  const bufferForDb = buffer.slice(0);

  await savePdfToLibrary({
    id: currentPdfId,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    buffer: bufferForDb,
  });

  await refreshLibrarySelectUI();

  // Reload from IndexedDB (iOS-safe)
  const rec = await loadPdfFromLibrary(currentPdfId);
  if (!rec?.buffer) throw new Error("Saved record missing buffer");

  currentPdfName = rec.name || currentPdfName;

  await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });
  restoredOnStartuped = true;
}

async function restoreLastPdfOnStartup() {
  try {
    const rec = await getLastPdfFromLibrary();
    if (!rec?.buffer) return;

    currentPdfId = rec.id;
    currentPdfName = rec.name || "";

    await refreshLibrarySelectUI();
    await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });

    restoredOnStartuped = true;

    if (askOutput) {
      askOutput.textContent =
        `Restored from Library ✅\n\n${rec.name}\n\nSafety: Always verify in the official POH/AFM.`;
    }
  } catch (err) {
    if (isRenderingCancelled(err)) return;
    console.error("restoreLastPdfOnStartup failed:", err);
  }
}

// =====================================================
// Feedback (copy to clipboard)
// =====================================================
async function copyFeedbackFlow() {
  const typed = prompt(
    "Type your feedback here (it will be copied to clipboard):",
    "What worked? What didn’t? iPad/iPhone? Any confusing buttons?"
  );
  if (typed === null) return;

  const section =
    currentSectionIndex >= 0 && sectionRanges[currentSectionIndex]
      ? sectionRanges[currentSectionIndex].title
      : "";

  const payload =
    `POH Reader Feedback\n` +
    `===================\n` +
    `Date: ${new Date().toISOString()}\n` +
    `PDF: ${currentPdfName || currentPdfId || "—"}\n` +
    `Page: ${pdfDoc ? `${pageNum}/${pageCount}` : "—"}\n` +
    (section ? `Section: ${section}\n` : "") +
    `Browser: ${navigator.userAgent}\n\n` +
    `Feedback:\n${typed}\n`;

  try {
    await navigator.clipboard.writeText(payload);
    setFeedbackStatus("Copied ✅");
    setTimeout(() => setFeedbackStatus(""), 2500);
  } catch (e) {
    console.warn("Clipboard failed:", e);
    alert("Could not copy to clipboard. (Browser blocked it)");
  }
}

// =====================================================
// Events
// =====================================================
fileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // allow picking same file again
  if (!file) return;

  if (file.type !== "application/pdf") {
    alert("Please choose a PDF file.");
    return;
  }

  try {
    enableCoreInputs();
    enablePdfDependentControls(false);
    setLibraryStatus("Saving + loading…");
    await loadPdfFromFileAndSave(file);
  } catch (err) {
    console.error(err);
    alert("Failed to load PDF. Check Console.");
    setLibraryStatus("Load failed.");
    enablePdfDependentControls(false);
  }
});

prevBtn?.addEventListener("click", async () => {
  if (!pdfDoc || pageNum <= 1) return;
  pageNum -= 1;
  await renderPage(pageNum);
  updateCurrentSectionFromPage();
});

nextBtn?.addEventListener("click", async () => {
  if (!pdfDoc || pageNum >= pageCount) return;
  pageNum += 1;
  await renderPage(pageNum);
  updateCurrentSectionFromPage();
});

// iOS: Best Places tap handler (touchend, capture) — works when click doesn’t fire
document.addEventListener("touchend", async (e) => {
  const btn = e.target.closest('button[data-action][data-page]');
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  if (!pdfDoc) return;

  const action = btn.dataset.action;
  const page = Number(btn.dataset.page);
  if (!Number.isFinite(page)) return;

  pageNum = Math.max(1, Math.min(page, pageCount));
  await renderPage(pageNum);

  if (action === "jump") updateCurrentSectionFromPage();
  if (action === "read") {
    // later: hook TTS from here
  }
}, { passive: false, capture: true });

// iOS-safe click handler for Best Places cards (delegation)
document.addEventListener("click", async (e) => {
  const btn = e.target.closest('button[data-action][data-page]');
  if (!btn || !pdfDoc) return;

  const action = btn.dataset.action;
  const page = Number(btn.dataset.page);
  if (!Number.isFinite(page)) return;

  pageNum = Math.max(1, Math.min(page, pageCount));
  await renderPage(pageNum);

  if (action === "jump") {
    updateCurrentSectionFromPage();
  }

  if (action === "read") {
    // later: hook TTS from here
  }
});

uploadBtn?.addEventListener("click", () => {
  fileInput?.click();
});

openFromLibraryBtn?.addEventListener("click", async () => {
  const id = librarySelect?.value;
  if (!id) return;

  try {
    const rec = await loadPdfFromLibrary(id);
    if (!rec?.buffer) return;

    currentPdfId = rec.id;
    currentPdfName = rec.name || "";

    await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });

    setLibraryStatus("Opened ✅");
  } catch (err) {
    console.error(err);
    alert("Open failed. Check Console.");
  }
});

deleteFromLibraryBtn?.addEventListener("click", async () => {
  const id = librarySelect?.value;
  if (!id) {
    alert("Select a PDF first");
    return;
  }
  if (!confirm("Delete this PDF from the library?")) return;

  try {
    await deletePdfFromLibrary(id);
    await refreshLibrarySelectUI();
    setLibraryStatus("Deleted ✅");
  } catch (err) {
    console.error(err);
    alert("Delete failed. Check Console.");
  }
});

clearLibraryBtn?.addEventListener("click", async () => {
  if (!confirm("Clear ALL saved PDFs?")) return;

  try {
    await clearLibrary();
    await refreshLibrarySelectUI();
    setLibraryStatus("Library cleared ✅");
  } catch (err) {
    console.error(err);
    alert("Clear failed. Check Console.");
  }
});

feedbackBtn?.addEventListener("click", copyFeedbackFlow);

sectionFilter?.addEventListener("input", () => {
  applySectionsFilter();
});

searchBtn?.addEventListener("click", async () => {
  if (!pdfDoc) return;
  await runSearch(searchInput?.value || "");
});

searchInput?.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!pdfDoc) return;
    await runSearch(searchInput?.value || "");
  }
});

readHitsBtn?.addEventListener("click", async () => {
  await readSearchHits();
});

askBtn?.addEventListener("click", handleAsk);

readPageBtn?.addEventListener("click", async () => {
  await readCurrentPage();
});

readSectionBtn?.addEventListener("click", async () => {
  await readCurrentSection();
});

stopReadBtn?.addEventListener("click", () => {
  stopTts({ keepProgress: true }); // keep resume progress
  refreshResumeBtn();
});

document.getElementById("bestPlaces")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn) return;

  const page = parseInt(btn.dataset.page, 10);
  if (!Number.isFinite(page)) return;

  // Jump to page
  if (typeof gotoPage === "function") {
    gotoPage(page);
  } else if (window.__POH?.gotoPage) {
    window.__POH.gotoPage(page);
  }
});

resumeReadBtn?.addEventListener("click", async () => {
  if (!pdfDoc || !lastReadProgress) return;
  await resumeTts();
});

if (micBtn) {
  micBtn.disabled = false;
  micBtn.addEventListener("pointerdown", async (e) => {
    e.preventDefault();
    if (isHolding) return;
    isHolding = true;

    const ok = await ensureMicPermission();
    if (!ok) {
      setMicStatus("Mic permission denied.");
      isHolding = false;
      return;
    }

    if (!micReady) setupSpeechRecognition();
    if (!micReady) {
      isHolding = false;
      return;
    }

    setMicStatus("Listening…");
    startListening();
  });

  const endHold = (e) => {
    e.preventDefault();
    if (!isHolding) return;
    isHolding = false;
    stopListening();
  };

  micBtn.addEventListener("pointerup", endHold);
  micBtn.addEventListener("pointercancel", endHold);
  micBtn.addEventListener("pointerleave", endHold);
}

window.addEventListener("DOMContentLoaded", async () => {
  enableCoreInputs();

  enablePdfDependentControls(false);
  setPageInfo();

  if ("speechSynthesis" in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  await refreshLibrarySelectUI();
  await restoreLastPdfOnStartup();

  if (window.setEmptyStateVisible) {
    window.setEmptyStateVisible(!restoredOnStartuped);
  }

  setMicStatus("Mic ready. Hold to talk.");
  refreshResumeBtn();
});

// Small safety: cancel search if user loads another PDF fast
function cancelSearch() {
  searchCancelToken.cancel = true;
}

// --- Debug helpers (remove later if you want) ---
window.__POH = window.__POH || {};
window.__POH.getPageTextForTts = getPageTextForTts;
window.__POH.getProgress = () => ({ ...lastReadProgress });
window.__POH.pageNum = () => pageNum;

// Register Service Worker (GitHub Pages–safe)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[SW] registered:', reg.scope))
      .catch(err => console.error('[SW] registration failed:', err));
  });
}
window.renderBestPlaces = renderBestPlaces;
import * as pdfjsLib from "./pdf.mjs";
// pdf.js worker served from /docs (GitHub Pages root)
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

// ─── Native TTS (iOS Capacitor) vs Web TTS (browser fallback) ───
const isCapacitor = !!(window?.Capacitor?.isNativePlatform?.());
const NativeTTS = isCapacitor ? (window?.Capacitor?.Plugins?.TextToSpeech ?? null) : null;

const $ = (id) => document.getElementById(id);

// Build stamp (optional)
const bs = $("buildStamp");
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
  await idbPut(STORE_PDFS, { id, name, size, lastModified, buffer, savedAt: Date.now() });
  await idbPut(STORE_META, { key: "lastPdfId", value: id });
  return id;
}

async function loadPdfFromLibrary(id) {
  return await idbGet(STORE_PDFS, id);
}

async function deletePdfFromLibrary(id) {
  await idbDelete(STORE_PDFS, id);
  const meta = await idbGet(STORE_META, "lastPdfId");
  if (meta?.value === id) await idbPut(STORE_META, { key: "lastPdfId", value: "" });
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
const uploadBtn = $("uploadBtn"); // optional / can exist
const canvas = $("canvas");
const ctx = canvas?.getContext("2d");
const pageInfo = $("pageInfo");

// Bottom dock buttons
const bottomPrevBtn = $("bottomPrev");
const bottomNextBtn = $("bottomNext");
const bottomUploadBtn = $("bottomUpload");
const bottomSearchBtn = $("bottomSearch");

// Library
const librarySelect = $("librarySelect");
const openFromLibraryBtn = $("openFromLibraryBtn");
const deleteFromLibraryBtn = $("deleteFromLibraryBtn");
const clearLibraryBtn = $("clearLibraryBtn");
const libraryStatus = $("libraryStatus");
const feedbackBtn = $("feedbackBtn");

// Sections + Search
const sectionFilter = $("sectionFilter");
const sectionsList = $("sectionsList");
const searchInput = $("searchInput");
const searchBtn = $("searchBtn");
const searchResults = $("searchResults");

// Ask & Listen
const questionEl = $("question");
const askBtn = $("askBtn");
const bestPlacesWrap = $("bestPlacesWrap");
const bestPlacesBox = $("bestPlaces");
const answerEl = $("answer");

// Mic
const micBtn = $("micBtn");
const micStatus = $("micStatus");

// TTS
const readPageBtn = $("readPageBtn");
const readSectionBtn = $("readSectionBtn");
const stopReadBtn = $("stopReadBtn");
const resumeReadBtn = $("resumeReadBtn");
const voiceSelect = $("voiceSelect");
const speedRange = $("speedRange");

// Bottom bar "Read page" delegates to the main Read Page TTS button
// (keeps one single, reliable TTS entry point)
const bottomReadBtn = $("bottomSearch"); // still id="bottomSearch"

bottomReadBtn?.addEventListener("click", () => {
  readPageBtn?.click();
});

// =====================================================
// State
// =====================================================
let pdfDoc = null;
let pageNum = 1;
let pageCount = 0;
let renderTask = null;

let currentPdfId = null;
let currentPdfName = "";
let restoredOnStartup = false;

let outlineItems = [];
let sectionRanges = [];
let currentSectionIndex = -1;

let pageTextCache = new Map(); // raw extracted text (for search/ask)
let pageTtsCache = new Map();  // cleaned text (for TTS)

let lastSearchHits = [];
let searchCancelToken = { cancel: false };

// TTS
let voices = [];
let ttsSpeaking = false;
let ttsRunId = 0;          // increases each time we start a new reading
let ttsUserStopped = false; // true only when user pressed Stop
let currentUtterance = null; // keep reference (prevents GC quirks)
let lastReadProgress = null; // { page, key, offset, label, started? }
let ttsWasCancelled = false;
let ttsKeepProgressOnCancel = false;

function isStaleRun(runId) {
  return runId !== ttsRunId;
}

if (resumeReadBtn) resumeReadBtn.disabled = true;

// =====================================================
// Helpers / UI
// =====================================================
function setLibraryStatus(msg) {
  if (libraryStatus) libraryStatus.textContent = msg || "";
}

function setMicStatus(msg) {
  if (micStatus) micStatus.textContent = msg || "";
}

function setPageInfo() {
  if (!pageInfo) return;
  pageInfo.textContent = pdfDoc ? `Page: ${pageNum} / ${pageCount}` : "Page: – / –";
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

function enablePdfDependentControls(enabled) {
  // bottom nav
  if (bottomPrevBtn) bottomPrevBtn.disabled = !enabled;
  if (bottomNextBtn) bottomNextBtn.disabled = !enabled;
  if (bottomSearchBtn) bottomSearchBtn.disabled = !enabled;

  // sections/search
  if (sectionFilter) sectionFilter.disabled = !enabled;
  if (searchInput) searchInput.disabled = !enabled;
  if (searchBtn) searchBtn.disabled = !enabled;

  // ask
  if (questionEl) questionEl.disabled = !enabled;
  if (askBtn) askBtn.disabled = !enabled;

  // tts
  if (readPageBtn) readPageBtn.disabled = !enabled;
  if (readSectionBtn) readSectionBtn.disabled = !enabled;
  if (stopReadBtn) stopReadBtn.disabled = !enabled;
  if (speedRange) speedRange.disabled = !enabled;
  if (voiceSelect) voiceSelect.disabled = !enabled;

  refreshResumeBtn();
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
// Rendering helpers
// =====================================================
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
  window.__resetPinchZoom?.();
  await renderPage(pageNum);
  updateCurrentSectionFromPage();

  if (lastReadProgress && lastReadProgress.page !== pageNum) {
    refreshResumeBtn();
  }
}

// =====================================================
// Text extraction (raw for Search + Ask)
// =====================================================
async function getPageText(pageNumber1Based) {
  if (!pdfDoc) return "";
  if (pageTextCache.has(pageNumber1Based)) return pageTextCache.get(pageNumber1Based);

  const page = await pdfDoc.getPage(pageNumber1Based);
  const tc = await page.getTextContent({ includeMarkedContent: true });

  const items = (tc.items || [])
    .map((it) => {
      const str = (it.str || "").replace(/\s+/g, " ").trim();
      if (!str) return null;

      const t = it.transform || [];
      const x = t[4] ?? 0;
      const y = t[5] ?? 0;

      return { str, x, y };
    })
    .filter(Boolean);

  if (!items.length) {
    pageTextCache.set(pageNumber1Based, "");
    return "";
  }

  // Sort visually: top-to-bottom (y desc), then left-to-right (x asc)
  items.sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1.5) return dy;
    return a.x - b.x;
  });

  const lines = [];
  let current = [];
  let currentY = items[0].y;

  const sameLine = (y1, y2) => Math.abs(y1 - y2) <= 2.5;

  for (const it of items) {
    if (!sameLine(it.y, currentY)) {
      current.sort((a, b) => a.x - b.x);
      lines.push(current.map((w) => w.str).join(" "));
      current = [];
      currentY = it.y;
    }
    current.push(it);
  }

  if (current.length) {
    current.sort((a, b) => a.x - b.x);
    lines.push(current.map((w) => w.str).join(" "));
  }

  const result = lines.join("\n");
  pageTextCache.set(pageNumber1Based, result);
  return result;
}

// =====================================================
// TTS cleaning (Pilatus-friendly)
// =====================================================
function cleanTtsText(text) {
  if (!text) return "";
  let t = String(text).replace(/\s+/g, " ").trim();

  const patterns = [
    /\bissued\b\s*[:\-]?\s*[a-z]{3,9}\s+\d{1,2},\s+\d{4}/gi,
    /\brevision\b\s*\d+\s*[:\-]?\s*[a-z]{3,9}\s+\d{1,2},\s+\d{4}/gi,
    /\brevision\b\s*[:\-]?\s*\d{1,3}/gi,
    /\brev\.?\b\s*[:\-]?\s*\d{1,3}/gi,
    /\breport\s*(no|number)\b\s*[:\-]?\s*[0-9a-z\-/. ]{1,20}/gi,
    /\bdoc(ument)?\s*(no|number)\b\s*[:\-]?\s*[0-9a-z\-/. ]{1,25}/gi,
    /\beffective\s*date\b\s*[:\-]?\s*[0-9a-z.,/ ]{1,25}/gi,
    /\bprint(ed)?\s*date\b\s*[:\-]?\s*[0-9a-z.,/ ]{1,25}/gi,
    /\bpage\s+\d+\s*(of\s+\d+)?\b/gi,
    /\b\d{1,4}\s*[-–]\s*\d{1,4}\b/g,
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
    if (sectionsList) {
      sectionsList.innerHTML = `<div style="opacity:.7;font-size:12px;">No outline found in this PDF.</div>`;
    }
    return;
  }

  async function resolveDestToPage(dest) {
    try {
      const resolved = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
      if (!resolved || !resolved[0]) return null;
      const pageIndex = await pdfDoc.getPageIndex(resolved[0]);
      return pageIndex + 1;
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
  outlineItems.sort((a, b) => a.page - b.page);

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

  if (sectionsList) {
    sectionsList.innerHTML = "";

    for (let i = 0; i < sectionRanges.length; i++) {
      const s = sectionRanges[i];

      const btn = document.createElement("button");
      btn.className = "sectionBtn";
      btn.style.width = "100%";
      btn.style.textAlign = "left";

      const indent = s.level ? "&nbsp;".repeat(Math.min(6, s.level) * 2) : "";
      btn.innerHTML = `${indent}${escapeHtml(s.title)} <span style="opacity:.7;">(p.${s.start})</span>`;

      btn.addEventListener("click", async () => {
        currentSectionIndex = i;
        await goToPage(s.start);
      });

      sectionsList.appendChild(btn);
    }

    applySectionsFilter();
  }

  updateCurrentSectionFromPage();
}

function applySectionsFilter() {
  if (!sectionsList) return;
  const q = (sectionFilter?.value || "").trim().toLowerCase();
  const btns = sectionsList.querySelectorAll("button.sectionBtn");
  btns.forEach((btn) => {
    const text = (btn.textContent || "").toLowerCase();
    btn.style.display = !q || text.includes(q) ? "" : "none";
  });
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
// Search (exact)
// =====================================================
function clearSearchUI() {
  lastSearchHits = [];
  if (searchResults) searchResults.innerHTML = "";
}

async function runSearch(query) {
  if (!pdfDoc) return;
  const q = (query || "").trim();
  if (!q) return;

  clearSearchUI();
  searchCancelToken.cancel = false;

  const maxHits = 60;
  const hits = [];

  if (searchResults) {
    searchResults.innerHTML = `<div style="opacity:.7;font-size:12px;">Searching…</div>`;
  }

  const ql = q.toLowerCase();

  for (let p = 1; p <= pageCount; p++) {
    if (searchCancelToken.cancel) break;

    const text = await getPageText(p);
    if (text) {
      const tl = text.toLowerCase();
      const pos = tl.indexOf(ql);
      if (pos >= 0) {
        const left = Math.max(0, pos - 80);
        const right = Math.min(text.length, pos + q.length + 120);
        const context = text.slice(left, right);
        hits.push({ page: p, context });
        if (hits.length >= maxHits) break;
      }
    }

    if (p % 12 === 0) await sleep(0);
  }

  lastSearchHits = hits;

  if (!searchResults) return;

  if (!hits.length) {
    searchResults.innerHTML = `<div style="opacity:.7;font-size:12px;">No hits found.</div>`;
    return;
  }

  const wrap = document.createElement("div");

  for (const h of hits) {
    const item = document.createElement("div");
    item.className = "hit";
    item.innerHTML = `
      <div style="font-weight:600;">Page ${h.page}</div>
      <div style="opacity:.8;font-size:12px;margin-top:6px;">${escapeHtml(h.context)}</div>
    `;
    item.addEventListener("click", async () => {
      await goToPage(h.page);
    });
    wrap.appendChild(item);
  }

  searchResults.innerHTML = "";
  searchResults.appendChild(wrap);
}

// =====================================================
// Best Places cards (Jump / Read from here)
// =====================================================
let bestPlacesHandlersAttached = false;

function attachBestPlacesHandlersOnce() {
  if (bestPlacesHandlersAttached) return;
  if (!bestPlacesBox) return;

  const onTap = async (e) => {
    const btn = e.target?.closest?.(".bestPlaceBtn[data-page]");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    if (!pdfDoc) return;

    const p = Number(btn.dataset.page);
    if (!Number.isFinite(p)) return;

    if (btn.dataset.read === "1") {
      const t = await getPageTextForTts(p);
      await speakChunked(
        `Page ${p}. ${t || "No readable text found on this page."}`,
        { page: p, label: "best-place" },
        { resume: false }
      );
      return;
    }

    await goToPage(p);
  };

  bestPlacesBox.addEventListener("touchend", onTap, { passive: false, capture: true });
  bestPlacesBox.addEventListener("click", onTap, { capture: true });

  bestPlacesHandlersAttached = true;
}

function renderBestPlaces(hits) {
  if (!bestPlacesWrap || !bestPlacesBox) return;

  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) {
    bestPlacesWrap.style.display = "none";
    bestPlacesBox.innerHTML = "";
    return;
  }

  bestPlacesWrap.style.display = "block";
  attachBestPlacesHandlersOnce();

  bestPlacesBox.innerHTML = list
    .map((h, idx) => {
      const title = escapeHtml(h.sectionTitle || "Best place to look");
      const excerpt = escapeHtml(h.excerpt || "");
      const page = Number(h.page || 1);

      return `
        <div class="bestPlaceCard">
          <div class="bestPlaceTitle">${idx + 1}. ${title}</div>
          ${excerpt ? `<div class="bestPlaceExcerpt">${excerpt}</div>` : ""}
          <div class="bestPlaceActions">
            <button class="bestPlaceBtn" data-page="${page}" data-read="0">Jump</button>
            <button class="bestPlaceBtn" data-page="${page}" data-read="1">Read from here</button>
            <div class="bestPlaceMeta">p.${page}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

// =====================================================
// "Ask" (Local mode) — incremental scan
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

  while (askScanState.nextPage <= pageCount) {
    const p = askScanState.nextPage++;

    const text = await getPageText(p);
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

  const final = [];
  for (const r of sorted) {
    if (final.length >= maxReturn) break;
    if (final.some((x) => Math.abs(x.page - r.page) <= 1)) continue;
    final.push(r);
  }

  const done = askScanState.nextPage > pageCount;
  return { hits: final, done };
}

async function handleAsk() {
  if (!requirePaid("Ask")) return;
  const q = (questionEl?.value || "").trim();
  if (!q) return;

  if (!pdfDoc) {
    if (answerEl) answerEl.textContent = "Load a PDF first.";
    return;
  }

  if (answerEl) answerEl.innerHTML = `<div style="opacity:.85;">Searching your POH/AFM offline…</div>`;
  renderBestPlaces([]); // clear old cards while scanning

  const { hits, done } = await runLocalAskIncremental(q, { timeBudgetMs: 1200, maxReturn: 7 });

  if (!hits.length) {
    if (answerEl) {
      answerEl.innerHTML =
        `<div style="font-weight:700;">No strong matches found.</div>
         <div style="opacity:.8;margin-top:8px;">Try shorter keywords (e.g., “Vref”, “105”, “oil pressure”, “takeoff”).</div>
         <div style="opacity:.75;margin-top:10px;">Safety: Always verify in the official POH/AFM.</div>`;
    }
    renderBestPlaces([]);
    return;
  }

  renderBestPlaces(hits);

  if (answerEl) {
    answerEl.innerHTML = `
      ${
        done
          ? ""
          : `<div style="margin-top:6px;display:flex;align-items:center;gap:10px;">
               <button id="askMoreBtn">Search more</button>
               <span style="opacity:.75;font-size:12px;">Scanning…</span>
             </div>`
      }
    `;
  }

  const more = document.getElementById("askMoreBtn");
  if (more) {
    more.onclick = async () => {
      await handleAsk();
    };
  }
}

// =====================================================
// TTS (chunked resume)
// =====================================================
function pickBestVoiceForLang(lang) {
  const l = (lang || "en").toLowerCase();
  const candidates = voices.filter(v => (v.lang || "").toLowerCase().startsWith(l));
  const pool = candidates.length ? candidates : voices;

  const prefer = (rx) => pool.find(v => rx.test((v.name || "").toLowerCase()));
  return prefer(/siri/) || prefer(/enhanced|premium|neural|natural/) || pool[0] || null;
}

function getSelectedVoice() {
  const name = voiceSelect?.value || "";
  return voices.find((v) => v.name === name) || null;
}

// ── Enhanced Voice Prompt (iOS only) ──────────────────────
function showEnhancedVoicePrompt() {
  if (!isCapacitor) return;
  if (localStorage.getItem("pohVoicePromptSeen")) return;
  localStorage.setItem("pohVoicePromptSeen", "1");

  const banner = document.createElement("div");
  banner.id = "voiceBanner";
  banner.innerHTML = `
    <div style="
      position:fixed; bottom:110px; left:12px; right:12px;
      background:#1a1f2e; border:1px solid rgba(77,163,255,0.4);
      border-radius:16px; padding:14px 16px; z-index:9998;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
      display:flex; align-items:flex-start; gap:12px;
    ">
      <span style="font-size:22px;">🎙️</span>
      <div style="flex:1;">
        <div style="font-weight:700;color:#fff;font-size:13px;">
          Get a better voice
        </div>
        <div style="color:#9aa4b2;font-size:12px;margin-top:3px;line-height:1.4;">
          Download <b style="color:#e9edf3;">Daniel (Enhanced)</b> in iOS Settings
          for a much more natural reading voice.
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button onclick="
            if(window.Capacitor?.Plugins?.App) {
              window.Capacitor.Plugins.App.openUrl({url:'app-settings:'});
            }
            document.getElementById('voiceBanner')?.remove();
          " style="
            background:#4da3ff;border:none;color:#fff;
            padding:8px 14px;border-radius:10px;font-weight:700;font-size:12px;
          ">Open Settings</button>
          <button onclick="document.getElementById('voiceBanner')?.remove();" style="
            background:transparent;border:1px solid rgba(255,255,255,0.15);
            color:#9aa4b2;padding:8px 14px;border-radius:10px;font-size:12px;
          ">Dismiss</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 18000);
}

function refreshVoices() {
  // On iOS native TTS, hide the voice selector — AVSpeechSynthesizer handles it
  if (isCapacitor && NativeTTS) {
    if (voiceSelect) {
      voiceSelect.closest("label")?.style.setProperty("display", "none");
    }
    return;
  }
  voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voiceSelect) return;

  // Helper: normalize
  const norm = (s) => String(s || "").toLowerCase();

  // 1) Keep mostly English voices (plus a small fallback set)
  const preferredLangPrefixes = ["en-"];
  const fallbackAllowNames = [
    "Daniel", "Samantha", "Alex", "Karen", "Moira", "Tessa", "Serena",
    "Oliver", "Thomas", "Arthur", "Rishi", "George"
  ].map(norm);

  let filtered = voices.filter(v => {
    const lang = norm(v.lang);
    const name = norm(v.name);
    const isEnglish = preferredLangPrefixes.some(p => lang.startsWith(p));
    const isFallbackGood = fallbackAllowNames.includes(name);
    return isEnglish || isFallbackGood;
  });

  // 2) Sort: Daniel first, then known nice voices
  const preferredOrder = [
    "daniel",
    "samantha",
    "alex",
    "karen",
    "moira",
    "tessa",
    "serena",
    "oliver",
    "thomas",
    "arthur",
    "rishi",
    "george",
  ];

  filtered.sort((a, b) => {
    const an = norm(a.name);
    const bn = norm(b.name);

    const ai = preferredOrder.indexOf(an);
    const bi = preferredOrder.indexOf(bn);

    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }

    const aGB = norm(a.lang).startsWith("en-gb");
    const bGB = norm(b.lang).startsWith("en-gb");
    if (aGB !== bGB) return aGB ? -1 : 1;

    return an.localeCompare(bn);
  });

  // 3) Fill the select
  voiceSelect.innerHTML = "";
  for (const v of filtered) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  }

  // 4) Default selection
  const daniel = filtered.find(v => norm(v.name) === "daniel" && norm(v.lang).startsWith("en-gb"));
  const anyDaniel = filtered.find(v => norm(v.name) === "daniel");
  const best = daniel || anyDaniel || pickBestVoiceForLang("en");
  if (best) voiceSelect.value = best.name;
}

function stopTts({ keepProgress = true } = {}) {
  ttsUserStopped = true;
  ttsRunId++;

  setTimeout(() => (ttsUserStopped = false), 400);

  try {
    ttsWasCancelled = true;
    ttsKeepProgressOnCancel = keepProgress;
    if (NativeTTS) {
      NativeTTS.stop().catch(() => {});
    } else {
      window.speechSynthesis.cancel();
    }
  } catch {}

  ttsSpeaking = false;

  if (!keepProgress) lastReadProgress = null;
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
    if (end < s.length) {
      const lastSpace = s.lastIndexOf(" ", end);
      if (lastSpace > i + 80) end = lastSpace;
    }
    chunks.push(s.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}

function guessLang(text) {
  const t = String(text || "");
  // quick & dirty: German umlauts / ß = likely German
  if (/[äöüßÄÖÜ]/.test(t)) return "de";
  return "en";
}

async function speakChunked(text, { page, label } = {}, { resume = false } = {}) {
  ttsUserStopped = false;   // ✅ RESET USER-STOP FLAG (CRITICAL)
  const myRunId = ++ttsRunId;

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
  showEnhancedVoicePrompt();
  lastReadProgress = { page, key, offset, label, started: false };
  refreshResumeBtn();

  const v = getSelectedVoice() || pickBestVoiceForLang(guessLang(text));
  const rate = Number(speedRange?.value || 1.0);

  const speakNext = () => {
    if (myRunId !== ttsRunId) return;
      if (ttsUserStopped) return;
    if (!chunks.length) {
      ttsSpeaking = false;
      refreshResumeBtn();
      return;
    }

    const chunk = chunks.shift();
    const u = new SpeechSynthesisUtterance(chunk);
    currentUtterance = u; // keep reference
    if (v) u.voice = v;
    u.rate = Number.isFinite(rate) ? rate : 1.0;

    u.onstart = () => {
      if (lastReadProgress) {
        lastReadProgress.started = true;
        if ((lastReadProgress.offset || 0) === 0) lastReadProgress.offset = 1;
        refreshResumeBtn();
      }
    };

    u.onend = () => {
      if (ttsWasCancelled) {
        ttsWasCancelled = false;
        if (!ttsKeepProgressOnCancel) lastReadProgress = null;
        refreshResumeBtn();
        return;
      }

      if (lastReadProgress) lastReadProgress.offset += chunk.length;
      refreshResumeBtn();
      speakNext();
    };

    u.onerror = (e) => {
  const err = String(e?.error || "").toLowerCase();

  // iOS Safari often fires "interrupted"/"canceled" mid-speech.
  // Treat it like a normal end and continue.
  if (!ttsUserStopped && (err === "interrupted" || err === "canceled" || err === "cancelled")) {
    if (lastReadProgress) lastReadProgress.offset += chunk.length;
    refreshResumeBtn();
    setTimeout(speakNext, 80);
    return;
  }

  // real error -> stop
  ttsSpeaking = false;
  refreshResumeBtn();
};

    if (lastReadProgress && (lastReadProgress.offset || 0) === 0) {
      lastReadProgress.offset = 1;
      refreshResumeBtn();
    }

    if (NativeTTS) {
      NativeTTS.speak({
        text: chunk,
        lang: guessLang(chunk) === "de" ? "de-DE" : "en-GB",
        rate: Number.isFinite(rate) ? rate * 0.92 : 0.92,
        pitch: 0.88,
        volume: 1.0,
      }).then(() => {
        if (ttsWasCancelled) {
          ttsWasCancelled = false;
          if (!ttsKeepProgressOnCancel) lastReadProgress = null;
          refreshResumeBtn();
          return;
        }
        if (lastReadProgress) lastReadProgress.offset += chunk.length;
        refreshResumeBtn();
        speakNext();
      }).catch((e) => {
        const err = String(e?.message || "").toLowerCase();
        if (!ttsUserStopped && (err.includes("interrupt") || err.includes("cancel"))) {
          if (lastReadProgress) lastReadProgress.offset += chunk.length;
          refreshResumeBtn();
          setTimeout(speakNext, 80);
          return;
        }
        ttsSpeaking = false;
        refreshResumeBtn();
      });
    } else {
      window.speechSynthesis.speak(u);
    }
  };

  speakNext();
}

async function resumeTts() {
  if (!pdfDoc || !lastReadProgress) return;

  const p = lastReadProgress.page;
  await goToPage(p);

  const text = await getPageTextForTts(p);
  const keyNow = makeTextKey(text);

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

  if (!canResume && lastReadProgress) lastReadProgress.offset = 0;
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
  // Native speech recognition for Capacitor iOS
  if (isCapacitor && window?.Capacitor?.Plugins?.SpeechRecognition) {
    micReady = true;
    return;
  }
  // Web fallback
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setMicStatus("Mic not supported in this browser.");
    if (micBtn) micBtn.disabled = true;
    return;
  }
  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.onstart = () => setMicStatus("Listening\u2026");
  recognition.onend = () => setMicStatus("Mic ready. Hold to talk.");
  recognition.onerror = (e) => setMicStatus("Mic error: " + (e?.error || "unknown"));
  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    transcript = transcript.trim();
    if (!transcript) return;
    if (questionEl) questionEl.value = transcript;
    const questionSheet = document.getElementById("questionSheet");
    if (questionSheet) questionSheet.value = transcript;
    setMicStatus("Heard: " + transcript);
  };
  micReady = true;
}

async function startListening() {
  if (isCapacitor && window?.Capacitor?.Plugins?.SpeechRecognition) {
    const NativeSR = window.Capacitor.Plugins.SpeechRecognition;
    try {
      const available = await NativeSR.available();
      if (!available?.available) { setMicStatus("Speech recognition not available."); return; }
      const perm = await NativeSR.requestPermissions();
      setMicStatus("Listening\u2026");
      const result = await NativeSR.start({
        language: "en-US",
        maxResults: 1,
        prompt: "Ask about your aircraft manual",
        partialResults: false,
        popup: false,
      });
      const transcript = (result?.matches?.[0] || "").trim();
      if (transcript) {
        if (questionEl) questionEl.value = transcript;
        const questionSheet = document.getElementById("questionSheet");
        if (questionSheet) questionSheet.value = transcript;
        setMicStatus("Heard: " + transcript);
      } else {
        setMicStatus("Mic ready. Hold to talk.");
      }
    } catch (e) {
      setMicStatus("Mic ready. Hold to talk.");
    }
    return;
  }
  if (!recognition) return;
  try { recognition.start(); } catch {}
}

function stopListening() {
  if (isCapacitor && window?.Capacitor?.Plugins?.SpeechRecognition) {
    try { window.Capacitor.Plugins.SpeechRecognition.stop(); } catch {}
    setMicStatus("Mic ready. Hold to talk.");
    return;
  }
  if (!recognition) return;
  try { recognition.stop(); } catch {}
}

// =====================================================
// PDF Loading (robust + iOS friendly)
// =====================================================
async function loadPdfFromBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const task = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: "./standard_fonts/",
  });

  pdfDoc = await task.promise;

  pageCount = pdfDoc.numPages;
  pageNum = 1;

  pageTextCache.clear();
  pageTtsCache.clear();
  clearSearchUI();
  askScanState = null;
  lastReadProgress = null;

  enablePdfDependentControls(true);
  setPageInfo();
  await renderPage(pageNum);
  await buildOutlineAndSections();

  setLibraryStatus("Loaded ✅");

  if (answerEl) {
    answerEl.textContent = `Loaded ✅\n\nSafety: Always verify in the official POH/AFM.`;
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

  const rec = await loadPdfFromLibrary(currentPdfId);
  if (!rec?.buffer) throw new Error("Saved record missing buffer");

  currentPdfName = rec.name || currentPdfName;

  await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });
  restoredOnStartup = true;
}

async function restoreLastPdfOnStartup() {
  try {
    const rec = await getLastPdfFromLibrary();
    if (!rec?.buffer) return;

    currentPdfId = rec.id;
    currentPdfName = rec.name || "";

    await refreshLibrarySelectUI();
    await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });

    restoredOnStartup = true;

    if (answerEl) {
      answerEl.textContent =
        `Restored from Library ✅\n\n${rec.name}\n\nSafety: Always verify in the official POH/AFM.`;
    }
  } catch (err) {
    if (isRenderingCancelled(err)) return;
    console.error("restoreLastPdfOnStartup failed:", err);
  }
}

async function refreshLibrarySelectUI() {
  let items = [];
  try {
    items = await idbGetAll(STORE_PDFS);
  } catch (e) {
    console.warn("Could not read library:", e);
    return;
  }
  items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

  if (librarySelect) {
    librarySelect.innerHTML = "";
    if (!items.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(No saved PDFs yet)";
      librarySelect.appendChild(opt);
    } else {
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
  }

  const sheetList = document.getElementById("librarySheetList");
  if (sheetList) {
    sheetList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "opacity:.6;font-size:13px;";
      empty.textContent = "(No saved PDFs yet)";
      sheetList.appendChild(empty);
    } else {
      for (const it of items) {
        const isActive = it.id === currentPdfId;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--card);border-radius:12px;border:1px solid var(--border);margin-bottom:6px;";
        const nameEl = document.createElement("span");
        nameEl.style.cssText = "flex:1;font-size:13px;font-weight:" + (isActive?"700":"400") + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        nameEl.textContent = (isActive ? "▶ " : "") + (it.name || it.id);
        const openBtn = document.createElement("button");
        openBtn.textContent = "Open";
        openBtn.style.cssText = "font-size:11px;padding:5px 10px;flex-shrink:0;";
        openBtn.addEventListener("click", () => window.__openFromSheet(it.id));
        const delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.style.cssText = "font-size:11px;padding:5px 10px;flex-shrink:0;background:rgba(255,80,80,0.1);border-color:rgba(255,80,80,0.3);color:#ff6060;";
        delBtn.addEventListener("click", () => window.__deleteFromSheet(it.id));
        row.appendChild(nameEl);
        row.appendChild(openBtn);
        row.appendChild(delBtn);
        sheetList.appendChild(row);
      }
    }
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
    setLibraryStatus("Feedback copied ✅");
    setTimeout(() => setLibraryStatus(""), 2500);
  } catch (e) {
    console.warn("Clipboard failed:", e);
    alert("Could not copy to clipboard. (Browser blocked it)");
  }
}

// =====================================================
// Events
// =====================================================
function cancelSearch() {
  searchCancelToken.cancel = true;
}

fileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;

  if (file.type !== "application/pdf") {
    alert("Please choose a PDF file.");
    return;
  }

  try {
    cancelSearch();
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

// optional upload button (if your top bar still has it)
uploadBtn?.addEventListener("click", () => fileInput?.click());

bottomUploadBtn?.addEventListener("click", () => fileInput?.click());

bottomPrevBtn?.addEventListener("click", async () => {
  if (!pdfDoc || pageNum <= 1) return;
  await goToPage(pageNum - 1);
});

bottomNextBtn?.addEventListener("click", async () => {
  if (!pdfDoc || pageNum >= pageCount) return;
  await goToPage(pageNum + 1);
});

bottomSearchBtn?.addEventListener("click", () => {
  const section =
    document.getElementById("searchSection") ||
    document.querySelector(".searchCard") ||
    document.getElementById("searchResults") ||
    searchInput;

  section?.scrollIntoView({ behavior: "smooth", block: "start" });

  setTimeout(() => {
    (searchInput ||
      document.getElementById("searchInput") ||
      document.getElementById("searchQuery"))?.focus?.();
  }, 250);
});

openFromLibraryBtn?.addEventListener("click", async () => {
  const id = librarySelect?.value;
  if (!id) return;

  try {
    cancelSearch();
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

sectionFilter?.addEventListener("input", applySectionsFilter);

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

askBtn?.addEventListener("click", handleAsk);

readPageBtn?.addEventListener("click", () => {
  if (!requirePaid("Read aloud")) return;
  readCurrentPage();
});

readSectionBtn?.addEventListener("click", () => {
  if (!requirePaid("Read aloud")) return;
  readCurrentSection();
});

stopReadBtn?.addEventListener("click", () => {
  stopTts({ keepProgress: true });
  refreshResumeBtn();
});

resumeReadBtn?.addEventListener("click", resumeTts);

// Mic hold-to-talk
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

// ================================
// Pilot Subscription (paid gating)
// ================================
const PAID_KEY = "pohPilotPaid"; // "1" = paid, null = not paid

function isPaidUser() {
  return localStorage.getItem(PAID_KEY) === "1";
}

// TEMP helper (for manual unlock during testing)
// Call from console: unlockPilot()
function unlockPilot() {
  localStorage.setItem(PAID_KEY, "1");
  console.log("Pilot subscription unlocked");
}

// TEMP helper (lock again if needed)
function lockPilot() {
  localStorage.removeItem(PAID_KEY);
  console.log("Pilot subscription locked");
}

// Expose helpers for DevTools / testing
window.unlockPilot = unlockPilot;
window.lockPilot = lockPilot;

function showPaywall(featureName = "this feature") {
  const overlay = document.getElementById("paywallOverlay");
  const msg = document.getElementById("paywallMsg");
  const unlockRow = document.getElementById("paywallUnlockRow");
  const code = document.getElementById("paywallCode");

if (msg) msg.textContent = `Unlock ${featureName} with POH Reader PRO (4,99 € one-time).`;
  unlockRow?.setAttribute("hidden", "");
  if (code) code.value = "";

  overlay?.removeAttribute("hidden");
}

function requirePaid(featureName) {
  if (isPaidUser()) return true;
  showPaywall(featureName);
  return false;
}

// Paywall UI wiring
const SUBSCRIBE_URL = "https://buy.stripe.com/5kQaEXccuguagFt6yo6AM00";

(function initPaywallUI() {
  const overlay = document.getElementById("paywallOverlay");
  const closeBtn = document.getElementById("paywallClose");
  const subscribeBtn = document.getElementById("paywallSubscribeBtn");
  const alreadyBtn = document.getElementById("paywallAlreadyBtn");
  const unlockRow = document.getElementById("paywallUnlockRow");
  const codeInput = document.getElementById("paywallCode");
  const unlockBtn = document.getElementById("paywallUnlockBtn");

  if (subscribeBtn) subscribeBtn.href = SUBSCRIBE_URL;

  function hidePaywall() {
    overlay?.setAttribute("hidden", "");
    unlockRow?.setAttribute("hidden", "");
    if (codeInput) codeInput.value = "";
  }

  unlockBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  const raw = (codeInput?.value || "").trim();
  const code = raw.toUpperCase();

  const VALID_CODES = new Set(["POH-PILOT-2025", "POH-BETA-001", "POH-BETA-002", "POH-BETA-003"]);
  if (!VALID_CODES.has(code)) {
    alert("Invalid code. Please check the code you received after purchasing.");
    return;
  }

  // ✅ THIS is what makes it persist
  localStorage.setItem(PAID_KEY, "1");

  // ✅ close + refresh UI
  hidePaywall();
  enablePdfDependentControls(true);

  // extra safety for iOS tap weirdness
  setTimeout(() => {
    overlay?.setAttribute("hidden", "");
  }, 0);
});

  closeBtn?.addEventListener("click", hidePaywall);
closeBtn?.addEventListener("pointerup", hidePaywall);
closeBtn?.addEventListener("touchend", (e) => { e.preventDefault(); hidePaywall(); }, { passive: false });

  // Tap outside closes
overlay?.addEventListener("pointerdown", (e) => {
  if (e.target === overlay) hidePaywall();
});
overlay?.addEventListener("click", (e) => {
  if (e.target === overlay) hidePaywall();
});

  // Reveal unlock only when requested
  alreadyBtn?.addEventListener("click", () => {
    unlockRow?.removeAttribute("hidden");
    setTimeout(() => codeInput?.focus(), 50);
  });

  // iPhone keyboard: keep input visible
  codeInput?.addEventListener("focus", () => {
    setTimeout(() => codeInput.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
  });

  window.hidePaywall = hidePaywall;
})();

// =====================
// License persistence
// =====================
const LICENSE_DB = "poh_reader";
const LICENSE_STORE = "kv";
const LICENSE_KEY = "pohPilotPaid";

let isUnlocked = false;

function openLicenseDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LICENSE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LICENSE_STORE)) {
        db.createObjectStore(LICENSE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function licenseGet(key) {
  const db = await openLicenseDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LICENSE_STORE, "readonly");
    const store = tx.objectStore(LICENSE_STORE);
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function licenseSet(key, value) {
  const db = await openLicenseDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LICENSE_STORE, "readwrite");
    const store = tx.objectStore(LICENSE_STORE);
    const r = store.put(value, key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

async function loadLicenseState() {
  // 1) localStorage fast path
  const ls = localStorage.getItem(LICENSE_KEY);
  if (ls === "1") {
    isUnlocked = true;
    // Backfill IDB (best-effort)
    try { await licenseSet(LICENSE_KEY, true); } catch {}
    return true;
  }

  // 2) IndexedDB fallback
  try {
    const v = await licenseGet(LICENSE_KEY);
    isUnlocked = (v === true);
    if (isUnlocked) localStorage.setItem(LICENSE_KEY, "1");
    return isUnlocked;
  } catch {
    isUnlocked = false;
    return false;
  }
}

async function setUnlocked(value) {
  isUnlocked = !!value;

  if (isUnlocked) localStorage.setItem(LICENSE_KEY, "1");
  else localStorage.removeItem(LICENSE_KEY);

  try { await licenseSet(LICENSE_KEY, isUnlocked); } catch {}

  updatePaywallUI();
}

function updatePaywallUI() {
  // Overlay exists in your HTML
const overlay = document.getElementById("paywallOverlay");
if (overlay && isUnlocked) overlay.hidden = true;   // only force-hide when unlocked
// if NOT unlocked → do nothing (keep it hidden unless user triggers it)

  // Gate buttons (only if they exist)
  // askBtn already declared above
  if (askBtn) askBtn.disabled = !isUnlocked;

  // Your mobile bottom "Read page" button is bottomSearch
  const readBtnMobile = document.getElementById("bottomSearch");
  if (readBtnMobile) readBtnMobile.disabled = !isUnlocked;

  // If you also have a desktop read button, gate it too (optional)
  const readBtn = document.getElementById("readBtn");
  if (readBtn) readBtn.disabled = !isUnlocked;
}

// =====================================================
// Startup
// =====================================================
window.addEventListener("DOMContentLoaded", async () => {
  await loadLicenseState();
  updatePaywallUI();

  // ================================
// Welcome overlay (first run)
// ================================
const WELCOME_KEY = "pohWelcomeSeen";
 
function hideWelcome() {
  document.getElementById("welcomeOverlay")?.setAttribute("hidden", "");
  localStorage.setItem(WELCOME_KEY, "1");
}
 
(function initWelcomeUI() {
  const overlay  = document.getElementById("welcomeOverlay");
  const splash   = document.getElementById("wSplash");
  const card     = document.getElementById("wCard");
  const closeBtn = document.getElementById("welcomeClose");
  const continueBtn = document.getElementById("welcomeContinueBtn");
 
  // Only show on first run
  if (localStorage.getItem(WELCOME_KEY) === "1") return;
 
  overlay?.removeAttribute("hidden");
 
  // After 1.2 s: fade out splash, fade in card
  setTimeout(() => {
    splash?.classList.add("wFadeOut");
 
    setTimeout(() => {
      if (splash) splash.style.display = "none";
      if (card) {
        card.style.display = "block";
        card.removeAttribute("aria-hidden");
        // trigger animation
        requestAnimationFrame(() => card.classList.add("wVisible"));
      }
    }, 400); // matches wFadeOut duration
 
  }, 1200);
 
  closeBtn?.addEventListener("click", hideWelcome);
  continueBtn?.addEventListener("click", hideWelcome);
 
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) hideWelcome();
  });
})();
 

  if (speedRange) speedRange.value = "0.9";

  await refreshLibrarySelectUI();
  await restoreLastPdfOnStartup();

  setMicStatus("Mic ready. Hold to talk.");
  refreshResumeBtn();

// Theme toggle (Auto / Light / Dark)
const THEME_KEY = "pohTheme"; // store: "auto" | "light" | "dark"
const root = document.documentElement;
const themeBtn = document.getElementById("themeToggle");

function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function getSavedTheme() {
  const v = localStorage.getItem(THEME_KEY);
  return (v === "auto" || v === "light" || v === "dark") ? v : "auto";
}

function applyTheme(mode) {
  // mode: "auto" | "light" | "dark"
  const effective = (mode === "auto") ? getSystemTheme() : mode;

  if (effective === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme"); // light default

  localStorage.setItem(THEME_KEY, mode);
  updateThemeIcon(mode, effective);
}

function updateThemeIcon(mode, effective) {
  if (!themeBtn) return;

  // Icon shows effective theme, but we also hint mode
  const icon = (effective === "dark") ? "🌙" : "☀️";

  // If you want super clean: only icon
  themeBtn.textContent = icon;

  // Optional: tooltip explains state
  themeBtn.title = `Theme: ${mode.toUpperCase()} (${effective})`;
  themeBtn.setAttribute("aria-label", `Theme ${mode}, currently ${effective}`);
}

function nextMode(mode) {
  // cycle: auto -> light -> dark -> auto
  if (mode === "auto") return "light";
  if (mode === "light") return "dark";
  return "auto";
}

function initTheme() {
  // 1) apply saved mode
  applyTheme(getSavedTheme());

  // 2) react to system changes ONLY if mode is auto
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener?.("change", () => {
    if (getSavedTheme() !== "auto") return;
    applyTheme("auto");
  });

  // 3) user toggle cycles modes
  themeBtn?.addEventListener("click", () => {
    const mode = getSavedTheme();
    applyTheme(nextMode(mode));
  });
}

initTheme();

// Debug helpers
window.__POH = window.__POH || {};
window.__POH.getPageTextForTts = getPageTextForTts;
window.__POH.pageNum = () => pageNum;
window.__POH.renderBestPlaces = renderBestPlaces;
window.goToPage = goToPage;
window.closeAllSheets = () => {
  document.querySelectorAll('.bottomSheet').forEach(s => s.classList.remove('sheetOpen'));
  document.getElementById('sheetBackdrop')?.classList.remove('backdropVisible');
};

// Register Service Worker (GitHub Pages-safe)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => console.log("[SW] registered:", reg.scope))
      .catch((err) => console.error("[SW] registration failed:", err));
  });
}
});

/* ============================================================
   MOBILE BOTTOM SHEET SYSTEM
   Add this entire block at the END of app.js,
   replacing the old "Bottom Dock Collapse / Expand" section
   ============================================================ */


// ── Pinch-to-zoom + pan on PDF canvas ────────────────────────
(function initPinchZoom() {
  const viewer = document.querySelector('.viewer');
  const canvas = document.getElementById('canvas');
  if (!viewer || !canvas) return;
  let scale = 1, panX = 0, panY = 0;
  let lastDist = null, lastMidX = 0, lastMidY = 0;
  let lastSingleX = null, lastSingleY = null;
  function applyTransform() {
    canvas.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + scale + ")";
    canvas.style.transformOrigin = 'top left';
  }
  function resetTransform() {
    scale = 1; panX = 0; panY = 0; applyTransform();
  }
  window.__resetPinchZoom = resetTransform;
  viewer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastDist = Math.sqrt(dx*dx + dy*dy);
      lastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      lastSingleX = null; lastSingleY = null;
    } else if (e.touches.length === 1 && scale > 1.05) {
      lastSingleX = e.touches[0].clientX;
      lastSingleY = e.touches[0].clientY;
    }
  }, { passive: true });
  viewer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && lastDist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const delta = dist / lastDist;
      const rect = canvas.getBoundingClientRect();
      panX += (midX - rect.left) * (1 - delta) + (midX - lastMidX);
      panY += (midY - rect.top) * (1 - delta) + (midY - lastMidY);
      scale = Math.min(Math.max(scale * delta, 0.8), 5.0);
      lastDist = dist; lastMidX = midX; lastMidY = midY;
      applyTransform();
    } else if (e.touches.length === 1 && scale > 1.05 && lastSingleX !== null) {
      panX += e.touches[0].clientX - lastSingleX;
      panY += e.touches[0].clientY - lastSingleY;
      lastSingleX = e.touches[0].clientX;
      lastSingleY = e.touches[0].clientY;
      applyTransform();
    }
  }, { passive: true });
  viewer.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) lastDist = null;
    if (e.touches.length === 1 && scale > 1.05) {
      lastSingleX = e.touches[0].clientX;
      lastSingleY = e.touches[0].clientY;
    }
    if (e.touches.length === 0) {
      lastSingleX = null; lastSingleY = null;
      if (scale < 1.05) resetTransform();
    }
  }, { passive: true });
})();

window.__openFromSheet = async (id) => {
  try {
    const rec = await loadPdfFromLibrary(id);
    if (!rec?.buffer) return;
    currentPdfId = rec.id;
    currentPdfName = rec.name || "";
    await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });
    setLibraryStatus("Opened ✅");
    window.closeAllSheets?.();
  } catch (err) { console.error(err); }
};

window.__deleteFromSheet = async (id) => {
  if (!confirm("Delete this PDF?")) return;
  try {
    await deletePdfFromLibrary(id);
    await refreshLibrarySelectUI();
    setLibraryStatus("Deleted ✅");
  } catch (err) { console.error(err); }
};

// ── Mobile Bottom Sheet System ────────────────────────────────
(function initMobileSheets() {
  const isMobile = () => window.innerWidth <= 768;

  // Sheet elements
  const backdrop     = document.getElementById("sheetBackdrop");
  const librarySheet = document.getElementById("librarySheet");
  const searchSheet  = document.getElementById("searchSheet");
  const askSheet     = document.getElementById("askSheet");

  // Action bar buttons
  const mabPrev    = document.getElementById("mabPrev");
  const mabNext    = document.getElementById("mabNext");
  const mabUpload  = document.getElementById("mabUpload");
  const mabLibrary = document.getElementById("mabLibrary");
  const mabSearch  = document.getElementById("mabSearch");
  const mabAsk     = document.getElementById("mabAsk");

  // Sheet close buttons
  const libraryClose = document.getElementById("librarySheetClose");
  const searchClose  = document.getElementById("searchSheetClose");
  const askClose     = document.getElementById("askSheetClose");

  // TTS mini bar
  const ttsMiniBar   = document.getElementById("ttsMiniBar");
  const ttsBarLabel  = document.getElementById("ttsBarLabel");
  const ttsBarStop   = document.getElementById("ttsBarStop");
  const ttsBarResume = document.getElementById("ttsBarResume");

  let activeSheet = null;

  function openSheet(sheet) {
    if (!isMobile()) return;
    if (activeSheet && activeSheet !== sheet) closeSheet(activeSheet, false);
    activeSheet = sheet;
    sheet?.classList.add("sheetOpen");
    backdrop?.classList.add("backdropVisible");
  }

  function closeSheet(sheet, clearActive = true) {
    sheet?.classList.remove("sheetOpen");
    if (clearActive) {
      backdrop?.classList.remove("backdropVisible");
      activeSheet = null;
    }
  }

  function closeAll() {
    [librarySheet, searchSheet, askSheet].forEach(s => closeSheet(s, false));
    backdrop?.classList.remove("backdropVisible");
    activeSheet = null;
  }

  // Backdrop tap closes
  backdrop?.addEventListener("click", closeAll);

  // Open buttons
  mabLibrary?.addEventListener("click", () => openSheet(librarySheet));
  mabSearch?.addEventListener("click",  () => openSheet(searchSheet));
  mabAsk?.addEventListener("click",     () => openSheet(askSheet));

  // Close buttons
  libraryClose?.addEventListener("click", closeAll);
  searchClose?.addEventListener("click",  closeAll);
  askClose?.addEventListener("click",     closeAll);

  // Nav buttons
  mabPrev?.addEventListener("click", async () => {
    if (!pdfDoc || pageNum <= 1) return;
    await goToPage(pageNum - 1);
  });

  mabNext?.addEventListener("click", async () => {
    if (!pdfDoc || pageNum >= pageCount) return;
    await goToPage(pageNum + 1);
  });

  // Upload
mabUpload?.addEventListener("click", (e) => {
    e.preventDefault();
    const f = document.getElementById("file");
    if (f) {
      f.value = "";
      f.click();
    }
  });

  // TTS mini bar: auto-show/hide when reading
  // Patch into the existing refreshResumeBtn cycle
  const _origRefreshResumeBtn = window.__origRefreshResumeBtn || null;

  function updateTtsMiniBar() {
    if (!isMobile() || !ttsMiniBar) return;

    if (ttsSpeaking) {
      ttsMiniBar.classList.add("ttsActive");
      if (ttsBarLabel) {
        const section = getSectionForPage(pageNum);
        ttsBarLabel.textContent = section
          ? `Reading: ${section}`
          : `Reading page ${pageNum}`;
      }
    } else {
      ttsMiniBar.classList.remove("ttsActive");
    }

    if (ttsBarResume) {
      ttsBarResume.style.display = (!ttsSpeaking && lastReadProgress && (lastReadProgress.offset || 0) > 0)
        ? "grid" : "none";
    }
  }

  // Hook TTS mini bar into stop/resume buttons
  ttsBarStop?.addEventListener("click", () => {
    stopTts({ keepProgress: true });
    updateTtsMiniBar();
  });

  ttsBarResume?.addEventListener("click", async () => {
    await resumeTts();
    updateTtsMiniBar();
  });

  // Periodically sync mini bar state
  setInterval(updateTtsMiniBar, 600);

  // Swipe down to close sheets
  let touchStartY = 0;

  [librarySheet, searchSheet, askSheet].forEach(sheet => {
    if (!sheet) return;

    sheet.addEventListener("touchstart", (e) => {
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    sheet.addEventListener("touchmove", (e) => {
      const dy = e.touches[0].clientY - touchStartY;
      if (dy > 60) closeAll();
    }, { passive: true });
  });

  // Auto-close sheet after section/search jump
  const origGoToPage = window.__origGoToPage;

  // Close ask sheet after asking (keep results visible briefly)
  // askBtn already declared above
  if (askBtn) {
    const origClick = askBtn.onclick;
    askBtn.addEventListener("click", () => {
      // Sheet stays open to show results — user closes manually
    });
  }

  // After search result click, close sheet
  // searchResults already declared above
  if (searchResults) {
    searchResults.addEventListener("click", (e) => {
      if (e.target.closest(".hit")) {
        setTimeout(closeAll, 300);
      }
    });
  }

  // After section click, close sheet
  // sectionsList already declared above
  if (sectionsList) {
    sectionsList.addEventListener("click", (e) => {
      if (e.target.closest(".sectionBtn")) {
        setTimeout(closeAll, 300);
      }
    });
  }

  // Disable action bar buttons until PDF loaded
  function syncActionBarState() {
    const hasPdf = !!pdfDoc;
    if (mabPrev) mabPrev.disabled = !hasPdf || pageNum <= 1;
    if (mabNext) mabNext.disabled = !hasPdf || pageNum >= pageCount;
  }

  setInterval(syncActionBarState, 500);

  // ── Wire Sheet-suffixed IDs to core functions ──────────────
  // Search sheet
  const searchInputSheet = document.getElementById("searchInputSheet");
  const searchBtnSheet = document.getElementById("searchBtnSheet");
  const searchResultsSheet = document.getElementById("searchResultsSheet");

  searchBtnSheet?.addEventListener("click", async () => {
    if (!pdfDoc) return;
    const q = searchInputSheet?.value || "";
    if (!q) return;
    if (searchResultsSheet) searchResultsSheet.innerHTML = `<div style="opacity:.7;font-size:12px;">Searching…</div>`;
    searchCancelToken.cancel = false;
    const ql = q.toLowerCase();
    const hits = [];
    for (let p = 1; p <= pageCount; p++) {
      if (searchCancelToken.cancel) break;
      const text = await getPageText(p);
      if (text) {
        const pos = text.toLowerCase().indexOf(ql);
        if (pos >= 0) {
          hits.push({ page: p, context: text.slice(Math.max(0,pos-80), pos+q.length+120) });
          if (hits.length >= 60) break;
        }
      }
      if (p % 12 === 0) await sleep(0);
    }
    if (!searchResultsSheet) return;
    if (!hits.length) { searchResultsSheet.innerHTML = `<div style="opacity:.7;font-size:12px;">No hits found.</div>`; return; }
    const wrap = document.createElement("div");
    for (const h of hits) {
      const item = document.createElement("div");
      item.className = "hit";
      item.innerHTML = `<div style="font-weight:600;">Page ${h.page}</div><div style="opacity:.8;font-size:12px;margin-top:6px;">${escapeHtml(h.context)}</div>`;
      item.addEventListener("click", async () => { await goToPage(h.page); setTimeout(closeAll, 300); });
      wrap.appendChild(item);
    }
    searchResultsSheet.innerHTML = "";
    searchResultsSheet.appendChild(wrap);
  });

  searchInputSheet?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchBtnSheet?.click(); }
  });

  // Ask sheet
  const questionSheet = document.getElementById("questionSheet");
  const askBtnSheet = document.getElementById("askBtnSheet");
  const answerSheet = document.getElementById("answerSheet");
  const bestPlacesWrapSheet = document.getElementById("bestPlacesWrapSheet");
  const bestPlacesSheet = document.getElementById("bestPlacesSheet");

  askBtnSheet?.addEventListener("click", async () => {
    if (!requirePaid("Ask")) return;
    const q = (questionSheet?.value || "").trim();
    if (!q || !pdfDoc) return;
    if (answerSheet) answerSheet.innerHTML = `<div style="opacity:.85;">Searching…</div>`;
    if (bestPlacesWrapSheet) bestPlacesWrapSheet.style.display = "none";
    const { hits, done } = await runLocalAskIncremental(q, { timeBudgetMs: 1200, maxReturn: 7 });
    if (!hits.length) {
      if (answerSheet) answerSheet.innerHTML = `<div style="font-weight:700;">No strong matches found.</div><div style="opacity:.8;margin-top:8px;">Try shorter keywords.</div>`;
      return;
    }
    if (bestPlacesWrapSheet && bestPlacesSheet) {
    bestPlacesWrapSheet.style.display = "block";
      bestPlacesSheet.innerHTML = hits.map((h, idx) => `
        <div class="bestPlaceCard">
          <div class="bestPlaceTitle">${idx+1}. ${escapeHtml(h.sectionTitle||"Best place to look")}</div>
          ${h.excerpt ? `<div class="bestPlaceExcerpt">${escapeHtml(h.excerpt)}</div>` : ""}
          <div class="bestPlaceActions">
            <button class="bestPlaceBtn" onclick="window.goToPage(${h.page});setTimeout(window.closeAllSheets,300);">Jump p.${h.page}</button>
            <button class="bestPlaceBtn" onclick="window.readPageBtnSheet_click(${h.page})">Read</button>
          </div>
        </div>`).join("");
    }
    if (answerSheet) answerSheet.innerHTML = done ? "" : `<button id="askMoreBtnSheet">Search more</button>`;
    document.getElementById("askMoreBtnSheet")?.addEventListener("click", () => askBtnSheet?.click());
  });

  window.readPageBtnSheet_click = async (p) => {
    if (!requirePaid("Read aloud")) return;
    await goToPage(p);
    const text = await getPageTextForTts(p);
    await speakChunked(text || "No readable text.", { page: p, label: "page" }, { resume: false });
  };

  // TTS sheet buttons
  document.getElementById("readPageBtnSheet")?.addEventListener("click", () => {
    if (!requirePaid("Read aloud")) return;
    readCurrentPage();
  });
  document.getElementById("readSectionBtnSheet")?.addEventListener("click", () => {
    if (!requirePaid("Read aloud")) return;
    readCurrentSection();
  });
  document.getElementById("stopReadBtnSheet")?.addEventListener("click", () => {
    stopTts({ keepProgress: true });
    refreshResumeBtn();
  });
  document.getElementById("resumeReadBtnSheet")?.addEventListener("click", resumeTts);

  // Speed sheet sync
  const speedRangeSheet = document.getElementById("speedRangeSheet");
  speedRangeSheet?.addEventListener("input", () => {
    if (speedRange) speedRange.value = speedRangeSheet.value;
  });

  // Sections sheet
  const sectionFilterSheet = document.getElementById("sectionFilterSheet");
  const sectionsListSheet = document.getElementById("sectionsListSheet");

  sectionFilterSheet?.addEventListener("input", () => {
    const q = (sectionFilterSheet.value || "").trim().toLowerCase();
    sectionsListSheet?.querySelectorAll("button.sectionBtn").forEach(btn => {
      btn.style.display = !q || btn.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // Sync sections list to sheet when PDF loads
  const _origBuildOutline = window.__origBuildOutline;
  function syncSectionsToSheet() {
    if (!sectionsListSheet || !sectionsList) return;
    sectionsListSheet.innerHTML = "";
    sectionRanges.forEach((s, i) => {
      const btn = document.createElement("button");
      btn.className = "sectionBtn";
      btn.style.cssText = "width:100%;text-align:left;";
      const indent = s.level ? "&nbsp;".repeat(Math.min(6, s.level) * 2) : "";
      btn.innerHTML = `${indent}${escapeHtml(s.title)} <span style="opacity:.7;">(p.${s.start})</span>`;
      btn.addEventListener("click", async () => {
        currentSectionIndex = i;
        await goToPage(s.start);
        setTimeout(closeAll, 300);
      });
      sectionsListSheet.appendChild(btn);
    });
  }

  // Poll for sections to appear (after PDF loads)
  setInterval(() => {
    if (sectionRanges.length > 0 && sectionsListSheet && sectionsListSheet.children.length === 0) {
      syncSectionsToSheet();
    }
  }, 800);

  // Mic sheet button
  const micBtnSheet = document.getElementById("micBtnSheet");
  const micStatusSheet = document.getElementById("micStatusSheet");
  if (micBtnSheet) {
    micBtnSheet.addEventListener("pointerdown", async (e) => {
      e.preventDefault();
      if (isHolding) return;
      isHolding = true;
      const ok = await ensureMicPermission();
      if (!ok) { if (micStatusSheet) micStatusSheet.textContent = "Mic permission denied."; isHolding = false; return; }
      if (!micReady) setupSpeechRecognition();
      if (!micReady) { isHolding = false; return; }
      if (micStatusSheet) micStatusSheet.textContent = "Listening…";
      startListening();
    });
    const endHoldSheet = (e) => {
      e.preventDefault();
      if (!isHolding) return;
      isHolding = false;
      stopListening();
      if (micStatusSheet) micStatusSheet.textContent = "Mic ready. Hold to talk.";
    };
    micBtnSheet.addEventListener("pointerup", endHoldSheet);
    micBtnSheet.addEventListener("pointercancel", endHoldSheet);
    micBtnSheet.addEventListener("pointerleave", endHoldSheet);
  }

})();
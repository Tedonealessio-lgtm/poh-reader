import * as pdfjsLib from "./pdf.mjs";

// pdf.js worker served from /docs (GitHub Pages root)
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

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
      <div class="sectionMeta">
        I’ve highlighted the most relevant pages below.
        Use <b>Jump</b> or <b>Read from here</b>.
      </div>
      ${
        done
          ? ""
          : `<div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
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

function refreshVoices() {
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
    window.speechSynthesis.cancel();
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
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setMicStatus("Mic not supported in this browser.");
    if (micBtn) micBtn.disabled = true;
    return;
  }

  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

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
      if (questionEl) questionEl.value = transcript;
      setMicStatus(`Heard: "${transcript}"`);
    } else {
      setMicStatus(`Listening… "${transcript}"`);
    }
  };

  micReady = true;
}

function startListening() {
  if (!recognition) return;
  try { recognition.start(); } catch {}
}

function stopListening() {
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

readPageBtn?.addEventListener("click", readCurrentPage);
readSectionBtn?.addEventListener("click", readCurrentSection);

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

// =====================================================
// Startup
// =====================================================
window.addEventListener("DOMContentLoaded", async () => {
  enablePdfDependentControls(false);
  setPageInfo();

  if ("speechSynthesis" in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  if (speedRange) speedRange.value = "0.9";

  await refreshLibrarySelectUI();
  await restoreLastPdfOnStartup();

  setMicStatus("Mic ready. Hold to talk.");
  refreshResumeBtn();

  // Theme toggle (light/dark)
const THEME_KEY = "pohTheme";
const root = document.documentElement;
const themeBtn = document.getElementById("themeToggle");

function updateThemeIcon() {
  if (!themeBtn) return;
  const isDark = root.getAttribute("data-theme") === "dark";
  themeBtn.textContent = isDark ? "🌙" : "☀️";
}

function applyTheme(mode) {
  // mode: "light" or "dark"
  if (mode === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme"); // light = default

  localStorage.setItem(THEME_KEY, mode);
  updateThemeIcon();
}

function getSavedTheme() {
  const v = localStorage.getItem(THEME_KEY);
  return v === "dark" || v === "light" ? v : null;
}

function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function initTheme() {
  // 1) apply saved or system
  const saved = getSavedTheme();
  applyTheme(saved || getSystemTheme());

  // 2) react to system changes ONLY if user has not chosen a theme
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener?.("change", () => {
    if (getSavedTheme()) return; // user preference wins
    applyTheme(getSystemTheme());
  });

  // 3) user toggle
  themeBtn?.addEventListener("click", () => {
    const isDark = root.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  });
}

initTheme();

// Debug helpers
window.__POH = window.__POH || {};
window.__POH.getPageTextForTts = getPageTextForTts;
window.__POH.pageNum = () => pageNum;
window.__POH.renderBestPlaces = renderBestPlaces;

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
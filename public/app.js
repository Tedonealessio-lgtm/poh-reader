import * as pdfjsLib from "./pdf.mjs";

// pdf.js worker served from /public (web root)
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

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
const canvas = $("canvas");
const ctx = canvas?.getContext("2d");

const prevBtn = $("prev");
const nextBtn = $("next");
const pageInfo = $("pageInfo");

const librarySelect = $("librarySelect");
const openFromLibraryBtn = $("openFromLibraryBtn");
const deleteFromLibraryBtn = $("deleteFromLibraryBtn");
const clearLibraryBtn = $("clearLibraryBtn");
const libraryStatus = $("libraryStatus");

const feedbackBtn = $("feedbackBtn");
const feedbackStatus = $("feedbackStatus");

const sectionsBox = $("sections");

const sectionFilter = $("sectionFilter");
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

let currentPdfId = null;
let currentPdfName = "";

let outlineItems = []; // {title, page, level}
let sectionRanges = []; // [{title, start, end}]
let currentSectionIndex = -1;

let pageTextCache = new Map(); // pageIndex (1-based) -> string
let lastSearchHits = []; // [{page, text, context}]
let searchCancelToken = { cancel: false };

// TTS
let voices = [];
let ttsSpeaking = false;

// =====================================================
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

function enableCoreInputs() {
  // Ask box should be usable even if no PDF loaded
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
}

function isRenderingCancelled(err) {
  return (
    err &&
    (err.name === "RenderingCancelledException" ||
      String(err.message || err).toLowerCase().includes("rendering cancelled") ||
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
}

// =====================================================
// Text extraction (for search + TTS)
// =====================================================
async function getPageText(pageNumber1Based) {
  if (!pdfDoc) return "";
  if (pageTextCache.has(pageNumber1Based)) return pageTextCache.get(pageNumber1Based);

  const page = await pdfDoc.getPage(pageNumber1Based);
  const tc = await page.getTextContent();
  const text = (tc.items || [])
    .map((it) => (it && it.str ? it.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  pageTextCache.set(pageNumber1Based, text);
  return text;
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
    if (sectionFilter) {
      sectionFilter.innerHTML = `<option value="ALL">All sections</option>`;
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
  }

  // Fill section filter
  if (sectionFilter) {
    sectionFilter.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "ALL";
    optAll.textContent = "All sections";
    sectionFilter.appendChild(optAll);

    sectionRanges.forEach((s, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = s.title;
      sectionFilter.appendChild(opt);
    });
  }

  updateCurrentSectionFromPage();
}

function updateCurrentSectionFromPage() {
  if (!sectionRanges.length || !pdfDoc) return;
  const idx = sectionRanges.findIndex((s) => pageNum >= s.start && pageNum <= s.end);
  currentSectionIndex = idx;
  if (sectionFilter) {
    if (idx >= 0) {
      // keep dropdown on ALL unless user specifically selects
      if (sectionFilter.value !== "ALL" && sectionFilter.value !== String(idx)) {
        // don’t force-change if user is filtering
      }
    }
  }
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

  const filterVal = sectionFilter?.value || "ALL";
  let startPage = 1;
  let endPage = pageCount;

  if (filterVal !== "ALL") {
    const idx = Number(filterVal);
    if (!Number.isNaN(idx) && sectionRanges[idx]) {
      startPage = sectionRanges[idx].start;
      endPage = sectionRanges[idx].end;
    }
  }

  const maxHits = 60;
  const hits = [];

  if (searchResults) {
    searchResults.innerHTML = `<div style="opacity:.7;font-size:12px;">Searching pages ${startPage}–${endPage}…</div>`;
  }

  // async scan (yields so UI doesn’t freeze)
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

    if (p % 8 === 0) {
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

  // Render hits
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
// TTS (Voice Read)
// =====================================================
function stopTts() {
  try {
    window.speechSynthesis.cancel();
  } catch {}
  ttsSpeaking = false;
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

  // try to keep a sensible default
  const en = voices.find((v) => (v.lang || "").toLowerCase().startsWith("en"));
  if (en) voiceSelect.value = en.name;
}

async function speakText(text) {
  stopTts();
  if (!text) return;

  const u = new SpeechSynthesisUtterance(text);
  const v = getSelectedVoice();
  if (v) u.voice = v;

  const rate = Number(ttsRate?.value || 1.0);
  u.rate = Number.isFinite(rate) ? rate : 1.0;

  ttsSpeaking = true;
  u.onend = () => (ttsSpeaking = false);
  u.onerror = () => (ttsSpeaking = false);

  window.speechSynthesis.speak(u);
}

async function readCurrentPage() {
  if (!pdfDoc) return;
  const text = await getPageText(pageNum);
  await speakText(text || "No readable text found on this page.");
}

async function readCurrentSection() {
  if (!pdfDoc) return;

  // pick section by current page, or dropdown if user selected
  let idx = currentSectionIndex;
  const filterVal = sectionFilter?.value || "ALL";
  if (filterVal !== "ALL") {
    const n = Number(filterVal);
    if (!Number.isNaN(n)) idx = n;
  }
  if (idx < 0 || !sectionRanges[idx]) {
    await readCurrentPage();
    return;
  }

  const s = sectionRanges[idx];

  // Safety: don’t read 200 pages in one go
  const maxPages = 6;
  const end = Math.min(s.end, s.start + maxPages - 1);

  let combined = `Section: ${s.title}. Pages ${s.start} to ${end}. `;
  for (let p = s.start; p <= end; p++) {
    const t = await getPageText(p);
    if (t) combined += " " + t;
    await sleep(0);
  }

  await speakText(combined.trim());
}

async function readSearchHits() {
  if (!lastSearchHits.length) return;

  let combined = `Reading ${Math.min(lastSearchHits.length, 12)} search hits. `;
  const limit = Math.min(lastSearchHits.length, 12);
  for (let i = 0; i < limit; i++) {
    const h = lastSearchHits[i];
    combined += ` Hit ${i + 1}, page ${h.page}. ${h.context}. `;
  }
  await speakText(combined.trim());
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
      // Optional: auto-ask
      // handleAsk();
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
// "Ask" (Local mode placeholder)
// =====================================================
function handleAsk() {
  const q = (askInput?.value || "").trim();
  if (!q) return;

  const info = pdfDoc ? `PDF: ${currentPdfName || currentPdfId || ""}\nPage: ${pageNum}/${pageCount}\n` : "";
  const msg =
    `Local-only mode ✅\n\n` +
    `${info}\n` +
    `Question:\n${q}\n\n` +
    `Next step (later): connect cloud AI + citations.\n\n` +
    `Safety: Always verify in the official POH/AFM.`;

  if (askOutput) askOutput.textContent = msg;
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
    standardFontDataUrl: "/standard_fonts/", // ok even if folder missing
  });

  pdfDoc = await task.promise;

  pageCount = pdfDoc.numPages;
  pageNum = 1;

  pageTextCache.clear();
  clearSearchUI();

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

  // clone for DB vs pdf.js
  const bufferForDb = buffer.slice(0);
  const bytesForPdf = new Uint8Array(buffer.slice(0));

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
}

async function restoreLastPdfOnStartup() {
  try {
    const rec = await getLastPdfFromLibrary();
    if (!rec?.buffer) return;

    currentPdfId = rec.id;
    currentPdfName = rec.name || "";

    await refreshLibrarySelectUI();

    await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });

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
// Feedback (where to type)
// =====================================================
async function copyFeedbackFlow() {
  // You type feedback here:
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

    // If you deleted the currently open PDF, leave it open (rendered), but it won’t be in library anymore.
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
  stopTts();
});

if (micBtn) {
  micBtn.disabled = false; // enabled if supported; setup will disable if not
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
  // Ask should always be usable
  enableCoreInputs();

  // Disable PDF dependent stuff until a PDF is loaded/restored
  enablePdfDependentControls(false);
  setPageInfo();

  // Voices can load async
  if ("speechSynthesis" in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  // Load library dropdown
  await refreshLibrarySelectUI();

  // Restore last PDF if present
  await restoreLastPdfOnStartup();

  // Update mic status
  setMicStatus("Mic ready. Hold to talk.");
});

// =====================================================
// Small safety: cancel search if user loads another PDF fast
// =====================================================
function cancelSearch() {
  searchCancelToken.cancel = true;
}
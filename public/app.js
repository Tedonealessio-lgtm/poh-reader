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

// ----- library API -----
async function savePdfToLibrary({ id, name, size, lastModified, buffer }) {
  if (!id) throw new Error("savePdfToLibrary: missing id");

  await idbPut(STORE_PDFS, {
    id,
    name,
    size,
    lastModified,
    buffer, // ArrayBuffer (structured clone)
    savedAt: Date.now(),
  });

  await idbPut(STORE_META, { key: "lastPdfId", value: id });
  return id;
}

async function loadPdfFromLibrary(id) {
  return await idbGet(STORE_PDFS, id);
}

async function getLastPdfFromLibrary() {
  const meta = await idbGet(STORE_META, "lastPdfId");
  if (!meta?.value) return null;
  return await loadPdfFromLibrary(meta.value);
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

// =====================================================
// UI refs
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

const askOutput = $("answer");
const ttsStatus = $("ttsStatus");

// Mic
const micBtn = $("micBtn");
const micStatus = $("micStatus");

// =====================================================
// State
// =====================================================
let pdfDoc = null;
let pageNum = 1;
let pageCount = 0;
let renderTask = null;
let currentPdfId = null;

// =====================================================
// Helpers
// =====================================================
function setStatus(text) {
  if (ttsStatus) ttsStatus.textContent = text;
}

function setControlsEnabled(enabled) {
  if (prevBtn) prevBtn.disabled = !enabled;
  if (nextBtn) nextBtn.disabled = !enabled;

  // library controls should always work
  if (openFromLibraryBtn) openFromLibraryBtn.disabled = false;
  if (deleteFromLibraryBtn) deleteFromLibraryBtn.disabled = false;
  if (clearLibraryBtn) clearLibraryBtn.disabled = false;

  if (!enabled && pageInfo) pageInfo.textContent = "Page: – / –";
}

function isRenderingCancelled(err) {
  return (
    err &&
    (err.name === "RenderingCancelledException" ||
      String(err.message || err).includes("Rendering cancelled"))
  );
}

async function cancelOngoingRender() {
  if (renderTask) {
    try {
      renderTask.cancel();
      await renderTask.promise.catch(() => {});
    } catch {}
    renderTask = null;
  }
}

// =====================================================
// Rendering
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

  if (pageInfo) pageInfo.textContent = `Page: ${pageNum}/${pageCount}`;
}

function goToPage(p) {
  if (!pdfDoc) return;
  pageNum = Math.max(1, Math.min(pageCount, p));
  renderPage(pageNum);
}

// =====================================================
// PDF Loading (robust + iOS friendly)
// =====================================================
async function loadPdfFromBytes(bytesOrBuffer) {
  const data =
    bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : new Uint8Array(bytesOrBuffer);

  const task = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: "/standard_fonts/",
  });

  pdfDoc = await task.promise;

  pageCount = pdfDoc.numPages;
  pageNum = 1;

  setControlsEnabled(true);
  await renderPage(pageNum);

  if (askOutput) {
    askOutput.textContent =
      `Loaded ✅\n\n${currentPdfId || ""}\n\nSafety: Always verify in the official POH/AFM.`;
  }
}

async function openWithRetries(bytesOrBuffer, { tries = 3, delayMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await loadPdfFromBytes(bytesOrBuffer);
      return;
    } catch (err) {
      if (isRenderingCancelled(err)) return;
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("openWithRetries failed:", lastErr);
  throw lastErr;
}

async function loadPdfFromFileAndSave(file) {
  currentPdfId = `${file.name}_${file.size}_${file.lastModified}`;

  const buffer = await file.arrayBuffer();

  // clone for DB (pdf.js may detach/consume buffers)
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

  await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });
}

async function restoreLastPdfOnStartup() {
  try {
    const rec = await getLastPdfFromLibrary();
    if (!rec?.buffer) return;

    currentPdfId = rec.id;
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
    setControlsEnabled(false);
    if (pageInfo) pageInfo.textContent = "Loading…";

    await loadPdfFromFileAndSave(file);
  } catch (err) {
    console.error(err);
    alert("Failed to load PDF. Check Console.");
    setControlsEnabled(false);
  }
});

prevBtn?.addEventListener("click", async () => {
  if (!pdfDoc || pageNum <= 1) return;
  pageNum -= 1;
  await renderPage(pageNum);
});

nextBtn?.addEventListener("click", async () => {
  if (!pdfDoc || pageNum >= pageCount) return;
  pageNum += 1;
  await renderPage(pageNum);
});

openFromLibraryBtn?.addEventListener("click", async () => {
  const id = librarySelect?.value;
  if (!id) return;

  try {
    const rec = await loadPdfFromLibrary(id);
    if (!rec?.buffer) return;

    currentPdfId = rec.id;
    await openWithRetries(rec.buffer, { tries: 3, delayMs: 250 });

    if (askOutput) askOutput.textContent = `Opened ✅\n\n${rec.name}`;
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
    console.log("[DELETE] deleting id:", id);
    await deletePdfFromLibrary(id);
    await refreshLibrarySelectUI();

    // If you deleted the currently-open pdf, clear viewer state
    if (currentPdfId === id) {
      currentPdfId = null;
      pdfDoc = null;
      pageNum = 1;
      pageCount = 0;
      setControlsEnabled(false);
    }

    alert("PDF deleted ✅");
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

    currentPdfId = null;
    pdfDoc = null;
    pageNum = 1;
    pageCount = 0;
    setControlsEnabled(false);

    alert("Library cleared ✅");
  } catch (err) {
    console.error(err);
    alert("Clear failed. Check Console.");
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  await refreshLibrarySelectUI();
  await restoreLastPdfOnStartup();
  setControlsEnabled(!!pdfDoc);
});

// =====================================================
// 🎙 Hold-to-talk Mic (iOS-friendly)
// =====================================================
let recognition = null;
let micReady = false;
let isHolding = false;

function setMicStatus(text) {
  if (micStatus) micStatus.textContent = text;
}

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
  recognition.continuous = false; // iOS safe

  recognition.onstart = () => setMicStatus("Listening…");
  recognition.onend = () => setMicStatus("Mic ready. Hold to talk.");
  recognition.onerror = (e) => {
    setMicStatus(`Mic error: ${e?.error || "unknown"}`);
  };

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    transcript = transcript.trim();
    if (!transcript) return;

    const last = event.results[event.results.length - 1];
    if (last.isFinal) {
      console.log("[VOICE]", transcript);
      setMicStatus(`Heard: "${transcript}"`);
      // Later: route into your Ask/commands
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
  } catch {
    // Safari throws if called twice quickly
  }
}

function stopListening() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch {}
}

if (micBtn) {
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

setMicStatus("Mic ready. Hold to talk.");
/* PhotoPick — main app. Browse media off a local folder, shortlist picks,
   export a filename list or copy the picks into a new folder. 100% local. */
import { isSupported, pickSourceDir, pickDestDir, scanDir, scanFileList, transferItems, ensureWritable, getItemFile, extOf } from "./fs.js";
import { readExif, extractEmbeddedJpeg } from "./exif.js";
import { buildZip } from "./zip.js";

const $ = (s, r = document) => r.querySelector(s);

/* ---- HEIC support (lazy-loaded heic2any, exposes window.heic2any) ---- */
const isHeic = (name) => /\.(heic|heif)$/i.test(name);
let heicLoad = null;
function loadHeic() {
  if (window.heic2any) return Promise.resolve();
  if (!heicLoad) heicLoad = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "lib/heic2any.min.js";
    s.onload = res; s.onerror = () => { heicLoad = null; rej(new Error("heic decoder failed to load")); };
    document.head.appendChild(s);
  });
  return heicLoad;
}
async function heicToJpeg(blob) {
  await loadHeic();
  const out = await window.heic2any({ blob, toType: "image/jpeg", quality: 0.85 });
  return Array.isArray(out) ? out[0] : out;
}

/* ---- splash ---- */
(function splash() {
  const el = $("#splash");
  if (!el) return;
  try { sessionStorage.setItem("photopick:splashed", "1"); } catch {}
  const hide = () => { el.style.transition = "opacity .35s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 400); };
  el.addEventListener("click", hide);
  setTimeout(hide, 2200);
})();

$("#year").textContent = new Date().getFullYear();

/* PhotoPick ships no service worker (removed — it only added offline/PWA extras and
   caused stale builds). Actively clean up any worker + cache left on returning visitors. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => k.startsWith("photopick") && caches.delete(k))).catch(() => {});
}

/* ---- state ---- */
const state = {
  dirHandle: null,
  canCopy: false,
  items: [],                 // {id,name,path,kind,handle}
  meta: new Map(),           // id -> {size,mtime,dateTaken,make,model,orientation,w,h}
  thumbs: new Map(),         // id -> objectURL (small)
  failed: new Set(),         // ids whose thumb couldn't render
  picked: new Set(),         // ids
  filter: "all",
  search: "",
  sort: "date",
  thumbsize: "s",
  view: [],                  // current filtered+sorted items
  cursor: -1,                // keyboard cursor into view
};

/* ---- elements ---- */
const els = {
  appbar: $("#appbar"),
  footer: $("#site-footer"),
  unsupported: $("#unsupported"),
  picker: $("#picker"),
  workbench: $("#workbench"),
  filtersEl: $("#filters"),
  grid: $("#grid"),
  gridEmpty: $("#grid-empty"),
  scanning: $("#scanning"),
  scanText: $("#scan-text"),
  folderName: $("#folder-name"),
  search: $("#search"),
  sort: $("#sort"),
  thumbsize: $("#thumbsize"),
  pickStatus: $("#pick-status"),
};

/* ---- capabilities ---- */
// FS Access API → full features incl. native copy-to-folder (Chrome/Edge/Brave/Opera).
// Fallback → <input webkitdirectory> reads any local folder in every browser;
// picks are exported as a .zip instead of a native copy.
const FS_ACCESS = isSupported();
const DIR_INPUT = "webkitdirectory" in document.createElement("input");
const dirInput = $("#dir-input");

$("#pick-btn").addEventListener("click", openFolder);
$("#pick-btn-2")?.addEventListener("click", openFolder);
dirInput.addEventListener("change", () => {
  if (dirInput.files && dirInput.files.length) openViaInput(dirInput.files);
  dirInput.value = ""; // allow re-picking the same folder later
});

function openFolder() {
  if (FS_ACCESS) return openViaFsAccess();
  if (DIR_INPUT) return dirInput.click();
  showUnsupported();
}

function showUnsupported() {
  $("#unsupported-msg").innerHTML = window.isSecureContext
    ? `Your browser can’t open local folders. Please use <strong>desktop Chrome, Edge, Brave, Opera, Firefox, or Safari</strong>.`
    : `PhotoPick needs a <strong>secure context</strong> to open local folders. Open it over <strong>https</strong> or <strong>http://localhost</strong> — a <code>file://</code> path or a LAN IP address won’t work.`;
  els.unsupported.hidden = false;
  els.picker.hidden = true;
  els.unsupported.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---- open + scan a folder ---- */
async function openViaFsAccess() {
  let handle;
  try { handle = await pickSourceDir(); }
  catch { return; } // user cancelled
  state.dirHandle = handle;
  state.canCopy = true;
  enterWorkbench(handle.name || "folder");
  els.scanText.textContent = "Scanning folder…";
  try {
    state.items = await scanDir(handle, (n) => { els.scanText.textContent = `Scanning… ${n} files`; });
  } catch {
    els.scanText.textContent = "Couldn’t read that folder. Try again.";
    return;
  }
  finishLoad();
}

function openViaInput(fileList) {
  state.dirHandle = null;
  state.canCopy = false; // no write-back handle in fallback mode → ZIP export instead
  const top = (fileList[0]?.webkitRelativePath || "").split("/")[0];
  enterWorkbench(top || "folder");
  state.items = scanFileList(fileList);
  finishLoad();
}

function enterWorkbench(name) {
  els.folderName.textContent = name;
  els.picker.hidden = true;
  els.unsupported.hidden = true;
  if (els.appbar) els.appbar.hidden = true;
  if (els.footer) els.footer.hidden = true;
  document.body.classList.add("in-workbench");
  els.workbench.hidden = false;
  els.grid.dataset.view = els.grid.dataset.view || "grid";
  els.grid.dataset.size = state.thumbsize;
  resetForNewScan();
  els.scanning.hidden = false;
  els.scanText.textContent = "Reading folder…";
  $("#write-note").hidden = true;
}

function finishLoad() {
  els.scanning.hidden = true;
  updateCounts();
  applyView();
  loadMetaInBackground();
}

function resetForNewScan() {
  for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
  state.items = []; state.meta.clear(); state.thumbs.clear();
  state.failed.clear(); state.picked.clear();
  state.cursor = -1; state.search = ""; els.search.value = "";
  els.grid.innerHTML = "";
  updatePickStatus();
}

/* ---- background metadata pass (size + modified time; cheap, no content read) ---- */
async function loadMetaInBackground() {
  const queue = state.items.slice();
  let active = 0, i = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (i >= queue.length && active === 0) { resolve(); return; }
      while (active < 6 && i < queue.length) {
        const it = queue[i++];
        active++;
        getItemFile(it).then((f) => {
          const m = state.meta.get(it.id) || {};
          m.size = f.size; m.mtime = f.lastModified;
          state.meta.set(it.id, m);
        }).catch(() => {}).finally(() => { active--; refreshTileMeta(it.id); next(); });
      }
    };
    next();
  });
}

/* ---- filtering / sorting / view ---- */
function matchesFilter(it) {
  if (state.filter === "picked") return state.picked.has(it.id);
  if (state.filter === "all") return true;
  return it.kind === state.filter;
}

function applyView() {
  const q = state.search.trim().toLowerCase();
  let v = state.items.filter((it) => matchesFilter(it) && (!q || it.name.toLowerCase().includes(q)));
  const key = state.sort;
  v.sort((a, b) => {
    if (key === "name") return cmpName(a, b);
    const ma = state.meta.get(a.id) || {}, mb = state.meta.get(b.id) || {};
    if (key === "size") return (mb.size || 0) - (ma.size || 0) || cmpName(a, b);
    if (key === "mtime") return (mb.mtime || 0) - (ma.mtime || 0) || cmpName(a, b);
    if (key === "date") return ((mb.dateTaken || mb.mtime || 0) - (ma.dateTaken || ma.mtime || 0)) || cmpName(a, b);
    return 0;
  });
  state.view = v;
  renderGrid();
}

function cmpName(a, b) { return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }); }

/* ---- grid render ---- */
let io; // IntersectionObserver for lazy thumbs
function renderGrid() {
  els.grid.innerHTML = "";
  if (io) io.disconnect();
  els.grid.dataset.size = state.thumbsize;
  els.gridEmpty.hidden = state.view.length > 0;

  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { ensureThumb(e.target.dataset.id, e.target); io.unobserve(e.target); }
    }
  }, { root: null, rootMargin: "600px 0px" });

  const frag = document.createDocumentFragment();
  state.view.forEach((it, idx) => {
    const tile = document.createElement("div");
    tile.className = "tile" + (state.picked.has(it.id) ? " is-picked" : "");
    tile.dataset.id = it.id;
    tile.dataset.idx = idx;
    tile.innerHTML = `
      <div class="tile__thumb"><div class="tile__ph" data-ext="${extOf(it.name).toUpperCase() || "FILE"}"></div></div>
      <button class="tile__star" title="Pick (space)" aria-label="Pick">★</button>
      ${it.kind === "video" ? '<span class="tile__badge">▶</span>' : it.kind === "raw" ? '<span class="tile__badge tile__badge--raw">RAW</span>' : ""}
      <div class="tile__foot"><span class="tile__name">${escapeHtml(it.name)}</span><span class="tile__sub"></span></div>`;
    tile.querySelector(".tile__star").addEventListener("click", (e) => { e.stopPropagation(); togglePick(it.id); });
    tile.addEventListener("click", () => openLightbox(idx));
    frag.appendChild(tile);
    io.observe(tile);
  });
  els.grid.appendChild(frag);
  state.view.forEach((it) => refreshTileMeta(it.id));
}

function tileEl(id) { return els.grid.querySelector(`.tile[data-id="${cssEsc(id)}"]`); }

function refreshTileMeta(id) {
  const t = tileEl(id);
  if (!t) return;
  const m = state.meta.get(id) || {};
  const sub = t.querySelector(".tile__sub");
  if (sub) {
    const bits = [];
    if (m.size) bits.push(humanSize(m.size));
    const d = m.dateTaken || m.mtime;
    if (d) bits.push(shortDate(d));
    sub.textContent = bits.join(" · ");
  }
}

/* ---- lazy thumbnail generation with a small concurrency cap ---- */
let running = 0;
const waitQ = [];
function ensureThumb(id, tile) {
  if (state.thumbs.has(id)) { paintThumb(id, tile); return; }
  if (state.failed.has(id)) return;
  waitQ.push({ id, tile });
  pump();
}
function pump() {
  while (running < 5 && waitQ.length) {
    const { id, tile } = waitQ.shift();
    if (!document.body.contains(tile)) continue;
    running++;
    makeThumb(id).then(() => { paintThumb(id, tile); }).catch(() => { state.failed.add(id); })
      .finally(() => { running--; pump(); });
  }
}

async function makeThumb(id) {
  const it = state.items.find((x) => x.id === id) || byId(id);
  if (!it) throw 0;
  const file = await getItemFile(it);
  // cache size/mtime opportunistically
  const m = state.meta.get(id) || {};
  if (!m.size) { m.size = file.size; m.mtime = file.lastModified; state.meta.set(id, m); refreshTileMeta(id); }

  if (it.kind === "video") { await videoThumb(id, file); return; }

  let source = file, exifBlob = file, readMeta = true;
  if (it.kind === "raw") {
    const jpeg = await extractEmbeddedJpeg(file);
    if (!jpeg) throw 0; // no preview -> placeholder stays
    source = jpeg; exifBlob = jpeg;
  } else if (isHeic(it.name)) {
    source = await heicToJpeg(file); // decoder normalizes orientation already
    readMeta = false;               // HEIC EXIF isn't JPEG-APP1; skip (falls back to mtime)
  }
  // EXIF (orientation/date/camera) — best effort
  if (readMeta) {
    try {
      const ex = await readExif(exifBlob);
      Object.assign(m, ex); state.meta.set(id, m); refreshTileMeta(id);
    } catch {}
  }
  await imageThumb(id, source, m.orientation || 1);
}

async function imageThumb(id, blob, orientation) {
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch { throw 0; } // undecodable (e.g. HEIC in this browser)
  // report display (orientation-corrected) dimensions: EXIF 5–8 rotate 90°, swapping w/h
  const swap = orientation >= 5 && orientation <= 8;
  const m = state.meta.get(id) || {}; m.w = swap ? bmp.height : bmp.width; m.h = swap ? bmp.width : bmp.height; state.meta.set(id, m);
  const url = await bitmapToThumbUrl(bmp, orientation);
  bmp.close?.();
  state.thumbs.set(id, url);
}

async function videoThumb(id, file) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement("video");
    v.muted = true; v.preload = "metadata"; v.src = url;
    await new Promise((res, rej) => {
      v.onloadeddata = res; v.onerror = () => rej(0);
      setTimeout(() => rej(0), 8000);
    });
    const m = state.meta.get(id) || {}; m.w = v.videoWidth; m.h = v.videoHeight; m.dur = v.duration; state.meta.set(id, m);
    await new Promise((res) => { v.onseeked = res; try { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); } catch { res(); } setTimeout(res, 4000); });
    const bmp = await createImageBitmap(v);
    const turl = await bitmapToThumbUrl(bmp, 1);
    bmp.close?.();
    state.thumbs.set(id, turl);
  } finally { URL.revokeObjectURL(url); }
}

async function bitmapToThumbUrl(bmp, orientation) {
  const MAX = 480;
  const swap = orientation >= 5 && orientation <= 8;
  let w = bmp.width, h = bmp.height;
  const scale = Math.min(1, MAX / Math.max(w, h));
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = swap ? dh : dw; c.height = swap ? dw : dh;
  const ctx = c.getContext("2d");
  applyOrient(ctx, orientation, dw, dh);
  ctx.drawImage(bmp, 0, 0, dw, dh);
  const blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.82));
  return URL.createObjectURL(blob || new Blob());
}

function applyOrient(ctx, o, w, h) {
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
}

function paintThumb(id, tile) {
  const url = state.thumbs.get(id);
  if (!url || !tile) return;
  const box = tile.querySelector(".tile__thumb");
  if (!box) return;
  box.innerHTML = `<img loading="lazy" src="${url}" alt="">`;
}

/* ---- selection ---- */
function togglePick(id) {
  const nowPicked = !state.picked.has(id);
  if (nowPicked) state.picked.add(id); else state.picked.delete(id);
  const t = tileEl(id);
  if (t) { t.classList.toggle("is-picked", nowPicked); if (nowPicked) burst(t.querySelector(".tile__star")); }
  updateCounts(); updatePickStatus();
  if (state.filter === "picked") applyView();
}

function updatePickStatus() {
  const n = state.picked.size;
  if (!n) { els.pickStatus.textContent = "No picks yet"; return; }
  let bytes = 0, known = true;
  for (const id of state.picked) { const m = state.meta.get(id); if (m && m.size) bytes += m.size; else known = false; }
  els.pickStatus.textContent = `${n} pick${n > 1 ? "s" : ""}${bytes ? " · " + humanSize(bytes) + (known ? "" : "+") : ""}`;
}

function updateCounts() {
  let a = 0, img = 0, vid = 0, raw = 0;
  for (const it of state.items) { a++; if (it.kind === "image") img++; else if (it.kind === "video") vid++; else if (it.kind === "raw") raw++; }
  $("#c-all").textContent = a; $("#c-image").textContent = img;
  $("#c-video").textContent = vid; $("#c-raw").textContent = raw;
  $("#c-picked").textContent = state.picked.size;
  // sidebar collection counts
  const sl = $("#snav-lib"), sp = $("#snav-pk");
  if (sl) sl.textContent = a;
  if (sp) { sp.textContent = state.picked.size; sp.classList.toggle("is-empty", state.picked.size === 0); }
}

/* ---- toolbar wiring ---- */
function setFilter(name) {
  state.filter = name; state.cursor = -1;
  for (const x of els.filtersEl.querySelectorAll(".fbtn")) x.classList.toggle("on", x.dataset.filter === name);
  syncSideNav();
  applyView();
}
function syncSideNav() {
  const active = state.filter === "picked" ? "picks" : "library";
  for (const s of document.querySelectorAll(".snav")) {
    if (s.dataset.nav === "folders") continue;
    s.classList.toggle("on", s.dataset.nav === active);
  }
}
els.filtersEl.addEventListener("click", (e) => {
  const b = e.target.closest(".fbtn"); if (!b) return;
  setFilter(b.dataset.filter);
});
/* sidebar collections: Library → all, Picks → picked, Folders → open another folder */
$("#side-nav")?.addEventListener("click", (e) => {
  const b = e.target.closest(".snav"); if (!b) return;
  if (b.dataset.nav === "folders") { openFolder(); return; }
  setFilter(b.dataset.nav === "picks" ? "picked" : "all");
});
/* grid / list view toggle */
$("#view-toggle")?.addEventListener("click", (e) => {
  const b = e.target.closest(".seg"); if (!b) return;
  for (const s of e.currentTarget.querySelectorAll(".seg")) s.classList.toggle("on", s === b);
  els.grid.dataset.view = b.dataset.view;
});
$("#import-btn")?.addEventListener("click", openFolder);
els.search.addEventListener("input", () => { state.search = els.search.value; applyView(); });
els.sort.addEventListener("change", () => { state.sort = els.sort.value; applyView(); });
els.thumbsize.addEventListener("change", () => { state.thumbsize = els.thumbsize.value; els.grid.dataset.size = state.thumbsize; });
$("#change-btn").addEventListener("click", openFolder);

$("#sel-all").addEventListener("click", () => {
  for (const it of state.view) state.picked.add(it.id);
  updateCounts(); updatePickStatus();
  if (state.filter === "picked") applyView();
  else for (const it of state.view) { const t = tileEl(it.id); if (t) t.classList.add("is-picked"); }
});
$("#sel-none").addEventListener("click", () => {
  state.picked.clear(); updateCounts(); updatePickStatus();
  if (state.filter === "picked") applyView();
  else for (const t of els.grid.querySelectorAll(".tile.is-picked")) t.classList.remove("is-picked");
});

/* ---- exports ---- */
$("#exp-txt").addEventListener("click", () => {
  const items = pickedItems(); if (!warnEmpty(items)) return;
  download(items.map((it) => it.path).join("\n") + "\n", "photopick-selection.txt", "text/plain");
});
$("#exp-csv").addEventListener("click", () => {
  const items = pickedItems(); if (!warnEmpty(items)) return;
  const rows = [["path", "name", "kind", "size_bytes", "modified", "date_taken", "camera"]];
  for (const it of items) {
    const m = state.meta.get(it.id) || {};
    rows.push([it.path, it.name, it.kind, m.size || "",
      m.mtime ? new Date(m.mtime).toISOString() : "",
      m.dateTaken ? new Date(m.dateTaken).toISOString() : "",
      [m.make, m.model].filter(Boolean).join(" ")]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  download(csv, "photopick-selection.csv", "text/csv");
});
$("#exp-copy").addEventListener("click", () => transfer(false));
$("#exp-move").addEventListener("click", () => transfer(true));

async function transfer(move) {
  const items = pickedItems(); if (!warnEmpty(items)) return;
  if (!FS_ACCESS) { showWriteHelp(); return; }

  // Pick the destination FIRST, while the click's user activation is still valid.
  // showDirectoryPicker() needs a user gesture; running confirm()/requestPermission()
  // before it consumes that gesture and the picker silently fails (that was the Move bug).
  let dest;
  try { dest = await pickDestDir(); }
  catch { return; } // user cancelled or the browser blocked it

  if (move && !confirm(`Move ${items.length} file${items.length > 1 ? "s" : ""} into “${dest.name}”?\nThe originals will be deleted from the source folder after they’re copied.`)) return;

  // A move also needs write access on the SOURCE folder to delete the originals.
  // If we can't get it, fall back to a plain copy (originals kept) rather than doing nothing.
  const canDelete = move ? await ensureWritable(state.dirHandle) : false;
  const doMove = move && canDelete;

  const verb = doMove ? "Moving" : "Copying";
  els.pickStatus.textContent = `${verb} 0/${items.length}…`;
  const res = await transferItems(items, dest, { move: doMove, sourceRoot: state.dirHandle },
    (done, total) => { els.pickStatus.textContent = `${verb} ${done}/${total}…`; });

  if (doMove && res.movedIds.length) removeMovedItems(res.movedIds);
  const extra = (res.renamed ? ` · ${res.renamed} renamed` : "") + (res.failed ? ` · ${res.failed} failed` : "");
  els.pickStatus.textContent = doMove
    ? `Moved ${res.deleted} to “${dest.name}”` + (res.ok > res.deleted ? ` · ${res.ok - res.deleted} copied, original kept` : "") + extra
    : move
      ? `Copied ${res.ok} to “${dest.name}” · originals kept (couldn’t get delete access)` + extra
      : `Copied ${res.ok} to “${dest.name}”` + extra;
}

function showWriteHelp() {
  const brave = navigator.brave || /\bBrave\b/.test(navigator.userAgent);
  const note = $("#write-note");
  note.innerHTML =
    `Copying or moving files into a folder needs the browser’s <strong>File System Access API</strong>, which your browser blocks. ` +
    (brave
      ? `Brave disables it by default — turn it on at <code>brave://flags/#file-system-access-api</code> → <strong>Enabled</strong>, then relaunch. `
      : `Use <strong>Chrome, Edge, Brave, or Opera</strong>. `) +
    `Or just use <strong>Download picks (.zip)</strong> and extract it wherever you want — same result, no permissions.`;
  note.hidden = false;
  els.pickStatus.textContent = "Copy/Move needs folder-write access →";
}

/* After a move, the originals are gone from the source — drop them from state. */
function removeMovedItems(ids) {
  const gone = new Set(ids);
  for (const id of ids) { const u = state.thumbs.get(id); if (u) URL.revokeObjectURL(u); state.thumbs.delete(id); state.picked.delete(id); state.meta.delete(id); }
  state.items = state.items.filter((it) => !gone.has(it.id));
  updateCounts(); updatePickStatus(); applyView();
}

$("#exp-zip").addEventListener("click", async () => {
  const items = pickedItems(); if (!warnEmpty(items)) return;
  const btn = $("#exp-zip"); btn.disabled = true;
  try {
    const used = new Set();
    const entries = [];
    for (const it of items) {
      const blob = await getItemFile(it);
      let name = it.name;
      if (used.has(name.toLowerCase())) name = uniqueZipName(it.name, used);
      used.add(name.toLowerCase());
      entries.push({ name, blob });
    }
    els.pickStatus.textContent = `Zipping 0/${entries.length}…`;
    const zip = await buildZip(entries, (done, total) => { els.pickStatus.textContent = `Zipping ${done}/${total}…`; });
    download(zip, "photopick-selection.zip");
    els.pickStatus.textContent = `Zipped ${entries.length} pick${entries.length > 1 ? "s" : ""} · ${humanSize(zip.size)}`;
  } catch {
    els.pickStatus.textContent = "Couldn’t build the zip (selection too large?)";
  } finally { btn.disabled = false; }
});

function uniqueZipName(name, used) {
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? "" : name.slice(dot);
  let n = 2, c;
  do { c = `${stem} (${n++})${ext}`; } while (used.has(c.toLowerCase()));
  return c;
}

function pickedItems() {
  const set = state.picked;
  return state.items.filter((it) => set.has(it.id)).sort(cmpName);
}
function warnEmpty(items) {
  if (items.length) return true;
  els.pickStatus.textContent = "Pick some photos first ★";
  return false;
}

/* ---- lightbox ---- */
const lb = {
  el: $("#lightbox"), stage: $("#lb-stage"), exif: $("#lb-exif"), strip: $("#lb-strip"),
  name: $("#lb-name"), count: $("#lb-count"), pick: $("#lb-pick"),
  idx: -1, url: null, token: 0, showExif: true,
  zoom: 1, panX: 0, panY: 0, dragging: false, sx: 0, sy: 0,
};

/* ---- zoom / pan for the preview stage ---- */
function lbMedia() { return lb.stage.querySelector("img, video"); }
function applyZoom() {
  const el = lbMedia(); if (!el) return;
  el.style.transition = lb.dragging ? "none" : "transform .12s ease";
  el.style.transform = `translate(${lb.panX}px, ${lb.panY}px) scale(${lb.zoom})`;
  lb.stage.classList.toggle("zoomed", lb.zoom > 1);
  lb.stage.classList.toggle("grabbing", lb.dragging);
}
function setZoom(z) {
  lb.zoom = Math.min(6, Math.max(1, +z.toFixed(3)));
  if (lb.zoom === 1) { lb.panX = 0; lb.panY = 0; }
  applyZoom();
}
function resetZoom() { lb.zoom = 1; lb.panX = 0; lb.panY = 0; lb.dragging = false; }

/* replay the pick-burst animation on a star element (springy pop + ripple + sparkles) */
function burst(el) {
  if (!el) return;
  el.classList.remove("pick-burst");
  void el.offsetWidth; // force reflow so the animation restarts even on rapid re-picks
  el.classList.add("pick-burst");
  // radial sparkle particles
  el.querySelector(".pick-spark")?.remove();
  const spark = document.createElement("span");
  spark.className = "pick-spark";
  const N = 9;
  for (let i = 0; i < N; i++) {
    const a = (Math.PI * 2 * i) / N;
    const p = document.createElement("i");
    p.style.setProperty("--dx", Math.cos(a).toFixed(3));
    p.style.setProperty("--dy", Math.sin(a).toFixed(3));
    spark.appendChild(p);
  }
  el.appendChild(spark);
  setTimeout(() => { el.classList.remove("pick-burst"); spark.remove(); }, 700);
}
function openLightbox(idx) {
  lb.idx = idx; lb.el.hidden = false;
  lb.el.classList.toggle("no-panel", !lb.showExif);
  $("#lb-info").classList.toggle("is-active", lb.showExif);
  renderStrip(); renderLightbox();
  document.addEventListener("keydown", lbKeys);
}
function closeLightbox() {
  lb.el.hidden = true; document.removeEventListener("keydown", lbKeys);
  if (lb.url) { URL.revokeObjectURL(lb.url); lb.url = null; }
  lb.stage.innerHTML = ""; lb.strip.innerHTML = "";
}
async function renderLightbox() {
  const it = state.view[lb.idx]; if (!it) return closeLightbox();
  const token = ++lb.token;
  resetZoom();
  if (lb.url) { URL.revokeObjectURL(lb.url); lb.url = null; }
  lb.stage.innerHTML = '<div class="lb__loading"><span class="spin"></span></div>';
  lb.name.textContent = it.name;
  lb.count.textContent = `${lb.idx + 1} of ${state.view.length}`;
  lb.pick.classList.toggle("on", state.picked.has(it.id));
  updateExif(it);
  highlightStrip();
  try {
    const file = await getItemFile(it);
    if (token !== lb.token) return; // a newer navigation superseded this render
    if (it.kind === "video") {
      lb.url = URL.createObjectURL(file);
      lb.stage.innerHTML = `<video src="${lb.url}" controls autoplay playsinline></video>`;
    } else {
      let blob = file;
      if (it.kind === "raw") { blob = await extractEmbeddedJpeg(file) || null; }
      else if (isHeic(it.name)) { try { blob = await heicToJpeg(file); } catch { blob = null; } }
      if (token !== lb.token) return;
      if (!blob) { lb.stage.innerHTML = `<div class="lb__none">${it.kind === "raw" ? "No embedded preview for this RAW file." : "Couldn’t decode this photo."}<br><small>${escapeHtml(it.name)}</small></div>`; return; }
      lb.url = URL.createObjectURL(blob);
      const img = new Image(); img.src = lb.url; img.alt = it.name; img.draggable = false;
      img.onload = () => { if (token === lb.token) { lb.stage.innerHTML = ""; lb.stage.appendChild(img); } };
      img.onerror = () => { if (token === lb.token) lb.stage.innerHTML = `<div class="lb__none">Can’t preview this file here.<br><small>${escapeHtml(it.name)}</small></div>`; };
    }
  } catch { if (token === lb.token) lb.stage.innerHTML = `<div class="lb__none">Couldn’t open this file.</div>`; }
}

/* folder location of an item, relative to the picked folder: "/" for root, "/sub/dir" otherwise */
function folderPath(it) {
  const parts = it.path.split("/");
  parts.pop();                                   // drop the filename
  if (!state.dirHandle && parts.length) parts.shift(); // fallback paths include the root folder name — drop it
  return "/" + parts.join("/");
}

function updateExif(it) {
  const m = state.meta.get(it.id) || {};
  const rows = [];
  const add = (label, val) => { if (val) rows.push(`<div class="exif-row"><span>${label}</span><b>${escapeHtml(String(val))}</b></div>`); };
  add("Path", folderPath(it));
  if (m.w && m.h) add("Dimensions", `${m.w} × ${m.h}`);
  add("Size", m.size ? humanSize(m.size) : "");
  add("Shutter", m.exposure);
  add("Aperture", m.fnumber);
  add("ISO", m.iso);
  add("Focal", m.focal);
  add("Camera", [m.make, m.model].filter(Boolean).join(" "));
  const d = m.dateTaken || m.mtime;
  add("Captured", d ? fullDate(d) : "");
  add("Type", it.kind === "raw" ? "RAW" : it.kind === "video" ? "Video" : "Photo");
  lb.exif.innerHTML = rows.join("") || `<div class="exif-row"><span>Info</span><b>Reading…</b></div>`;
}

/* filmstrip: a window of neighbouring thumbnails around the current photo */
function renderStrip() {
  const total = state.view.length;
  const half = 24;
  const start = Math.max(0, Math.min(lb.idx - half, total - half * 2 - 1));
  const end = Math.min(total, Math.max(lb.idx + half + 1, half * 2 + 1));
  const frag = document.createDocumentFragment();
  for (let i = Math.max(0, start); i < end; i++) {
    const it = state.view[i];
    const cell = document.createElement("button");
    cell.className = "lb__cell" + (i === lb.idx ? " on" : "") + (state.picked.has(it.id) ? " picked" : "");
    cell.dataset.idx = i;
    const url = state.thumbs.get(it.id);
    if (url) cell.style.backgroundImage = `url("${url}")`;
    else cell.classList.add("lb__cell--ph");
    cell.addEventListener("click", () => { lb.idx = i; renderStrip(); renderLightbox(); });
    frag.appendChild(cell);
  }
  lb.strip.innerHTML = ""; lb.strip.appendChild(frag);
  const cur = lb.strip.querySelector(".lb__cell.on");
  if (cur) cur.scrollIntoView({ inline: "center", block: "nearest" });
}
function highlightStrip() {
  const cells = lb.strip.querySelectorAll(".lb__cell");
  for (const c of cells) {
    const it = state.view[+c.dataset.idx];
    const on = +c.dataset.idx === lb.idx;
    c.classList.toggle("on", on);
    c.classList.toggle("picked", !!(it && state.picked.has(it.id)));
    // fill in a thumb if it has since been generated
    if (!c.style.backgroundImage) { const u = state.thumbs.get(it?.id); if (u) { c.style.backgroundImage = `url("${u}")`; c.classList.remove("lb__cell--ph"); } }
    if (on) c.scrollIntoView({ inline: "center", block: "nearest" });
  }
}

function lbStep(d) {
  const n = lb.idx + d;
  if (n < 0 || n >= state.view.length) return;
  lb.idx = n;
  // keep the strip window centred, else just re-highlight
  const inWindow = lb.strip.querySelector(`.lb__cell[data-idx="${n}"]`);
  if (inWindow) highlightStrip(); else renderStrip();
  renderLightbox();
}
function lbTogglePick() {
  const it = state.view[lb.idx]; if (!it) return;
  togglePick(it.id);
  const on = state.picked.has(it.id);
  lb.pick.classList.toggle("on", on);
  if (on) burst(lb.pick);
  const cell = lb.strip.querySelector(`.lb__cell[data-idx="${lb.idx}"]`);
  if (cell) cell.classList.toggle("picked", on);
}
function lbKeys(e) {
  const k = e.key.toLowerCase();
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowRight") lbStep(1);
  else if (e.key === "ArrowLeft") lbStep(-1);
  else if (e.key === " " || k === "p" || k === "s") { e.preventDefault(); lbTogglePick(); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(lb.zoom + 0.5); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(lb.zoom - 0.5); }
  else if (e.key === "0") { e.preventDefault(); setZoom(1); }
  else if (k === "i") { e.preventDefault(); $("#lb-info").click(); }
}
$("#lb-close").addEventListener("click", closeLightbox);
$("#lb-grid").addEventListener("click", closeLightbox);
$("#lb-prev").addEventListener("click", () => lbStep(-1));
$("#lb-next").addEventListener("click", () => lbStep(1));
$("#lb-pick").addEventListener("click", lbTogglePick);
$("#lb-info").addEventListener("click", () => {
  lb.showExif = !lb.showExif;
  lb.el.classList.toggle("no-panel", !lb.showExif);
  $("#lb-info").classList.toggle("is-active", lb.showExif);
});
$("#lb-download").addEventListener("click", async () => {
  const it = state.view[lb.idx]; if (!it) return;
  try { const f = await getItemFile(it); download(f, it.name); } catch {}
});
lb.el.addEventListener("click", (e) => { if (e.target === lb.el) closeLightbox(); });

/* zoom controls */
$("#lb-zin").addEventListener("click", () => setZoom(lb.zoom + 0.5));
$("#lb-zout").addEventListener("click", () => setZoom(lb.zoom - 0.5));
lb.stage.addEventListener("wheel", (e) => {
  if (lb.el.hidden) return;
  e.preventDefault();
  setZoom(lb.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });
lb.stage.addEventListener("dblclick", () => setZoom(lb.zoom > 1 ? 1 : 2));
lb.stage.addEventListener("dragstart", (e) => e.preventDefault()); // block native image drag
lb.stage.addEventListener("pointerdown", (e) => {
  if (lb.zoom <= 1) return;
  e.preventDefault();
  lb.dragging = true; lb.sx = e.clientX - lb.panX; lb.sy = e.clientY - lb.panY;
  applyZoom();
  // window-level listeners so the drag keeps tracking even if the pointer leaves the image
  const move = (ev) => { lb.panX = ev.clientX - lb.sx; lb.panY = ev.clientY - lb.sy; applyZoom(); };
  const up = () => { lb.dragging = false; applyZoom(); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

/* ---- keyboard nav on the grid ---- */
els.grid.addEventListener("keydown", (e) => {
  if (!lb.el.hidden) return;            // lightbox is open — its own keys handle nav/pick
  if (!state.view.length) return;
  const cols = gridCols();
  let c = state.cursor < 0 ? 0 : state.cursor;
  if (e.key === "ArrowRight") c = Math.min(state.view.length - 1, c + 1);
  else if (e.key === "ArrowLeft") c = Math.max(0, c - 1);
  else if (e.key === "ArrowDown") c = Math.min(state.view.length - 1, c + cols);
  else if (e.key === "ArrowUp") c = Math.max(0, c - cols);
  else if (e.key === " ") { e.preventDefault(); if (state.cursor >= 0) togglePick(state.view[state.cursor].id); return; }
  else if (e.key === "Enter") { if (state.cursor >= 0) openLightbox(state.cursor); return; }
  else return;
  e.preventDefault(); setCursor(c);
});
function setCursor(c) {
  const prev = els.grid.querySelector(".tile.is-cursor"); if (prev) prev.classList.remove("is-cursor");
  state.cursor = c;
  const t = els.grid.children[c];
  if (t) { t.classList.add("is-cursor"); t.scrollIntoView({ block: "nearest" }); }
}
function gridCols() {
  const first = els.grid.children[0]; if (!first) return 1;
  const gw = els.grid.clientWidth, tw = first.getBoundingClientRect().width || gw;
  return Math.max(1, Math.round(gw / tw));
}

/* ---- hover-to-pick: hover a thumbnail and press S / F to star it (no click needed) ---- */
let hoverId = null;
els.grid.addEventListener("mouseover", (e) => { const t = e.target.closest(".tile"); if (t) hoverId = t.dataset.id; });
els.grid.addEventListener("mouseleave", () => { hoverId = null; });
document.addEventListener("keydown", (e) => {
  if (!lb.el.hidden) return;                    // lightbox owns its own keys
  if (els.workbench.hidden) return;             // only inside the gallery
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  const k = e.key.toLowerCase();
  if (k === "s" || k === "f") {
    const id = hoverId || (state.cursor >= 0 ? state.view[state.cursor]?.id : null);
    if (id) { e.preventDefault(); togglePick(id); }
  }
});

/* ---- utils ---- */
function byId(id) { return state.items.find((x) => x.id === id); }
function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function csvCell(v) { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function humanSize(b) { if (b < 1024) return b + " B"; const u = ["KB", "MB", "GB"]; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < 2); return b.toFixed(b < 10 ? 1 : 0) + " " + u[i]; }
function shortDate(t) { const d = new Date(t); return d.toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" }); }
function fullDate(t) { return new Date(t).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }

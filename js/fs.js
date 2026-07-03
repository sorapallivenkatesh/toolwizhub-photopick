/* PhotoPick — File System Access API helpers. Read a folder off any drive and
   write selected copies back into a new folder. All local; nothing is uploaded. */

const IMG = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif"]);
const RAW = new Set(["cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "dng", "pef", "raw", "3fr", "erf", "kdc", "dcr", "mrw", "x3f"]);
const VID = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "3gp", "mpg", "mpeg", "mts", "m2ts", "wmv", "flv"]);

export function isSupported() {
  return typeof window.showDirectoryPicker === "function";
}

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function kindOf(name) {
  const e = extOf(name);
  if (RAW.has(e)) return "raw";
  if (IMG.has(e)) return "image";
  if (VID.has(e)) return "video";
  return null;
}

/* Prompt for a source folder to browse. Requested read-write so that Copy/Move
   (which delete originals) work in a single gesture later — otherwise the write
   prompt can't appear after the destination picker consumes the user activation.
   If the user grants view-only, Move gracefully degrades to a copy. */
export async function pickSourceDir() {
  return window.showDirectoryPicker({ id: "photopick-src", mode: "readwrite" });
}

/* Prompt for a destination folder to copy picks into. */
export async function pickDestDir() {
  return window.showDirectoryPicker({ id: "photopick-dest", mode: "readwrite" });
}

/* Get a File for an item, whether it came from a directory handle (FS Access API)
   or from a <input webkitdirectory> FileList (fallback). */
export function getItemFile(it) {
  return it.file ? Promise.resolve(it.file) : it.handle.getFile();
}

const NOISE = /(^|\/)(\.[^/]|__MACOSX\/|\.Trashes\/|\$RECYCLE\.BIN\/|System Volume Information\/)/i;

/* Fallback: build the item list from a <input type=file webkitdirectory> FileList.
   Works in every browser but yields Files (no write-back handle). */
export function scanFileList(fileList) {
  const out = [];
  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    if (NOISE.test(rel)) continue;
    const kind = kindOf(file.name);
    if (!kind) continue;
    out.push({ id: rel, name: file.name, path: rel, kind, file });
  }
  return out;
}

/* Recursively walk a directory handle, yielding media entries. `onProgress`
   is called with the running count so the UI can show a live scan indicator. */
export async function scanDir(dirHandle, onProgress) {
  const out = [];
  let count = 0;
  async function walk(handle, prefix) {
    for await (const entry of handle.values()) {
      if (entry.kind === "directory") {
        // skip noise dirs some cameras/OSes scatter around
        if (/^(\.|__MACOSX$|\.Trashes$|\$RECYCLE\.BIN$|System Volume Information$)/i.test(entry.name)) continue;
        await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.kind === "file") {
        const kind = kindOf(entry.name);
        if (!kind) continue;
        out.push({
          id: (prefix ? prefix + "/" : "") + entry.name,
          name: entry.name,
          path: prefix ? `${prefix}/${entry.name}` : entry.name,
          kind,
          handle: entry,
        });
        if ((++count & 31) === 0 && onProgress) onProgress(count);
      }
    }
  }
  await walk(dirHandle, "");
  if (onProgress) onProgress(count);
  return out;
}

/* Ensure we hold readwrite permission on a directory handle (needed to delete
   originals for a move). Returns true if granted. */
export async function ensureWritable(dirHandle) {
  if (!dirHandle || !dirHandle.requestPermission) return false;
  const opts = { mode: "readwrite" };
  if ((await dirHandle.queryPermission(opts)) === "granted") return true;
  return (await dirHandle.requestPermission(opts)) === "granted";
}

/* Transfer a set of items into destDir. Flattens; on filename collision appends
   " (2)", " (3)" … When opts.move is set (and sourceRoot given), each file whose
   copy succeeds is then removed from the source tree. Returns
   {ok, failed, renamed, deleted, movedIds}. */
export async function transferItems(items, destDir, opts, onProgress) {
  const { move = false, sourceRoot = null } = opts || {};
  const used = new Set();
  let ok = 0, failed = 0, renamed = 0, deleted = 0;
  const movedIds = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const file = await getItemFile(it);
      let target = it.name;
      if (used.has(target.toLowerCase())) { target = uniqueName(it.name, used); renamed++; }
      used.add(target.toLowerCase());
      const fh = await destDir.getFileHandle(target, { create: true });
      const w = await fh.createWritable();
      await file.stream().pipeTo(w);
      ok++;
      if (move && sourceRoot && it.handle) {
        try { await removeByPath(sourceRoot, it.path); deleted++; movedIds.push(it.id); }
        catch { /* copy kept; original left in place */ }
      }
    } catch {
      failed++;
    }
    if (onProgress) onProgress(i + 1, items.length);
  }
  return { ok, failed, renamed, deleted, movedIds };
}

async function removeByPath(root, path) {
  const parts = path.split("/");
  let dir = root;
  for (let k = 0; k < parts.length - 1; k++) dir = await dir.getDirectoryHandle(parts[k]);
  await dir.removeEntry(parts[parts.length - 1]);
}

function uniqueName(name, used) {
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? "" : name.slice(dot);
  let n = 2;
  let candidate;
  do { candidate = `${stem} (${n++})${ext}`; } while (used.has(candidate.toLowerCase()));
  return candidate;
}

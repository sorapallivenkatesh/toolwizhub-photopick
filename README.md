# PhotoPick

**Cull & shortlist photos and videos straight off any drive — privately, in your browser.**

Plug in a hard drive or pen drive, open the event folder, breeze through the thumbnails, star the keepers, then either **export a filename list** (`.txt`/`.csv`) to send your photographer, or **copy just the picks into a new folder**. Nothing is ever uploaded — every file is read and written locally on your device.

→ **[photopick.toolwizhub.com](https://photopick.toolwizhub.com)**

## Features
- 📂 Open any local folder — external drive **or** local system — sub-folders scanned too
- 🖼️ Fast lazy-loaded thumbnail grid for photos, RAW, and videos
- ⭐ One-click / keyboard shortlisting, with filters (photos · videos · RAW · picks) and search
- 🔍 Full-screen lightbox preview with next/prev and pick
- 🧭 Sort by name, capture date (EXIF), modified date, or size
- 📄 Export selected filenames as `.txt` or a metadata `.csv`
- 📁 **Copy or move** the selected files into another folder (needs File System Access API) — or **download them as a `.zip`** (every browser)
- 🔒 100% local: no backend, no accounts, no analytics, no network

## Privacy
PhotoPick has no server. Your photos, videos, filenames, and picks never leave your machine. See [privacy.html](privacy.html).

## Requirements
Works in any modern desktop browser. **Chrome, Edge, Brave, or Opera** get the full File System Access API (including native *copy to folder*); **Firefox and Safari** read folders via `<input webkitdirectory>` and export picks as a `.zip`. Must be served over **https** or **http://localhost** (a `file://` path or LAN IP disables local-folder access).

## Notes
- **HEIC/HEIF** (iPhone photos) are decoded in-browser via a lazy-loaded `heic2any` decoder — thumbnails and full previews both work.
- **RAW** files show their embedded JPEG preview when one exists; otherwise a filename tile you can still pick.

## Develop
```bash
npm run site   # serves at http://localhost:8096
```
Static site, no build step — plain ES modules. Deploys on Cloudflare Pages (output = repo root).

Part of [ToolWizHub](https://toolwizhub.com) — free, privacy-first, no-signup web tools.

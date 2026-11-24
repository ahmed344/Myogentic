# Myogentic Annotator

A local prototype for reviewing H&E whole-slide images. React/TypeScript and OpenSeadragon provide the interface; FastAPI, OpenSlide, and libvips serve the original files; SQLite stores assessments. No cloud account, upload, CDN, or internet connection is required after setup.

## Start on this computer

Dependencies and frontend assets are already installed/built. From the repository:

```bash
cd annotator
./start.sh
```

Open http://127.0.0.1:8000. Choose a consistent reviewer name or ID. The workspace opens in dark mode; the Light/Dark button in the header switches themes and remembers the choice in this browser. The server binds only to this computer. Stop it with Ctrl+C. To use another port:

```bash
MYOGENTIC_PORT=8002 ./start.sh
```

## Install or rebuild

Install `uv` first, then run:

```bash
./setup.sh
```

Setup uses `uv sync --locked` to populate `.venv/` and `npm ci` to populate `frontend/node_modules/`, then builds `frontend/dist/`. It downloads an official, checksum-verified Node 24 runtime into `.tools/` if Node/npm are absent. An existing Node installation must satisfy `frontend/package.json` (22.12+; a maintained Node 24 release is suitable). Python 3.14 is selected by `.python-version`; uv can install it if needed. Setup requires internet access the first time. Start-up uses the installed Python environment directly and never resolves or downloads packages.

`uv.lock` and `frontend/package-lock.json` are tracked. Environments, caches, downloaded tooling, slide data, local configuration, and the database are excluded from Git. The Node runtime is only needed to build/develop the frontend, not for everyday use of the built app.

## Slide folders

Defaults are the SSD and HDD raw directories in `config.example.toml`. Slide files are opened read-only, indexed by filename, and tiled on demand. Originals are never converted or modified. The file index found 1,035 candidate files across the configured roots during development; this is a file count, not a count of unique patients or verified readable slides.

To customize:

```bash
cp config.example.toml config.toml
```

Edit the source paths and restart. The **Refresh slide library** button indexes files added or drives reconnected during a session. Source folders are configured on disk and are not shown in the reviewer interface. `MYOGENTIC_CONFIG=/absolute/path/config.toml ./start.sh` selects another configuration. Relative database paths are interpreted from this directory.

Slide IDs combine a stable source ID with a relative path. When moving a disk to another computer, preserve source IDs and the folder structure; only change the source's absolute path. Renaming files or changing source IDs creates different identities. Copies under different sources are indexed separately; there is no automatic deduplication. Disconnected slides remain in the index with their saved annotations.

OpenSlide handles NDPI and supported pyramidal whole-slide formats. Ordinary single-page, 8-bit RGB/RGBA TIFFs that OpenSlide cannot open use the bundled libvips reader, including the large stripped TIFFs in the Copenhagen folder. The reader streams a small overview (at most 2,048 pixels per side) and reads finer image regions on demand. Originals remain unchanged and no full-size converted copies are created. All evidence coordinates remain in the original image's pixel frame. A real 27,673 × 32,733 TIFF and a 53,760 × 59,904 NDPI were verified.

The TIFF fallback deliberately rejects multipage, non-RGB, and higher-bit-depth images with a specific error rather than silently choosing a page or discarding precision. Some other unsupported formats may still require a separate reader. Two libvips workers and at most two concurrent TIFF streams limit memory use; an individual file's first overview may take a moment to appear. Native OpenSlide reads continue independently. `pyvips[binary]` supplies libvips inside the same uv environment, without a system-wide installation.

Unviewed ordinary TIFFs initially show a neutral slide thumbnail placeholder. Opening one creates a small preview, cached in `thumbnail-cache/` beside the database and reused on later launches. This prevents the library from reading tens of gigabytes of original TIFF pixels just to populate its sidebar. This cache is disposable and contains no annotations; an image changed on disk gets a new cache entry.

Zooming prioritizes tiles at the requested resolution, schedules up to three tiles per frame, and limits concurrent downloads to six. The viewer retains up to 400 decoded tiles per drawer for nearby zoom levels. The backend reads separate regions concurrently and keeps a shared, 64 MiB cache of finished JPEG tiles in memory, in addition to OpenSlide's 128 MiB decoded cache. Duplicate requests share one render; TIFF reads still obey the global two-stream limit and build each overview only once. Browser tile responses use private caching with revalidation, so unchanged tiles can be reused while changed or disconnected source files are still detected. Assessments remain uncached. The first read of a new area, especially a large non-pyramidal TIFF on an HDD, still depends on disk speed; revisiting recently viewed areas avoids that work. Restart the backend and reload the browser after rebuilding to apply viewer changes.

## Review workflow

1. Choose your reviewer name/ID; spelling and case identify the reviewer.
2. Search by a full or partial hashed slide ID (case-insensitive), or filter by your review status. Slides appear in a stable shuffled order.
3. Pan, zoom, and assess visible morphology. Multiple patterns may coexist.
4. Select **Brush** or press **R**. Adjust the width and paint as many strokes as the region needs. Each region has one evidence number and note. Use **Erase** to trim it. Use **Outline** to click successive points or trace with a drag.
   - Hold **Ctrl** when starting a stroke to paint, or **Alt** to erase from the active region. Each drag uses the mode you started it with. Release the key to use the selected toolbar tool for your next stroke.
   - **Finish & next** (**Enter**) keeps the marks as drawn and prepares a new region.
   - **Close, fill & next** (**Ctrl+Enter** or **Shift+Enter**) joins the ends of the latest outline or freehand stroke and fills the enclosed area. Trace at least three non-collinear points to enable it.
   - **Pan** or **Esc** returns to navigation. In pan mode, click a mark to select it and choose **Edit region**. The **Edit** button beside an evidence note also reopens that region. **E1**, **E2**, and the other evidence buttons select and focus their marks.
   - **Delete** or **Backspace** removes the selected region. **Undo** (**Ctrl+Z** or **⌘Z**) reverses the last region edit or deletion on the current slide during this session.
5. Changes autosave after a 700 ms pause. Check **All changes saved** before closing. Navigation flushes pending changes. **Complete & next** requires an overall assessment and an explicit main-pattern choice, then moves to the next available unfinished slide. Completion does not reinterpret unanswered fields as absent.
6. Use **View revision history** to inspect older records. Editing a completed assessment reopens it as in progress, preserving the completed revision.

**H** fits the slide; **[** / **]** move through the filtered list; **Esc** cancels drawing. Keyboard shortcuts pause while typing. The app remembers the reviewer and last selected slide in the local browser.

Both themes use soft pink and blue accents; changing themes does not alter the tissue pixels. The viewer uses faster zoom steps: ×3 for the buttons and double-click, ×2 per mouse-wheel step, with an 80 ms animation. The scale bar follows zoom and viewer size. It uses horizontal microns-per-pixel calibration from OpenSlide or the TIFF's embedded OME `PhysicalSizeX` metadata for µm/mm units. OME physical units are converted to micrometres; omitted units follow the OME default of µm. The metadata must match the original image dimensions. All 29 Copenhagen TIFFs contain `PhysicalSizeX` and `PhysicalSizeY` of **0.168942 µm per pixel**. Hover over the scale bar to see its calibration and source. Only when calibration is missing or invalid does the viewer show original image pixels. Objective magnification and generic print resolution are never used to guess physical size.

The interface uses **Annotation**, **Not yet annotated**, and **Abnormality changes identified**. Stored field IDs and old revisions retain their original values for compatibility.

Overall and per-pattern confidence use a keyboard-accessible **Low–Moderate–High** slider, defaulting to **High**. Confidence does not mark a finding as present or determine its grade. Previously unset legacy confidence receives the High default only on an explicit edit; recorded Low, Moderate, and High values are preserved.

Version **2.0** makes **Main pattern** mandatory for completion, including saves from older clients. Drafts can still autosave without it. An explicit “No dominant pattern identified,” “Uncertain,” or “Cannot assess” choice is allowed; none is selected automatically. Historical completed revisions remain unchanged.

In version **4.1**, **Nuclear alterations** groups **Internal nuclei** (off-center) and **Central nuclei**. **Inflammatory cells** groups **Perimysial**, **Endomysial**, and **Perivascular**. **Atrophy** groups **Rounded**, **Angular**, and **Perifascicular**. Each type has its own presence and optional grade. Choose **Present** or **Uncertain** on its row to enable **Grade 1 · Mild**, **Grade 2 · Moderate**, or **Grade 3 · Severe**. Changing one row affects only that type. Marking it absent sets its grade to **Not applicable**.

The current vocabulary is in `schemas/annotations-v4.3.json`. A group's `types` lists its children. Each child ID is a separate key in `findings` and `finding_grades`, including in the JSON and CSV exports. For example, `internal_nuclei_noncentered` and `centered_nuclei` can have different grades on the same slide. Version 3 exports retain their original `finding_types` lists and shared grades.

Opening an older review leaves its saved revision intact. Atrophy assessments from v2 onward keep their original type IDs, presence, and grades. The earlier v1 grouped-atrophy observation is retained in the historical snapshot. On edit, v2 nuclear presence and grades carry directly into the corresponding type rows. For v3, a selected type takes its parent's recorded presence or uncertainty. Unselected types stay unassessed, and the reviewer assigns each type's grade. **Earlier finding annotations** shows the original broad observations, shared grades, and selections with their original labels. The snapshot also travels with recovered drafts and exports.

Assessments preserve absent, uncertain, cannot assess, and not yet assessed separately. Grades, pattern severity, extent, and confidence are independent. The overall option is “No abnormality identified on this H&E section,” not a patient-level health claim. Version definitions when changing their meaning; do not silently reinterpret old records.

**Team consensus** creates a separate adjudicated record from individual reviews for the selected reviewer. It does not overwrite doctors' assessments. This prototype has no side-by-side consensus workflow or role enforcement. Reviewer profiles are attribution labels, not authenticated accounts. Use it as a local workstation prototype, not an internet-facing or authenticated multi-user service.

## Blinded slide identity and review order

Reviewers see `SL-` followed by the full 24-character hexadecimal slide ID. This reuses the existing SHA-256-derived identity, so saved reviews, revision history, browser drafts, and resume links remain attached to the same slides. Original files are not renamed. The local SQLite database retains the original filename/source mapping for backup and analysis.

The library, heading, tooltips, search, browser APIs, scan warnings, and browser exports omit the original filenames and source folders. Search matches only hashed slide IDs. Native reader errors are sanitized before reaching the browser. The TIFF preview placeholder does not advertise its file type. This blinds the displayed file identity; it does not redact annotation comments or identifying information embedded in image pixels. Local database/configuration access still exposes the original mapping; reviewer profiles are not security accounts.

A separate deterministic hash orders the slides independently of their source, patient-like filename, reviewer, and annotation status. The sequence stays consistent on reload, rescan, and restart; newly indexed slides fit into it without reordering existing slides. Previous/next, keyboard navigation, and Complete & next use this mixed sequence. This removes filename/source sorting, but is not patient-aware stratification: occasional neighboring slides from the same site or patient can occur by chance.

## Persistence, conflicts, and export

The default database is `data/annotations.sqlite3`. Every save appends a revision with reviewer, record type, timestamp, vocabulary version, and the indexed slide file size/modification time. Brush centerlines, diameters, and earlier rectangles use full-slide level-0 pixels, with the origin at the upper-left. Brush width is selected in screen pixels and converted to slide pixels at the current zoom. Exported strokes have round caps and joins, and paint is clipped at the slide edges. Version 4.3 stores each edited region as an optional original rectangle followed by ordered paint, outline, fill, and erase strokes. A filled outline includes its closed boundary and even-odd interior. Erasing subtracts from that region alone, and subsequent paint can add tissue back. Earlier single strokes and rectangles keep their original format until edited.

Two tabs editing the same record cannot silently overwrite each other: the stale save is rejected. Unsaved edits remain in the browser and are also cached locally when browser storage is available. After a failed save, retry or export the draft. For a conflict, export the local draft before using **Load saved version**, then reconcile manually. Avoid clearing browser data before unsaved drafts have been exported or saved. A file changed since the last scan requires a rescan; check old evidence against the changed image before continuing. File size and modification time are provenance hints, not cryptographic identity checks.

The **Export** menu provides:

- **JSON:** hashed slide IDs, all reviewers' individual/adjudicated records, all revisions, evidence coordinates, and annotation definitions. Original filenames, source IDs/labels, paths, and pixels are not included. File size and modification time remain as revision provenance hints.
- **CSV:** hashed slide IDs and the latest assessment per slide/reviewer/record type; structured pattern, finding, and region data remain JSON columns. Potential spreadsheet formulas in free text are escaped with a leading apostrophe; JSON retains the original text.

Browser exports retain reviewer details and annotation text, but omit original filename and source mappings. Store them alongside the project data. Import/merge of independently annotated workstations is not yet implemented.

## Backup and move between computers

For a consistent backup while the app is running:

```bash
.venv/bin/python scripts/backup.py
# Or choose a new destination filename:
.venv/bin/python scripts/backup.py /path/to/backup/annotations.sqlite3
```

The helper uses SQLite's backup API, includes committed write-ahead-log data, and refuses to replace an existing file. Browser-only unsaved drafts must be saved/exported separately. Back up `config.toml`, definitions, and source images as well. The default backup directory is `data/backups/`; copy backups to another drive for protection from disk failure.

To move: copy the source project and a database backup, run setup on the destination computer, stop the application, place the backup at the configured database path, update source paths while preserving IDs, then start. Do not copy `.venv/` or `node_modules/` between computers; recreate them from the lockfiles. JSON is an assessment archive with hashed slide IDs; restoring the application and the original filename/source mapping uses the SQLite backup rather than JSON import.

## Develop and verify

Run the backend and Vite in separate terminals:

```bash
uv run --locked uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000 --reload
```

```bash
export PATH="$PWD/.tools/node/bin:$PATH" # if using the local Node installation
cd frontend
npm run dev
```

Vite proxies `/api` to the local backend. For checks:

```bash
uv run --locked pytest -q
cd frontend
npm test
npm run build
```

Automated tests cover explicit unknown states, revision persistence, reviewer/adjudication separation, stale-save conflicts, evidence bounds and round trips, Deep Zoom tiles, offline drives, source relocation, export, and local request guards. Browser QA uses a separate database so demonstration assessments do not enter the real annotation workspace.

## Files

- `backend/`: configuration, schemas, database, bounded slide handle/cache management, and API.
- `frontend/src/`: slide library, OpenSeadragon viewer, review form, autosave, and CSS.
- `schemas/annotations-*.json`: provisional versioned vocabulary and coordinate contract.
- `tests/`: isolated API/persistence tests using generated image fixtures.
- `scripts/`: local Node setup and SQLite backup.

The application remains an annotator prototype. Classifier inference, account permissions, workstation merging, and clinical validation are future work.

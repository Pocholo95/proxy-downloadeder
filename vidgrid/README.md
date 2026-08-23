# VidGrid-HTML

A **local desktop app** (Windows and Linux) for generating video thumbnail
grids. Pick one or more video files (or a whole folder), and get a JPG
contact sheet or an **animated WebP/MP4** for each video — processed with
real, native `ffmpeg`/`ffprobe`, in parallel across your CPU cores. No
upload, no cloud processing, no account required.

The UI is the same React/Vite app running as a small local web server: a
Python backend (`desktop/`) serves it and opens it in your regular browser,
and drives real ffmpeg subprocesses instead of ffmpeg compiled to
WebAssembly, so batches of many files — and formats like AV1 that are slow
in WASM — process much faster. Picking files uses the browser's own
`<input type=file>` dialogs (and drag & drop); picked files are streamed to
the local backend, which is how ffmpeg still gets a real file to work with
even though browsers don't expose real filesystem paths. See
[Desktop App](#desktop-app) below for how to run/build it.

---

## What it does

VidGrid-HTML analyzes each video, samples frames at evenly-spaced timestamps
or custom timestamps per file across the duration, and assembles them into
a configurable grid. Each cell can be annotated with a timecode overlay. An
optional header row shows the filename, resolution, duration, bitrate, FPS,
codec, and file size. Results stay in the app as a high-quality JPEG or
animated WebP/MP4 you can preview, download (individually or all at once as
a ZIP), and/or upload to an image host.

---

## Privacy

**Nothing ever leaves your device** unless you explicitly upload to an image
host. All processing — metadata reading, frame extraction, canvas compositing,
and JPEG/WebP/MP4 encoding — happens entirely locally (in your browser tab
and via the bundled/system `ffmpeg`/`ffprobe` binaries, talking to a Python
server on `127.0.0.1` that never leaves your machine). No file data, no
metadata, and no generated images are transmitted anywhere unless you
trigger an upload.

---

## Desktop App

The `desktop/` Python backend serves the built frontend + a local JSON API
+ real ffmpeg/ffprobe from `http://127.0.0.1:<port>/`, and opens that URL in
your default browser (`python -m desktop.app`). No GUI toolkit, no system
packages beyond Python itself — file picking is the browser's own
`<input type=file>`/drag & drop, and outputs come back as regular browser
downloads. Setup is identical on Windows and Linux.

```bash
npm install
npm run build                       # builds the frontend into dist/

python -m venv .venv
```

```bash
# Windows
.venv\Scripts\pip install -r requirements-desktop.txt
.venv\Scripts\python -m desktop.app

# Linux/macOS
.venv/bin/pip install -r requirements-desktop.txt
.venv/bin/python -m desktop.app
```

You'll also want `ffmpeg`/`ffprobe` with AV1 support:
- **Windows:** download a static build into `bin/` (e.g. BtbN/FFmpeg-Builds
  "master-latest-win64-gpl", or any build whose `ffmpeg -decoders` lists
  av1/libdav1d/libaom-av1) — there's usually no system ffmpeg on Windows.
- **Linux:** your distro's `ffmpeg` package commonly already supports AV1
  (check with `ffmpeg -decoders | grep av1`); if so you don't need to do
  anything, the app finds it on `PATH` automatically. Otherwise drop a
  static `ffmpeg`/`ffprobe` build into `bin/` (`chmod +x` them).

To package a standalone executable (no Python/Node required to run it):

```bash
.venv\Scripts\pip install pyinstaller      # Windows
.venv\Scripts\pyinstaller desktop.spec --distpath pyinstaller_dist --workpath pyinstaller_build --noconfirm

.venv/bin/pip install pyinstaller          # Linux
.venv/bin/pyinstaller desktop.spec --distpath pyinstaller_dist --workpath pyinstaller_build --noconfirm
```

The packaged app is at `pyinstaller_dist/VidGrid/VidGrid.exe` (Windows) or
`pyinstaller_dist/VidGrid/VidGrid` (Linux) — an `--onedir` build, so
distribute the whole `pyinstaller_dist/VidGrid/` folder. `--distpath`/
`--workpath` are required — PyInstaller's own default output folder is also
named `dist`, which would otherwise collide with the frontend build output
this spec bundles as data. Must be built on the platform it targets
(PyInstaller doesn't cross-compile).

The packaged app runs with a visible console (there's no app window anymore
now that the UI is your browser) — that's where ffmpeg logs/errors show up,
and `Ctrl+C` there (or closing that window) stops the server.

---

## Table of Contents

- [Desktop App](#desktop-app)
- [Basic Usage](#basic-usage)
- [Features](#features)
- [Tasks Actions](#tasks-actions)
- [Generation Options](#generation-options)
- [Custom Grid Templates](#custom-grid-templates)
- [Custom Timestamps](#custom-timestamps)
- [Animated output](#animated-output)
- [Sequence mode - Video with audio](#sequence-mode---video-with-audio)
- [Gallery mode](#gallery-mode)
- [VR Video](#vr-video)
- [Presets](#presets)
- [Uploading](#uploading)
- [Settings](#settings)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)
- [Native FFmpeg](#native-ffmpeg)
- [Requirements](#requirements)
- [Development](#development)

---

## Basic Usage

1. **Add videos:** Click "Add videos…" for a multi-file picker, "Add
   folder…" to recursively queue every video in a folder, or just drag &
   drop files onto the drop zone.
2. **Review analysis:** Each video is immediately analyzed (via `ffprobe`)
   and added to the "Tasks" list with its detected properties. Add more
   files at any time.
3. **Customize options:** _(optional)_ Adjust grid size, style, animation,
   or VR settings as described in [Generation Options](#generation-options).
4. **Start processing:** Click "▶️ Start Processing". Multiple videos
   process in parallel, up to your CPU's core count.
5. **Preview/Download/Upload/Requeue:** Once a task is done, grab its
   output via "Download" (or "Download All" in the Tasks Actions panel to
   get every completed output as one ZIP), or "Requeue" to process the same
   video again with different settings. If you have configured one or more
   [Upload destinations](#upload-destinations), an "Upload" button will
   appear too.

> **Tip:** During long batches, if the options panel scrolls out of view, a
> compact progress bar appears at the top of the page with batch progress,
> item count, and quick-access buttons to cancel, requeue, or clear. Click the
> expand arrow to reveal the full controls again without having to scroll back
> to the top.

---

## Features

- **In-browser preview:** thumbnail previews of completed grids with a
  full-size modal viewer.
- **Universal metadata reading:** MediaInfo.js (WASM) accurately reads
  duration, resolution, bitrate, FPS, and codec from virtually any container
  format (MP4, MKV, AVI, MOV, WMV, WebM, TS, and many more) without decoding
  frames.
- **Native frame extraction** using the browser's built-in video decoder for
  all formats the browser supports — fast, with no extra memory overhead.
- **FFmpeg WASM fallback:** formats the browser cannot decode natively
  (e.g. AVI, WMV, certain MKV/H.265 files). A warning is shown on the file
  card during the analysis phase when this path will be taken.
- **Animated WebP/MP4 output:** generate an animated thumbnail grid or sequence
  of still frames/video where each cell plays a short clip from its sampled
  timestamp. See [Animated output](#animated-output).
- **Video with audio sequence:** generate an MP4 sequence that preserves the
  video's original audio track. See [Sequence mode - Video with audio](#sequence-mode---video-with-audio).
- **VR Video support:** crop one eye from Side-by-Side or Top-Bottom stereo
  VR video so thumbnails show a single, undoubled image. See
  [VR Video](#vr-video).
- **Automatic video rotation detection:** videos recorded in portrait or
  sideways orientations are automatically detected via rotation metadata and
  displayed correctly in thumbnails.
- **Custom grid templates:** design a free-form layout with any number of
  rows and any number of cells per row, instead of a uniform columns × rows
  grid. See [Custom Grid Templates](#custom-grid-templates).
- **Custom timestamps per file:** click **Edit Timestamps** on any task item
  to set exact frame positions using a built-in video player with marker pins. See
  [Custom Timestamps](#custom-timestamps).
- **Batch processing:** queue multiple tasks by adding video files and process
  them one after another with combined progress tracking.
- **Batch download:** completed tasks can be downloaded together as a
  ZIP archive.
- **Upload to image hosts:** upload generated grids to one or more configured
  image hosts. See [Upload Destinations](#upload-destinations).
- **Copy links:** after uploading, copy links in multiple formats per task
  or for all tasks at once. See [Copying Links](#copying-links).
- **Configurable grid:** choose columns, rows, output width, cell spacing,
  and timecode position (or disable the overlay entirely).
- **Custom colors:** set the background and text color for the header and
  timecode overlays.
- **Optional metadata header:** toggle a header row showing file info above
  the grid.
- **Presets:** save and switch between named option sets stored in
  localStorage. See [Presets](#presets).
- **Cancel at any time:** interrupt a running batch cleanly after the current
  frame.

---

## Tasks Actions

When at least one file has been analyzed, a **Tasks Actions** panel appears
above the tasks list. Use the dropdown to select a format and click **Copy All**
to copy links/formatted text for all uploaded outputs at once, one per line.

At first only one format is available, no generation/upload is required, it's
**BBCode — Title & Resolution** which produces `[b]filename resolution[/b]` lines
ready to paste as a list of titles into a forum post for example.

To unlock the other formats, you need to generate the thumbnails by processing the
files, and then upload them to one or more destinations using the individual "Upload"
buttons or the "Upload All" button that appears in the Tasks Actions panel. The
formats are detailed under [Copying Links](#copying-links).

Additionally, once multiple tasks are completed, a "Download All" button appears
in this panel; when used, it offers you a compressed ZIP archive of all
the completed tasks.

---

## Generation Options

The controls are grouped into three collapsible fieldsets: **Output Modes**, **Grid** (or **Dimensions** in sequence/gallery modes), and **Style**.

### Output Mode Selector

At the top of the options panel, an **Output mode** dropdown lets you choose between:

| Mode         | Description                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| **Static**   | Generate a single static JPEG contact sheet with frames arranged in a grid                                |
| **Animated** | Generate an animated WebP or MP4 with moving frames in a grid                                             |
| **Sequence** | Single-cell sequential playback instead of a grid, see [Sequence mode](#sequence-mode---video-with-audio) |
| **Gallery**  | Generate individual JPEG images at specified timestamps, see [Gallery mode](#gallery-mode)                |

> **Tip:** Hold **Shift** while clicking any section header to expand or
> collapse all sections at once — useful when you want to quickly scan or
> adjust multiple settings. This works on Tasks sections too.

### Grid / Dimensions

| Option                   | Description                                                                                                              | Default |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------- |
| **Output width**         | Total pixel width of the generated image. Hidden in gallery mode when original resolution is enabled.                    | 1920 px |
| **Image width**          | Width of each individual gallery image. Shown instead of "Output width" in gallery mode.                                 | 1920 px |
| **Cell spacing**         | Gap in pixels between cells. Hidden in sequence and gallery modes.                                                       | 0       |
| **Grid columns**         | Number of columns in the uniform grid. Hidden when a custom template is active or in sequence/gallery modes.             | 3       |
| **Grid rows**            | Number of rows in the uniform grid. Hidden when a custom template is active or in sequence/gallery modes.                | 4       |
| **Custom grid template** | Enable a free-form layout editor. See [Custom Grid Templates](#custom-grid-templates). Hidden in sequence/gallery modes. | Off     |

In **Sequence** and **Gallery** modes, this section is labeled **Dimensions**
instead of **Grid** since grid layout is not applicable. In Gallery mode with
original resolution enabled, the entire section is hidden as the video's native
resolution is used.

### Output Modes

| Option                   | Description                                                                                                             | Default  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| **Timecode position**    | Corner where the timestamp overlay appears, or **Disabled** to omit it.                                                 | Top-left |
| **Show metadata header** | Toggle the filename/info header row.                                                                                    | On       |
| **VR Video**             | Crop one part of a stereo VR frame (SBS or TB layout), see [VR Video options](#vr-video-options)                        | Disabled |
| **Animated output**      | Generate an animated WebP instead of a static JPEG. Reveals more options, see [Animation settings](#animation-settings) | Off      |
| **Sequence mode**        | Single-cell sequential playback instead of a grid. See [Sequence mode](#animation-settings)                             | Off      |
| **Output format**        | **WebP** for animated WebP; **MP4** for MP4 video output                                                                | WebP     |

### Style

| Option                 | Description                                                                  | Default        |
| ---------------------- | ---------------------------------------------------------------------------- | -------------- |
| **Background color**   | Canvas and header background.                                                | `#000000`      |
| **Text color**         | Header text and timecode label color.                                        | `#ffffff`      |
| **Font family**        | Typeface used for header text and timecode overlays.                         | System default |
| **Timecode font size** | Size of the timecode text in pixels. Toggle **Auto** to scale with the grid. | Auto           |
| **Header font size**   | Size of the header text in pixels. Toggle **Auto** to scale with the grid.   | Auto           |

---

## Custom Grid Templates

By default VidGrid-HTML arranges frames in a uniform columns × rows grid. The
**Custom grid template** checkbox in the Grid section replaces that with a
free-form layout: any number of rows, each with any number of cells.

**How it works:**

The template editor opens as a modal. Rows stack vertically on screen; within
each row, cells share the full output width equally; there is no manual width
control. The height of every cell in a row is derived automatically from the
cell width and the video's aspect ratio, so the output is always
pixel-perfect with no distortion. Fewer cells per row means wider, taller
cells; more cells means narrower, shorter cells.

### Building a template

- **+ Add Row** appends a new full-width single-cell row at the bottom.
- **+** at the right end of each row splits the row's available space by
  adding one more cell. All cells in that row are immediately rebalanced to
  equal widths.
- **✕** on a cell removes it; the remaining cells in that row rebalance
  equally. Removing the last cell in a row removes the entire row.
- The **⠿** handle on the left of each row can be grabbed to drag the row to
  a different position in the stack.
- **↺ Reset (?x?)** discards the current layout and restores a uniform grid
  sized based on the non-custom columns/rows options.

### Grid Preview

A compact, numbered preview of your current grid layout appears in the Grid
section at all times. Cells are numbered in reading order — left-to-right
within each row and top-to-bottom across rows — so you can quickly verify
which timestamp will be sampled for each position without generating a grid.
The preview updates live as you adjust columns, rows, or edit a custom
template.

### Cell numbering and timestamps

Cells are numbered in reading order — left-to-right within each row and
top-to-bottom across rows. That number determines which timestamp is
sampled for each cell, and it is the same count the **Timestamp Editor**
uses when you set per-file custom markers. If you change the template after
setting custom markers on a task, requeue the task so the new cell count is
applied.

### Saving and reusing templates

The full grid template is saved as part of the **Preset**. To reuse the same
layout in a different preset or with different style settings, save the
preset after building your grid template, then load it later and adjust any other
options (output width, colors, header, etc.) without touching the template.

---

## Custom Timestamps

Each task item shows its timestamp mode (**Auto** or **Custom**) with an
**Edit Timestamps** button. Click to open a full-featured editor modal for that
specific video.

### Editor features

- **Video player** with seekbar, play/pause (⏸️/▶️), seek buttons, and
  current time display
- **Visual marker pins** on the seekbar for the frame that will be used in the
  output file for thumbnails. To select a marker lick on its number on the
  seekbar or in the markers list.
- **Add (+) / Remove (-) Markers** buttons to manage the chosen frames. The
  remove button is only enabled when a marker is selected.
- **Keyboard shortcuts**:
  - `Space`: Play/Pause, `M`: Add Marker, `Esc`: Close
  - `Arrow Left`/`Arrow Right`: Seek 1 second. `Ctrl` modifier to go frame by
    frame, `Shift` to go by 5 seconds.
- **Mouse wheel seeking:** scroll over the video player or seekbar to scrub
  through the timeline — same speed as the arrow keys (you can use `Ctrl` and
  `Shift` modifiers; see [Keyboard Shortcuts](#keyboard-shortcuts)).
- **Mobile shortcuts**:
  - Double-tap seekbar: Add marker
  - Long-press marker: Delete marker
- **Live marker list:** click to seek, ✕ to delete individual markers
- **Zoom controls:** zoom the seekbar timeline from 100% (full view) up to
  1000% for precise marker placement when markers are close together. The current
  zoom percentage is displayed between the buttons. Hold **Shift** while clicking
  Zoom In to jump to maximum zoom (1000%), or Shift+Click Zoom Out to reset to
  100% immediately.
- **Overview bar:** when zoomed in, a mini-timeline appears below the seekbar.
  A semi-transparent overlay indicates the currently visible viewport range.
  Click anywhere on the overview bar to navigate to that position. Mouse wheel
  on the overview bar also seeks through the video.
- **Interactive grid preview:** a numbered schematic of your active grid
  layout appears on the right side. Click any cell to instantly seek the
  video to the corresponding marker — useful for quickly checking each
  frame without scrolling through the marker list.
- **Smart counting:** shows how many markers fit your grid (total cell count
  from the active layout, uniform or custom), extras ignored, shortages use
  auto fallback
- **Quick Fill:** when the marker list is empty, three utility buttons appear
  ("Full duration", "First half", "Second half") that instantly populate
  evenly-spaced markers across the chosen time range — useful for fast
  setup without manually seeking and adding each marker
- **Reset:** restore evenly-spaced timestamps
- **Save Markers:** apply custom timestamps

### Smart behaviors

- **Auto seeding:** opens with evenly-spaced timestamps as starting point
- **Zero markers = auto:** saving empty list reverts to automatic mode
- **Works with animation:** custom timestamps apply to both static JPEG
  and animated WebP modes
- **Per-file:** each video keeps its own custom markers independently
  (but they are not preserved in presets).

---

## Animated output

When **Animated output** is enabled, VidGrid-HTML generates an animated output
instead of a static JPEG. The output is a short looping video clip
sampled from its timestamp (auto or custom), giving a quick visual overview
of the entire video in motion.

There are two modes for **Animated output**:

- **Animated grid** (default) shows multiple cells simultaneously, each playing
  its own clip from a different timestamp. This uses the grid/custom grid.
- **Sequence mode** (when this switch is enabled) shows one cell at a time,
  playing segments sequentially from start to end of the video — like a fast
  visual summary.

Both modes are affected by the timestamps defined for each file in their
respective [Timestamp Editor](#custom-timestamps).

> **Note:** You can configure warning thresholds for large animations in the
> **[Animations Tab](#animations-tab)** of the Settings dialog. These help
> identify when an animated output might be too large for upload hosts or
> browser memory limits.

### Animation settings

The **Animation settings** panel is shown below the main options whenever
**Animated output** is enabled.

Common options:

| Setting           | Description                                                                            | Default |
| ----------------- | -------------------------------------------------------------------------------------- | ------- |
| **Output format** | **WebP** for animated WebP output; **MP4** for MP4 video output                        | WebP    |
| **Duration (s)**  | Length of each cell/segment. The whole animation loops from the start                  | 3 s     |
| **FPS**           | Frame rate of the animated output. Higher values are smoother but produce larger files | 10 fps  |

Available for WEBP output format:

| Setting          | Description                                                                                         | Default |
| ---------------- | --------------------------------------------------------------------------------------------------- | ------- |
| **WebP method**  | Compression effort (0 = fastest, 6 = smallest file). Higher values slow down encoding significantly | 5       |
| **WebP quality** | Output quality (5–100). Lower values produce smaller files with more visible artefacts              | 90      |

Available for Sequence Mode:

| Setting         | Description                                       | Default |
| --------------- | ------------------------------------------------- | ------- |
| **Segments**    | Number of segments to extract from the video      | 6       |
| **Render mode** | Defines the type of animation within the sequence | Video   |

Render modes for Sequence animations:

| Render Mode          | What it does                                             | Audio? |
| -------------------- | -------------------------------------------------------- | ------ |
| **Static**           | Holds one frame per segment for the duration             | No     |
| **Video**            | Plays each segment frame-by-frame via canvas composition | No     |
| **Video with audio** | Cuts and merges video segments with FFmpeg               | Yes    |

#### Requirements and limitations

- **Native browser decoding only:** Animated mode uses the browser's built-in
  `<video>` element to seek frames. Files that require the FFmpeg fallback
  (AVI, WMV, some MKV) are incompatible with animated mode. Disable animated
  mode and regenerate as a static JPEG if you need to cover those formats.
- **MP4 output** uses FFmpeg WASM for encoding and may be slower than WebP.
- **Memory usage** scales with the total frame count (segments × duration × FPS).
  Keep segments and duration reasonable to avoid exhausting browser memory.
- **Large output files:** Animated WebPs are significantly larger than static
  JPEGs or even animated MP4. A 3×4 grid at 3 s / 10 fps will composite 30 PNG
  frames before encoding. Reduce the output width, FPS, duration, or quality
  and increase the WebP method to keep file sizes manageable.
- **Encoding time:** libwebp encoding through FFmpeg WASM is single-threaded.
  High method values (5–6) combined with large frame counts can take many
  seconds, up to a couple minutes on slower devices.
- **Memory:** All composed PNG frames are held in browser memory before being
  handed to FFmpeg. Very high frame counts (long duration × high FPS) can
  exhaust available RAM.

---

## Sequence mode - Video with audio

When you select **Video with audio** as the render mode in Sequence mode,
VidGrid-HTML uses FFmpeg to cut short video segments directly from the source
file and merge them into a single MP4 — **preserving the original audio track**.
This is useful when you want a quick visual summary of a video that also
retains its sound, dialogue, or music.

Limitations:

- Certain codecs or encoding settings for source video simply cannot be cut
  reliably with FFmpeg and will either fail or partially fail. In this case
  using other **Render mode** options might help, but they do not include audio.

### Important notes

- **Disabled options**: Grid size/Custom grid, Cell spacing, Metadata header,
  and Timecode position are not available in this mode because FFmpeg cuts the
  raw video directly; there is no canvas to draw text on.
- **Output is always MP4.** WebP is not available for this mode.
- **Custom timestamps work:** if you've set custom markers in the Timestamp
  Editor, those positions are used as segment start points.

---

## Gallery mode

When **Gallery** is selected as the output mode, VidGrid-HTML generates individual
JPEG images instead of a single grid or animation. Each image captures a single
frame from the video at the timestamps you specify (auto-generated or custom).

**How it works:**

- **Frame count:** choose how many individual images to generate (default: 8).
  Timestamps are evenly distributed across the video duration, or you can set
  custom timestamps using the [Timestamp Editor](#custom-timestamps).
- **Original resolution:** by default, each image is captured at the video's
  native resolution for maximum quality. Disable this option to specify a custom
  image width instead.
- **Timecode overlay:** optionally add a timecode overlay to each image by
  enabling a timecode position in the Output Modes section.

### Gallery preview

After processing, the task card shows the first generated image as a preview.
Use the **Previous** and **Next** buttons to navigate through the gallery images.
You can also click any image to open the full-size preview modal in which you can
use **Arrow keys** (`←` / `→`) on your keyboard to navigate between images
or **Swipe left/right** on mobile devices.

### Downloading gallery images

- **Download JPG** button downloads the currently previewed image individually
- **Download Gallery** button generates a ZIP archive of all gallery images for
  that task and offers it for download
- **Download All** in the Tasks Actions panel includes gallery images from all
  completed tasks in the ZIP archive

### Gallery settings

| Setting                 | Description                                                        | Default |
| ----------------------- | ------------------------------------------------------------------ | ------- |
| **Number of frames**    | How many individual images to generate per video                   | 8       |
| **Original resolution** | Capture each image at the video's native resolution                | On      |
| **Image width**         | Custom width for each image (when original resolution is disabled) | 1920 px |

---

## VR Video

The **VR Video** dropdown lets you generate thumbnails from stereoscopic VR
video without the distracting double-image that appears when the full frame is
captured. Instead of showing both eyes side by side (or stacked), VidGrid-HTML
crops a single eye from each decoded frame before drawing it onto the canvas.

When any VR mode other than **Disabled** is selected, a note is added to the
header row (when visible) explaining that the screenshots were modified.

### Stereo layouts

VR video is recorded in one of two stereo layouts:

- **SBS (Side-by-Side):** the left and right eye views are placed next to each
  other horizontally. Each eye occupies half the frame width. Common in VR 180°
  content.
- **TB (Top-Bottom):** the left and right eye views are stacked vertically.
  Each eye occupies half the frame height. Common in VR 360° content.

### VR Video options

| Option                           | Description                                              |
| -------------------------------- | -------------------------------------------------------- |
| **Disabled**                     | No VR processing. The full frame is used as-is (default) |
| **SBS - Crop Left Eye**          | Crops the left half of a Side-by-Side frame              |
| **SBS - Crop Right Eye**         | Crops the right half of a Side-by-Side frame             |
| **TB - Crop Top (Left Eye)**     | Crops the top half of a Top-Bottom frame                 |
| **TB - Crop Bottom (Right Eye)** | Crops the bottom half of a Top-Bottom frame              |

### Limitations

- **Crop only, no projection correction:** The tool isolates one eye from the
  stereo pair but does not reproject the image (e.g. equirectangular to flat
  perspective). Thumbnails from 180° or 360° content will retain the
  characteristic barrel distortion of those formats.
- **Manual format selection:** VidGrid-HTML does not attempt to auto-detect
  whether a file is VR or which stereo layout it uses. Select the correct mode
  for your content.

---

## Presets

The 🗂️ dropdown at the top of the options panel lets you manage named presets:

- **Select a preset** from the dropdown to instantly apply its settings.
- **`<Default Preset>`** is a permanent, undeletable entry that resets all
  settings to the factory defaults.
- **💾 Save / Add preset:** opens an inline name field pre-filled with the current
  preset name (or blank when `<Default Preset>` is selected). Enter a name and
  confirm to create a new preset or overwrite an existing one with the same name.
- **🗑️ Delete preset:** removes the currently selected preset. Disabled when
  `<Default Preset>` is selected.

Presets are stored in the browser's `localStorage` and persist between sessions.
The last selected preset will also be restored when you return. All settings are
included in saved presets — grid options, style, output modes, animation
settings, VR mode, and any custom grid template. Custom timestamps are per-file
and are not stored in presets.

### Built-in Presets

On first launch, a set of ready-to-use presets is added for
common workflows. These are seeded only on a fresh install and can be
modified, saved under new names, or deleted like any other preset.

---

## Uploading

Once one or more destinations are added and enabled (see [Settings](#settings))
and processing is complete:

- Each task card shows a **☁️ Upload** button. Clicking it uploads that grid
  to all enabled destinations.
- The **☁️ Upload All** button in the tasks header uploads every completed
  grid to all enabled destinations in sequence, with a short delay between
  requests to respect rate limits.
  Upload progress is shown per-destination on each task card. Once complete,
  the card expands a link panel for each destination (see below).

### Copying Links

After a successful upload, each task item shows a collapsible link panel
(one per destination). Expand it with the destination name button to access the
following link formats:

| Format                     | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| **BBCode — full image**    | `[img]...[/img]` tag                                                        |
| **BBCode — medium**        | Medium-size image linking to the viewer page (when provided by host)        |
| **BBCode — thumbnail**     | Thumbnail linking to the viewer page                                        |
| **BBCode — Post Template** | Complete forum-ready block with bold title, resolution, and thumbnail links |
| **Direct URL**             | Full-resolution image link                                                  |
| **Viewer page**            | Host viewer/page URL                                                        |
| **Markdown**               | `![alt](url)`                                                               |
| **HTML img**               | `<img src="..." alt="..." />`                                               |

Each row has an individual **Copy** button. You can also **delete the image**
from the host using the **🗑 Delete** link in the panel header — this opens the
host's delete URL in a new tab.

#### BBCode — Post Template

The **Post Template** format generates a complete, forum-ready BBCode block
ready to paste directly into a forum post. Each entry produces output like:

```bbcode
[b]video-name 1080p[/b]
[url=page-url][img]thumbnail-url[/img][/url]
```

The first line displays the video filename in bold with its resolution. The
second line contains clickable thumbnail images that link to the full-size
viewer page — one link per upload destination.

When multiple destinations are configured, all thumbnail links appear on the
same line separated by spaces. When a provider doesn't support hotlinking
(e.g. Filester), the format falls back to a plain text link instead of an
image.

This format is especially useful when posting video summaries on forums
that support BBCode. Use **Copy All** in the Tasks Actions panel to
generate Post Template blocks for all uploaded tasks at once.

This also enables more options in the [Task Actions](#tasks-actions) panel to
copy the same formats but for all the completed (and uploaded) tasks.

---

## Settings

A few app-wide settings are available through the **⚙️ Settings** icon in the header. The settings dialog is organized into three tabs: **General**, **Uploads**, and **Animations**.

### General Tab

| Setting           | Description                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Themes**        | Choose a visual style for the app (Dark, Light, Dimmed, or Classic). The change visually applies immediately to the UI but need to be saved to persist. |
| **Show Previews** | Toggle visibility of thumbnail previews in the tasks list.                                                                                              |

### Uploads Tab

This tab manages upload destinations and CORS Tunnel status:

| Setting          | Description                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| **CORS Tunnel**  | Status and management for the [CORS Tunnel](#cors-restrictions) userscript.                                       |
| **Destinations** | Configure, enable/disable, edit, and delete upload destinations. See [Upload Destinations](#upload-destinations). |

#### Upload Destinations

VidGrid-HTML supports several image/file hosting providers out of the box.
Each provider has its own authentication requirements, URL format, and file
size limits.

| Provider     | API Key Required | Max File Size | Hotlinking? | Notes                                                                 |
| ------------ | ---------------- | ------------- | ----------- | --------------------------------------------------------------------- |
| **ImgBB**    | Yes              | 32 MB         | Yes         | Chevereto-compatible, `{key}` placeholder in URL                      |
| **Catbox**   | No (optional)    | 200 MB        | Yes         | Anonymous uploads supported; userhash enables file deletion           |
| **im.ge**    | Yes              | 100 MB        | Yes         | Base API URL style                                                    |
| **Filester** | No (optional)    | 10 GB         | No          | Guest uploads supported; API key enables file deletion; no hotlinking |

All destinations are configured in **Settings > Upload Destinations** and
persist in `localStorage` between sessions.

##### CORS restrictions

Some image hosts do not send proper `Access-Control-Allow-Origin` headers on
their upload endpoints, which causes the browser to block the response with a
**CORS (Cross-Origin Resource Sharing)** error. When this happens, the upload
usually fails.

VidGrid-HTML features a **CORS Tunnel** userscript that works around this
limitation. The userscript runs inside your browser's userscript manager
(Tampermonkey, Violentmonkey, or Greasemonkey) and uses the manager's
`GM_xmlhttpRequest` feature, which is exempt from CORS restrictions.

**How it works:**

1. When an upload fails with a CORS error, VidGrid-HTML automatically detects
   the failure and attempts to retry through the tunnel.
2. If the userscript is installed, updated and active, the retried upload succeeds
   transparently — no manual intervention needed.
3. If the userscript is not installed or updated, you'll see an error message
   explaining the issue. A help modal appears on the first occurrence with
   instructions on how to install/update the userscript.

**Installing the userscript:**

1. Install a userscript manager addon/extension for your browser:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
   - [Violentmonkey](https://violentmonkey.github.io/) (Firefox, Chromium)
   - [Greasemonkey](https://www.greasespot.net/) (Firefox)
2. In VidGrid-HTML, when you encounter a CORS error, click **Download** in the help
   dialog to get the pre-configured `.user.js` file or use the **View Code** button
   and copy the code with the **Copy** button (top-right) in the
   modal window that opens.
3. If you have downloaded the file, open it in your browser, your userscript manager
   will prompt you to install it. If you have copied the code, create a new script
   in your userscript manager, paste the code, save it.
4. The userscript is now installed, refresh the VidGrid-HTML page and retry the upload.

The userscript is scoped to the origin where VidGrid-HTML is running and does
not interfere with other websites.

If you want to choose to ignore this error you can permanently dismiss the CORS help
modal by clicking **Don't show again**. This choice can be changed at any time in the
**Settings** (⚙️ icon top-right), you also can find the **Download** and **View Code**
buttons to install the **CORS Tunnel** at the same place.

#### Managing destinations

Click **☁️ Upload Destinations** in the Settings to open the destination
manager. From there you can:

- **Add** a new destination by clicking **＋ Add destination** and filling in
  its name, type, upload URL, and API key.
- **Edit** an existing destination with the ✏️ button.
- **Enable / disable** a destination with its toggle (✅ / ⬜) without deleting it.
  Disabled destinations are skipped during uploads.
- **Delete** a destination with the 🗑️ button.
- Click **Save & close** to persist your changes, or **Discard changes** to
  cancel.
  Destinations are stored in `localStorage` alongside presets and persist between
  sessions.

### Animations Tab

Found in the **Animations** tab of the Settings dialog, these thresholds help you identify when an animated output might be too large for upload hosts or browser memory limits:

| Setting        | Description                                                                                                                    | Default    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **Max Frames** | Warning threshold for total frame count in animated output. Values above this limit are highlighted with an amber warning.     | 120 frames |
| **Max Pixels** | Warning threshold for total pixel count (canvas area × frames). Values above this limit are highlighted with an amber warning. | 50 MP      |

Set either threshold to **0** to disable that warning. The warnings appear both in the Info Panel while processing (as "Animation estimates") and after completion (as "Output details") on each task card.

---

## Keyboard Shortcuts

| Shortcut         | Action                                                             |
| ---------------- | ------------------------------------------------------------------ |
| `Ctrl` + `Enter` | Start processing the current batch from anywhere on the page       |
| `Space`          | Play/pause video (inside the Timestamp Editor)                     |
| `M`              | Add a marker at the current position (inside the Timestamp Editor) |
| `Esc`            | Close the Timestamp Editor modal                                   |
| `←` / `→`        | Seek 1 second (inside the Timestamp Editor)                        |
| `Ctrl` + `←/→`   | Seek frame by frame (inside the Timestamp Editor)                  |
| `Shift` + `←/→`  | Seek 5 seconds (inside the Timestamp Editor)                       |

---

## Troubleshooting

### Corrupt or missing settings

VidGrid-HTML stores presets, destinations and app settings in the browser's
`localStorage`. In rare cases this data can become corrupt — for example after
an abrupt browser shutdown or a failed write. If the app behaves strangely
(presets disappear, settings don't save, options look wrong), try these steps:

1. **Reload the page** — settings are automatically validated on each load,
   and most issues self-repair.
2. **Clear localStorage** — open your browser's developer tools (F12), go to
   Application → Storage → Local Storage, and delete the `vidgrid-settings`
   entry. The app will restart with fresh defaults on the next load.
3. **Clear all site data** — as a last resort, clear all cookies and site data
   for the page in your browser settings.

### FFmpeg generations keep failing

See the [Native FFmpeg](#native-ffmpeg) section for codec support and
recovery steps.

---

## Native FFmpeg

Frame extraction fallback (for formats the browser's native `<video>`
decoder can't handle) and all encoding (animated WebP, MP4, sequence-with-
audio) run through a real `ffmpeg`/`ffprobe` binary via a Python subprocess
— not WebAssembly. This removes most of the old limitations:

- **No WASM memory heap ceiling:** ffmpeg reads/writes real files on disk,
  so peak memory use is governed by your system RAM, not a fixed WASM heap.
- **Real multi-threading:** decode/encode use however many threads your
  ffmpeg build enables, and separate videos in a batch process concurrently
  (one native ffmpeg process each, up to your CPU's core count) instead of
  one at a time.
- **Broad codec support, including AV1:** whatever your bundled `ffmpeg`
  build supports (verify with `ffmpeg -decoders`). The AV1 decode path in
  particular is dramatically faster than the old WASM build.
- **Stalled processing:** if a task hangs, the collapsible "FFmpeg Logs"
  container on its task card still shows a **Kill** button, which now
  terminates that task's real ffmpeg subprocess directly.

If a generation fails, check the task's "FFmpeg Logs" panel for the actual
ffmpeg stderr output — it's the most reliable way to tell whether it's a
codec issue, a corrupt file, or something else.

**Note on disk usage:** since browsers don't expose real filesystem paths,
every file you add is copied once into a local temp folder so ffmpeg has a
real path to work with. For large batches this temporarily uses roughly as
much extra disk space as the total size of your input videos; the temp
folder is removed automatically when the server stops (`Ctrl+C`).

---

## Requirements

**Windows** or **Linux**, plus a modern browser (Chrome/Edge/Firefox) --
the app opens in your regular browser, it's not an embedded native window.
No other system packages needed. The app can bundle its own
`ffmpeg`/`ffprobe` in `bin/` (no separate install needed), or fall back to
`ffmpeg`/`ffprobe` already on `PATH` if `bin/` is empty — the latter is
usually the simplest option on Linux, where distro ffmpeg packages commonly
already support AV1.

---

## Development

```bash
npm install
npm run dev              # local Vite dev server (frontend only)
npm run build             # production build → dist/
npm run preview           # preview the production build locally
npm run test               # run the test suite
npm run test:coverage      # generate the test coverage report
```

`npm run dev` is useful for iterating on layout/styling, but its dev server
doesn't proxy `/api/*` anywhere — ffprobe metadata and ffmpeg processing
need the real Python backend behind those routes (the file picker itself
works fine, since it's just the browser's own `<input type=file>`). Use
`python -m desktop.app` (see [Desktop App](#desktop-app)) for full
end-to-end testing; it serves the last `npm run build` output plus the
`/api/*` routes on the same origin.

See [RELEASE.md](./RELEASE.md) for deployment instructions.

## Tech stack

**Frontend:**
- [Vite](https://vitejs.dev/) with TypeScript
- [React JS](https://react.dev/)
- [Zustand/Immer](https://zustand.site/) — state management and middleware
- [Testing Library](https://testing-library.com/)/[vitest](https://vitest.dev/)/[happy-dom](https://github.com/capricorn86/happy-dom) — testing suite
- [TailwindCSS](https://tailwindcss.com/)
- [Radix UI](https://www.radix-ui.com/)
- [@formkit/auto-animate](https://github.com/formkit/auto-animate) — smooth layout transitions
- [Lucide](https://lucide.dev/)
- [JSZip](https://github.com/Stuk/jszip) — compressing gallery output for manual download
- [FileSaver.js](https://github.com/eligrey/FileSaver.js/) — manual-download helper
- [color-picker](https://github.com/markoradak/color-picker)
- HTML5 Canvas API — grid compositing and JPEG/PNG encoding
- HTML5 Video API — native frame seeking for supported formats

**Desktop backend (`desktop/`):**
- Plain `http.server` (stdlib, no third-party dependencies at all) serving
  the built frontend, a JSON API, and a Range-supporting media endpoint for
  uploaded video files, opened in the user's regular browser via
  `webbrowser.open()`
- Server-Sent Events (`/api/events`) for real-time ffmpeg log/progress push
- `/api/upload_input` streams browser-picked files to local temp copies, so
  ffmpeg gets a real filesystem path even though browsers don't expose one
- Real `ffmpeg`/`ffprobe` binaries, driven via `subprocess` (no ffmpeg-wasm/mediainfo.js)
- [PyInstaller](https://pyinstaller.org/) — standalone executable packaging (Windows `.exe`, Linux binary)

## License

See the LICENSE file for details.

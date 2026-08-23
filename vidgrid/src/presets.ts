import type {
  AppSettings,
  GridCell,
  OutputMode,
  Presets,
  SavedOptions,
  UploadDestination,
} from "./types";
import { createVersionedStorage } from "./services/storage.service";
import {
  APP_STORAGE_KEY,
  DEFAULTS,
  ESTIMATION_MAX_FRAMES,
  ESTIMATION_MAX_PIXELS,
  OUTPUT_MODES,
} from "./constants";

// ---------------------------------------------------------------------------
// Built-in Presets
// ---------------------------------------------------------------------------
// Easily editable: add, remove, or tweak presets here.
// Each preset defines only the fields that differ from DEFAULTS, so new fields
// added to DEFAULTS automatically propagate to all presets.
// Seeded only on a completely fresh install (no localStorage data).
// ---------------------------------------------------------------------------

/** Helper to build a row of cells. */
function row(y: number, count: number): GridCell[] {
  const w = 60 / count;
  return Array.from({ length: count }, (_, i) => ({
    id: `cell-${y}-${i}`,
    x: i,
    y,
    w,
    h: 1,
  }));
}

/** A built-in preset: partial overrides merged with DEFAULTS at seed time. */
type BuiltInPreset = { name: string; opts: Partial<SavedOptions> };

export const BUILT_IN_PRESETS: BuiltInPreset[] = [
  {
    name: "Hero Shot",
    opts: {
      gridTemplate: {
        cols: 60,
        cells: [...row(0, 3), ...row(1, 1), ...row(2, 3)],
      },
    },
  },
  {
    name: "Animated Hero Light",
    opts: {
      width: 1152,
      outputMode: "animated",
      webpMethod: 6,
      webpQuality: 75,
      gridTemplate: {
        cols: 60,
        cells: [...row(0, 3), ...row(1, 1), ...row(2, 3)],
      },
    },
  },
  {
    name: "Balanced",
    opts: {
      gridTemplate: {
        cols: 60,
        cells: [...row(0, 1), ...row(1, 2), ...row(2, 1)],
      },
    },
  },
  {
    name: "8 Frames Gallery",
    opts: {
      outputMode: "gallery",
      galleryCount: 8,
      galleryOriginalResolution: true,
      tcPosition: "disabled",
    },
  },
  {
    name: "Film Strip",
    opts: {
      width: 2560,
      cols: 6,
      rows: 2,
      gridTemplate: {
        cols: 60,
        cells: [
          ...row(0, 1),
          ...row(1, 6),
          ...row(2, 1),
          ...row(3, 6),
          ...row(4, 1),
        ],
      },
    },
  },
  {
    name: "Spotlight",
    opts: {
      cols: 2,
      rows: 3,
      gridTemplate: {
        cols: 60,
        cells: [...row(0, 2), ...row(1, 1), ...row(2, 2)],
      },
    },
  },
  {
    name: "Storyboard",
    opts: {
      cols: 1,
      rows: 8,
    },
  },
  {
    name: "Bento Box",
    opts: {
      cols: 2,
      rows: 4,
      gridTemplate: {
        cols: 60,
        cells: [...row(0, 2), ...row(1, 1), ...row(2, 1), ...row(3, 2)],
      },
    },
  },
  {
    name: "Quick Preview",
    opts: {
      width: 1280,
      rows: 2,
    },
  },
  {
    name: "4K Archive",
    opts: {
      width: 3840,
      cols: 4,
      rows: 6,
      spacing: 4,
    },
  },
  {
    name: "VR Side-by-Side",
    opts: {
      vrMode: "sbs-left",
    },
  },
  {
    name: "VR Top-Bottom",
    opts: {
      vrMode: "tb-left",
    },
  },
  {
    name: "Sequence Static Frames WebP",
    opts: {
      width: 1280,
      outputMode: "sequence",
      sequenceMode: "static",
      animSegments: 10,
      animFormat: "webp",
      animDuration: 2,
      animFps: 1,
      webpMethod: 6,
      webpQuality: 75,
    },
  },
  {
    name: "Sequence Video WebP",
    opts: {
      width: 1024,
      outputMode: "sequence",
      sequenceMode: "video",
      animSegments: 6,
      animFormat: "webp",
      animDuration: 3,
      animFps: 10,
      webpMethod: 6,
      webpQuality: 75,
    },
  },
  {
    name: "Sequence Video MP4",
    opts: {
      width: 1024,
      outputMode: "sequence",
      sequenceMode: "video",
      animSegments: 8,
      animFormat: "mp4",
      animDuration: 3,
      animFps: 10,
    },
  },
  {
    name: "Sequence Video with audio MP4",
    opts: {
      width: 1024,
      outputMode: "sequence",
      sequenceMode: "video_with_audio",
      animSegments: 5,
      animFormat: "mp4",
      animDuration: 5,
      animFps: 30,
    },
  },
];

// ---------------------------------------------------------------------------
// Defaults & Storage
// ---------------------------------------------------------------------------

const DEFAULT: AppSettings = {
  presets: { entries: {}, lastUsed: null },
  destinations: [],
  theme: "dark",
  showPreview: true,
  corsModalDismissed: false,
  estimationMaxFrames: ESTIMATION_MAX_FRAMES,
  estimationMaxPixels: ESTIMATION_MAX_PIXELS,
};

/**
 * Ensure settings object has all required keys with safe defaults.
 * This handles corrupt or incomplete settings (e.g., old data missing
 * schema-migration keys) by merging with defaults for any missing fields.
 */
const ensureValidSettings = (settings: AppSettings): AppSettings => {
  const presets =
    settings.presets && typeof settings.presets === "object"
      ? settings.presets
      : {};
  const entries: Presets =
    "entries" in presets &&
    presets.entries &&
    typeof presets.entries === "object"
      ? (presets.entries as Presets)
      : DEFAULT.presets.entries;
  return {
    ...DEFAULT,
    ...settings,
    presets: {
      ...DEFAULT.presets,
      ...presets,
      entries,
    },
  };
};

/**
 * Singleton VersionedStorage instance for app settings.
 * Handles schema versioning and migration automatically.
 */
const storage = createVersionedStorage();

/**
 * Seed built-in presets into localStorage if this is a completely fresh install
 * (no app settings stored at all). Once the user has any settings — even if
 * they delete all presets — we do not re-seed.
 */
export const seedBuiltInPresets = (): void => {
  /* Only seed on a truly fresh install — no data in localStorage at all.
     If the user deletes all presets manually, we respect that choice and do
     NOT re-seed on the next load. */
  const raw = localStorage.getItem(APP_STORAGE_KEY);
  if (raw !== null) return;

  const settings = ensureValidSettings(structuredClone(DEFAULT));
  settings.presets.entries = Object.fromEntries(
    BUILT_IN_PRESETS.map((p) => [
      p.name,
      { ...structuredClone(DEFAULTS), ...structuredClone(p.opts) },
    ]),
  );
  storage.save(settings);
};

/**
 * Load the full AppSettings object from localStorage.
 * Returns a safe default if nothing is stored or parsing fails.
 * Automatically runs schema migrations if needed.
 */
export const loadAppSettings = (): AppSettings =>
  ensureValidSettings(storage.load(() => structuredClone(DEFAULT)));

/**
 * Persist the full AppSettings object to localStorage.
 * Wraps data in VersionedSettings with current schema version.
 *
 * @param settings - The settings object to store.
 */
export const persistAppSettings = (settings: AppSettings): void => {
  storage.save(settings);
};

// ---------------------------------------------------------------------------
// Preset grouping helper
// ---------------------------------------------------------------------------

/**
 * Group preset entries by their `outputMode`.
 * Returns an array of `{ mode, label, names }` sorted by OUTPUT_MODES order,
 * with preset names sorted alphabetically within each group.
 */
export function getPresetsGroupedByMode(
  entries: Presets,
): { mode: OutputMode; label: string; names: string[] }[] {
  const groups = new Map<OutputMode, string[]>();
  for (const m of OUTPUT_MODES) {
    groups.set(m.value, []);
  }

  for (const name of Object.keys(entries)) {
    const mode = (entries[name].outputMode ??
      DEFAULTS.outputMode ??
      "static") as OutputMode;
    const group = groups.get(mode);
    if (group) group.push(name);
  }

  for (const names of groups.values()) {
    names.sort((a, b) => a.localeCompare(b));
  }

  return OUTPUT_MODES.map((m) => ({
    mode: m.value,
    label: m.title,
    names: groups.get(m.value)!,
  }));
}

// Preset display helpers

/**
 * Lookup the display title for an output mode from shared constants.
 */
function getModeTitle(mode: OutputMode): string {
  return OUTPUT_MODES.find((m) => m.value === mode)?.title ?? "Static";
}

/**
 * Compute a human-readable summary string for a preset, e.g.
 * "Static Grid, 1920px, 3×4" or "Animated Grid, 1280px, Custom: 3 | 1 | 3 (SBS)".
 * Pure display concern — does not modify stored preset names.
 */
export function getPresetSummary(opts: SavedOptions): string {
  const outputMode = opts.outputMode ?? DEFAULTS.outputMode ?? "static";
  const isSequence = outputMode === "sequence";
  const isGallery = outputMode === "gallery";

  const mode = getModeTitle(outputMode);

  const width = `${opts.width}px`;

  // Gallery mode shows frame count and resolution info
  if (isGallery) {
    const res =
      (opts.galleryOriginalResolution ?? DEFAULTS.galleryOriginalResolution)
        ? "Original"
        : width;
    return `${mode} · ${res} · ${opts.galleryCount ?? DEFAULTS.galleryCount ?? 6} frames`;
  }

  // Sequence mode shows segments instead of grid
  if (isSequence) {
    let fmt = "";
    if (opts.animFormat === "mp4") fmt = " (MP4)";
    else if (opts.animFormat === "webp") fmt = " (WebP)";
    return `${mode} · ${width} · ${opts.animSegments} segments${fmt}`;
  }

  let grid: string;
  if (opts.gridTemplate && opts.gridTemplate.cells.length > 0) {
    // Group cells by row and show cell count per row
    const rowCounts: number[] = [];
    const byRow = new Map<number, number>();
    for (const cell of opts.gridTemplate.cells) {
      byRow.set(cell.y, (byRow.get(cell.y) ?? 0) + 1);
    }
    for (let y = 0; y < byRow.size; y++) {
      rowCounts.push(byRow.get(y) ?? 0);
    }
    grid = `Custom Grid: ${rowCounts.join(" | ")}`;
  } else {
    grid = `Grid: ${opts.cols}×${opts.rows}`;
  }

  let vr = "";
  if (opts.vrMode && opts.vrMode !== "disabled") {
    if (opts.vrMode.startsWith("sbs")) vr = "(SBS)";
    else if (opts.vrMode.startsWith("tb")) vr = "(TB)";
  }

  return `${mode} · ${width} · ${grid}${vr ? ` · ${vr}` : ""}`;
}

// Preset helpers

/** Load only the presets map from persisted settings. */
export const loadPresets = (): Presets => loadAppSettings().presets.entries;

/**
 * Overwrite the presets map while preserving other settings.
 *
 * @param entries - The full replacement presets map.
 */
export const persistPresets = (entries: Presets): void => {
  const s = loadAppSettings();
  s.presets.entries = entries;
  persistAppSettings(s);
};

/** Return the name of the last-used preset, or null. */
export const getLastUsedPreset = (): string | null =>
  loadAppSettings().presets.lastUsed;

/**
 * Set the last-used preset name.
 *
 * @param name - Preset name to record, or null to clear.
 */
export const setLastUsedPreset = (name: string | null): void => {
  const s = loadAppSettings();
  s.presets.lastUsed = name;
  persistAppSettings(s);
};

/**
 * Save a named preset and mark it as last-used.
 *
 * @param name - Display name for the preset.
 * @param opts - The SavedOptions to store.
 */
export const savePreset = (name: string, opts: SavedOptions): void => {
  const entries = loadPresets();
  entries[name] = opts;
  persistPresets(entries);
  setLastUsedPreset(name);
};

/**
 * Delete a named preset. If it was the last-used preset, clears that pointer.
 *
 * @param name - The preset name to remove.
 */
export const deletePreset = (name: string): void => {
  const entries = loadPresets();
  delete entries[name];
  persistPresets(entries);
  if (getLastUsedPreset() === name) setLastUsedPreset(null);
};

// Destination helpers

/** Load the destinations array from persisted settings. */
export const loadDestinations = (): UploadDestination[] =>
  loadAppSettings().destinations;

/**
 * Overwrite the destinations array while preserving other settings.
 *
 * @param destinations - Full replacement list of upload destinations.
 */
export const persistDestinations = (
  destinations: UploadDestination[],
): void => {
  const s = loadAppSettings();
  s.destinations = destinations;
  persistAppSettings(s);
};

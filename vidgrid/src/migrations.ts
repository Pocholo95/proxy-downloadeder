/**
 * Schema migration pipeline for persisted app settings.
 *
 * Each migration function takes data at version N and returns data at version N+1.
 * New migrations are appended to the `migrations` array.
 *
 * Current schema version: 3 (defined in constants.ts as STORAGE_SCHEMA_VERSION)
 */

import type { AppSettings, Presets, SavedOptions } from "./types";
import {
  STORAGE_SCHEMA_VERSION,
  DEFAULTS,
  FONT_FACES,
  DEFAULT_DEST_ALLOWED_EXTENSIONS,
  DEFAULT_DEST_MAX_SIZE_MB,
} from "./constants";

/** - Migration functions */

/** v0 → v1: Wrap legacy raw settings into versioned format */
function migrateV0toV1(data: unknown): AppSettings {
  // If data is already at v0 format (raw AppSettings object), return as-is.
  return data as AppSettings;
}

/**
 * v3 → v4: Add allowedExtensions and maxSizeMb fields to upload destinations.
 *
 * Destinations created before v4 lack per-host upload constraints.
 * This migration injects default values so existing destinations continue
 * to work correctly.
 */
function migrateV3toV4(data: unknown): AppSettings {
  const settings = data as AppSettings;
  if (!settings?.destinations) return settings;

  type LegacyDest = Record<string, unknown>;

  const migratedDests = settings.destinations.map((dest) => {
    const legacy = dest as LegacyDest;
    return {
      ...dest,
      allowedExtensions:
        typeof legacy.allowedExtensions === "string" &&
        legacy.allowedExtensions.trim()
          ? legacy.allowedExtensions
          : DEFAULT_DEST_ALLOWED_EXTENSIONS,
      maxSizeMb:
        typeof legacy.maxSizeMb === "number" &&
        Number.isFinite(legacy.maxSizeMb)
          ? legacy.maxSizeMb
          : DEFAULT_DEST_MAX_SIZE_MB,
    };
  });

  return {
    ...settings,
    destinations: migratedDests,
  };
}

/**
 * v1 → v2: Add font-related fields, rename position → tcPosition, remove preview.
 *
 * Presets created before v2 lack `fontFamily`, `tcFontSizeAuto`, `tcFontSize`,
 * `headerFontSizeAuto`, and `headerFontSize`. This migration injects sensible
 * defaults so existing presets continue to work correctly.
 *
 * Additionally:
 * - Renames `position` to `tcPosition` (same value, clearer name).
 * - Removes the obsolete `preview` field (was never read by app logic).
 */
function migrateV1toV2(data: unknown): AppSettings {
  const settings = data as AppSettings;
  if (!settings?.presets?.entries) return settings;

  // Legacy preset shape before v2 (includes obsolete `preview` and `position`)
  type LegacyPreset = Record<string, unknown>;

  const migratedEntries: Presets = Object.fromEntries(
    Object.entries(settings.presets.entries).map(([key, opts]) => {
      const legacy = opts as LegacyPreset;
      const rest: Record<string, unknown> = {};

      // Copy all fields except obsolete `preview` and legacy `position`
      for (const [k, v] of Object.entries(legacy)) {
        if (k !== "preview" && k !== "position") {
          rest[k] = v;
        }
      }

      return [
        key,
        {
          ...rest,
          // Rename position → tcPosition (preserve existing value if present)
          tcPosition:
            (legacy.tcPosition as string) ??
            (legacy.position as string) ??
            DEFAULTS.tcPosition,
          fontFamily:
            typeof rest.fontFamily === "string" && rest.fontFamily
              ? rest.fontFamily
              : FONT_FACES[0],
          tcFontSizeAuto:
            typeof rest.tcFontSizeAuto === "boolean"
              ? rest.tcFontSizeAuto
              : DEFAULTS.tcFontSizeAuto,
          tcFontSize:
            typeof rest.tcFontSize === "number" &&
            Number.isFinite(rest.tcFontSize)
              ? rest.tcFontSize
              : DEFAULTS.tcFontSize,
          headerFontSizeAuto:
            typeof rest.headerFontSizeAuto === "boolean"
              ? rest.headerFontSizeAuto
              : DEFAULTS.headerFontSizeAuto,
          headerFontSize:
            typeof rest.headerFontSize === "number" &&
            Number.isFinite(rest.headerFontSize)
              ? rest.headerFontSize
              : DEFAULTS.headerFontSize,
        } as SavedOptions,
      ];
    }),
  ) as Presets;

  return {
    ...settings,
    presets: {
      ...settings.presets,
      entries: migratedEntries,
    },
  };
}

/**
 * v2 → v3: Add animSegments and animFormat fields.
 *
 * Presets created before v3 lack the new sequence mode fields.
 * This migration injects default values so existing presets continue
 * to work correctly with the new sequence mode feature.
 */
function migrateV2toV3(data: unknown): AppSettings {
  const settings = data as AppSettings;
  if (!settings?.presets?.entries) return settings;

  type LegacyPreset = Record<string, unknown>;

  const migratedEntries: Presets = Object.fromEntries(
    Object.entries(settings.presets.entries).map(([key, opts]) => {
      const legacy = opts as LegacyPreset;

      return [
        key,
        {
          ...opts,
          animSegments:
            typeof legacy.animSegments === "number" &&
            Number.isFinite(legacy.animSegments)
              ? legacy.animSegments
              : DEFAULTS.animSegments,
          animFormat:
            (legacy.animFormat as "webp" | "mp4") === "mp4"
              ? "mp4"
              : DEFAULTS.animFormat,
        } as SavedOptions,
      ];
    }),
  ) as Presets;

  return {
    ...settings,
    presets: {
      ...settings.presets,
      entries: migratedEntries,
    },
  };
}

/**
 * v4 → v5: Add corsModalDismissed field to AppSettings.
 *
 * Settings created before v5 lack the `corsModalDismissed` flag which controls
 * whether the CORS help modal is shown when uploads fail with cross-origin
 * errors. Default is false (modal will be shown).
 */
function migrateV4toV5(data: unknown): AppSettings {
  const settings = data as AppSettings;
  return {
    ...settings,
    corsModalDismissed: settings?.corsModalDismissed ?? false,
  };
}

/**
 * v5 → v6: Add outputMode field, gallery defaults, sectionStates, and remove legacy booleans.
 *
 * Presets created before v6 lack the unified `outputMode` selector,
 * gallery-related fields, and the new `overlays` key in `sectionStates`.
 * This migration derives `outputMode` from the existing `animated`/`animSequence`
 * booleans, removes those deprecated fields, adds gallery defaults, and ensures
 * `sectionStates` contains all four section keys (grid, style, modes, overlays).
 */
function migrateV5toV6(data: unknown): AppSettings {
  const settings = data as AppSettings;
  if (!settings?.presets?.entries) return settings;

  type LegacyPreset = Record<string, unknown>;

  const migratedEntries: Presets = Object.fromEntries(
    Object.entries(settings.presets.entries).map(([key, opts]) => {
      const legacy = opts as LegacyPreset;

      // Derive outputMode from legacy booleans
      const animated = legacy.animated === true;
      const animSequence = legacy.animSequence === true;
      let outputMode = DEFAULTS.outputMode;
      if (animated) {
        outputMode = animSequence ? "sequence" : "animated";
      }

      // Remove legacy fields by spreading without them
      const {
        animated: _animated,
        animSequence: _animSequence,
        ...rest
      } = legacy;
      void _animated;
      void _animSequence;

      return [
        key,
        {
          ...rest,
          outputMode,
          galleryCount:
            typeof legacy.galleryCount === "number" &&
            Number.isFinite(legacy.galleryCount)
              ? legacy.galleryCount
              : DEFAULTS.galleryCount,
          galleryOriginalResolution:
            typeof legacy.galleryOriginalResolution === "boolean"
              ? legacy.galleryOriginalResolution
              : DEFAULTS.galleryOriginalResolution,
          sectionStates: {
            grid:
              (legacy.sectionStates as Record<string, boolean>)?.grid ??
              DEFAULTS.sectionStates?.grid ??
              true,
            style:
              (legacy.sectionStates as Record<string, boolean>)?.style ??
              DEFAULTS.sectionStates?.style ??
              true,
            modes:
              (legacy.sectionStates as Record<string, boolean>)?.modes ??
              DEFAULTS.sectionStates?.modes ??
              true,
            overlays:
              (legacy.sectionStates as Record<string, boolean>)?.overlays ??
              DEFAULTS.sectionStates?.overlays ??
              true,
          },
        } as SavedOptions,
      ];
    }),
  ) as Presets;

  return {
    ...settings,
    presets: {
      ...settings.presets,
      entries: migratedEntries,
    },
  };
}

/** - Migration registry - ordered from oldest to newest - END */

/**
 * Array of migration functions. Index i migrates from version i to i+1.
 */
const migrations: Array<(data: unknown) => AppSettings> = [
  migrateV0toV1,
  migrateV1toV2,
  migrateV2toV3,
  migrateV3toV4,
  migrateV4toV5,
  migrateV5toV6,
];

/** - Public API */

/**
 * Run the migration pipeline on settings data.
 *
 * @param data - Settings data at the given schema version.
 * @param fromVersion - Current schema version of the data.
 * @returns Migrated settings at the latest schema version.
 */
export function migrateSettings(
  data: AppSettings,
  fromVersion: number,
): AppSettings {
  // If already at latest version, no migration needed
  if (fromVersion >= STORAGE_SCHEMA_VERSION) {
    return data;
  }

  let current = data;
  for (let v = fromVersion; v < STORAGE_SCHEMA_VERSION; v++) {
    const migration = migrations[v];
    if (!migration) {
      // Missing migration - skip to avoid data loss
      continue;
    }
    current = migration(current);
  }
  return current;
}

/**
 * Check if a migration is needed for the given version.
 */
export function needsMigration(fromVersion: number): boolean {
  return fromVersion < STORAGE_SCHEMA_VERSION;
}

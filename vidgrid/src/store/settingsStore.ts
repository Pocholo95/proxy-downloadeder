import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  loadAppSettings,
  persistAppSettings,
  seedBuiltInPresets,
} from "@/presets";
import type { AppSettings } from "@/types";
import { resetBatchState } from "@/lib/cors-tunnel";

/**
 * Zustand store for app settings, theme, presets, and upload destinations.
 * Replaces: src/context/settingsContext.tsx + src/hooks/useAppSettings.ts
 *
 * Settings are persisted to localStorage immediately on every change.
 * No snapshot tracking is needed since changes auto-save.
 */
interface SettingsState {
  // --- Core state ---
  settings: AppSettings;

  // --- Settings dialog ---
  showSettingsDialog: boolean;

  // --- Actions ---
  loadSettings: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  updateDestinations: (dests: AppSettings["destinations"]) => void;
  handleThemeChange: (theme: AppSettings["theme"]) => void;
  handleShowPreviewChange: (show: boolean) => void;

  // --- Dialog ---
  setShowSettingsDialog: (open: boolean) => void;
  handleOpenSettingsDialog: () => void;
  handleCloseSettingsDialog: () => void;

  // --- Helpers ---
  applyTheme: (theme: AppSettings["theme"]) => void;
}

export const useSettingsStore = create<SettingsState>()(
  immer((set) => ({
    // --- Initial state ---
    settings: loadAppSettings(),
    showSettingsDialog: false,

    // --- Load from localStorage ---
    loadSettings: () => {
      set((state) => {
        state.settings = loadAppSettings();
      });
    },

    // --- Update settings (persist immediately) ---
    updateSettings: (patch) =>
      set((state) => {
        Object.assign(state.settings, patch);
        // When the user toggles corsModalDismissed off in the settings dialog,
        // also reset the CORS tunnel's per-batch flag so the modal can show
        // again on the next upload attempt.
        if (patch.corsModalDismissed === false) {
          resetBatchState();
        }
        persistAppSettings(state.settings);
      }),

    // --- Update destinations (persist immediately) ---
    updateDestinations: (dests) =>
      set((state) => {
        state.settings.destinations = dests;
        persistAppSettings(state.settings);
      }),

    // --- Theme ---
    handleThemeChange: (theme) =>
      set((state) => {
        state.settings.theme = theme;
        persistAppSettings(state.settings);
        document.documentElement.className = theme;
      }),

    handleShowPreviewChange: (show) =>
      set((state) => {
        state.settings.showPreview = show;
        persistAppSettings(state.settings);
      }),

    applyTheme: (theme) => {
      document.documentElement.className = theme;
    },

    // --- Dialog ---
    setShowSettingsDialog: (open) =>
      set((state) => {
        state.showSettingsDialog = open;
      }),

    handleOpenSettingsDialog: () =>
      set((state) => {
        state.showSettingsDialog = true;
      }),

    handleCloseSettingsDialog: () =>
      set((state) => {
        state.showSettingsDialog = false;
      }),
  })),
);

/** Seed built-in presets on fresh install, reload settings, then apply theme. */
seedBuiltInPresets();
useSettingsStore.getState().loadSettings();
useSettingsStore
  .getState()
  .applyTheme(useSettingsStore.getState().settings.theme);

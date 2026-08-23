import { useCallback, useState } from "react";
import type { AppSettings, Presets, UploadDestination } from "@/types";
import { loadAppSettings as loadRaw, persistAppSettings } from "@/presets";

export function useAppSettings() {
  // Load persisted settings once on mount (these are the original/saved values)
  const [savedSettings, setSavedSettings] = useState<AppSettings>(() =>
    loadRaw(),
  );

  // Track pending changes for preview-only fields (theme, showPreview) - not yet saved to localStorage
  const [pendingSettings, setPendingSettings] = useState<Partial<AppSettings>>(
    {},
  );

  // Helper: Get merged "current" settings (for visual preview in UI before save)
  const getCurrentSettings = useCallback(() => {
    return { ...savedSettings, ...pendingSettings };
  }, [savedSettings, pendingSettings]);

  // Update can either just update preview OR persist immediately based on fields
  // Fields that always persist immediately: presets, destinations
  // Fields in preview mode (theme, showPreview): require saveSettings() to persist
  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      // Check if this is a persistent field (not theme or showPreview)
      const shouldPersist =
        patch.presets !== undefined || patch.destinations !== undefined;

      if (shouldPersist) {
        // For presets/destinations, persist immediately to localStorage AND update saved state
        const merged = { ...savedSettings, ...patch };
        persistAppSettings(merged);
        setSavedSettings(merged);
      } else {
        // For theme/showPreview, only update preview (pending)
        setPendingSettings((prev) => ({ ...prev, ...patch }));
      }

      return getCurrentSettings();
    },
    [savedSettings],
  );

  // Commit any remaining pending settings (theme, showPreview) to localStorage AND UI
  const saveSettings = useCallback(
    (persistedSettings?: AppSettings) => {
      if (!persistedSettings) {
        persistedSettings = { ...savedSettings, ...pendingSettings };
      }
      setSavedSettings(persistedSettings);
      persistAppSettings(persistedSettings);
      setPendingSettings({});
      return persistedSettings;
    },
    [savedSettings, pendingSettings],
  );

  // Reset pending settings to empty state (visual revert when dialog closes)
  const resetPending = useCallback(() => {
    setPendingSettings({});
  }, []);

  // Update a single setting and persist immediately
  const updateSettingAndPersist = useCallback(
    (key: keyof AppSettings, value: unknown) => {
      const patch: Partial<AppSettings> = { [key]: value };
      persistAppSettings({ ...savedSettings, ...patch });
      setSavedSettings({ ...savedSettings, ...patch });
    },
    [savedSettings],
  );

  // Getters that always read from saved settings only
  const getPresets = useCallback(
    (): Presets => savedSettings.presets.entries,
    [savedSettings],
  );

  const getLastUsed = useCallback(
    (): string | null => savedSettings.presets.lastUsed,
    [savedSettings],
  );

  // For destinations, we use updateDestinations helper
  const updateDestinations = useCallback(
    (dests: UploadDestination[]) => {
      const updated = { ...savedSettings, destinations: dests };
      persistAppSettings(updated);
      setSavedSettings(updated);
      return updated;
    },
    [savedSettings],
  );

  return {
    savedSettings, // Original persisted state from localStorage (never includes pending theme changes)
    getCurrentSettings, // Current merged settings (includes pending preview changes like theme)
    pendingSettings, // Preview-only changes for theme/showPreview
    updateSettings, // Update with auto-persist for presets/destinations, preview only for theme
    saveSettings, // Commit any remaining pending settings to localStorage and UI
    resetPending, // Clear pending (used on cancel/close)
    getPresets, // Shorthand for presets.entries from saved settings
    getLastUsed, // Shorthand for presets.lastUsed from saved settings
    updateDestinations, // Update destinations array (persists immediately)
    updateSettingAndPersist, // Update a single setting and persist immediately
  };
}

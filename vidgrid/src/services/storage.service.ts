/**
 * Persistent storage abstraction layer.
 * Wraps localStorage with error handling and schema versioning.
 */

import type { IStorageProvider, VersionedSettings } from "../types/service";
import type { AppSettings } from "../types";
import { APP_STORAGE_KEY, STORAGE_SCHEMA_VERSION } from "../constants";
import { migrateSettings } from "../migrations";

/** - LocalStorageProvider - thin wrapper with error handling */

export class LocalStorageProvider implements IStorageProvider {
  constructor(
    private storage: Storage = localStorage,
    private onError?: (error: unknown) => void,
  ) {}

  public getItem(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch (error) {
      this.onError?.(error);
      return null;
    }
  }

  public setItem(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch (error) {
      this.onError?.(error);
    }
  }

  public removeItem(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch (error) {
      this.onError?.(error);
    }
  }
}

/** - VersionedStorage - decorator with auto-migration */

/**
 * Wraps an IStorageProvider with schema versioning.
 * When loading, if the stored schema version is older than current,
 * the data is passed through the migration pipeline automatically.
 */
export class VersionedStorage {
  private provider: IStorageProvider;
  private key: string;

  constructor(provider: IStorageProvider, key: string = APP_STORAGE_KEY) {
    this.provider = provider;
    this.key = key;
  }

  /**
   * Load and deserialize settings, running migrations if needed.
   *
   * Migrated data is returned in memory but is **not** automatically persisted
   * back to localStorage. It will be written only when the user triggers an
   * explicit save action (change a setting, save a preset, etc.).
   *
   * This is intentional: if a migration contains a bug, the original data in
   * localStorage remains untouched, giving the user a chance to recover by
   * clearing cache or downgrading. The settings payload is small and
   * migrations are lightweight, so re-running migration on each load until the
   * first explicit save is an acceptable trade-off.
   *
   * @param defaults - Factory that returns default settings when nothing is stored.
   * @returns Current settings at the latest schema version.
   */
  public load<T extends AppSettings>(defaults: () => T): T {
    const raw = this.provider.getItem(this.key);
    if (!raw) return defaults();

    try {
      const parsed = JSON.parse(raw);

      // Legacy data without schema version - treat as v0
      const versioned = this.ensureVersioned(parsed);
      const migrated = migrateSettings(versioned.data, versioned.schemaVersion);

      // Note: migrated data is NOT auto-saved here. See method JSDoc above.
      return migrated as T;
    } catch {
      return defaults();
    }
  }

  /**
   * Serialize and save settings with current schema version.
   */
  public save(data: AppSettings): void {
    const versioned: VersionedSettings = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      data,
    };
    this.provider.setItem(this.key, JSON.stringify(versioned));
  }

  /**
   * Remove stored settings entirely.
   */
  public clear(): void {
    this.provider.removeItem(this.key);
  }

  /**
   * If the parsed value is not already a VersionedSettings object,
   * wrap it with schemaVersion 0 (legacy format).
   */
  private ensureVersioned(value: unknown): VersionedSettings {
    if (
      typeof value === "object" &&
      value !== null &&
      "schemaVersion" in value &&
      "data" in value
    ) {
      return value as VersionedSettings;
    }
    // Legacy data - wrap with version 0
    return { schemaVersion: 0, data: value as AppSettings };
  }
}

/** - Factory helper */

/**
 * Create a ready-to-use VersionedStorage backed by localStorage.
 */
export function createVersionedStorage(
  onError?: (error: unknown) => void,
): VersionedStorage {
  const provider = new LocalStorageProvider(localStorage, onError);
  return new VersionedStorage(provider);
}

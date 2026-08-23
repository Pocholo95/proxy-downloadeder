import type { UploadDestination, UploadResult, DestinationType } from "@/types";
import {
  UPLOAD_DESTINATION_PROVIDERS,
  DEFAULT_DEST_ALLOWED_EXTENSIONS,
  DEFAULT_DEST_MAX_SIZE_MB,
} from "@/constants";

/**
 * Returns the default config for a given provider type, falling back to
 * global defaults if the provider is unknown (e.g. after schema changes).
 */
export function getProviderDefaults(type: DestinationType): {
  defaultUrl: string;
  defaultAllowedExtensions: string;
  defaultMaxSizeMb: number;
} {
  const provider = UPLOAD_DESTINATION_PROVIDERS[type];
  if (provider) return provider;
  return {
    defaultUrl: "",
    defaultAllowedExtensions: DEFAULT_DEST_ALLOWED_EXTENSIONS,
    defaultMaxSizeMb: DEFAULT_DEST_MAX_SIZE_MB,
  };
}

export type OptionFieldType = "boolean";

export interface ProviderOptionSchema {
  key: string;
  label: string;
  description?: string;
  type: OptionFieldType;
  defaultValue: boolean | string | number;
}

export interface UploadProvider {
  type: DestinationType;
  optionsSchema: ProviderOptionSchema[];
  upload(
    blob: Blob,
    filename: string,
    dest: UploadDestination,
    onProgress: (pct: number) => void,
  ): Promise<UploadResult>;
  delete?(result: UploadResult, dest: UploadDestination): Promise<void>;
  canDelete?(result: UploadResult, dest: UploadDestination): boolean;
}

const providers: Map<DestinationType, UploadProvider> = new Map();

export function registerProvider(provider: UploadProvider) {
  providers.set(provider.type, provider);
}

export function getProvider(type: DestinationType): UploadProvider {
  const provider = providers.get(type);
  if (!provider) {
    throw new Error(`Unknown destination type: ${type}`);
  }
  return provider;
}

/**
 * Resolves whether direct hotlinking is supported for a given provider type.
 * Defaults to true for backward compatibility with providers that don't
 * specify the flag (most hosts allow hotlinking).
 */
export function resolveCanHotlink(type: DestinationType): boolean {
  const config = UPLOAD_DESTINATION_PROVIDERS[type];
  return config?.canHotlink !== false;
}

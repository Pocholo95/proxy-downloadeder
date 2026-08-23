import { Cloud, Pencil, Plus, Trash2, Info } from "lucide-react";
import { useSettingsStore } from "@/store/settingsStore";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldDescription, FieldLabel, FieldSet } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { UploadDestination, DestinationType } from "@/types";
import { makeId } from "@/utils";
import { getProvider, getProviderDefaults } from "@/upload/providers";
import { cn } from "@/lib/utils";
import {
  UPLOAD_DESTINATION_PROVIDERS,
  DEFAULT_DEST_ALLOWED_EXTENSIONS,
} from "@/constants";
import RangeNumberInput from "@/components/control/RangeNumberInput";
import { useState } from "react";
import CORSStatus from "./CORSStatus";

const CHEVERETO_DEFAULTS = getProviderDefaults("chevereto");

const EMPTY_DRAFT: {
  name: string;
  type: DestinationType;
  apiKey: string;
  url: string;
  enabled: boolean;
  allowedExtensions: string;
  maxSizeMb: number;
  options: Record<string, unknown>;
} = {
  name: "",
  type: "chevereto",
  apiKey: "",
  url: CHEVERETO_DEFAULTS.defaultUrl,
  enabled: true,
  allowedExtensions: CHEVERETO_DEFAULTS.defaultAllowedExtensions,
  maxSizeMb: CHEVERETO_DEFAULTS.defaultMaxSizeMb,
  options: {},
};

function getAvailableTypes(): DestinationType[] {
  return Object.keys(UPLOAD_DESTINATION_PROVIDERS) as DestinationType[];
}

interface UploadsTabProps {
  dialogOpen: boolean;
}

export default function UploadsTab({ dialogOpen }: UploadsTabProps) {
  const settings = useSettingsStore((s) => s.settings);
  const updateDestinations = useSettingsStore((s) => s.updateDestinations);

  const [destList, setDestList] = useState<UploadDestination[]>(() =>
    structuredClone(settings.destinations),
  );
  const [editing, setEditing] = useState<UploadDestination | null>(null);
  const [draft, setDraft] = useState<typeof EMPTY_DRAFT>({ ...EMPTY_DRAFT });
  const [draftError, setDraftError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Sync when settings change externally
  useState(() => {
    // This is a placeholder to trigger re-render when needed
  });

  const openAdd = () => {
    setEditing({ id: "__new__", ...EMPTY_DRAFT });
    setDraft({ ...EMPTY_DRAFT });
    setDraftError("");
  };

  const openEdit = (d: UploadDestination) => {
    setEditing(d);
    setDraft({
      name: d.name,
      type: d.type,
      apiKey: d.apiKey,
      url: d.url,
      enabled: d.enabled,
      allowedExtensions: d.allowedExtensions,
      maxSizeMb: d.maxSizeMb,
      options: d.options ?? {},
    });
    setDraftError("");
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraftError("");
  };

  const confirmEdit = () => {
    if (!draft.name.trim()) {
      setDraftError("Name is required.");
      return;
    }

    const normalizedUrl = draft.url.trim().replace(/\/+$/, "");
    if (!normalizedUrl) {
      setDraftError("Upload URL is required.");
      return;
    }
    try {
      new URL(normalizedUrl);
    } catch {
      setDraftError("Upload URL is not a valid URL.");
      return;
    }
    if (!normalizedUrl.startsWith("https://")) {
      setDraftError("Upload URL must start with https://.");
      return;
    }

    const providerConfig = UPLOAD_DESTINATION_PROVIDERS[draft.type];
    if (
      providerConfig?.requiresKeyPlaceholder &&
      !normalizedUrl.includes("{key}")
    ) {
      setDraftError(
        "Upload URL must contain {key} as a placeholder for the API key.",
      );
      return;
    }

    if (providerConfig?.apiKeyRequired && !draft.apiKey.trim()) {
      setDraftError("API key is required for this destination type.");
      return;
    }

    const provider = getProvider(draft.type);
    const mergedOptions: Record<string, unknown> = {};
    for (const opt of provider.optionsSchema) {
      mergedOptions[opt.key] = draft.options?.[opt.key] ?? opt.defaultValue;
    }

    const rawExt = draft.allowedExtensions.trim();
    let normalizedExt = rawExt;
    if (rawExt) {
      const parts = rawExt.split(",").map((s) => s.trim().replace(/^\.+/, ""));
      if (parts.some((p) => p && /[^\w]/.test(p))) {
        setDraftError(
          "Allowed extensions must be comma-separated alphanumeric names (e.g. jpg,webp).",
        );
        return;
      }
      normalizedExt = parts.join(",");
    }

    const base = {
      name: draft.name.trim(),
      apiKey: draft.apiKey.trim(),
      url: normalizedUrl,
      type: draft.type,
      enabled: draft.enabled,
      allowedExtensions: normalizedExt,
      maxSizeMb: draft.maxSizeMb,
      options: mergedOptions,
    };

    if (editing!.id === "__new__") {
      const newList = [...destList, { id: makeId(), ...base }];
      setDestList(newList);
      updateDestinations(newList);
    } else {
      const newList = destList.map((d) =>
        d.id === editing!.id ? { ...d, ...base } : d,
      );
      setDestList(newList);
      updateDestinations(newList);
    }
    setEditing(null);
    setDraftError("");
  };

  const toggleDestEnabled = (id: string) => {
    const newList = destList.map((d) =>
      d.id === id ? { ...d, enabled: !d.enabled } : d,
    );
    setDestList(newList);
    updateDestinations(newList);
  };

  const confirmDeleteDest = () => {
    if (deleteTarget) {
      removeDest(deleteTarget);
      setDeleteTarget(null);
    }
  };

  const removeDest = (id: string) => {
    const newList = destList.filter((d) => d.id !== id);
    setDestList(newList);
    updateDestinations(newList);
    setEditing(null);
    setDraftError("");
  };

  const providerConfig = UPLOAD_DESTINATION_PROVIDERS[draft.type];

  return (
    <>
      {/* CORS Tunnel Section */}
      <CORSStatus dialogOpen={dialogOpen} />

      {/* Destinations Section */}
      <FieldSet className="p-4 rounded-lg border bg-muted/30 min-w-0 mt-4">
        <FieldLabel className="flex items-center gap-2 mb-2">
          <Cloud className="size-4" />
          Upload Destinations
          <span className="text-muted-foreground text-xs font-normal">
            ({destList.filter((d) => d.enabled).length}/{destList.length})
          </span>
        </FieldLabel>
        <FieldDescription className="mb-3">
          Configure where to upload the generated files
        </FieldDescription>

        <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
          {destList.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No destinations yet. Add one below.
            </p>
          )}
          {destList.map((d) => (
            <div
              key={d.id}
              className={cn(
                "bg-muted/30 flex flex-wrap items-center gap-3 rounded-md border p-3",
                !d.enabled && "opacity-60",
              )}
            >
              <Switch
                checked={d.enabled}
                onCheckedChange={() => toggleDestEnabled(d.id)}
              />
              <span className="bg-secondary text-secondary-foreground rounded px-2 py-0.5 font-mono text-xs">
                {d.type}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {d.name}
              </span>
              <span className="text-muted-foreground font-mono text-xs">
                {d.apiKey.slice(0, 8)}…
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openEdit(d)}
                  title="Edit"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleteTarget(d.id)}
                  title="Delete"
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {editing && (
          <div className="bg-card flex flex-col gap-4 rounded-md border p-4 mt-3">
            <h3 className="text-sm font-semibold">
              {editing.id === "__new__"
                ? "Add destination"
                : "Edit destination"}
            </h3>

            <div className="flex flex-col gap-2">
              <Label htmlFor="dest-type">Type</Label>
              <Select
                value={draft.type}
                onValueChange={(value) => {
                  const newType = value as DestinationType;
                  const defaults = getProviderDefaults(newType);
                  setDraft((p) => ({
                    ...p,
                    type: newType,
                    url: defaults.defaultUrl,
                    allowedExtensions: defaults.defaultAllowedExtensions,
                    maxSizeMb: defaults.defaultMaxSizeMb,
                    options: {},
                  }));
                }}
              >
                <SelectTrigger id="dest-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getAvailableTypes().map((type) => (
                    <SelectItem key={type} value={type}>
                      {UPLOAD_DESTINATION_PROVIDERS[type].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dest-name">Name</Label>
              <Input
                id="dest-name"
                type="text"
                value={draft.name}
                maxLength={64}
                placeholder="Display name"
                onChange={(e) =>
                  setDraft((p) => ({ ...p, name: e.target.value }))
                }
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="dest-key">
                  {providerConfig?.apiKeyLabel ?? "API Key"}
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="size-6 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="About API Key / Auth Token"
                    >
                      <Info className="size-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="max-w-72 text-xs leading-relaxed">
                    <p className="font-medium mb-1">
                      {providerConfig?.apiKeyHelpTitle ?? "API Key"}
                    </p>
                    <p>
                      {providerConfig?.apiKeyHelpDescription ??
                        "Usually found in the host's dashboard or account settings."}
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
              <Input
                id="dest-key"
                type="text"
                value={draft.apiKey}
                placeholder={
                  providerConfig?.apiKeyPlaceholder ?? "Paste your API key"
                }
                onChange={(e) =>
                  setDraft((p) => ({ ...p, apiKey: e.target.value }))
                }
                autoComplete="off"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="dest-url">Base API URL</Label>
              <Input
                id="dest-url"
                type="text"
                value={draft.url}
                placeholder={UPLOAD_DESTINATION_PROVIDERS.chevereto.defaultUrl}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, url: e.target.value }))
                }
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                {providerConfig?.urlHelpText ??
                  "Base URL of the provider (e.g. https://im.ge). HTTPS required."}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="dest-extensions">Allowed Extensions</Label>
              <Input
                id="dest-extensions"
                type="text"
                value={draft.allowedExtensions}
                placeholder={DEFAULT_DEST_ALLOWED_EXTENSIONS}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    allowedExtensions: e.target.value,
                  }))
                }
              />
              <p className="text-muted-foreground text-xs">
                Comma-separated extensions (e.g.{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  jpg,webp
                </code>
                ). Leave empty to allow all file types.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="dest-maxsize">Max File Size</Label>
              {(() => {
                const providerMax = getProviderDefaults(
                  draft.type,
                ).defaultMaxSizeMb;
                return (
                  <RangeNumberInput
                    id="dest-maxsize"
                    value={draft.maxSizeMb}
                    min={0}
                    max={providerMax || 64}
                    step={1}
                    suffix="MB"
                    hardMin={0}
                    unbounded
                    hardMax={Number.MAX_SAFE_INTEGER}
                    onChange={(v) => setDraft((p) => ({ ...p, maxSizeMb: v }))}
                  />
                );
              })()}
              <p className="text-muted-foreground text-xs">
                0 means no size limit. Files larger than this will be blocked
                from upload.
              </p>
            </div>

            {/* Provider-specific options */}
            {(() => {
              const provider = getProvider(draft.type);
              return provider.optionsSchema.map((opt) => (
                <div key={opt.key} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor={`dest-opt-${opt.key}`}
                      className="flex flex-col items-start"
                    >
                      <span>{opt.label}</span>
                      <span className="text-muted-foreground font-normal text-xs">
                        {opt.description}
                      </span>
                    </Label>
                    {opt.type === "boolean" ? (
                      <Switch
                        id={`dest-opt-${opt.key}`}
                        checked={
                          (draft.options?.[opt.key] as boolean) ??
                          (opt.defaultValue as boolean)
                        }
                        onCheckedChange={(checked) =>
                          setDraft((p) => ({
                            ...p,
                            options: { ...p.options, [opt.key]: checked },
                          }))
                        }
                      />
                    ) : (
                      <Input
                        id={`dest-opt-${opt.key}`}
                        type="text"
                        value={
                          (draft.options?.[opt.key] as string) ??
                          (opt.defaultValue as string)
                        }
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            options: {
                              ...p.options,
                              [opt.key]: e.target.value,
                            },
                          }))
                        }
                      />
                    )}
                  </div>
                </div>
              ));
            })()}

            {draftError && (
              <p className="text-destructive text-sm font-medium">
                {draftError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button variant="default" onClick={confirmEdit}>
                {editing.id === "__new__" ? "Add" : "Update"}
              </Button>
            </div>
          </div>
        )}

        {!editing && (
          <Button variant="outline" onClick={openAdd} className="w-full mt-3">
            <Plus className="size-4" /> Add destination
          </Button>
        )}
      </FieldSet>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete destination?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the upload destination. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteDest}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

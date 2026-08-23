import { useRef, useState } from "react";
import { Save, Trash2, Check, X, ListRestart } from "lucide-react";
import { DEFAULTS, PRESETS_DEFAULT_VALUE } from "../../constants";
import {
  deletePreset,
  getPresetsGroupedByMode,
  getPresetSummary,
  loadPresets,
  savePreset,
} from "../../presets";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemDescription,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AppSettings, SavedOptions } from "../../types";

interface Props {
  opts: SavedOptions;
  setOpts: (o: SavedOptions) => void;
  presets: AppSettings["presets"];
  setPresets: (p: AppSettings["presets"]) => void;
}

/**
 * Renders the presets selector + delete/save buttons, with an inline
 * "rename" input row that appears when the user clicks Save.
 */
export default function PresetsRow({
  opts,
  setOpts,
  presets,
  setPresets,
}: Props) {
  const presetNameRef = useRef<HTMLInputElement>(null);
  const [nameVisible, setNameVisible] = useState(false);
  const [nameValue, setNameValue] = useState("");

  const selectedPreset = presets.lastUsed ?? PRESETS_DEFAULT_VALUE;

  const applyPreset = (name: string) => {
    if (name === PRESETS_DEFAULT_VALUE) {
      setOpts(DEFAULTS);
      setPresets({ ...presets, lastUsed: null });
    } else if (presets.entries[name]) {
      setOpts(presets.entries[name]);
      setPresets({ ...presets, lastUsed: name });
    }
  };

  const openSave = () => {
    const cur = presets.lastUsed;
    const hasName = cur && cur !== PRESETS_DEFAULT_VALUE;
    const newName = hasName ? cur : "";
    setNameValue(newName);
    setNameVisible(true);
    setTimeout(() => {
      if (presetNameRef.current) {
        presetNameRef.current.focus();
        // Select all text if there's a name to be edited, otherwise leave cursor at start for new entry
        if (newName.length > 0) {
          presetNameRef.current.setSelectionRange(0, newName.length);
        }
      }
    }, 0);
  };

  const confirmSave = () => {
    const name = nameValue.trim();
    if (!name || name === PRESETS_DEFAULT_VALUE) return;
    savePreset(name, opts);
    const entries = loadPresets();
    setPresets({ entries, lastUsed: name });
    setNameVisible(false);
  };

  const handleDelete = () => {
    const name = presets.lastUsed;
    if (!name) return;

    // Compute sorted list and index BEFORE deleting, so we know what to select next
    const sortedNames = Object.keys(presets.entries).sort((a, b) =>
      a.localeCompare(b),
    );
    const deleteIndex = sortedNames.indexOf(name);

    deletePreset(name);
    const entries = loadPresets();

    // Priority: next preset > previous preset > default
    let nextName: string | null = null;

    if (deleteIndex < sortedNames.length - 1) {
      // Pick the next preset in alphabetical order
      nextName = sortedNames[deleteIndex + 1];
    } else if (deleteIndex > 0) {
      // Was at the end; pick the previous preset
      nextName = sortedNames[deleteIndex - 1];
    }
    // else: only preset existed; fall through to default (nextName stays null)

    if (nextName && entries[nextName]) {
      setOpts(entries[nextName]);
      setPresets({ entries, lastUsed: nextName });
    } else {
      setPresets({ entries, lastUsed: null });
      setOpts(DEFAULTS);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <ListRestart className="size-4 shrink-0" />
          </PopoverTrigger>
          <PopoverContent sideOffset={6} side="top" className="p-2 text-sm">
            Presets: Shortcuts to set all the options below quickly
          </PopoverContent>
        </Popover>
        <Select
          value={selectedPreset}
          disabled={nameVisible}
          onValueChange={applyPreset}
        >
          <SelectTrigger className="w-full min-w-20 truncate">
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent className="max-w-sm md:max-w-none">
            <SelectItem value={PRESETS_DEFAULT_VALUE}>
              <span className="flex items-center justify-between min-w-0 gap-2">
                <span className="shrink-0">{"<Default Preset>"}</span>
                <SelectItemDescription
                  className="text-muted-foreground truncate text-right flex-1"
                  title={getPresetSummary(DEFAULTS)}
                >
                  {getPresetSummary(DEFAULTS)}
                </SelectItemDescription>
              </span>
            </SelectItem>
            {getPresetsGroupedByMode(presets.entries).map(
              ({ mode, label, names }) => (
                <SelectGroup key={mode}>
                  <SelectLabel>{label}</SelectLabel>
                  {names.map((n) => {
                    const summary = getPresetSummary(presets.entries[n]);
                    return (
                      <SelectItem key={n} value={n} className="pl-4">
                        <span className="flex items-center justify-between min-w-0 gap-2">
                          <span className="shrink-0">{n}</span>
                          <SelectItemDescription
                            className="text-muted-foreground truncate text-right flex-1"
                            title={summary}
                          >
                            {summary}
                          </SelectItemDescription>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              ),
            )}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          title="Save / add preset"
          disabled={nameVisible}
          onClick={openSave}
        >
          <Save className="size-4" />
        </Button>
        <Button
          variant="destructive"
          size="icon"
          title="Delete selected preset"
          disabled={!presets.lastUsed || nameVisible}
          onClick={handleDelete}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {nameVisible && (
        <div className="flex items-center gap-2">
          <Input
            ref={presetNameRef}
            type="text"
            placeholder="Preset name… (reuse a name to overwrite)"
            maxLength={64}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirmSave();
              }
              if (e.key === "Escape") setNameVisible(false);
            }}
            className="flex-1"
          />
          <Button
            size="icon"
            title="Confirm"
            onClick={confirmSave}
            disabled={!nameValue.trim()}
          >
            <Check className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="Cancel"
            onClick={() => setNameVisible(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderOpen, Upload } from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import type { VideoSource } from "@/types";
import { errlog } from "@/utils";
import { nativeApi, type ScannedFile } from "@/services/nativeApi";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

interface Props {
  onSourcesChange: (sources: VideoSource[]) => void;
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".m4v",
  ".ts", ".flv", ".mpg", ".mpeg", ".3gp", ".ogv", ".vob",
]);

function isVideoFile(file: File): boolean {
  const dot = file.name.lastIndexOf(".");
  if (dot === -1) return false;
  return VIDEO_EXTENSIONS.has(file.name.slice(dot).toLowerCase());
}

function toUrl(token: string): string {
  return `${window.location.origin}/media/${token}`;
}

/** Streams the File's bytes to the local backend and builds a VideoSource
 *  from the real filesystem path it hands back -- browsers don't expose
 *  real paths from File objects, which ffmpeg/ffprobe need. */
async function toVideoSource(file: File): Promise<VideoSource> {
  const { path, token } = await nativeApi.uploadInput(file);
  return {
    name: file.name,
    size: file.size,
    type: file.type || "video/*",
    lastModified: file.lastModified,
    path,
    url: toUrl(token),
  };
}

function scannedToVideoSource(f: ScannedFile): VideoSource {
  return {
    name: f.name,
    size: f.size,
    type: "video/*",
    lastModified: f.lastModified,
    path: f.path,
    url: toUrl(f.token),
  };
}

/**
 * File Picker with two ways to add videos:
 * - The browser's own <input type=file multiple> dialog, or drag & drop --
 *   these upload the picked files' bytes to the local backend
 *   (uploadInput), since browsers don't expose real filesystem paths.
 *   Multi-select is native to the dialog, so this covers batches too.
 * - The shared-folder shortcut (sharedDir/scanPath below), when the
 *   backend is configured with VIDGRID_SHARED_DIR -- scanned in place by
 *   the backend with no upload at all, since the app and that folder are
 *   on the same machine (e.g. another app's shared downloads volume in a
 *   combined deploy).
 *
 * Used to also have a native folder-picker button and a free-text
 * scan-path field for typing an arbitrary path; dropped both since they
 * were rarely used and Add videos… already covers multi-file selection.
 * handleScanPath still exists to back the sharedDir shortcut below.
 */
export default function FilePicker({ onSourcesChange }: Props) {
  const [successAnim, setSuccessAnim] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [pathError, setPathError] = React.useState<string | null>(null);
  const [sharedDir, setSharedDir] = React.useState("");
  const [browseResults, setBrowseResults] = React.useState<ScannedFile[] | null>(null);
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(new Set());
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    nativeApi
      .getSharedDir()
      .then(setSharedDir)
      .catch(() => setSharedDir(""));
  }, []);

  const flashSuccess = () => {
    setSuccessAnim(true);
    setTimeout(() => setSuccessAnim(false), 400);
  };

  const ingestFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const sources: VideoSource[] = [];
    for (const file of files) {
      try {
        sources.push(await toVideoSource(file));
      } catch (e) {
        errlog(`Failed to upload "${file.name}":`, e);
      }
    }
    setBusy(false);
    if (sources.length) {
      onSourcesChange(sources);
      flashSuccess();
    }
  };

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void ingestFiles(files);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter(isVideoFile);
    void ingestFiles(files);
  };

  // Scans the path and opens the picker dialog below rather than adding
  // everything found straight away -- a shared folder (the common case
  // this backs) can easily hold way more videos than you want in one
  // batch, so nothing gets added until you explicitly pick some.
  const handleScanPath = async (path: string) => {
    if (!path.trim()) return;
    setBusy(true);
    setPathError(null);
    try {
      const found = await nativeApi.scanPath(path);
      if (!found.length) {
        setPathError("No video files found at that path.");
      } else {
        setBrowseResults(found);
        setSelectedPaths(new Set());
      }
    } catch (e) {
      setPathError(e instanceof Error ? e.message : String(e));
      errlog(`Failed to scan path "${path}":`, e);
    } finally {
      setBusy(false);
    }
  };

  const toggleOne = (path: string, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelectedPaths(checked ? new Set((browseResults ?? []).map((f) => f.path)) : new Set());
  };

  const confirmSelection = () => {
    if (!browseResults) return;
    const chosen = browseResults.filter((f) => selectedPaths.has(f.path));
    if (chosen.length) {
      onSourcesChange(chosen.map(scannedToVideoSource));
      flashSuccess();
    }
    setBrowseResults(null);
    setSelectedPaths(new Set());
  };

  return (
    <Field className="h-full flex flex-col">
      <FieldLabel>Add video files</FieldLabel>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`
  relative w-full flex-1 rounded-md border-2 border-dashed p-2 transition-all duration-300 flex flex-col items-stretch justify-center gap-2
  ${
    successAnim
      ? "border-emerald-500/60 bg-emerald-50/30 ring-2 ring-emerald-500/40 shadow-md shadow-emerald-200/30 animate-[pulse_1s_ease-in-out_2] fill-mode-[forwards]"
      : dragActive
        ? "border-primary bg-primary/5"
        : "border-input"
  }
`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,.mkv,.avi,.mov,.wmv,.webm,.m4v,.ts,.flv,.mpg,.mpeg,.3gp,.ogv,.vob"
          className="hidden"
          onChange={handleFilesSelected}
        />
        <Button
          type="button"
          variant="ghost"
          className="h-full w-full justify-center gap-2 border-none bg-transparent p-2 shadow-none"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          <Upload className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">Add videos…</span>
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {sharedDir && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full justify-center gap-2"
            onClick={() => void handleScanPath(sharedDir)}
            disabled={busy}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="text-sm font-medium">Browse {sharedDir}</span>
          </Button>
        )}
        {pathError && <p className="text-xs text-destructive">{pathError}</p>}
      </div>

      <Dialog
        open={browseResults !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBrowseResults(null);
            setSelectedPaths(new Set());
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Select videos to add</DialogTitle>
            <DialogDescription>
              Found {browseResults?.length ?? 0} video file
              {browseResults?.length === 1 ? "" : "s"} at {sharedDir}.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 border-b pb-2 text-sm font-medium">
            <Checkbox
              checked={
                browseResults !== null &&
                browseResults.length > 0 &&
                selectedPaths.size === browseResults.length
              }
              onCheckedChange={(checked) => toggleAll(checked === true)}
            />
            Select all
          </label>
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {browseResults?.map((f) => (
              <label
                key={f.path}
                className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={selectedPaths.has(f.path)}
                  onCheckedChange={(checked) => toggleOne(f.path, checked === true)}
                />
                <span className="flex-1 truncate" title={f.path}>
                  {f.name}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {fmtSize(f.size)}
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setBrowseResults(null);
                setSelectedPaths(new Set());
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={confirmSelection} disabled={selectedPaths.size === 0}>
              Add {selectedPaths.size || ""} selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}

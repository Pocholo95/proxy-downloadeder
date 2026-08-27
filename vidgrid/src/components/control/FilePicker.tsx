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
import { ChevronRight, Folder, FolderOpen, Upload } from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import type { VideoSource } from "@/types";
import { errlog } from "@/utils";
import {
  nativeApi,
  type ScannedFile,
  type SharedDirEntry,
} from "@/services/nativeApi";

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
 * - The shared-folder browser (sharedDir/listSharedDir below), when the
 *   backend is configured with VIDGRID_SHARED_DIR -- listed in place by
 *   the backend with no upload at all, since the app and that folder are
 *   on the same machine (e.g. another app's shared downloads volume in a
 *   combined deploy). Navigable folder by folder with a breadcrumb rather
 *   than one flat list of every video found anywhere under it -- a shared
 *   downloads volume organized into per-batch/per-site subfolders used to
 *   turn into one giant same-looking list of basenames with no way to
 *   tell which folder a given file actually came from. Selections persist
 *   across navigation (selectedFiles is keyed by absolute path, not
 *   scoped to whichever folder is currently on screen), so picking videos
 *   from several different folders in one visit to the dialog still works.
 *
 * Used to also have a native folder-picker button and a free-text
 * scan-path field for typing an arbitrary path; dropped both since they
 * were rarely used and Add videos… already covers multi-file selection.
 */
export default function FilePicker({ onSourcesChange }: Props) {
  const [successAnim, setSuccessAnim] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [pathError, setPathError] = React.useState<string | null>(null);
  const [sharedDir, setSharedDir] = React.useState("");
  const [browsePath, setBrowsePath] = React.useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = React.useState<SharedDirEntry[]>([]);
  const [browseFiles, setBrowseFiles] = React.useState<ScannedFile[]>([]);
  const [selectedFiles, setSelectedFiles] = React.useState<Map<string, ScannedFile>>(new Map());
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

  // Opens (or navigates within) the picker dialog below rather than adding
  // everything found straight away -- a shared folder (the common case
  // this backs) can easily hold way more videos than you want in one
  // batch, so nothing gets added until you explicitly pick some.
  const loadDir = async (subpath: string) => {
    setBusy(true);
    setPathError(null);
    try {
      const listing = await nativeApi.listSharedDir(subpath);
      setBrowsePath(listing.path);
      setBrowseDirs(listing.dirs);
      setBrowseFiles(listing.files);
    } catch (e) {
      setPathError(e instanceof Error ? e.message : String(e));
      errlog(`Failed to list shared dir "${subpath}":`, e);
    } finally {
      setBusy(false);
    }
  };

  const closeBrowse = () => {
    setBrowsePath(null);
    setBrowseDirs([]);
    setBrowseFiles([]);
    setSelectedFiles(new Map());
  };

  const toggleOne = (file: ScannedFile, checked: boolean) => {
    setSelectedFiles((prev) => {
      const next = new Map(prev);
      if (checked) next.set(file.path, file);
      else next.delete(file.path);
      return next;
    });
  };

  // Only affects the videos in the folder currently on screen -- selections
  // from other folders visited earlier this session stay untouched either way.
  const toggleAllInCurrentFolder = (checked: boolean) => {
    setSelectedFiles((prev) => {
      const next = new Map(prev);
      for (const f of browseFiles) {
        if (checked) next.set(f.path, f);
        else next.delete(f.path);
      }
      return next;
    });
  };

  const confirmSelection = () => {
    const chosen = [...selectedFiles.values()];
    if (chosen.length) {
      onSourcesChange(chosen.map(scannedToVideoSource));
      flashSuccess();
    }
    closeBrowse();
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
            onClick={() => void loadDir("")}
            disabled={busy}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="text-sm font-medium">Browse {sharedDir}</span>
          </Button>
        )}
        {pathError && <p className="text-xs text-destructive">{pathError}</p>}
      </div>

      <Dialog
        open={browsePath !== null}
        onOpenChange={(open) => {
          if (!open) closeBrowse();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Select videos to add</DialogTitle>
            <DialogDescription>
              Browse {sharedDir} and check the videos you want.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-1 border-b pb-2 text-xs text-muted-foreground">
            <button
              type="button"
              className="hover:text-foreground hover:underline"
              onClick={() => void loadDir("")}
            >
              {sharedDir}
            </button>
            {(browsePath ?? "")
              .split("/")
              .filter(Boolean)
              .map((part, i, parts) => {
                const target = parts.slice(0, i + 1).join("/");
                return (
                  <React.Fragment key={target}>
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <button
                      type="button"
                      className="hover:text-foreground hover:underline"
                      onClick={() => void loadDir(target)}
                    >
                      {part}
                    </button>
                  </React.Fragment>
                );
              })}
          </div>

          {browseFiles.length > 0 && (
            <label className="flex items-center gap-2 border-b pb-2 text-sm font-medium">
              <Checkbox
                checked={browseFiles.every((f) => selectedFiles.has(f.path))}
                onCheckedChange={(checked) => toggleAllInCurrentFolder(checked === true)}
              />
              Select all in this folder
            </label>
          )}

          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {browseDirs.map((d) => (
              <button
                key={d.path}
                type="button"
                className="flex items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => void loadDir(d.path)}
                disabled={busy}
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{d.name}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
            {browseFiles.map((f) => (
              <label
                key={f.path}
                className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={selectedFiles.has(f.path)}
                  onCheckedChange={(checked) => toggleOne(f, checked === true)}
                />
                <span className="flex-1 truncate" title={f.path}>
                  {f.name}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {fmtSize(f.size)}
                </span>
              </label>
            ))}
            {browseDirs.length === 0 && browseFiles.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Empty folder.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeBrowse}>
              Cancel
            </Button>
            <Button type="button" onClick={confirmSelection} disabled={selectedFiles.size === 0}>
              Add {selectedFiles.size || ""} selected
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}

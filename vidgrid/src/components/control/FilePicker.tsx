import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderInput, FolderOpen, Upload } from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import type { VideoSource } from "@/types";
import { errlog } from "@/utils";
import { nativeApi, type ScannedFile } from "@/services/nativeApi";

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
 * File Picker with three ways to add videos:
 * - Browser <input type=file> dialogs (single/multi file, or a whole
 *   folder via webkitdirectory), or drag & drop -- these upload the picked
 *   files' bytes to the local backend (uploadInput), since browsers don't
 *   expose real filesystem paths.
 * - A typed path (file or folder) -- scanned in place by the backend with
 *   no upload at all (scanPath), since the app and the files are on the
 *   same machine. Much faster for large batches/whole folders.
 */
export default function FilePicker({ onSourcesChange }: Props) {
  const [successAnim, setSuccessAnim] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [pathInput, setPathInput] = React.useState("");
  const [pathError, setPathError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);

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

  const handleFolderSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(isVideoFile);
    e.target.value = "";
    void ingestFiles(files);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter(isVideoFile);
    void ingestFiles(files);
  };

  const handleScanPath = async () => {
    const path = pathInput.trim();
    if (!path) return;
    setBusy(true);
    setPathError(null);
    try {
      const found = await nativeApi.scanPath(path);
      if (!found.length) {
        setPathError("No video files found at that path.");
      } else {
        onSourcesChange(found.map(scannedToVideoSource));
        setPathInput("");
        flashSuccess();
      }
    } catch (e) {
      setPathError(e instanceof Error ? e.message : String(e));
      errlog(`Failed to scan path "${path}":`, e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field className="h-full flex flex-col">
      <FieldLabel>Add video files or a whole folder</FieldLabel>
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
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error -- non-standard attribute, no React DOM typing for it
          webkitdirectory=""
          className="hidden"
          onChange={handleFolderSelected}
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
        <Button
          type="button"
          variant="outline"
          className="w-full justify-center gap-2"
          onClick={() => folderInputRef.current?.click()}
          disabled={busy}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">Add folder…</span>
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="…or paste a file/folder path (no upload, scanned in place)"
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value);
              setPathError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleScanPath();
              }
            }}
            disabled={busy}
            className="text-sm"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleScanPath()}
            disabled={busy || !pathInput.trim()}
          >
            <FolderInput className="h-4 w-4" />
            Add
          </Button>
        </div>
        {pathError && <p className="text-xs text-destructive">{pathError}</p>}
      </div>
    </Field>
  );
}

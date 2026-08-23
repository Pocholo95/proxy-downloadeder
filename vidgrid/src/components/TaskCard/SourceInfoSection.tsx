import { useState } from "react";
import { ChevronDown, ChevronUp, FileVideo } from "lucide-react";
import type { VideoMetadata } from "@/types";
import { buildMetadataLines, formatTime } from "@/utils";

interface Props {
  metadata: VideoMetadata;
  filename: string;
  fileSize?: number;
}

export default function SourceInfoSection({
  metadata,
  filename,
  fileSize,
}: Props) {
  const [open, setOpen] = useState(false);

  const summary = `${metadata.width}×${metadata.height} · ${metadata.fps ?? "?"}fps · ${formatTime(metadata.duration)}`;

  const lines = buildMetadataLines(metadata, filename, fileSize);

  return (
    <div className="border rounded-md">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <button
          type="button"
          className="flex items-center gap-2 hover:text-foreground flex-1 text-muted-foreground"
          onClick={() => setOpen((s) => !s)}
        >
          <FileVideo className="size-4" />
          <span className="font-medium">Source</span>
          <span className="text-muted-foreground">{summary}</span>
        </button>
        <button
          type="button"
          className="shrink-0 hover:text-foreground"
          onClick={() => setOpen((s) => !s)}
        >
          {open ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2 text-xs text-muted-foreground space-y-1">
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

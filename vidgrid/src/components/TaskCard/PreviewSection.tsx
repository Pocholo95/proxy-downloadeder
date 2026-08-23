import { CircleAlert, Clock, EyeOff, Loader2 } from "lucide-react";
import type { TaskItem } from "@/types";

interface Props {
  item: TaskItem;
  blobUrl: string | null;
  showPreview: boolean;
  onPreview: (url: string) => void;
  onShowPreviewDialog: () => void;
}

export default function PreviewSection({
  item,
  blobUrl,
  showPreview,
  onPreview,
  onShowPreviewDialog,
}: Props) {
  return (
    <div className="bg-muted/50 flex min-h-35 items-center justify-center overflow-hidden rounded-md">
      {blobUrl && showPreview ? (
        <div className="max-h-65 overflow-hidden rounded-md m-2">
          {item.outputName?.endsWith(".mp4") ? (
            <video src={blobUrl} controls className="max-h-65 object-contain" />
          ) : (
            <img
              src={blobUrl}
              alt={`Preview for ${item.source.name}`}
              onClick={() => onPreview(blobUrl)}
              className="max-h-65 cursor-zoom-in object-contain"
            />
          )}
        </div>
      ) : (
        <div
          className="flex flex-col items-center justify-center gap-2 p-4 text-center text-xs"
          onClick={() => {
            if (!showPreview && item.status !== "error") {
              onShowPreviewDialog();
            }
          }}
          title={
            showPreview
              ? "Click to open full-size preview"
              : item.status === "error"
                ? "Preview not generated due to error"
                : "Click to enable previews globally"
          }
        >
          {item.status === "error" ? (
            <>
              <CircleAlert className="size-8 text-destructive mb-1" />
              <div className="text-muted-foreground">Preview not generated</div>
            </>
          ) : showPreview ? (
            item.status === "done" || item.status === "cancelled" ? (
              <>
                <EyeOff className="size-8 text-muted-foreground mb-1" />
                <div className="text-muted-foreground">No preview</div>
              </>
            ) : item.status === "queued" ? (
              <>
                <Clock className="size-8 text-muted-foreground" />
                <div className="text-muted-foreground font-medium">Queued</div>
              </>
            ) : (
              <>
                <div className="relative">
                  <div className="animate-ping absolute inset-0 rounded-full bg-primary/20 opacity-75" />
                  <Loader2 className="size-8 animate-spin text-primary" />
                </div>
                <div className="text-muted-foreground">Generating preview…</div>
              </>
            )
          ) : (
            <>
              <EyeOff className="size-8 text-muted-foreground" />
              <div className="text-muted-foreground">Preview off</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

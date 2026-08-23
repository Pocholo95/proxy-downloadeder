import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  EyeOff,
  Loader2,
} from "lucide-react";
import type { TaskItem } from "@/types";
import { getOrCreateUrl } from "@/lib/blobCache";
import { useTaskStore } from "@/store/taskStore";
import { useUiStore } from "@/store/uiStore";

interface Props {
  item: TaskItem;
  showPreview: boolean;
  onPreview: (url: string) => void;
  onShowPreviewDialog: () => void;
}

/**
 * Gallery preview component that displays the current gallery frame
 * with prev/next navigation buttons.
 */
export default function GalleryPreview({
  item,
  showPreview,
  onPreview,
  onShowPreviewDialog,
}: Props) {
  const images = item.galleryImages;
  const currentIndex = item.galleryCurrentIndex ?? 0;
  const totalImages = images?.length ?? 0;

  // Get blob URL for current image
  const currentBlob = images?.[currentIndex];
  const blobUrl = currentBlob ? getOrCreateUrl(currentBlob) : null;

  const goToPrev = () => {
    if (!images || totalImages < 2) return;
    const newIndex = (currentIndex - 1 + totalImages) % totalImages;
    useTaskStore
      .getState()
      .updateItem(item.id, { galleryCurrentIndex: newIndex });
  };

  const goToNext = () => {
    if (!images || totalImages < 2) return;
    const newIndex = (currentIndex + 1) % totalImages;
    useTaskStore
      .getState()
      .updateItem(item.id, { galleryCurrentIndex: newIndex });
  };

  return (
    <div className="bg-muted/50 flex min-h-35 items-center justify-center overflow-hidden rounded-md">
      {blobUrl && showPreview ? (
        <div className="flex flex-col items-center gap-2 m-2">
          {/* Image with navigation */}
          <div className="relative max-h-55 overflow-hidden rounded-md">
            <img
              src={blobUrl}
              alt={`Gallery frame ${currentIndex + 1} of ${totalImages}`}
              onClick={() => {
                // Set gallery preview state so modal knows which task to browse
                useUiStore.getState().setGalleryPreview(item.id, currentIndex);
                onPreview(blobUrl);
              }}
              className="max-h-55 cursor-zoom-in object-contain"
            />
            {/* Navigation overlay buttons - always shown when >1 image, loops */}
            {totalImages > 1 && (
              <>
                <button
                  type="button"
                  className="absolute left-1 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background/90 text-foreground rounded-full p-1.5 transition-colors backdrop-blur-sm shadow-md opacity-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    goToPrev();
                  }}
                  aria-label="Previous image"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  className="absolute right-1 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background/90 text-foreground rounded-full p-1.5 transition-colors backdrop-blur-sm shadow-md opacity-50"
                  onClick={(e) => {
                    e.stopPropagation();
                    goToNext();
                  }}
                  aria-label="Next image"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </div>
          {/* Frame counter */}
          <div className="text-xs text-muted-foreground">
            {currentIndex + 1} / {totalImages}
          </div>
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

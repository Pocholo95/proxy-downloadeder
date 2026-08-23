import { useEffect, useMemo, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";
import { useIsTouch } from "@/hooks/useIsTouch";
import { getOrCreateUrl } from "@/lib/blobCache";
interface Props {
  url: string | null;
  onClose: () => void;
  /** Gallery mode: array of blob images for a single task. */
  galleryImages?: Blob[];
  /** Current index in gallery. */
  galleryIndex?: number;
  /** Callback when gallery index changes. */
  onGalleryIndexChange?: (index: number) => void;
}

/**
 * Full-screen image preview modal.
 *
 * Built directly on the Radix Dialog primitive (rather than the styled
 * `DialogContent`) so the image can fill the viewport without the
 * default bordered/rounded card styling.
 *
 * Supports gallery mode with prev/next navigation via buttons, keyboard
 * arrow keys, PageUp/PageDown, mouse wheel scroll, and touch swipe on mobile.
 *
 * @param url - Blob URL of the image to display, or null when closed.
 * @param onClose - Called when the user dismisses the modal.
 * @param galleryImages - Gallery images for navigation mode.
 * @param galleryIndex - Current index in gallery.
 * @param onGalleryIndexChange - Callback when gallery index changes.
 */
export default function PreviewModal({
  url,
  onClose,
  galleryImages,
  galleryIndex = 0,
  onGalleryIndexChange,
}: Props) {
  const isTouch = useIsTouch();
  const isOpen = url !== null;
  const isGallery = galleryImages && galleryImages.length > 1;
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  // Build blob URLs for gallery images
  const galleryUrls = useMemo(() => {
    if (!galleryImages) return [];
    return galleryImages.map((blob) => getOrCreateUrl(blob));
  }, [galleryImages]);

  const currentUrl = isGallery ? (galleryUrls[galleryIndex] ?? null) : url;

  const goNextRef = useRef<() => void>(() => {});
  const goPrevRef = useRef<() => void>(() => {});

  goNextRef.current = () => {
    if (!isGallery || !onGalleryIndexChange) return;
    onGalleryIndexChange((galleryIndex + 1) % galleryImages.length);
  };

  goPrevRef.current = () => {
    if (!isGallery || !onGalleryIndexChange) return;
    onGalleryIndexChange(
      (galleryIndex - 1 + galleryImages.length) % galleryImages.length,
    );
  };

  const goNext = () => goNextRef.current();
  const goPrev = () => goPrevRef.current();

  // Keyboard shortcuts for gallery navigation using useKeyboardShortcut
  useKeyboardShortcut([
    {
      key: "ArrowRight",
      callback: goNext,
      deps: [goNext],
      isActive: () => Boolean(isGallery && isOpen),
    },
    {
      key: "ArrowLeft",
      callback: goPrev,
      deps: [goPrev],
      isActive: () => Boolean(isGallery && isOpen),
    },
    {
      key: "PageDown",
      callback: goNext,
      deps: [goNext],
      isActive: () => Boolean(isGallery && isOpen),
    },
    {
      key: "PageUp",
      callback: goPrev,
      deps: [goPrev],
      isActive: () => Boolean(isGallery && isOpen),
    },
  ]);

  // Mouse wheel navigation for gallery
  useEffect(() => {
    if (!isGallery || !isOpen) return;

    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY > 0) {
        goNextRef.current();
      } else {
        goPrevRef.current();
      }
    };

    window.addEventListener("wheel", handler, {
      passive: false,
      capture: true,
    });
    return () => {
      window.removeEventListener("wheel", handler, { capture: true });
    };
  }, [isGallery, isOpen]);

  // Touch swipe handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    // Only trigger if horizontal swipe is dominant and significant
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0) {
        goPrev();
      } else {
        goNext();
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/80" />
        <DialogPrimitive.Content
          data-dialog-scope="preview-modal"
          className={
            "rounded-none fixed inset-0 z-50 flex items-center justify-center " +
            (isGallery ? "p-4 pb-20" : "p-4") +
            " outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          }
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <DialogPrimitive.Title className="sr-only">
            Image preview
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Full-screen image preview dialog. Click or press Escape to close.
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 ring-offset-background focus-visible:ring-ring absolute top-4 right-4 inline-flex size-9 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none z-50"
            aria-label="Close preview"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
          {currentUrl && (
            <>
              {/* Previous button */}
              {isGallery && (
                <button
                  type="button"
                  className="absolute left-5 z-50 bg-background/80 hover:bg-background/90 text-foreground rounded-full p-2 transition-colors backdrop-blur-sm shadow-md opacity-50"
                  onClick={goPrev}
                  aria-label="Previous image"
                >
                  <ChevronLeft className="size-6" />
                </button>
              )}
              <img
                src={currentUrl}
                alt="Preview"
                className="max-h-full max-w-full rounded-none object-contain shadow-2xl"
                style={{
                  transition: "opacity 150ms ease",
                }}
              />
              {/* Next button */}
              {isGallery && (
                <button
                  type="button"
                  className="absolute right-5 z-50 bg-background/80 hover:bg-background/90 text-foreground rounded-full p-2 transition-colors backdrop-blur-sm shadow-md opacity-50"
                  onClick={goNext}
                  aria-label="Next image"
                >
                  <ChevronRight className="size-6" />
                </button>
              )}
              {/* Image counter */}
              {isGallery && (
                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-background/80 text-foreground text-sm px-3 py-1 rounded-full backdrop-blur-sm shadow-md">
                  {galleryIndex + 1} / {galleryImages.length}
                </div>
              )}
              {/* Navigation hints */}
              {isGallery && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 text-xs text-foreground/60">
                  <span>Navigate:</span>
                  {isTouch ? (
                    <span>Swipe left/right</span>
                  ) : (
                    <>
                      <span className="flex items-center gap-1">
                        <Kbd>←</Kbd>
                        <Kbd>→</Kbd>
                      </span>
                      <span className="text-muted-foreground/50">or</span>
                      <span className="flex items-center gap-1">
                        <Kbd>PgUp</Kbd>
                        <Kbd>PgDn</Kbd>
                      </span>
                      <span className="text-muted-foreground/50">or</span>
                      <span>Mouse scroll</span>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

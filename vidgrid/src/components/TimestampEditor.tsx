import { useCallback, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Timeline,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { TaskItem } from "../types";
import { DEFAULTS } from "../constants";
import { calculateSampleTimes } from "../gridUtils";
import { formatTimeExact } from "../utils";
import { useLongPress } from "../hooks/useLongPress";
import { useKeyboardShortcut } from "../hooks/useKeyboardShortcut";
import { useIsTouch } from "../hooks/useIsTouch";
import GridPreview from "./GridPreview";
import { templateFromUniform } from "../gridTemplate";
import { useUiStore } from "../store";

interface Props {
  item: TaskItem;
  totalCells: number;
  onSave: (markers: number[]) => void;
  onClose: () => void;
}

/**
 * Formats a time value as HH:MM:SS.f for display inside the editor.
 * Delegates to formatTimeExact but guards against bad values.
 *
 * @param t - Time in seconds.
 */
const fmtT = (t: number) =>
  Number.isFinite(t) && t >= 0 ? formatTimeExact(t) : "00:00:00.000";

function ZoomControls({
  zoomIndex,
  zoomLevel,
  zoomMaxIndex,
  onZoomIn,
  onZoomOut,
}: {
  zoomIndex: number;
  zoomLevel: number;
  zoomMaxIndex: number;
  onZoomIn: (shift: boolean) => void;
  onZoomOut: (shift: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="size-5"
        onClick={(e) => onZoomOut(e.shiftKey)}
        disabled={zoomIndex <= 0}
        title="Zoom out (Shift to reset)"
      >
        <ZoomOut className="size-3" />
      </Button>
      <span
        className="text-[11px] tabular-nums select-none w-7 text-center shrink-0"
        title="Zoom level"
      >
        {zoomLevel}%
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-5"
        onClick={(e) => onZoomIn(e.shiftKey)}
        disabled={zoomIndex >= zoomMaxIndex}
        title="Zoom in (Shift to max)"
      >
        <ZoomIn className="size-3" />
      </Button>
    </div>
  );
}

interface MarkerPinProps {
  t: number;
  idx: number;
  totalCells: number;
  selected: number | null;
  duration: number;
  isTouch: boolean;
  onSeek: (t: number, idx: number) => void;
  onDelete: (idx: number) => void;
  viewportStart?: number;
  viewportEnd?: number;
}

function MarkerPin({
  t,
  idx,
  totalCells,
  selected,
  duration,
  isTouch,
  onSeek,
  onDelete,
  viewportStart = 0,
  viewportEnd,
}: MarkerPinProps) {
  // Two-step delete protection: long-press on unselected marker selects it;
  // long-press on already-selected marker deletes it.
  const handleLongPress = () => {
    if (selected === idx) {
      onDelete(idx);
    } else {
      onSeek(t, idx);
    }
  };
  const longPress = useLongPress(handleLongPress, { thresholdMs: 500 });
  const isUsed = idx < totalCells;
  const isSelected = selected === idx;

  return (
    <div
      data-marker-pin
      className={cn(
        "absolute top-0 flex h-full -translate-x-1/2 flex-col items-center pointer-events-none",
      )}
      style={{
        left: `${
          duration > 0 && viewportEnd !== undefined
            ? ((t - viewportStart) / (viewportEnd - viewportStart)) * 100
            : duration > 0
              ? (t / duration) * 100
              : 0
        }%`,
      }}
    >
      {/* Clickable badge — interaction limited to the top area so the
          seekbar below remains freely usable for seeking. */}
      <span
        className={cn(
          "rounded px-1 text-[10px] leading-tight font-semibold tabular-nums cursor-pointer pointer-events-auto",
          isUsed
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground border",
          isSelected && "bg-selected text-selected-foreground",
        )}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (isTouch) longPress.onPointerDown(e);
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          if (isTouch) longPress.onPointerUp();
        }}
        onPointerLeave={(e) => {
          e.stopPropagation();
          if (isTouch) longPress.onPointerLeave();
        }}
        onPointerCancel={(e) => {
          e.stopPropagation();
          if (isTouch) longPress.onPointerCancel();
        }}
        onClick={(e) => {
          e.stopPropagation();
          // onSeek is guarded by seekToMarkerGuarded in the parent, so calling
          // it unconditionally is safe — phantom clicks after a long press are
          // suppressed at the TimestampEditor level regardless of which marker
          // element they land on.
          onSeek(t, idx);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          e.preventDefault();
          // On touch devices deletion is handled exclusively by the long-press
          // timer. Skipping contextmenu here prevents the browser's native
          // contextmenu event (also synthesized on long-press release) from
          // landing on the marker underneath and triggering a phantom deletion.
          if (!isTouch) onDelete(idx);
        }}
      >
        {idx + 1}
      </span>
      {/* Decorative vertical line — no interaction handlers so clicks
          pass through to the seekbar below. */}
      <div
        className={cn(
          "flex-1 pointer-events-none transition-all",
          isSelected
            ? "bg-selected"
            : isUsed
              ? "bg-primary"
              : "bg-muted-foreground/50",
          isSelected ? "w-1" : "w-0.5",
        )}
      />
    </div>
  );
}

/** Simple collapsible panel with ChevronDown toggle in the header. */
function CollapsiblePanel({
  label,
  expanded,
  onToggle,
  children,
  rightContent,
  className,
  bodyClassName,
}: {
  label: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  rightContent?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={cn("border rounded-lg flex flex-col", className)}>
      {/* Use div instead of button to avoid nested <button> issues when
          rightContent renders shadcn Button (which is also a <button>). */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-semibold hover:bg-muted/50 transition-colors cursor-pointer",
          expanded ? "rounded-t-lg" : "rounded-lg",
        )}
      >
        <span>{label}</span>
        <div className="flex items-center gap-2">
          {rightContent}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </div>
      </div>
      {expanded && (
        <div
          className={cn(
            "border-t p-2 flex flex-col min-h-0 gap-2",
            bodyClassName,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default function TimestampEditor({
  item,
  totalCells,
  onSave,
  onClose,
}: Props) {
  const duration = item.metadata?.duration ?? 0;
  // Use actual FPS from metadata for precise frame-stepping; fallback to 30.
  const fps = item.metadata?.fps ?? 30;
  const [isPortrait, setIsPortrait] = useState(() =>
    Boolean(item.metadata && item.metadata.height > item.metadata.width),
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekbarRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const clickTimerRef = useRef<number | null>(null);
  const isTouch = useIsTouch();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // Local copy of markers — sorted ascending at all times.
  const [markers, setMarkers] = useState<number[]>(() => {
    if (item.timestampMode === "custom" && item.customTimestamps?.length) {
      return [...item.customTimestamps];
    }
    // Seed with auto-calculated times so the user has a ready starting point.
    return calculateSampleTimes(totalCells, Math.max(1, duration));
  });

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  // Initialize videoError from canNativelyPlay if already known
  const [videoError, setVideoError] = useState(
    () => item.canNativelyPlay === false,
  );
  const [selectedMarker, setSelectedMarker] = useState<number | null>(null);

  // Grid collapsed on mobile by default, expanded on desktop
  const [gridExpanded, setGridExpanded] = useState(!isTouch);
  const [markersExpanded, setMarkersExpanded] = useState(true);

  const toggleGrid = useCallback(() => setGridExpanded((v) => !v), []);
  const toggleMarkers = useCallback(() => setMarkersExpanded((v) => !v), []);

  // Precomputed zoom levels — index-based approach guarantees perfect
  // reversibility: step up then step down always returns to the same value.
  const MIN_ZOOM = 100;
  const MAX_ZOOM = 1000;
  const ZOOM_LEVELS_COUNT = 7;

  const ZOOM_LEVELS = Array.from({ length: ZOOM_LEVELS_COUNT }, (_, i) =>
    Math.round(
      MIN_ZOOM + ((MAX_ZOOM - MIN_ZOOM) * i) / (ZOOM_LEVELS_COUNT - 1),
    ),
  );

  // Zoom state — stored as an index into ZOOM_LEVELS.
  const [zoomIndex, setZoomIndex] = useState(0);
  const zoomLevel = ZOOM_LEVELS[zoomIndex];
  const [zoomOffset, setZoomOffset] = useState(0);

  // Derived viewport values
  const viewportWidth = duration > 0 ? duration / (zoomLevel / 100) : duration;

  /** Adjust zoomOffset so the given time is centered in the visible viewport. */
  const clampViewport = useCallback(
    (t: number) => {
      if (duration <= 0 || zoomIndex <= 0) return 0;
      const half = viewportWidth / 2;
      return Math.max(0, Math.min(duration - viewportWidth, t - half));
    },
    [duration, viewportWidth, zoomIndex],
  );

  const zoomIn = useCallback(
    (shift: boolean) => {
      setZoomIndex((prev) => {
        const next = shift
          ? ZOOM_LEVELS.length - 1
          : Math.min(ZOOM_LEVELS.length - 1, prev + 1);
        if (next !== prev) {
          setZoomOffset(clampViewport(currentTime));
        }
        return next;
      });
    },
    [currentTime, clampViewport],
  );

  const zoomOut = useCallback(
    (shift: boolean) => {
      setZoomIndex((prev) => {
        const next = shift ? 0 : Math.max(0, prev - 1);
        if (next <= 0) {
          setZoomOffset(0);
        } else {
          setZoomOffset(clampViewport(currentTime));
        }
        return next;
      });
    },
    [currentTime, clampViewport],
  );

  /** Ensure the playhead stays inside the visible viewport after any seek. */
  const ensureViewportVisible = useCallback(
    (t: number) => {
      if (zoomIndex <= 0) return;
      setZoomOffset((prev) => {
        if (t >= prev && t <= prev + viewportWidth) return prev;
        return clampViewport(t);
      });
    },
    [zoomIndex, viewportWidth, clampViewport],
  );

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoReady) return;

    const initialTime =
      markers.length > 0 && Number.isFinite(markers[0]) ? markers[0] : 0;

    v.pause();
    v.currentTime = initialTime;
    setCurrentTime(initialTime);

    setSelectedMarker(markers.length > 0 ? 0 : null);
  }, [videoReady]);

  // The media server URL is stable for the lifetime of the source, no blob
  // cache needed.
  useEffect(() => {
    setBlobUrl(item.source.url);
    return () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
    };
  }, [item.source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentTime(video.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onReady = () => {
      setVideoReady(true);
      // Fallback: detect portrait from video element dimensions
      if (video.videoWidth && video.videoHeight) {
        setIsPortrait(video.videoHeight > video.videoWidth);
      }
    };
    const onErr = () => setVideoError(true);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("error", onErr);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("error", onErr);
    };
  }, [blobUrl, videoError]);

  const addMarker = useCallback(
    (clientX: number) => {
      const bar = seekbarRef.current;
      if (!bar || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / rect.width),
      );
      const t = zoomOffset + ratio * viewportWidth;
      if (videoRef.current) videoRef.current.currentTime = t;
      setCurrentTime(t);
      setMarkers((prev) => {
        const next = [...prev, t].sort((a, b) => a - b);
        // Auto-select the newly added marker if within active range.
        const idx = next.indexOf(t);
        if (idx >= 0 && idx < totalCells) {
          setSelectedMarker(idx);
        } else {
          setSelectedMarker(null);
        }
        return next;
      });
    },
    [duration, totalCells, zoomOffset, viewportWidth],
  );

  const seekbarHandler = useCallback(
    (clientX: number) => {
      const bar = seekbarRef.current;
      if (!bar || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / rect.width),
      );
      const t = zoomOffset + ratio * viewportWidth;
      if (videoRef.current) videoRef.current.currentTime = t;
      setCurrentTime(t);
    },
    [duration, zoomOffset, viewportWidth],
  );

  const addMarkerAtCurrentTime = useCallback(() => {
    const t = videoRef.current?.currentTime ?? currentTime;
    setMarkers((prev) => {
      const next = [...prev, t].sort((a, b) => a - b);
      // Auto-select the newly added marker if within active range.
      const idx = next.indexOf(t);
      if (idx >= 0 && idx < totalCells) {
        setSelectedMarker(idx);
      } else {
        setSelectedMarker(null);
      }
      return next;
    });
  }, [currentTime, totalCells]);

  const deleteMarker = useCallback((idx: number) => {
    setMarkers((prev) => prev.filter((_, i) => i !== idx));
    setSelectedMarker(null);
  }, []);

  const deleteSelectedMarker = useCallback(() => {
    if (selectedMarker !== null) {
      deleteMarker(selectedMarker);
    }
  }, [selectedMarker, deleteMarker]);

  const clearAllMarkers = useCallback(() => {
    setMarkers([]);
    setSelectedMarker(null);
  }, []);

  /**
   * Factory: returns a handler that fills markers evenly across a time range.
   *
   * @param rangeStart - Start of the range in seconds (inclusive).
   * @param rangeEnd - End of the range in seconds (exclusive).
   */
  const makeFillHandler = useCallback(
    (rangeStart: number, rangeEnd: number) => () => {
      const rangeDuration = Math.max(1, rangeEnd - rangeStart);
      setMarkers(
        calculateSampleTimes(totalCells, rangeDuration, rangeStart, rangeEnd),
      );
      setSelectedMarker(null);
    },
    [totalCells],
  );

  const seekToMarker = useCallback(
    (t: number, idx: number) => {
      const v = videoRef.current;
      if (v) v.currentTime = t;
      setCurrentTime(t);
      setSelectedMarker(idx);
      ensureViewportVisible(t);
    },
    [ensureViewportVisible],
  );

  /**
   * Subscribe only to the specific store fields we need for the grid preview.
   * Stable selectors avoid unnecessary re-renders.
   */
  const storeGridTpl = useUiStore((s) => s.opts?.gridTemplate);
  const storeCols = useUiStore((s) => s.opts?.cols);
  const storeRows = useUiStore((s) => s.opts?.rows);
  const isSequenceMode = useUiStore(
    (s) => (s.opts?.outputMode ?? DEFAULTS.outputMode) === "sequence",
  );
  const isGalleryMode = useUiStore(
    (s) => (s.opts?.outputMode ?? DEFAULTS.outputMode) === "gallery",
  );
  const gridTemplate = storeGridTpl?.cells?.length
    ? storeGridTpl
    : templateFromUniform(storeCols ?? 4, storeRows ?? 3);

  /**
   * Handler for clicking a cell in the grid preview: seeks to the marker
   * that corresponds to that cell index.
   */
  const handleGridCellClick = useCallback(
    (cellIndex: number) => {
      if (cellIndex < 0 || cellIndex >= markers.length) return;
      seekToMarker(markers[cellIndex], cellIndex);
    },
    [markers, seekToMarker],
  );

  // When a long press fires, the browser removes the marker element from the
  // DOM mid-gesture. Pointer capture is released at that point, so subsequent
  // pointer/click/contextmenu events are dispatched to whatever element is now
  // at those coordinates - possibly another marker underneath. This flag
  // suppresses any phantom interaction during the release window.
  const longPressSuppressRef = useRef(false);

  const deleteMarkerFromLongPress = useCallback(
    (idx: number) => {
      // Already suppressed — a phantom call arrived during the release window.
      if (longPressSuppressRef.current) return;
      longPressSuppressRef.current = true;
      deleteMarker(idx);
      // Delay covers all synthesized pointer/click/contextmenu events.
      setTimeout(() => {
        longPressSuppressRef.current = false;
      }, 300);
    },
    [deleteMarker],
  );

  const seekToMarkerGuarded = useCallback(
    (t: number, idx: number) => {
      if (longPressSuppressRef.current) return;
      seekToMarker(t, idx);
    },
    [seekToMarker],
  );

  const seekBy = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v || duration <= 0) return;

      const nextTime = Math.min(duration, Math.max(0, v.currentTime + delta));
      v.currentTime = nextTime;
      setCurrentTime(nextTime);
      ensureViewportVisible(nextTime);
      if (v.paused) return;
    },
    [duration, ensureViewportVisible],
  );

  // Mouse wheel seeking: same delta logic as arrow keys.
  // preventDefault + stopPropagation suppresses browser zoom (Ctrl+wheel)
  // and prevents the scroll from bubbling out of the dialog.
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const direction = e.deltaY > 0 ? 1 : -1;
      const delta = e.ctrlKey ? 1 / fps : e.shiftKey ? 5 : 1;
      seekBy(direction * delta);
    },
    [fps, seekBy],
  );

  const seekBack1s = useCallback(() => seekBy(-1), [seekBy]);
  const seekForward1s = useCallback(() => seekBy(1), [seekBy]);
  const seekBack5s = useCallback(() => seekBy(-5), [seekBy]);
  const seekForward5s = useCallback(() => seekBy(5), [seekBy]);
  const seekBackFrame = useCallback(() => seekBy(-1 / fps), [seekBy, fps]);
  const seekForwardFrame = useCallback(() => seekBy(1 / fps), [seekBy, fps]);

  // Attach wheel listener to video and seekbar elements for scroll-seeking.
  // Use native addEventListener (not React synthetic events) so that
  // preventDefault reliably suppresses the browser's Ctrl+wheel zoom.
  //
  // Depend on blobUrl/videoError so the effect re-runs after the conditional
  // render updates the DOM. The `if (video)` guard handles both the initial
  // null ref (first render) and the case where videoError replaced the <video>
  // with an <Alert>.
  useEffect(() => {
    const video = videoRef.current;
    const seekbar = seekbarRef.current;
    const overview = overviewRef.current;
    if (video) video.addEventListener("wheel", handleWheel, { passive: false });
    if (seekbar)
      seekbar.addEventListener("wheel", handleWheel, { passive: false });
    if (overview)
      overview.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      if (video) video.removeEventListener("wheel", handleWheel);
      if (seekbar) seekbar.removeEventListener("wheel", handleWheel);
      if (overview) overview.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel, blobUrl, videoError]);

  const handleSeekbarPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-marker-pin]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    seekbarHandler(e.clientX);
  };

  const handleSeekbarClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-marker-pin]")) return;
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      addMarker(e.clientX);
    } else {
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
      }, 250);
    }
  };

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  // Keyboard shortcuts via useKeyboardShortcut
  useKeyboardShortcut([
    { key: " ", callback: togglePlay, deps: [], scope: "timestamp-editor" },
    {
      key: "m",
      callback: addMarkerAtCurrentTime,
      deps: [addMarkerAtCurrentTime],
      scope: "timestamp-editor",
    },
    {
      key: "ArrowLeft",
      callback: seekBack1s,
      deps: [seekBack1s],
      scope: "timestamp-editor",
    },
    {
      key: "ArrowRight",
      callback: seekForward1s,
      deps: [seekForward1s],
      scope: "timestamp-editor",
    },
    {
      key: "ArrowLeft",
      shift: true,
      callback: seekBack5s,
      deps: [seekBack5s],
      scope: "timestamp-editor",
    },
    {
      key: "ArrowRight",
      shift: true,
      callback: seekForward5s,
      deps: [seekForward5s],
      scope: "timestamp-editor",
    },
    {
      key: "ArrowLeft",
      ctrl: true,
      callback: seekBackFrame,
      deps: [seekBackFrame],
      scope: "timestamp-editor",
    },
    {
      key: "ArrowRight",
      ctrl: true,
      callback: seekForwardFrame,
      deps: [seekForwardFrame],
      scope: "timestamp-editor",
    },
  ]);

  // Playhead position as percentage within the current zoomed viewport
  const progressPct =
    duration > 0 && viewportWidth > 0
      ? Math.min(
          100,
          Math.max(0, ((currentTime - zoomOffset) / viewportWidth) * 100),
        )
      : 0;

  // Handler for clicking the mini-timeline overview to reposition viewport
  const handleOverviewClick = useCallback(
    (clientX: number) => {
      const bar = overviewRef.current;
      if (!bar || duration <= 0) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.min(
        1,
        Math.max(0, (clientX - rect.left) / rect.width),
      );
      const t = ratio * duration;
      setZoomOffset(clampViewport(t));
      if (videoRef.current) videoRef.current.currentTime = t;
      setCurrentTime(t);
    },
    [duration, clampViewport],
  );

  // Computed viewport times for MarkerPin positioning
  const viewportStart = zoomOffset;
  const viewportEnd = zoomOffset + viewportWidth;

  // Overview drag state
  const [overviewDragging, setOverviewDragging] = useState(false);

  const handleOverviewPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Don't intercept pointer events on marker dots — let their onClick
      // handler fire so the marker is selected.
      if ((e.target as HTMLElement).closest("[data-marker-pin]")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setOverviewDragging(true);
      handleOverviewClick(e.clientX);
    },
    [handleOverviewClick],
  );

  // How many markers will actually be used (capped at totalCells).
  const effectiveCount = Math.min(markers.length, totalCells);
  const autoFilledCount = Math.max(0, totalCells - markers.length);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-dialog-scope="timestamp-editor"
          className="bg-background fixed top-1/2 left-1/2 z-50 flex h-[min(95svh,1000px)] w-[min(96vw,1100px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border p-3 shadow-lg sm:p-4"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            setTimeout(() => saveButtonRef.current?.focus(), 0);
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Edit timestamps for {item.source.name}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Customize the timestamps used to capture the video frames
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-center justify-between gap-3 sm:h-3">
            <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold sm:text-lg">
              <Timeline className="size-5 shrink-0 -rotate-90" />
              <span className="shrink-0">Timestamps for</span>
              <span className="truncate font-normal" title={item.source.name}>
                {item.source.name}
              </span>
            </h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              title="Close (Esc)"
            >
              <X className="size-4" />
            </Button>
          </div>

          {/* Main content area — scrollable on mobile, grid on desktop */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto md:overflow-hidden md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] md:grid-rows-[1fr]">
            {/* === Video + Controls: full-width on mobile, left-col on desktop === */}
            <div className="flex min-h-0 shrink-0 flex-col gap-2 md:w-full">
              {videoError ? (
                <Alert>
                  <AlertTriangle />
                  <AlertDescription>
                    Browser cannot play this file for preview. You can still
                    edit markers using the seekbar below.
                  </AlertDescription>
                </Alert>
              ) : (
                <video
                  ref={videoRef}
                  src={blobUrl ?? undefined}
                  className={cn(
                    "object-contain min-h-0",
                    isPortrait
                      ? // Portrait: centered, height constrained on mobile, flexible on desktop
                        "mx-auto max-h-[calc(100svh-320px)] md:max-h-none md:flex-1 md:w-full"
                      : // Landscape: full width, height constrained (smaller for compact viewports)
                        "w-full max-h-[calc(100svh-320px)] md:max-h-[40svh]",
                  )}
                  muted
                  playsInline
                  preload="metadata"
                />
              )}

              {/* Seekbar */}
              <div
                ref={seekbarRef}
                className="bg-muted relative h-11 w-full shrink-0 cursor-pointer touch-none rounded-md select-none overflow-hidden lg:h-8"
                onPointerDown={handleSeekbarPointerDown}
                onPointerMove={(e) => isDragging && seekbarHandler(e.clientX)}
                onPointerUp={(e) => {
                  setIsDragging(false);
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onClick={handleSeekbarClick}
              >
                {/* Track fill */}
                <div
                  className="bg-primary/30 pointer-events-none absolute top-0 left-0 h-full rounded-md"
                  style={{ width: `${progressPct}%` }}
                />

                {/* Playhead */}
                <div
                  className="bg-foreground pointer-events-none absolute top-0 h-full w-0.5 -translate-x-1/2"
                  style={{ left: `${progressPct}%` }}
                />

                {markers.map((t, idx) => (
                  <MarkerPin
                    key={idx}
                    t={t}
                    idx={idx}
                    totalCells={totalCells}
                    selected={selectedMarker}
                    duration={duration}
                    isTouch={isTouch}
                    onSeek={seekToMarkerGuarded}
                    onDelete={deleteMarkerFromLongPress}
                    viewportStart={viewportStart}
                    viewportEnd={viewportEnd}
                  />
                ))}
              </div>

              {/* Mini-timeline overview bar — shows zoomed viewport position.
                  When visible, zoom controls are placed on the same row so the
                  user doesn't have to readjust their mouse/touch to zoom again. */}
              {zoomLevel > MIN_ZOOM && (
                <div className="flex items-center gap-2">
                  <div
                    ref={overviewRef}
                    className="relative h-4 min-w-0 flex-1 cursor-pointer touch-none rounded-md select-none overflow-hidden border"
                    style={{ backgroundColor: "hsl(var(--muted))" }}
                    onPointerDown={handleOverviewPointerDown}
                    onPointerMove={(e) =>
                      overviewDragging && handleOverviewClick(e.clientX)
                    }
                    onPointerUp={(e) => {
                      setOverviewDragging(false);
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }}
                  >
                    {/* Viewport range indicator */}
                    <div
                      className="absolute top-0 h-full bg-primary/20 border-x border-primary/40 pointer-events-none"
                      style={{
                        left: `${(zoomOffset / duration) * 100}%`,
                        width: `${(viewportWidth / duration) * 100}%`,
                      }}
                    />
                    {/* Playhead */}
                    <div
                      className="bg-foreground pointer-events-none absolute top-0 h-full w-0.5 -translate-x-1/2"
                      style={{ left: `${(currentTime / duration) * 100}%` }}
                    />
                  </div>
                  {/* Zoom controls — inline when overview bar is visible */}
                  <ZoomControls
                    zoomIndex={zoomIndex}
                    zoomLevel={zoomLevel}
                    zoomMaxIndex={ZOOM_LEVELS.length - 1}
                    onZoomIn={zoomIn}
                    onZoomOut={zoomOut}
                  />
                </div>
              )}

              {/* Timestamp Display with Zoom Controls */}
              <div className="relative flex items-center justify-center">
                {/* Zoom controls — shown only when overview bar is hidden */}
                {zoomLevel <= MIN_ZOOM && (
                  <div className="absolute right-0">
                    <ZoomControls
                      zoomIndex={zoomIndex}
                      zoomLevel={zoomLevel}
                      zoomMaxIndex={ZOOM_LEVELS.length - 1}
                      onZoomIn={zoomIn}
                      onZoomOut={zoomOut}
                    />
                  </div>
                )}
                {/* Timestamp — centered */}
                <div className="font-mono text-xs tabular-nums text-center">
                  {fmtT(currentTime)}
                  <span className="text-muted-foreground mx-1">/</span>
                  {fmtT(duration)}
                </div>
              </div>

              {/* Transport Controls Bar */}
              <div className="relative flex items-center justify-center">
                {/* Centered seek controls */}
                <div className="flex items-center gap-1 mx-auto">
                  {/* Backward seeks */}
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={seekBack5s}
                    disabled={!videoReady && !videoError}
                    title={`Back 5 seconds ${isTouch ? " (Shift+ArrowLeft)" : ""}`}
                  >
                    <svg className="size-3.5" viewBox="0 0 24 24">
                      <ChevronLeft x={-5} />
                      <ChevronLeft />
                      <ChevronLeft x={5} />
                    </svg>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={seekBack1s}
                    disabled={!videoReady && !videoError}
                    title={`Back 1 second ${isTouch ? " (ArrowLeft)" : ""}`}
                  >
                    <svg className="size-3.5" viewBox="0 0 24 24">
                      <ChevronLeft x={-3} />
                      <ChevronLeft x={3} />
                    </svg>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={seekBackFrame}
                    disabled={!videoReady && !videoError}
                    title={`Back 1 frame ${isTouch ? " (Ctrl+ArrowLeft)" : ""}`}
                  >
                    <ChevronLeft className="size-3.5" />
                  </Button>

                  {/* Play/Pause */}
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={togglePlay}
                    disabled={!videoReady && !videoError}
                    title={
                      isTouch
                        ? isPlaying
                          ? "Pause"
                          : "Play"
                        : isPlaying
                          ? "Pause (Space)"
                          : "Play (Space)"
                    }
                  >
                    {isPlaying ? (
                      <Pause className="size-3.5" />
                    ) : videoReady || videoError ? (
                      <Play className="size-3.5" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                  </Button>

                  {/* Forward seeks */}
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={seekForwardFrame}
                    disabled={!videoReady && !videoError}
                    title={`Forward 1 frame ${isTouch ? " (Ctrl+ArrowRight)" : ""}`}
                  >
                    <ChevronRight className="size-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={seekForward1s}
                    disabled={!videoReady && !videoError}
                    title={`Forward 1 second ${isTouch ? " (ArrowRight)" : ""}`}
                  >
                    <svg className="size-3.5" viewBox="0 0 24 24">
                      <ChevronRight x={-3} />
                      <ChevronRight x={3} />
                    </svg>
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={seekForward5s}
                    disabled={!videoReady && !videoError}
                    title={`Forward 5 seconds $${isTouch ? " (Shift+ArrowRight)" : ""}`}
                  >
                    <svg className="size-3.5" viewBox="0 0 24 24">
                      <ChevronRight x={-5} />
                      <ChevronRight />
                      <ChevronRight x={5} />
                    </svg>
                  </Button>
                </div>

                {/* Marker controls — positioned absolutely to the right so they
                    don't affect the centered layout of the seek controls */}
                <div className="absolute right-0 flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={deleteSelectedMarker}
                    disabled={selectedMarker === null}
                    title="Delete selected marker"
                  >
                    <Minus className="size-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-7 md:size-8"
                    onClick={addMarkerAtCurrentTime}
                    title={`Add marker at current position${isTouch ? " (M)" : ""}`}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Right column on Desktop / Flex on Mobile */}
            <div className="flex min-h-0 flex-col gap-2 md:overflow-auto">
              {/* Grid Layout Section */}
              {!isSequenceMode && !isGalleryMode && (
                <CollapsiblePanel
                  label="Grid Layout"
                  expanded={gridExpanded}
                  onToggle={toggleGrid}
                >
                  <div className="bg-card overflow-x-auto rounded-md border p-2">
                    <GridPreview
                      template={gridTemplate}
                      selectedCellIndex={selectedMarker}
                      onClickCell={handleGridCellClick}
                      assignedCount={effectiveCount}
                    />
                  </div>
                </CollapsiblePanel>
              )}

              {/* Markers Section */}
              <div
                className={cn(
                  "flex min-h-auto flex-col",
                  markersExpanded && "md:flex-1",
                )}
              >
                <CollapsiblePanel
                  label={
                    <span>
                      Markers
                      {!markersExpanded && (
                        <span>
                          {" ("}
                          <span
                            className={
                              markers.length > totalCells
                                ? "text-destructive"
                                : ""
                            }
                          >
                            {markers.length}
                          </span>
                          /{totalCells}
                          {")"}
                        </span>
                      )}
                    </span>
                  }
                  expanded={markersExpanded}
                  onToggle={toggleMarkers}
                  rightContent={
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1 p-0 -my-1 mx-2 text-xs text-destructive hover:text-destructive"
                      disabled={markers.length == 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearAllMarkers();
                      }}
                      title="Remove all markers"
                    >
                      <Trash2 className="size-3" />
                      <span>Clear all</span>
                    </Button>
                  }
                  className={cn(markersExpanded && "md:flex min-h-0 md:flex-1")}
                  bodyClassName="flex min-h-0 flex-col gap-1 p-2 md:min-h-0"
                >
                  {/* Marker count summary */}
                  <div className="shrink-0 text-muted-foreground text-xs text-center">
                    {markers.length === 0 ? (
                      <span>
                        No markers — all {totalCells} cells will use auto
                        timestamps.
                      </span>
                    ) : (
                      <>
                        <span className="text-foreground">
                          {effectiveCount} marker
                          {effectiveCount !== 1 ? "s" : ""} set for {totalCells}{" "}
                          cell{totalCells !== 1 ? "s" : ""}
                        </span>
                        {autoFilledCount > 0 && (
                          <span>
                            {" · "}
                            {autoFilledCount} cell
                            {autoFilledCount !== 1 ? "s" : ""} use auto fallback
                          </span>
                        )}
                        {markers.length > totalCells && (
                          <span className="text-destructive">
                            {" · "}
                            {markers.length - totalCells} marker
                            {markers.length - totalCells !== 1 ? "s" : ""}{" "}
                            ignored
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Marker list */}
                  <div
                    className={cn(
                      "flex flex-col p-3 gap-1",
                      "md:min-h-auto md:flex-1 md:overflow-auto",
                    )}
                  >
                    {markers.length === 0 ? (
                      <>
                        <p className="text-muted-foreground p-2 text-xs text-center">
                          {isTouch ? (
                            <>
                              Seek to a position and tap on the{" "}
                              <strong>+</strong> button or double tap the{" "}
                              seekbar to add a marker.
                            </>
                          ) : (
                            <>
                              Seek to a position and click <strong>+</strong>,
                              or press <Kbd>M</Kbd> to add a marker.
                            </>
                          )}
                        </p>
                        <div className="flex flex-col items-center gap-1.5 p-2">
                          <span className="text-muted-foreground text-[11px]">
                            Or add evenly spaced markers for
                          </span>
                          <div className="flex gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={makeFillHandler(0, duration)}
                              title={`Fill ${totalCells} markers across the full duration`}
                            >
                              Full duration
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={makeFillHandler(0, duration / 2)}
                              title={`Fill ${totalCells} markers in the first half`}
                            >
                              First half
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={makeFillHandler(duration / 2, duration)}
                              title={`Fill ${totalCells} markers in the second half`}
                            >
                              Second half
                            </Button>
                          </div>
                        </div>
                      </>
                    ) : (
                      markers.map((t, idx) => {
                        const isUsed = idx < totalCells;
                        const isSelected = selectedMarker === idx;
                        return (
                          <div
                            key={idx}
                            className={cn(
                              "bg-muted/50 hover:bg-primary/50 flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors box-content",
                              isSelected &&
                                "bg-selected text-selected-foreground border-selected outline outline-selected",
                              !isUsed && "opacity-60",
                            )}
                            onClick={() => seekToMarker(t, idx)}
                          >
                            <span className="w-7 shrink-0 font-mono text-[11px] tabular-nums">
                              #{idx + 1}
                            </span>
                            <span className="min-w-0 flex-1 font-mono text-[11px] tabular-nums truncate">
                              {fmtT(t)}
                            </span>
                            {!isUsed && (
                              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[10px] uppercase">
                                ignored
                              </span>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-6 shrink-0"
                              title="Delete this marker"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteMarker(idx);
                              }}
                            >
                              <X className="size-3" />
                            </Button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </CollapsiblePanel>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between sm:h-8">
            <p className="text-muted-foreground text-xs text-center">
              {isTouch ? (
                <>
                  Double-tap to add marker &nbsp;·&nbsp; Long-press marker to
                  remove
                </>
              ) : (
                <>
                  <Kbd>Space</Kbd> Play/Pause &nbsp;·&nbsp; <Kbd>M</Kbd> Add
                  Marker &nbsp;·&nbsp; <Kbd>Ctrl+Arrow</Kbd> frame-step
                  &nbsp;·&nbsp; Double-click seekbar to add marker &nbsp;·&nbsp;
                  Right-click marker to remove
                </>
              )}
            </p>
            <div className="flex items-center gap-2 self-end sm:self-auto">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMarkers(
                    calculateSampleTimes(totalCells, Math.max(1, duration)),
                  );
                  setSelectedMarker(null);
                }}
                title="Reset to evenly-spaced auto timestamps"
              >
                <RotateCcw className="size-4" />
                Reset
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                ref={saveButtonRef}
                variant="default"
                onClick={() => onSave(markers)}
              >
                Save Markers
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

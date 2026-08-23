import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, RotateCcw, Trash2 } from "lucide-react";
import type { SavedOptions, TaskItem } from "@/types";
import { useUiStore, selectTotalCells } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULTS } from "@/constants";
import { computeAnimationEstimate } from "@/gridUtils";
import { isItemUploadEligible } from "@/uploadUtils";
import { formatElapsed } from "@/utils";
import { useTick } from "@/lib/useTick";
import { cn } from "@/lib/utils";
import { getOrCreateUrl } from "@/lib/blobCache";

// Sub-components
import SourceInfoSection from "./TaskCard/SourceInfoSection";
import FfmpegLogsSection from "./TaskCard/FfmpegLogsSection";
import TimestampRow from "./TaskCard/TimestampRow";
import PreviewSection from "./TaskCard/PreviewSection";
import GalleryPreview from "./TaskCard/GalleryPreview";
import InfoPanel from "./TaskCard/InfoPanel";
import UploadResultsSection from "./TaskCard/UploadResultsSection";

// Shared components
import TimestampEditor from "./TimestampEditor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import Section from "./control/Section";

interface Props {
  /** 1-based position in the task list for display purposes. */
  position?: number;
  item: TaskItem;
  onPreview: (url: string) => void;
  onUpload: (id: string) => void;
  onUpdateTimestamps: (
    id: string,
    mode: "auto" | "custom",
    markers: number[],
  ) => void;
  onRemove: (id: string) => void;
  onRequeue: (id: string) => void;
  handleEnablePreviews: () => void;
  /** True when this specific task is detected as stale (stuck FFmpeg). */
  isStale?: boolean;
  /** Callback to force-kill FFmpeg for this task only. */
  onForceCancel?: () => void;
}

export default function TaskCard({
  position,
  item,
  onPreview,
  onUpload,
  onUpdateTimestamps,
  onRemove,
  onRequeue,
  handleEnablePreviews,
  isStale,
  onForceCancel,
}: Props) {
  // --- Read from Zustand stores directly ---
  const totalCells = useUiStore(selectTotalCells);
  const showPreview = useSettingsStore((s) => s.settings.showPreview);
  const destinations = useSettingsStore((s) => s.settings.destinations);
  const estimationMaxFrames = useSettingsStore(
    (s) => s.settings.estimationMaxFrames,
  );
  const estimationMaxPixels = useSettingsStore(
    (s) => s.settings.estimationMaxPixels,
  );
  const opts = useUiStore((s) => s.opts);

  // For done tasks, prefer the stored outputAnimationInfo (captured at
  // completion time) so the displayed info doesn't change when settings
  // are modified. For in-progress / queued tasks, compute a live estimate.
  // Only compute estimates for animated/sequence modes.
  const estimate = useMemo(() => {
    if (item.status === "done" && item.outputAnimationInfo) {
      return item.outputAnimationInfo;
    }
    if (!item.metadata || !opts) return null;
    // Only compute animation estimates for animated/sequence modes
    const mode =
      item.status === "done"
        ? item.completedOutputMode
        : (opts.outputMode ?? "static");
    if (mode !== "animated" && mode !== "sequence") return null;
    return computeAnimationEstimate(item.metadata, {
      outputMode: opts.outputMode ?? "static",
      animSegments: opts.animSegments ?? DEFAULTS.animSegments!,
      animDuration: opts.animDuration ?? DEFAULTS.animDuration!,
      animFps: opts.animFps ?? DEFAULTS.animFps!,
      width: opts.width ?? DEFAULTS.width!,
      cols: opts.cols ?? DEFAULTS.cols!,
      rows: opts.rows ?? DEFAULTS.rows!,
      spacing: opts.spacing ?? DEFAULTS.spacing!,
      header: Boolean(opts.header),
      vrMode: opts.vrMode ?? DEFAULTS.vrMode!,
      gridTemplate: opts.gridTemplate,
      headerFontSizeAuto: Boolean(opts.headerFontSizeAuto),
      headerFontSize: opts.headerFontSize ?? DEFAULTS.headerFontSize!,
    });
  }, [item.status, item.outputAnimationInfo, item.metadata, opts]);

  /**
   * Determine if this task will use FFmpeg processing based on current options.
   * Animated mode always uses FFmpeg for encoding (WebP or MP4).
   * Static grid mode doesn't always need FFmpeg — it only uses it as a fallback
   * when native browser video decoding fails, which we can't predict in advance.
   * The FFmpeg logs section will still appear for static mode once logs populate.
   */
  const needsFfmpeg = (o: SavedOptions): boolean =>
    (o.outputMode ?? "static") !== "static";

  const urlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [pendingMarkers, setPendingMarkers] = useState<number[] | null>(null);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [outputDimensions, setOutputDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // Track mounted state to prevent setState on unmounted component
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // --- Blob URL management (using blob cache) ---
  useEffect(() => {
    if (!item.outputBlob) {
      // Blob gone, clear the local URL reference.
      // The blob cache will release the URL when the task is removed.
      urlRef.current = null;
      setBlobUrl(null);
      setOutputDimensions(null);
      return;
    }
    if (!urlRef.current) urlRef.current = getOrCreateUrl(item.outputBlob);
    setBlobUrl(urlRef.current);

    // Read image dimensions from the blob
    const img = new Image();
    img.onload = () => {
      if (mountedRef.current) {
        setOutputDimensions({
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      }
    };
    img.src = urlRef.current;
    return () => {
      setOutputDimensions(null);
    };
  }, [item.outputBlob]);

  // --- Gallery blob URLs for download button ---
  const galleryBlobUrls = useMemo(() => {
    if (!item.galleryImages || item.galleryImages.length === 0) return [];
    return item.galleryImages.map((blob) => getOrCreateUrl(blob));
  }, [item.galleryImages]);

  // --- Live tick using useTick (replaces manual setInterval) ---
  useTick(item.status === "processing" && !!item.processingStartedAt, 100);

  // Compute status text with timing info.
  let statusText: string;
  if (item.status === "processing" && item.processingStartedAt) {
    statusText = `processing - ${formatElapsed(Date.now() - item.processingStartedAt)}`;
  } else if (item.status === "done" && item.processingDurationMs != null) {
    statusText = `done in ${formatElapsed(item.processingDurationMs)}`;
  } else {
    statusText = item.status;
  }

  const isDone = item.status === "done";
  const enabledDests = destinations.filter((d) => d.enabled);

  // Filter to only destinations eligible for this task's output
  const eligibleDests = enabledDests.filter((d) =>
    isItemUploadEligible(item, d),
  );

  const anyUploading = eligibleDests.some(
    (d) => item.uploads?.[d.id]?.status === "uploading",
  );
  // allDone: every eligible destination has all files in "done" state.
  // If any file is deleted, errored, or idle, the upload button stays available.
  const allDone =
    eligibleDests.length > 0 &&
    eligibleDests.every((d) => {
      const state = item.uploads?.[d.id];
      if (!state?.fileResults) return state?.status === "done";
      return state.fileResults.every((f) => f.status === "done");
    });

  const canUpload =
    isDone &&
    (!!item.outputBlob || (item.galleryImages?.length ?? 0) > 0) &&
    eligibleDests.length > 0 &&
    !anyUploading &&
    !allDone;

  const isCustom = item.timestampMode === "custom";
  const markerCount = item.customTimestamps?.length ?? 0;

  const applyMarkers = (markers: number[]) => {
    if (markers.length === 0) {
      onUpdateTimestamps(item.id, "auto", []);
    } else {
      onUpdateTimestamps(item.id, "custom", markers);
    }
  };

  const handleSaveMarkers = (markers: number[]) => {
    if (item.status === "done") {
      setPendingMarkers(markers);
      setShowEditor(false);
      return;
    }
    applyMarkers(markers);
    setShowEditor(false);
  };

  const handleRequeueConfirm = () => {
    if (pendingMarkers != null) {
      applyMarkers(pendingMarkers);
      onRequeue(item.id);
      setPendingMarkers(null);
    }
  };

  const handleRequeueDecline = () => {
    if (pendingMarkers != null) {
      applyMarkers(pendingMarkers);
      setPendingMarkers(null);
    }
  };

  const canEditTimestamps = item.status !== "processing" && !!item.metadata;
  const canRequeue =
    item.status === "done" ||
    item.status === "error" ||
    item.status === "cancelled";

  const handleShowPreviewDialog = useCallback(
    () => setShowPreviewDialog(true),
    [],
  );

  return (
    <>
      <Section
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        groupKey="task-list"
        bodyClassName="flex flex-col gap-3 !grid-cols-1"
        className={cn(
          item.status === "error" && "border-destructive/50",
          allDone && "border-emerald-500/40",
        )}
        renderTrigger={() => (
          <>
            {position != null && (
              <Badge
                variant="info"
                className="text-xs uppercase shrink-0 font-mono p-1"
              >
                #{position}
              </Badge>
            )}
            <div className="min-w-0 flex-1">
              <h3
                className="truncate text-sm font-semibold"
                title={item.source.name}
              >
                {item.source.name}
              </h3>
            </div>
            <Badge variant={item.status} className="uppercase shrink-0">
              {item.status}
            </Badge>
            <Button
              variant="destructive"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item.id);
              }}
              disabled={item.status === "processing"}
              title="Remove this task"
              className="h-6 w-6 p-1"
            >
              <Trash2 className="size-3" />
            </Button>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </>
        )}
      >
        {/* Warning row */}
        {item.warning && (
          <Alert className="py-2 px-3">
            <AlertTriangle />
            <AlertDescription>{item.warning}</AlertDescription>
          </Alert>
        )}

        {/* Error row */}
        {item.error && (
          <Alert variant="destructive" className="py-2 px-3">
            <AlertTriangle />
            <AlertDescription>{item.error}</AlertDescription>
          </Alert>
        )}

        {/* Stale warning */}
        {isStale && (
          <Alert variant="destructive" className="py-2 px-3">
            <AlertTriangle />
            <AlertDescription>
              FFmpeg processing might be stuck, if you don't see any progress in
              the FFmpeg log after some time you can press the "Kill" button to
              proceed.
            </AlertDescription>
          </Alert>
        )}

        {/* Source Info */}
        {item.metadata && (
          <SourceInfoSection
            metadata={item.metadata}
            filename={item.source.name}
            fileSize={item.source.size}
          />
        )}

        {/* FFmpeg Logs — shown when processing + FFmpeg needed, or when logs exist */}
        {(item.status === "processing" && needsFfmpeg(opts)) ||
        (item.ffmpegLogs && item.ffmpegLogs.length > 0) ? (
          <FfmpegLogsSection
            logs={item.ffmpegLogs ?? []}
            totalLines={item.ffmpegTotalLines}
            isProcessing={item.status === "processing"}
            isStale={isStale}
            onForceCancel={onForceCancel}
          />
        ) : null}

        {/* Timestamp row */}
        <TimestampRow
          isCustom={isCustom}
          markerCount={markerCount}
          totalCells={totalCells}
          canEdit={canEditTimestamps}
          onEdit={() => setShowEditor(true)}
        />

        {/* Preview + info grid */}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* For done tasks, use the stored completedOutputMode so switching
             global options doesn't change the preview type. */}
          {(item.status === "done" && item.completedOutputMode === "gallery") ||
          (item.status !== "done" && opts.outputMode === "gallery") ? (
            <GalleryPreview
              item={item}
              showPreview={showPreview}
              onPreview={onPreview}
              onShowPreviewDialog={handleShowPreviewDialog}
            />
          ) : (
            <PreviewSection
              item={item}
              blobUrl={blobUrl}
              showPreview={showPreview}
              onPreview={onPreview}
              onShowPreviewDialog={handleShowPreviewDialog}
            />
          )}
          <InfoPanel
            item={item}
            blobUrl={blobUrl}
            statusText={statusText}
            outputDimensions={outputDimensions}
            destinations={destinations}
            canUpload={canUpload}
            canRequeue={canRequeue}
            estimate={estimate}
            estimationMaxFrames={estimationMaxFrames}
            estimationMaxPixels={estimationMaxPixels}
            onUpload={() => onUpload(item.id)}
            onRequeue={() => onRequeue(item.id)}
            onDownloadGallery={() => {
              useUiStore.getState().downloadGallery(item.id);
            }}
            galleryBlobUrls={galleryBlobUrls}
            galleryCurrentIndex={item.galleryCurrentIndex}
            galleryImageNames={item.galleryImageNames}
          />
        </div>

        {/* Upload results */}
        <UploadResultsSection item={item} destinations={destinations} />
      </Section>

      {/* Timestamp Editor Dialog */}
      {showEditor && item.metadata && (
        <TimestampEditor
          item={item}
          totalCells={totalCells}
          onSave={handleSaveMarkers}
          onClose={() => setShowEditor(false)}
        />
      )}

      {/* Requeue Confirmation Dialog */}
      <AlertDialog
        open={pendingMarkers !== null}
        onOpenChange={(open) => {
          if (!open) handleRequeueDecline();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Requeue with new timestamps?</AlertDialogTitle>
            <AlertDialogDescription>
              This task is already done. Requeue it with the new timestamps for
              processing?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleRequeueDecline}>
              Save markers only
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRequeueConfirm}>
              <RotateCcw className="size-4" />
              Save & Requeue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview Enable Dialog */}
      {showPreviewDialog && (
        <AlertDialog
          open={showPreviewDialog}
          onOpenChange={setShowPreviewDialog}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Enable previews?</AlertDialogTitle>
              <AlertDialogDescription>
                You have disabled previews in the settings.
                <br />
                Do you want to enable them again?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setShowPreviewDialog(false)}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-primary hover:bg-primary/90"
                onClick={() => {
                  handleEnablePreviews();
                  setShowPreviewDialog(false);
                }}
              >
                Enable Previews
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

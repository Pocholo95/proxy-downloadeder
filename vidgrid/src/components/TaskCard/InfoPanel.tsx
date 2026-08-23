import {
  Cloud,
  Download,
  RotateCcw,
  AlertTriangle,
  Check,
  Archive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/CopyField";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { AnimationEstimate } from "@/types";
import type { TaskItem } from "@/types";
import type { UploadDestination } from "@/types";
import { isItemUploadEligible } from "@/uploadUtils";
import { buildBbcodeTitle, humanPixels, humanSize } from "@/utils";

interface Props {
  item: TaskItem;
  blobUrl: string | null;
  statusText: string;
  outputDimensions: { width: number; height: number } | null;
  destinations: UploadDestination[];
  canUpload: boolean;
  canRequeue: boolean;
  estimate: AnimationEstimate | null;
  estimationMaxFrames: number;
  estimationMaxPixels: number;
  onUpload: () => void;
  onRequeue: () => void;
  onDownloadGallery?: () => void;
  /** Gallery: blob URLs for each frame (populated when outputMode === "gallery") */
  galleryBlobUrls?: string[];
  /** Gallery: current index being previewed */
  galleryCurrentIndex?: number;
  /** Gallery: filenames for each frame */
  galleryImageNames?: string[];
}

export default function InfoPanel({
  item,
  blobUrl,
  statusText,
  outputDimensions,
  destinations,
  canUpload,
  canRequeue,
  estimate,
  estimationMaxFrames,
  estimationMaxPixels,
  onUpload,
  onRequeue,
  onDownloadGallery,
  galleryBlobUrls,
  galleryCurrentIndex,
  galleryImageNames,
}: Props) {
  const isDone = item.status === "done";
  const enabledDests = destinations.filter((d) => d.enabled);

  // Helper: check if a destination truly has everything done
  const isDestFullyDone = (d: UploadDestination): boolean => {
    const state = item.uploads?.[d.id];
    if (!state?.fileResults) return state?.status === "done";
    return state.fileResults.every((f) => f.status === "done");
  };

  // Filter enabled destinations to only those eligible for this task's output
  // and not fully done (so deleted/errored files keep the destination visible)
  const eligibleDests = enabledDests.filter(
    (d) => isItemUploadEligible(item, d) && !isDestFullyDone(d),
  );

  const allDone =
    enabledDests.length > 0 && enabledDests.every((d) => isDestFullyDone(d));

  // BBCode video title
  const bbcodeVideoTitle = buildBbcodeTitle(item);

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        <span className="text-muted-foreground">Task status: </span>
        <span className="inline-block first-letter-capitalize">
          {statusText}
        </span>
      </p>
      {/* Animation estimates (shown while queued/processing for animated output) */}
      {estimate && !isDone && (
        <div className="flex flex-col gap-1 pt-1">
          <span className="text-muted-foreground">Animation estimates:</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {/* Frames */}
            <span className="flex items-center gap-1">
              {estimationMaxFrames > 0 &&
              estimate.totalFrames >= estimationMaxFrames ? (
                <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
              ) : (
                <Check className="size-3.5 shrink-0 text-emerald-500" />
              )}
              <span
                className={
                  estimationMaxFrames > 0 &&
                  estimate.totalFrames >= estimationMaxFrames
                    ? "text-amber-600 dark:text-amber-400 font-medium"
                    : ""
                }
              >
                {estimate.totalFrames.toLocaleString()} frames
              </span>
            </span>
            {/* Pixels */}
            <span className="flex items-center gap-1">
              {estimationMaxPixels > 0 &&
              estimate.totalPixels >= estimationMaxPixels ? (
                <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
              ) : (
                <Check className="size-3.5 shrink-0 text-emerald-500" />
              )}
              <span
                className={
                  estimationMaxPixels > 0 &&
                  estimate.totalPixels >= estimationMaxPixels
                    ? "text-amber-600 dark:text-amber-400 font-medium"
                    : ""
                }
              >
                {humanPixels(estimate.totalPixels)} pixels
              </span>
            </span>
            {/* Canvas dimensions */}
            <span className="text-muted-foreground">
              ({estimate.canvasWidth}×{estimate.canvasHeight})
            </span>
          </div>
        </div>
      )}
      {/* Output details (shown when task is done) */}
      {isDone && (
        <div className="flex flex-col gap-1 pt-1">
          <span className="text-muted-foreground">Output details:</span>
          <div className="flex flex-col gap-1 text-xs">
            {/* File size + dimensions */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {item.outputSize && (
                <span>
                  {item.galleryImages && item.galleryImages.length > 0
                    ? `Total gallery size: ${humanSize(item.outputSize)} (${item.galleryImages.length} images)`
                    : `File size: ${humanSize(item.outputSize)}`}
                </span>
              )}
              {outputDimensions && (
                <span className="text-muted-foreground">
                  ({outputDimensions.width}×{outputDimensions.height})
                </span>
              )}
            </div>
            {/* Animation-specific details (only for animated output, not gallery) */}
            {estimate && item.completedOutputMode !== "gallery" && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* Frames */}
                <span className="flex items-center gap-1">
                  {estimationMaxFrames > 0 &&
                  estimate.totalFrames >= estimationMaxFrames ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <Check className="size-3.5 shrink-0 text-emerald-500" />
                  )}
                  <span
                    className={
                      estimationMaxFrames > 0 &&
                      estimate.totalFrames >= estimationMaxFrames
                        ? "text-amber-600 dark:text-amber-400 font-medium"
                        : ""
                    }
                  >
                    {estimate.totalFrames.toLocaleString()} frames
                  </span>
                </span>
                {/* Pixels */}
                <span className="flex items-center gap-1">
                  {estimationMaxPixels > 0 &&
                  estimate.totalPixels >= estimationMaxPixels ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <Check className="size-3.5 shrink-0 text-emerald-500" />
                  )}
                  <span
                    className={
                      estimationMaxPixels > 0 &&
                      estimate.totalPixels >= estimationMaxPixels
                        ? "text-amber-600 dark:text-amber-400 font-medium"
                        : ""
                    }
                  >
                    {humanPixels(estimate.totalPixels)} pixels
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      {item.outputName && (
        <p>
          <span className="text-muted-foreground">Output name: </span>
          <span className="break-all">
            {galleryImageNames?.[galleryCurrentIndex ?? 0] ?? item.outputName}
          </span>
        </p>
      )}
      <div className="flex flex-col gap-1 my-2">
        <span className="text-xs font-medium">
          BBCode — video title + resolution
        </span>
        <CopyField value={bbcodeVideoTitle} fieldType="input" />
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {isDone && item.outputBlob && item.outputName && (
          <Button asChild variant="outline" size="sm">
            <a
              href={
                galleryBlobUrls?.[galleryCurrentIndex ?? 0] ?? blobUrl ?? "#"
              }
              download={
                galleryImageNames?.[galleryCurrentIndex ?? 0] ?? item.outputName
              }
            >
              <Download className="size-4" />
              Download{" "}
              {(
                galleryImageNames?.[galleryCurrentIndex ?? 0] ?? item.outputName
              )
                .split(".")
                .pop()
                ?.toUpperCase() ?? "File"}
              {galleryBlobUrls && galleryBlobUrls.length > 1
                ? ` (Frame ${galleryCurrentIndex != null ? galleryCurrentIndex + 1 : 1})`
                : ""}
            </a>
          </Button>
        )}
        {isDone &&
          item.galleryImages &&
          item.galleryImages.length > 1 &&
          onDownloadGallery && (
            <Button
              variant="outline"
              size="sm"
              onClick={onDownloadGallery}
              title={`Download all ${item.galleryImages.length} gallery frames as ZIP`}
            >
              <Archive className="size-4" />
              Download Gallery (ZIP)
            </Button>
          )}
        {isDone && eligibleDests.length > 0 && !allDone && (
          <Button
            variant="default"
            size="sm"
            onClick={onUpload}
            disabled={!canUpload}
            title={`Upload to ${eligibleDests.map((d) => d.name).join(", ")}`}
          >
            <Cloud className="size-4" />
            Upload
            {eligibleDests.length === 1
              ? ` to ${eligibleDests[0].name}`
              : ` (${eligibleDests.length} destinations)`}
          </Button>
        )}
        {isDone &&
          eligibleDests.length === 0 &&
          enabledDests.length > 0 &&
          !allDone && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="default" size="sm" className="opacity-60">
                  <Cloud className="size-4" />
                  Upload
                  {enabledDests.length === 1
                    ? ` to ${enabledDests[0].name}`
                    : ` (${enabledDests.length} destinations)`}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64" side="top" align="start">
                <p className="text-sm font-medium">Upload unavailable</p>
                <p className="text-muted-foreground text-xs mt-1">
                  No enabled destinations accept this file type or size.
                </p>
              </PopoverContent>
            </Popover>
          )}
        {canRequeue && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRequeue}
            title="Requeue this task to process it again"
          >
            <RotateCcw className="size-4" />
            Requeue
          </Button>
        )}
      </div>
      {/* Per-destination upload progress (only for legacy single-file mode;
          gallery multi-file mode shows progress inside each frame row) */}
      {enabledDests.map((dest) => {
        const state = item.uploads?.[dest.id];
        if (!state || state.status === "idle") return null;
        // Skip if fileResults exist (gallery multi-file mode - progress shown in UploadResultsSection)
        if (state.fileResults) return null;
        if (state.status === "uploading") {
          return (
            <Field key={dest.id}>
              <FieldLabel className="text-muted-foreground flex w-full justify-between text-xs font-normal">
                <span>Uploading to {dest.name}…</span>
                <span>{state.progress}%</span>
              </FieldLabel>
              <Progress value={state.progress} />
            </Field>
          );
        }
        if (state.status === "error" && state.error) {
          return (
            <p key={dest.id} className="text-destructive text-xs">
              Upload to {dest.name} failed: {state.error}
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}

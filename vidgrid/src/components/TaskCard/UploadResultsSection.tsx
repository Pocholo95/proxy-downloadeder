import { useState } from "react";
import { useSectionSync } from "@/hooks/useSectionSync";
import {
  RefreshCw,
  Trash2,
  Check,
  X,
  Loader2,
  ChevronDown,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CopyField } from "@/components/CopyField";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { buildFormats, type LinkFormat } from "@/uploadUtils";
import { resolveCanHotlink } from "@/upload/providers";
import { canDeleteFromDestination, deleteFromDestination } from "@/upload";
import type {
  TaskItem,
  UploadDestination,
  FileUploadResult,
  UploadResult,
} from "@/types";
import { useUploadStore } from "@/store/uploadStore";

interface Props {
  item: TaskItem;
  destinations: UploadDestination[];
}

/**
 * Build aggregated link formats from all successful file results.
 * Each format contains all individual codes joined by spaces, preserving
 * gallery frame order.
 *
 * For bbcodePostTemplate, the bold title line is only emitted once (from the
 * first frame) and subsequent frames only contribute their image/link lines.
 */
function buildAggregatedFormats(
  fileResults: FileUploadResult[],
  filename: string,
  canHotlink: boolean,
  metadata?: TaskItem["metadata"],
): LinkFormat[] {
  const doneResults = fileResults
    .map((fr, idx) => ({ fr, idx }))
    .filter(({ fr }) => fr.status === "done" && fr.result);

  if (doneResults.length === 0) return [];

  // Collect individual format values per format key
  const formatKeys = [
    "bbcodeFull",
    "bbcodeThumb",
    "bbcodePostTemplate",
    "directUrl",
    "pageUrl",
    "markdown",
    "htmlImg",
  ];

  const aggregated: Record<
    string,
    {
      label: string;
      value: string;
      description: string;
      fieldType?: "input" | "textarea";
    }
  > = {};

  for (const { fr } of doneResults) {
    const formats = buildFormats(
      fr.result!,
      fr.filename ?? filename,
      canHotlink,
      metadata,
    );
    for (const fmt of formats) {
      if (!aggregated[fmt.key]) {
        aggregated[fmt.key] = {
          label: fmt.label,
          value: "",
          description: fmt.description,
          fieldType: fmt.fieldType,
        };
      }

      if (fmt.key === "bbcodePostTemplate") {
        // For the first frame, keep the full value (title + image). For
        // subsequent frames, strip the title line ([b]...[/b]\n) so the
        // title only appears once at the top. Use [\s\S]*? to handle nested
        // BBCode tags (e.g. [COLOR=...]) inside the title that contain ']'.
        if (aggregated[fmt.key].value === "") {
          // First frame – keep everything (title + image BBCode)
          aggregated[fmt.key].value = fmt.value;
        } else {
          // Subsequent frames – strip title, keep only image BBCode body
          const bodyOnly = fmt.value.replace(/^\[b\][\s\S]*?\[\/b\]\n?/, "");
          // Join all image BBCode on a single line, separated by spaces.
          aggregated[fmt.key].value += " " + bodyOnly;
        }
      } else {
        if (aggregated[fmt.key].value) {
          aggregated[fmt.key].value += ` ${fmt.value}`;
        } else {
          aggregated[fmt.key].value = fmt.value;
        }
      }
    }
  }

  // Convert to array, preserving format key order
  return formatKeys
    .map((key) => {
      const agg = aggregated[key];
      if (!agg) return null;
      return {
        key,
        label: agg.label,
        value: agg.value,
        description: agg.description,
        fieldType: agg.fieldType,
      };
    })
    .filter(Boolean) as LinkFormat[];
}

/**
 * Compact frame status indicator (single character icon per frame).
 */
function FrameStatusIcon({
  status,
  error,
}: {
  status: string;
  error?: string;
}) {
  if (status === "done") {
    return <Check className="size-3 text-emerald-500 shrink-0" />;
  }
  if (status === "error") {
    return error ? (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="p-0.5 rounded cursor-pointer hover:bg-muted hover:ring-2 hover:ring-destructive/40 transition-all"
          >
            <AlertCircle className="size-3.5 text-destructive shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="max-w-[min(90vw,32rem)] max-h-112 overflow-y-auto"
          side="top"
          align="start"
        >
          <p className="text-xs text-destructive whitespace-pre-wrap wrap-break-word leading-relaxed">
            {error}
          </p>
        </PopoverContent>
      </Popover>
    ) : (
      <X className="size-3 text-destructive shrink-0" />
    );
  }
  if (status === "uploading") {
    return <Loader2 className="size-3 animate-spin text-blue-500 shrink-0" />;
  }
  return <div className="size-3 shrink-0 rounded-full bg-muted" />;
}

/**
 * Per-destination file upload section with collapsible frame rows.
 * Extracted as a separate component so useState can be used safely.
 */
function DestinationFileSection({
  dest,
  fileResults,
  filename,
  metadata,
  onRetryDest,
  onRetryFile,
  onDeleteFile,
  onDeleteAll,
  deletingDestId,
  groupKey,
}: {
  dest: UploadDestination;
  fileResults: FileUploadResult[];
  filename: string;
  metadata?: TaskItem["metadata"];
  onRetryDest: (destId: string) => void;
  onRetryFile: (destId: string, fileIndex: number) => void;
  onDeleteFile: (destId: string, fileIndex: number) => void;
  onDeleteAll: (dest: UploadDestination) => void;
  deletingDestId: string | null;
  groupKey?: string;
}) {
  const [showDeletePopover, setShowDeletePopover] = useState(false);
  const [sectionExpanded, setSectionExpanded] = useState(true);
  const { handleOpenChange, shiftRef } = useSectionSync(
    groupKey,
    sectionExpanded,
    () => setSectionExpanded((v) => !v),
  );
  const [deletingFileIdx, setDeletingFileIdx] = useState<number | null>(null);

  const doneFiles = fileResults.filter((f) => f.status === "done");
  const errorFiles = fileResults.filter((f) => f.status === "error");
  const uploadingFiles = fileResults.filter((f) => f.status === "uploading");
  const anyActive = uploadingFiles.length > 0;

  const aggregatedFormats = buildAggregatedFormats(
    fileResults,
    filename,
    resolveCanHotlink(dest.type),
    metadata,
  );

  // Per-frame delete handler
  const handleDeleteSingleFile = async (fileIndex: number) => {
    const fr = fileResults[fileIndex];
    if (!fr?.result) {
      onDeleteFile(dest.id, fileIndex);
      return;
    }
    // Chevereto (link-based deletion, no API): open delete page in new tab,
    // do NOT remove item from UI (we can't confirm the user deleted it)
    if (dest.type === "chevereto") {
      if (fr.result.deleteUrl) {
        window.open(fr.result.deleteUrl, "_blank", "noopener noreferrer");
      }
      return;
    }
    // Providers with API delete (im.ge, filester, etc.): call delete then remove
    setDeletingFileIdx(fileIndex);
    try {
      await deleteFromDestination(fr.result, dest);
    } catch {
      // Ignore error, still clear
    } finally {
      setDeletingFileIdx(null);
      onDeleteFile(dest.id, fileIndex);
    }
  };

  // Delete All handler: Chevereto shows popover, others show confirmation dialog
  const handleDeleteAll = () => {
    if (dest.type === "chevereto") {
      // Single file: open delete link directly (no popover)
      if (singleFile && doneFiles[0]?.result?.deleteUrl) {
        window.open(
          doneFiles[0].result.deleteUrl,
          "_blank",
          "noopener noreferrer",
        );
        return;
      }
      // Multiple files: show popover with delete links
      setShowDeletePopover(true);
    } else {
      onDeleteAll(dest);
    }
  };

  // Determine if we have a single file (simplified display)
  const singleFile = fileResults.length === 1;

  // Delete button text: singularize for single file
  const deleteButtonText = doneFiles.length === 1 ? "Delete" : "Delete All";
  const deleteButtonTitle =
    doneFiles.length === 1
      ? `Delete the file from ${dest.name}`
      : `Delete all ${doneFiles.length} file(s) from ${dest.name}`;

  const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    shiftRef.current = e.shiftKey;
    if (e.shiftKey) {
      e.preventDefault();
    }
  };

  return (
    <Collapsible
      className="rounded-md border"
      open={sectionExpanded}
      onOpenChange={handleOpenChange}
      data-group={groupKey}
    >
      {/* Header row: CollapsibleTrigger only wraps the label+chevron; delete button is outside to avoid nested <button> */}
      <div
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onPointerDown={handlePointerDown}
      >
        {/* Left: Name + progress (clickable to toggle) — use <div> to avoid nested <button> when PopoverTrigger<Button> is a sibling */}
        <CollapsibleTrigger asChild>
          <div className="flex flex-1 items-center gap-2 text-sm font-medium text-left cursor-pointer">
            <span>{dest.name}</span>
            {doneFiles.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {doneFiles.length}/{fileResults.length} done
              </span>
            )}
            <ChevronDown
              className={`size-4 shrink-0 transition-transform duration-200 ml-auto ${
                sectionExpanded ? "rotate-180" : ""
              }`}
            />
          </div>
        </CollapsibleTrigger>

        {/* Middle: Delete button (outside CollapsibleTrigger to avoid nested <button>) */}
        {doneFiles.length > 0 &&
          /* Only wrap in Popover for Chevereto with multiple files (needs delete links list).
             Single Chevereto file opens delete URL directly. Non-Chevereto shows AlertDialog. */
          (dest.type === "chevereto" && !singleFile ? (
            <Popover
              open={showDeletePopover}
              onOpenChange={(open) => {
                if (!open) setShowDeletePopover(false);
                setShowDeletePopover(open);
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  title={deleteButtonTitle}
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteAll();
                  }}
                  disabled={deletingDestId !== null}
                >
                  {deletingDestId === dest.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {deleteButtonText}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-64"
                side="top"
                align="start"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-medium">
                    {doneFiles.length === 1
                      ? "Open delete link"
                      : `Open delete links for ${doneFiles.length} file(s)`}
                  </p>
                  <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                    {doneFiles.map((f: FileUploadResult, idx: number) => (
                      <a
                        key={idx}
                        href={f.result!.deleteUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        {singleFile
                          ? "Delete link"
                          : `Frame ${idx + 1} delete link`}
                      </a>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDeletePopover(false)}
                    >
                      Close
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        doneFiles.forEach((f) => {
                          window.open(
                            f.result!.deleteUrl!,
                            "_blank",
                            "noopener noreferrer",
                          );
                        });
                        setShowDeletePopover(false);
                      }}
                    >
                      {doneFiles.length === 1
                        ? "Open Delete Link"
                        : "Open All Delete Links"}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              title={deleteButtonTitle}
              className="text-destructive hover:text-destructive shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAll();
              }}
              disabled={deletingDestId !== null}
            >
              {deletingDestId === dest.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {deleteButtonText}
            </Button>
          ))}
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t p-3">
          {singleFile ? (
            /* Single file: skip status row when done (delete handled by header button).
               Show error message directly with retry. Show progress when uploading/idle. */
            <>
              {fileResults[0].status === "error" && (
                <div className="flex items-start gap-2 text-sm">
                  <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-destructive">Upload failed</p>
                    {fileResults[0].error && (
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                        {fileResults[0].error}
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRetryFile(dest.id, 0)}
                      title="Retry upload"
                      disabled={anyActive}
                      className="mt-2"
                    >
                      <RefreshCw className="size-3" />
                      Retry
                    </Button>
                  </div>
                </div>
              )}
              {(fileResults[0].status === "uploading" ||
                fileResults[0].status === "idle") && (
                <div className="flex items-center gap-2">
                  <FrameStatusIcon status={fileResults[0].status} />
                  <span className="text-xs text-muted-foreground flex-1">
                    {fileResults[0].status === "uploading"
                      ? `Uploading… ${fileResults[0].progress}%`
                      : "Waiting…"}
                  </span>
                  {fileResults[0].status === "uploading" && (
                    <Progress
                      value={fileResults[0].progress}
                      className="flex-1"
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            /* Multiple files: frame status bar + horizontal scrollable card strip */
            <>
              {/* Horizontal scrollable frame card strip — always visible */}
              <div className="flex gap-2 overflow-x-auto pb-2">
                {fileResults.map((fr, idx) => {
                  return (
                    <div
                      key={idx}
                      className="flex flex-col items-center gap-1.5 w-24 p-1 rounded-md border shrink-0 bg-card"
                      title={`Frame ${idx + 1}: ${fr.status}${fr.error ? ` - ${fr.error}` : ""}`}
                    >
                      {/* Frame number badge */}
                      <span className="text-xs font-medium text-muted-foreground">
                        {idx + 1}
                      </span>

                      {fr.status === "deleted" ? (
                        /* Deleted — show reupload button, matches error card layout */
                        <>
                          <X className="size-3 text-muted-foreground shrink-0" />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onRetryFile(dest.id, idx)}
                            title={`Reupload frame ${idx + 1} to ${dest.name}`}
                            disabled={anyActive}
                            className="shrink-0 w-full mt-auto"
                          >
                            <RefreshCw className="size-3" />
                            <span className="text-xs">Reupload</span>
                          </Button>
                        </>
                      ) : (
                        <>
                          {/* Status icon */}
                          <FrameStatusIcon
                            status={fr.status}
                            error={fr.error}
                          />

                          {/* Progress for uploading */}
                          {fr.status === "uploading" && (
                            <div className="flex flex-col items-center gap-0.5 w-full">
                              <Progress
                                value={fr.progress}
                                className="w-full"
                              />
                              <span className="text-xs text-muted-foreground">
                                {fr.progress}%
                              </span>
                            </div>
                          )}

                          {/* Idle */}
                          {fr.status === "idle" && (
                            <span className="text-xs text-muted-foreground">
                              Waiting…
                            </span>
                          )}

                          {/* Done — delete button */}
                          {fr.status === "done" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteSingleFile(idx)}
                              title={`Delete frame ${idx + 1} from ${dest.name}`}
                              disabled={
                                deletingFileIdx !== null ||
                                (dest.type !== "chevereto" &&
                                  deletingDestId === dest.id)
                              }
                              className="text-destructive hover:text-destructive shrink-0 w-full"
                            >
                              {deletingFileIdx === idx ||
                              (dest.type !== "chevereto" &&
                                deletingDestId === dest.id) ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <Trash2 className="size-3" />
                              )}
                            </Button>
                          )}

                          {/* Error — retry button */}
                          {fr.status === "error" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onRetryFile(dest.id, idx)}
                              title={`Retry upload for frame ${idx + 1}`}
                              disabled={anyActive}
                              className="shrink-0 w-full"
                            >
                              <RefreshCw className="size-3" />
                              <span className="text-xs">Retry</span>
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Retry all failed button */}
              {errorFiles.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRetryDest(dest.id)}
                    title={`Retry all ${errorFiles.length} failed file(s)`}
                    disabled={anyActive}
                  >
                    <RefreshCw className="size-3" />
                    Retry All Failed ({errorFiles.length})
                  </Button>
                </div>
              )}
            </>
          )}

          {/* Aggregated CopyFields per format */}
          {aggregatedFormats.map((fmt) => (
            <div key={fmt.key} className="flex flex-col gap-1.5">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{fmt.label}</span>
                <span className="text-muted-foreground text-xs">
                  {fmt.description}
                  {doneFiles.length > 1
                    ? ` (${doneFiles.length} frames, space-separated)`
                    : ""}
                </span>
              </div>
              <CopyField
                value={fmt.value}
                fieldType={fmt.fieldType === "textarea" ? "textarea" : "input"}
                rows={fmt.fieldType === "textarea" ? 3 : undefined}
              />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Single-file upload links (for non-gallery output modes) */
function SingleFileUploadLinks({
  dest,
  result,
  filename,
  metadata,
  onDelete,
  groupKey,
}: {
  dest: UploadDestination;
  result: UploadResult;
  filename: string;
  metadata?: TaskItem["metadata"];
  onDelete: (destId: string) => void;
  groupKey?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const { handleOpenChange: handleSyncOpenChange, shiftRef: syncShiftRef } =
    useSectionSync(groupKey, expanded, () => setExpanded((v) => !v));
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const formats = buildFormats(
    result,
    filename,
    resolveCanHotlink(dest.type),
    metadata,
  );

  const useDirectDelete = dest.type === "chevereto";

  const handleDeleteClick = () => {
    if (useDirectDelete) {
      window.open(result.deleteUrl, "_blank", "noopener noreferrer");
      return;
    }
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteFromDestination(result, dest);
      onDelete(dest.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (!open && deleting) return;
    setShowDeleteDialog(open);
  };

  const handleSinglePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    syncShiftRef.current = e.shiftKey;
    if (e.shiftKey) {
      e.preventDefault();
    }
  };

  return (
    <>
      <Collapsible
        open={expanded}
        onOpenChange={handleSyncOpenChange}
        className="rounded-md border"
        data-group={groupKey}
      >
        {/* Header row: CollapsibleTrigger only wraps the label+chevron; delete button is outside to avoid nested <button> */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          onPointerDown={handleSinglePointerDown}
        >
          {/* Left: Name + chevron (clickable to toggle) — use <div> to avoid nested <button> when delete Button is a sibling */}
          <CollapsibleTrigger asChild>
            <div className="flex flex-1 items-center justify-between gap-2 text-sm font-medium cursor-pointer">
              <span className="flex items-center gap-2">
                <span>{dest.name}</span>
              </span>
              <ChevronDown
                className={`size-4 shrink-0 transition-transform duration-200 ${
                  expanded ? "rotate-180" : ""
                }`}
              />
            </div>
          </CollapsibleTrigger>
          {/* Right: Delete button (outside CollapsibleTrigger to avoid nested <button>) */}
          {result.deleteUrl && canDeleteFromDestination(result, dest) && (
            <Button
              variant="ghost"
              size="sm"
              title={`Delete this image from ${dest.name}`}
              className="text-destructive hover:text-destructive shrink-0"
              onClick={!useDirectDelete ? handleDeleteClick : undefined}
            >
              <span className="flex items-center gap-2">
                <Trash2 className="size-4" />
                Delete
              </span>
            </Button>
          )}
        </div>

        <CollapsibleContent>
          <div className="flex flex-col gap-3 border-t p-3">
            {formats.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{f.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {f.description}
                  </span>
                </div>
                <CopyField
                  value={f.value}
                  fieldType={f.fieldType === "textarea" ? "textarea" : "input"}
                  rows={3}
                />
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <AlertDialog
        open={showDeleteDialog}
        onOpenChange={handleDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete from {dest.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the uploaded file from the server.
              The file cannot be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div className="text-destructive text-sm">{deleteError}</div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={handleConfirmDelete}
              disabled={deleting}
            >
              <Trash2 className="size-4" />
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function UploadResultsSection({ item, destinations }: Props) {
  const enabledDests = destinations.filter((d) => d.enabled);
  const clearUploadResult = useUploadStore((s) => s.clearUploadResult);
  const removeFileResult = useUploadStore((s) => s.removeFileResult);
  const retryFailedFiles = useUploadStore((s) => s.retryFailedFiles);
  const retrySingleFile = useUploadStore((s) => s.retrySingleFile);

  /** Batch delete all files for a destination */
  const [deletingDestId, setDeletingDestId] = useState<string | null>(null);
  const [deletingProgress, setDeletingProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteDest = (destId: string) => {
    clearUploadResult(item.id, destId);
  };

  const handleDeleteFile = (destId: string, fileIndex: number) => {
    // Remove the file result from the array (don't leave it in idle/"Waiting" state)
    removeFileResult(item.id, destId, fileIndex);
  };

  const handleRetryDest = async (destId: string) => {
    await retryFailedFiles(item.id, destId);
  };

  const handleRetryFile = async (destId: string, fileIndex: number) => {
    await retrySingleFile(item.id, destId, fileIndex);
  };

  // Show if any destination has uploads in progress, done files, deleted files, or errors
  const hasRelevantUploads = enabledDests.some((d) => {
    const state = item.uploads?.[d.id];
    if (!state) return false;
    // Gallery mode: check fileResults (include deleted so reupload cards are visible)
    if (state.fileResults) {
      return state.fileResults.some(
        (f) =>
          f.status === "done" ||
          f.status === "uploading" ||
          f.status === "idle" ||
          f.status === "error" ||
          f.status === "deleted",
      );
    }
    // Single-file mode: check top-level status
    return state.status === "done" || state.status === "uploading";
  });
  if (!hasRelevantUploads) {
    return null;
  }

  const handleDeleteAllClick = (dest: UploadDestination) => {
    // For destinations with API delete, show confirmation dialog
    setShowDeleteDialog(dest.id);
  };

  // Compute done files count for the destination being deleted (for singularization)
  const deletingCount = showDeleteDialog
    ? (item.uploads?.[showDeleteDialog]?.fileResults?.filter(
        (f) => f.status === "done" && f.result,
      ).length ?? 0)
    : 0;

  const handleConfirmDeleteAll = async (destId: string) => {
    setDeletingDestId(destId);
    setDeleteError(null);
    setDeletingProgress(null);

    const state = item.uploads?.[destId];
    if (!state?.fileResults) return;

    const doneFiles = state.fileResults
      .map((fr, idx) => ({ fr, idx }))
      .filter(({ fr }) => fr.status === "done" && fr.result);

    setDeletingProgress({ current: 0, total: doneFiles.length });

    try {
      // Find the destination config
      const settingsStore = await import("@/store/settingsStore");
      const settings = settingsStore.useSettingsStore.getState().settings;
      const dest = settings?.destinations?.find(
        (d: UploadDestination) => d.id === destId,
      );
      if (!dest) throw new Error("Destination not found");

      for (const { fr } of doneFiles) {
        if (!fr.result) continue;
        try {
          await deleteFromDestination(fr.result, dest);
        } catch {
          // Continue deleting remaining files
        }
        setDeletingProgress((prev) =>
          prev ? { current: prev.current + 1, total: prev.total } : null,
        );
      }

      // Clear all results after deletion
      clearUploadResult(item.id, destId);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingDestId(null);
      setDeletingProgress(null);
      setShowDeleteDialog(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {enabledDests.map((dest) => {
        const state = item.uploads?.[dest.id];
        if (!state) return null;

        const fileResults = state.fileResults;
        // Single-file mode: no fileResults, use top-level result
        if (!fileResults) {
          if (state.status !== "done" || !state.result) return null;
          return (
            <SingleFileUploadLinks
              key={dest.id}
              dest={dest}
              result={state.result}
              filename={item.outputName ?? item.source.name}
              metadata={item.metadata}
              onDelete={handleDeleteDest}
              groupKey={`upload-${item.id}`}
            />
          );
        }

        const doneFiles = fileResults.filter((f) => f.status === "done");
        const errorFiles = fileResults.filter((f) => f.status === "error");
        const uploadingFiles = fileResults.filter(
          (f) => f.status === "uploading",
        );

        // Include deleted files so the section stays visible for reupload
        const deletedFiles = fileResults.filter((f) => f.status === "deleted");
        if (
          doneFiles.length === 0 &&
          errorFiles.length === 0 &&
          uploadingFiles.length === 0 &&
          deletedFiles.length === 0
        )
          return null;

        return (
          <DestinationFileSection
            key={dest.id}
            dest={dest}
            fileResults={fileResults}
            filename={item.outputName ?? item.source.name}
            metadata={item.metadata}
            onRetryDest={handleRetryDest}
            onRetryFile={handleRetryFile}
            onDeleteFile={handleDeleteFile}
            onDeleteAll={handleDeleteAllClick}
            deletingDestId={deletingDestId}
            groupKey={`upload-${item.id}`}
          />
        );
      })}

      {/* Delete All Confirmation Dialog (non-Chevereto providers) */}
      <AlertDialog
        open={showDeleteDialog !== null}
        onOpenChange={(open) => {
          if (!open && showDeleteDialog) setShowDeleteDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletingCount === 1
                ? "Delete the file from"
                : "Delete all files from"}{" "}
              {showDeleteDialog
                ? enabledDests.find((d) => d.id === showDeleteDialog)?.name
                : ""}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingCount === 1
                ? "This will permanently delete the uploaded file from the server. The file cannot be recovered."
                : `This will permanently delete all ${deletingCount} uploaded files from the server. The files cannot be recovered.`}
              {deletingProgress && (
                <span className="block mt-1">
                  Deleting {deletingProgress.current}/{deletingProgress.total}…
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div className="text-destructive text-sm">{deleteError}</div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deletingDestId !== null}
              onClick={() => {
                setShowDeleteDialog(null);
                setDeletingProgress(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() =>
                showDeleteDialog && handleConfirmDeleteAll(showDeleteDialog)
              }
              disabled={deletingDestId !== null}
            >
              <Trash2 className="size-4" />
              {deletingDestId
                ? "Deleting…"
                : deletingCount === 1
                  ? "Delete"
                  : "Delete All"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

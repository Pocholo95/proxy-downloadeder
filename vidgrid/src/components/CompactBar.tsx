import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Info,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ProcessorStatus, VideoSource } from "@/types";
import { formatElapsed } from "../utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import ProcessingPanel from "./ProcessingPanel";
import FilePicker from "./control/FilePicker";

const STATUS_TEXT_ICON: Record<
  NonNullable<ProcessorStatus["textKind"]>,
  LucideIcon
> = {
  info: Info,
  success: CircleCheck,
  warning: AlertTriangle,
  cancelled: Square,
};

interface CompactBarProps {
  status: ProcessorStatus;
  isProcessing: boolean;
  hasFiles: boolean;
  allMetadataReady: boolean;
  hasRequeuableItems: boolean;
  effectiveBatchTotal: number;
  effectiveBatchDone: number;
  isCompact: boolean;
  onSourcesChange: (sources: VideoSource[]) => void;
  onStart: () => void;
  onCancel: () => void;
  onClear: () => void;
  onRequeueAll: () => void;
}

export default function CompactBar({
  status,
  isProcessing,
  hasFiles,
  allMetadataReady,
  hasRequeuableItems,
  effectiveBatchTotal,
  effectiveBatchDone,
  isCompact: isCompact,
  onSourcesChange,
  onStart,
  onCancel,
  onClear,
  onRequeueAll,
}: CompactBarProps) {
  const [open, setOpen] = useState(false);

  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!status.batchStartTime) return;
    const id = setInterval(() => forceUpdate((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [status.batchStartTime]);

  const effectiveTotal = effectiveBatchTotal;
  const effectiveDone = effectiveBatchDone;

  // Granular batch progress: completed files + current file's partial progress
  const granularDone =
    effectiveDone + (isProcessing ? status.currentPct / 100 : 0);
  const batchPct =
    effectiveTotal > 0 ? Math.round((granularDone / effectiveTotal) * 100) : 0;
  const batchElapsedStr = status.batchStartTime
    ? ` - ${formatElapsed(Date.now() - status.batchStartTime)}`
    : "";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "bg-card border-b border-border",
          isCompact &&
            "shadow-[0_4px_12px_rgba(0,0,0,0.25)] dark:shadow-[0_6px_15px_rgba(0,0,0,0.75)]",
        )}
      >
        <div className="mx-auto max-w-6xl px-4 py-2">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              disabled={!hasFiles || !allMetadataReady || isProcessing}
              onClick={onStart}
              title="Start Processing"
            >
              <Play className="size-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              disabled={!isProcessing}
              onClick={onCancel}
              title="Cancel"
            >
              <Square className="size-3" />
            </Button>
            {hasRequeuableItems && (
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                disabled={isProcessing}
                onClick={onRequeueAll}
                title="Requeue All"
              >
                <RotateCcw className="size-3" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-destructive"
              disabled={isProcessing || (!hasFiles && !hasRequeuableItems)}
              onClick={onClear}
              title="Remove All Tasks"
            >
              <Trash2 className="size-3" />
            </Button>

            {status.text &&
              (() => {
                const StatusIcon = STATUS_TEXT_ICON[status.textKind ?? "info"];
                return (
                  <div className="hidden items-center gap-1.5 rounded border bg-card px-2 py-1 md:flex w-full">
                    <StatusIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground wrap-anywhere">
                      {status.text}
                    </span>
                  </div>
                );
              })()}

            <div className="hidden md:block flex-1" />

            <Progress
              value={batchPct}
              className="h-1.5 flex-1 md:w-24 md:flex-none"
            />
            <span className="text-xs font-medium shrink-0 whitespace-nowrap flex items-center gap-1">
              {isProcessing && (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              )}
              {effectiveDone}/{effectiveTotal}
            </span>

            {batchElapsedStr && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {batchElapsedStr}
              </span>
            )}

            <CollapsibleTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                title={open ? "Collapse" : "Expand"}
              >
                {open ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>

        <CollapsibleContent>
          <div className="bg-background border-b border-border">
            <div className="mx-auto max-w-6xl p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="w-full sm:w-1/3">
                  <FilePicker onSourcesChange={onSourcesChange} />
                </div>
                <div className="w-full sm:w-2/3">
                  <ProcessingPanel
                    status={status}
                    isProcessing={isProcessing}
                    hasFiles={hasFiles}
                    allMetadataReady={allMetadataReady}
                    hasRequeuableItems={hasRequeuableItems}
                    effectiveBatchTotal={effectiveBatchTotal}
                    effectiveBatchDone={effectiveBatchDone}
                    onStart={onStart}
                    onCancel={onCancel}
                    onClear={onClear}
                    onRequeueAll={onRequeueAll}
                  />
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

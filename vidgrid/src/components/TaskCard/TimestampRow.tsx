import { Timeline } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  isCustom: boolean;
  markerCount: number;
  totalCells: number;
  canEdit: boolean;
  onEdit: () => void;
}

export default function TimestampRow({
  isCustom,
  markerCount,
  totalCells,
  canEdit,
  onEdit,
}: Props) {
  // Timestamp mode label
  let tsLabel: string;
  if (!isCustom) {
    tsLabel = "Auto timestamps (evenly distributed)";
  } else if (markerCount === 0) {
    tsLabel = "Custom timestamps — no markers (uses auto)";
  } else {
    const used = Math.min(markerCount, totalCells);
    const fallback = Math.max(0, totalCells - markerCount);
    const ignored = markerCount - totalCells;
    if (ignored > 0) {
      tsLabel = `Custom timestamps — ${used} marker${used !== 1 ? "s" : ""} (${ignored} ignored)`;
    } else {
      tsLabel =
        `Custom timestamps — ${used} marker${used !== 1 ? "s" : ""}` +
        (fallback > 0 ? ` + ${fallback} auto` : "");
    }
  }

  return (
    <div className="bg-muted/50 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2">
      <span
        className={cn(
          "flex items-center gap-2 text-xs",
          isCustom ? "text-primary font-medium" : "text-muted-foreground",
        )}
      >
        <Timeline className="size-4 -rotate-90" />
        {tsLabel}
      </span>
      <Button
        variant={isCustom ? "default" : "outline"}
        className="w-full sm:w-auto"
        size="sm"
        disabled={!canEdit}
        onClick={onEdit}
        title={
          canEdit
            ? "Edit timestamps for this file"
            : "Timestamps can be edited after analysis completes"
        }
      >
        <Timeline className="size-4 -rotate-90" />
        Edit Timestamps
      </Button>
    </div>
  );
}

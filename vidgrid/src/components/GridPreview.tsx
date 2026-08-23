import { useCallback } from "react";
import { cn } from "@/lib/utils";
import type { GridCell, GridTemplate } from "../types";

/** Return the distinct sorted row indices present in the cell list. */
const getRowIndices = (cells: GridCell[]): number[] =>
  [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);

/** Return cells in a given row, sorted left-to-right. */
const getRowCells = (cells: GridCell[], rowY: number): GridCell[] =>
  cells.filter((c) => c.y === rowY).sort((a, b) => a.x - b.x);

interface GridPreviewProps {
  template: GridTemplate;
  /**
   * Zero-based index of the currently selected cell (in reading order).
   * When provided, that cell is visually highlighted.
   */
  selectedCellIndex?: number | null;
  /**
   * Called when a cell is clicked. Receives the zero-based reading-order
   * index of the clicked cell.
   */
  onClickCell?: (index: number) => void;
  /**
   * Number of cells (from the start of reading order) that have been
   * assigned a marker. Cells beyond this count are styled as unassigned.
   * When omitted, all cells are considered assigned.
   */
  assignedCount?: number;
  className?: string;
}

/**
 * GridPreview renders a compact, schematic representation of a grid
 * template. Cells are numbered in reading order (top-to-bottom,
 * left-to-right) — the same order used for timestamp assignment.
 *
 * This is purely a structural visual aid: no video frames are displayed.
 */
export default function GridPreview({
  template,
  selectedCellIndex = null,
  onClickCell,
  assignedCount,
  className,
}: GridPreviewProps) {
  const rowIndices = getRowIndices(template.cells);

  // Build reading-order map: cell.id -> 1-based index
  const sortedCells = [...template.cells].sort((a, b) =>
    a.y !== b.y ? a.y - b.y : a.x - b.x,
  );
  const cellOrder = new Map(sortedCells.map((c, idx) => [c.id, idx + 1]));

  const handleCellClick = useCallback(
    (id: string) => {
      if (!onClickCell) return;
      const idx = cellOrder.get(id);
      if (idx !== undefined) {
        onClickCell(idx - 1); // convert to zero-based
      }
    },
    [onClickCell, cellOrder],
  );

  if (template.cells.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid-preview flex flex-col gap-1",
        onClickCell && "select-none",
        className,
      )}
    >
      {rowIndices.map((rowY) => {
        const rowCells = getRowCells(template.cells, rowY);
        return (
          <div key={`row-${rowY}`} className="flex gap-1">
            {rowCells.map((cell) => {
              const idx = cellOrder.get(cell.id);
              const num = idx ?? "?";
              const isSelected =
                idx !== undefined && selectedCellIndex === idx - 1;
              const isUnassigned =
                assignedCount !== undefined &&
                idx !== undefined &&
                idx > assignedCount;
              const hasMarker =
                assignedCount !== undefined &&
                idx !== undefined &&
                idx <= assignedCount;
              return (
                <div
                  key={cell.id}
                  className={cn(
                    "grid-preview-cell flex items-center justify-center rounded border text-[10px] font-mono font-semibold tabular-nums py-1 transition-colors",
                    "bg-muted/50 text-muted-foreground",
                    (hasMarker ||
                      (isSelected && assignedCount !== undefined)) &&
                      "border-selected",
                    isUnassigned &&
                      "bg-destructive/10 text-destructive/65 border-destructive/20",
                    onClickCell &&
                      "cursor-pointer bg-muted/50 hover:bg-primary/50 text-foreground",
                    isSelected &&
                      "bg-selected text-selected-foreground border-selected ring-2 ring-selected",
                  )}
                  style={{ flex: `${cell.w} 0 0` }}
                  title={`Cell ${num}${isUnassigned ? " (unassigned)" : ""}`}
                  onClick={() => handleCellClick(cell.id)}
                >
                  {num}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

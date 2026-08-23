import type { GridCell, GridTemplate, VideoMetadata, VrMode } from "./types";
import { getEffectiveDimensions } from "./gridUtils";

/** Pixel rect for one cell, used by both the JPEG and animated WebP renderers. */
export type CellPixelRect = {
  /** The source GridCell definition. */
  cell: GridCell;
  /** Pixel X in the canvas (left edge). */
  x: number;
  /** Pixel Y in the canvas (top edge, includes header offset). */
  y: number;
  /** Pixel width of the cell (proportional share of the row). */
  w: number;
  /**
   * Pixel height of the cell (cell pixel width × video aspect ratio).
   * May be shorter than the row height when other cells in the row are wider.
   * The background color fills the remaining vertical space automatically
   * because the canvas is pre-filled before any cells are drawn.
   */
  h: number;
};

/**
 * Sort cells in reading order: top-to-bottom by row, then left-to-right within
 * each row. Used to assign timestamps in a predictable, intuitive order.
 *
 * @param cells - Unsorted cell array.
 * @returns New sorted array; does not mutate the input.
 */
export const sortCellsReadingOrder = (cells: GridCell[]): GridCell[] =>
  [...cells].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));

/**
 * Group cells by row index (`y`), returning rows sorted top-to-bottom with
 * each row's cells sorted left-to-right.
 *
 * @param cells - Cell array (may be in any order).
 * @returns Array of rows, each row being a sorted array of cells.
 */
const groupByRow = (cells: GridCell[]): GridCell[][] => {
  const rowMap = new Map<number, GridCell[]>();
  for (const cell of cells) {
    if (!rowMap.has(cell.y)) rowMap.set(cell.y, []);
    rowMap.get(cell.y)!.push(cell);
  }
  return [...rowMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, rowCells]) => [...rowCells].sort((a, b) => a.x - b.x));
};

/**
 * Compute pixel rectangles for every cell in a custom grid template.
 *
 * Layout rules:
 * - Cells are grouped into rows by their `y` value.
 * - Each cell's pixel width = `(w / rowTotalWeight) × availableRowWidth`,
 *   where `availableRowWidth = totalWidth - spacing × (n - 1)`.
 * - Each cell's pixel height = `cellPixelWidth × videoAspectRatio`.
 * - Row height = tallest cell in that row (widest cell's height).
 * - Cells shorter than the row height are top-aligned; background color fills
 *   the remaining space (the canvas is pre-filled before drawing begins).
 * - Any pixel rounding remainder is absorbed by the last cell in each row.
 *
 * Cells are returned in reading order (top-to-bottom, left-to-right) to match
 * the timestamp assignment order used by the renderers.
 *
 * @param template - Custom grid template with cell layout.
 * @param totalWidth - Output canvas width in pixels.
 * @param spacing - Gap between cells in pixels.
 * @param meta - Video metadata; width/height used to derive cell aspect ratio.
 * @param vrMode - VR crop mode; adjusts the effective per-cell aspect ratio.
 * @param headerHeight - Header row height in pixels (0 when header is disabled).
 * @returns Sorted pixel rects plus the total canvas width and height.
 */
export const computeTemplatePixelRects = (
  template: GridTemplate,
  totalWidth: number,
  spacing: number,
  meta: VideoMetadata,
  vrMode: VrMode,
  headerHeight: number,
): { rects: CellPixelRect[]; canvasWidth: number; canvasHeight: number } => {
  const vrActive = vrMode !== "disabled";

  // Use effective (rotation-applied) dimensions so portrait videos filmed with
  // rotation metadata produce the correct cell aspect ratio.
  const { width: effW, height: effH } = getEffectiveDimensions(meta);
  let cellAspect = effW > 0 && effH > 0 ? effH / effW : 9 / 16;
  if (vrActive) {
    if (vrMode.startsWith("sbs")) cellAspect *= 2;
    else cellAspect /= 2;
  }

  const sortedRows = groupByRow(template.cells);
  const rects: CellPixelRect[] = [];
  let currentY = headerHeight;

  for (const rowCells of sortedRows) {
    const n = rowCells.length;
    if (n === 0) continue;

    // Use the same approach as the uniform grid: divide available width equally
    // with floor, giving every cell in the row the same pixel width.
    // This avoids the rounding discrepancy that occurs when EDITOR_COLS (60)
    // is not divisible by n — in that case proportional weights differ by 1
    // unit, which maps to a large pixel difference (e.g. 32px at 1920) and
    // causes visible height mismatch and bottom padding on shorter cells.
    const availableWidth = Math.max(1, totalWidth - spacing * (n - 1));
    const cellW = Math.max(1, Math.floor(availableWidth / n));
    const cellH = Math.max(1, Math.floor(cellW * cellAspect));

    let currentX = 0;
    for (let i = 0; i < n; i++) {
      rects.push({
        cell: rowCells[i],
        x: currentX,
        y: currentY,
        w: cellW,
        h: cellH,
      });
      currentX += cellW + spacing;
    }

    currentY += cellH + spacing;
  }

  // Remove the trailing spacing added after the last row
  const canvasHeight = Math.max(
    1,
    sortedRows.length > 0 ? currentY - spacing : 0,
  );

  return { rects, canvasWidth: totalWidth, canvasHeight };
};

/**
 * Internal column count used by the editor canvas and stored in GridTemplate.cols.
 * All cell `w` values are expressed in these units. The renderer ignores this
 * constant — it treats `w` as a proportional weight and normalises per-row.
 * Exported so GridTemplateEditor can import it rather than redefining it.
 */
export const EDITOR_COLS = 60;

/**
 * Build a uniform grid template seeded from cols×rows settings.
 * Each cell in a row gets an equal proportional share of EDITOR_COLS so that
 * the editor shows cells at the correct relative widths immediately.
 * Rows and columns are numbered sequentially left-to-right, top-to-bottom.
 *
 * @param cols - Number of cells per row.
 * @param rows - Number of rows.
 * @returns A GridTemplate whose cells tile the space uniformly.
 */
export const templateFromUniform = (
  cols: number,
  rows: number,
): GridTemplate => {
  const safeC = Math.max(1, cols);
  const safeR = Math.max(1, rows);
  // Distribute EDITOR_COLS evenly; last cell in each row absorbs rounding.
  const baseW = Math.floor(EDITOR_COLS / safeC);
  const remainder = EDITOR_COLS - baseW * safeC;

  return {
    cols: EDITOR_COLS,
    cells: Array.from({ length: safeC * safeR }, (_, i) => {
      const col = i % safeC;
      const row = Math.floor(i / safeC);
      // Cumulative x position so cells pack left-to-right without gaps
      const x = col * baseW + Math.min(col, remainder);
      const w = baseW + (col < remainder ? 1 : 0);
      return { id: crypto.randomUUID(), x, y: row, w, h: 1 };
    }),
  };
};

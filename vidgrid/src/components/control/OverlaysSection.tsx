import { DEFAULTS } from "../../constants";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, FieldLabel } from "@/components/ui/field";
import Section from "./Section";
import type { Position, SavedOptions } from "../../types";

interface Props {
  opts: SavedOptions;
  setOpts: (o: SavedOptions) => void;
  expanded: boolean;
  onToggle: () => void;
  groupKey?: string;
}

/**
 * Overlays section of the ControlPanel.
 *
 * Contains header toggle and timecode position controls.
 * Hidden entirely when video_with_audio mode is active (both fields disabled).
 */
export default function OverlaysSection({
  opts,
  setOpts,
  expanded,
  onToggle,
  groupKey,
}: Props) {
  const outputMode = opts.outputMode ?? DEFAULTS.outputMode;
  const isGallery = outputMode === "gallery";
  const isVideoWithAudio =
    outputMode === "sequence" &&
    (opts.sequenceMode ?? DEFAULTS.sequenceMode) === "video_with_audio";

  // When video_with_audio is active, both fields are disabled - hide section entirely
  if (isVideoWithAudio) {
    return null;
  }

  return (
    <Section
      label="Overlays"
      expanded={expanded}
      onToggle={onToggle}
      groupKey={groupKey}
    >
      {/* Left column: Header toggle (hidden in gallery mode) */}
      {!isGallery && (
        <div className="flex flex-col gap-3">
          <Field orientation="horizontal">
            <Switch
              id="cp-chk-header"
              label="Show metadata header"
              checked={opts.header !== false}
              onCheckedChange={(checked) => {
                setOpts({ ...opts, header: checked === true });
              }}
            />
          </Field>
        </div>
      )}

      {/* Right column: Timecode position */}
      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="cp-tc-pos">Timecode position</FieldLabel>
          <TimecodePositionGrid
            id="cp-tc-pos"
            value={opts.tcPosition}
            onChange={(v) => setOpts({ ...opts, tcPosition: v })}
            textColor={opts.textColor}
            bgColor={opts.bgColor}
            fontFamily={opts.fontFamily}
            fontSize={opts.tcFontSize}
          />
        </Field>
      </div>
    </Section>
  );
}

/**
 * Props for the TimecodePositionGrid component.
 */
interface TimecodePositionGridProps {
  id: string;
  value: Position;
  onChange: (position: Position) => void;
  textColor: string;
  bgColor: string;
  fontFamily: string;
  fontSize: number;
}

/**
 * Visual frame selector for timecode overlay position.
 *
 * Renders a frame-like preview with 4 corner buttons absolutely positioned
 * at the edges, each showing a timecode pill. Center button disables the overlay.
 */
function TimecodePositionGrid({
  id,
  value,
  onChange,
  textColor,
  bgColor,
  fontFamily,
  fontSize,
}: TimecodePositionGridProps) {
  const isDisabled = value === "disabled";

  // Clamp preview font size to fit within small pills
  const previewFontSize = Math.min(Math.max(fontSize, 8), 12);

  // The four corner positions with their CSS corner classes
  const corners: { pos: Position; corner: string }[] = [
    { pos: "top-left", corner: "top-1 left-1" },
    { pos: "top-right", corner: "top-1 right-1" },
    { pos: "bottom-left", corner: "bottom-1 left-1" },
    { pos: "bottom-right", corner: "bottom-1 right-1" },
  ];

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label="Timecode position"
      className="mx-auto mt-2 w-64"
    >
      {/* Frame container - represents a single video cell */}
      <div className="relative aspect-video rounded-lg border-2 border-input bg-muted">
        {/* Center disable button */}
        <Button
          variant="ghost"
          size="icon"
          role="radio"
          aria-checked={isDisabled}
          aria-label="Disable timecode"
          onClick={() => onChange("disabled")}
          className={`absolute inset-0 m-auto size-9 ${
            isDisabled ? "text-ring" : "text-muted-foreground/50"
          }`}
        >
          <Ban className="size-3.5" />
        </Button>

        {/* Corner position buttons */}
        {corners.map(({ pos, corner }) => {
          const isActive = value === pos;
          return (
            <Button
              key={pos}
              variant="ghost"
              role="radio"
              aria-checked={isActive}
              aria-label={`${pos.replace("-", " ")} position`}
              onClick={() => onChange(pos)}
              className={`absolute ${corner} p-1`}
            >
              <span
                className={`rounded px-1.5 py-0.5 text-center select-none transition-all ${
                  isActive
                    ? "shadow-sm opacity-100"
                    : "opacity-20 hover:opacity-30"
                }`}
                style={{
                  backgroundColor: `${bgColor}99`,
                  color: textColor,
                  fontFamily: fontFamily,
                  fontSize: `${previewFontSize}px`,
                  lineHeight: 1.2,
                }}
              >
                00:00:00
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

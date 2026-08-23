import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import RangeNumberInput from "@/components/control/RangeNumberInput";
import Section from "./Section";
import ColorPickerField from "@/components/ColorPickerField";
import type { SavedOptions } from "../../types";
import {
  DEFAULTS,
  FONT_FACES,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
} from "../../constants";

interface Props {
  opts: SavedOptions;
  setOpts: (o: SavedOptions) => void;
  expanded: boolean;
  onToggle: () => void;
  groupKey?: string;
}

/**
 * Style section of the ControlPanel.
 *
 * Background color (used for spacing/gutter fill). Only shown when there
 * are text overlays to style.
 */
export default function StyleSection({
  opts,
  setOpts,
  expanded,
  onToggle,
  groupKey,
}: Props) {
  const outputMode = opts.outputMode ?? DEFAULTS.outputMode;

  // Determine if there are any text overlays (header or timecode) to style.
  const isVideoWithAudio =
    outputMode === "sequence" &&
    (opts.sequenceMode ?? DEFAULTS.sequenceMode) === "video_with_audio";

  // Header is never shown in gallery mode or video_with_audio sequence mode
  const hasHeaderText =
    outputMode !== "gallery" && !isVideoWithAudio && opts.header !== false;

  // Timecode can be shown in any mode
  const hasTimecodeText = opts.tcPosition !== "disabled";

  // Show text styling options whenever any text overlay is visible
  const hasAnyText = hasHeaderText || hasTimecodeText;

  // In gallery mode, styles only apply to timecode overlay.
  // If timecode is disabled, hide the entire section.
  if (outputMode === "gallery" && !hasTimecodeText) {
    return null;
  }

  return (
    <Section
      label="Style"
      expanded={expanded}
      onToggle={onToggle}
      groupKey={groupKey}
    >
      {/* Background color (used for spacing/gutter fill) */}
      <div className="col-span-2 md:col-span-1">
        <ColorPickerField
          label="Background color"
          id="bg-color"
          value={opts.bgColor}
          fallback="#000000"
          onChange={(v) => setOpts({ ...opts, bgColor: v })}
        />
      </div>

      {hasAnyText && (
        <>
          {/* Text color */}
          <div className="col-span-2 md:col-span-1">
            <ColorPickerField
              label="Text color"
              id="text-color"
              value={opts.textColor}
              fallback="#ffffff"
              onChange={(v) => setOpts({ ...opts, textColor: v })}
            />
          </div>

          {/* Font Family - spans full width */}
          <div className="col-span-2">
            <Field>
              <FieldLabel htmlFor="cp-font-family">Font family</FieldLabel>
              <Select
                value={opts.fontFamily}
                onValueChange={(v) => setOpts({ ...opts, fontFamily: v })}
              >
                <SelectTrigger
                  id="cp-font-family"
                  className="w-full"
                  style={{ fontFamily: opts.fontFamily }}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_FACES.map((f) => (
                    <SelectItem key={f} value={f} style={{ fontFamily: f }}>
                      {f.split(",")[0]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </>
      )}

      {hasTimecodeText && (
        <div className="col-span-2 md:col-span-1">
          <Field>
            <FieldLabel>Timecode font size</FieldLabel>
            <div className="flex items-center gap-3">
              <RangeNumberInput
                id="tc-font-size"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={opts.tcFontSize}
                onChange={(v) => setOpts({ ...opts, tcFontSize: v })}
                disabled={opts.tcFontSizeAuto}
                suffix="px"
                className="flex-1"
              />
              <Switch
                id="tc-font-auto"
                label="Auto"
                checked={opts.tcFontSizeAuto}
                onCheckedChange={(checked) =>
                  setOpts({ ...opts, tcFontSizeAuto: !!checked })
                }
              />
            </div>
          </Field>
        </div>
      )}

      {hasHeaderText && (
        <div className="col-span-2 md:col-span-1">
          <Field>
            <FieldLabel>Header font size</FieldLabel>
            <div className="flex items-center gap-3">
              <RangeNumberInput
                id="header-font-size"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={opts.headerFontSize}
                onChange={(v) => setOpts({ ...opts, headerFontSize: v })}
                disabled={opts.headerFontSizeAuto}
                suffix="px"
                className="flex-1"
              />
              <Switch
                id="header-font-auto"
                label="Auto"
                checked={opts.headerFontSizeAuto}
                onCheckedChange={(checked) =>
                  setOpts({ ...opts, headerFontSizeAuto: !!checked })
                }
              />
            </div>
          </Field>
        </div>
      )}
    </Section>
  );
}

import { useEffect } from "react";
import { DEFAULTS } from "../../constants";
import { Info } from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import Section from "./Section";
import RangeNumberInput from "./RangeNumberInput";
import OutputModeCards from "./OutputModeCards";
import type { OutputMode, SavedOptions } from "../../types";

interface Props {
  opts: SavedOptions;
  setOpts: (o: SavedOptions) => void;
  expanded: boolean;
  onToggle: () => void;
  groupKey?: string;
}

export default function OutputModesSection({
  opts,
  setOpts,
  expanded,
  onToggle,
  groupKey,
}: Props) {
  const outputMode = opts.outputMode ?? DEFAULTS.outputMode;
  const isAnimated = outputMode === "animated" || outputMode === "sequence";
  const isSequence = outputMode === "sequence";
  const isGallery = outputMode === "gallery";
  // Fit-to-limits only covers the two grid image outputs (Static/Animated) --
  // Sequence and Gallery aren't the "thumbnail grid you upload somewhere"
  // case this feature targets, and Sequence's video-with-audio path has no
  // quality knob to shrink at all.
  const showLimitFit = outputMode === "static" || outputMode === "animated";
  const limitFitEnabled = opts.limitFitEnabled ?? DEFAULTS.limitFitEnabled;
  const isVideoWithAudio =
    isSequence &&
    (opts.sequenceMode ?? DEFAULTS.sequenceMode) === "video_with_audio";

  // Reactively enforce constraints when "Video with audio" is active.
  useEffect(() => {
    if (!isVideoWithAudio) return;
    const needsChange =
      opts.header !== false ||
      opts.tcPosition !== "disabled" ||
      opts.animFormat !== "mp4";
    if (needsChange) {
      setOpts({
        ...opts,
        header: false,
        tcPosition: "disabled",
        animFormat: "mp4",
      });
    }
  }, [isVideoWithAudio, opts, setOpts]);

  const handleModeChange = (mode: OutputMode) => {
    setOpts({
      ...opts,
      outputMode: mode,
    });
  };

  return (
    <Section
      label="Output Mode"
      expanded={expanded}
      onToggle={onToggle}
      groupKey={groupKey}
      bodyClassName="flex flex-col gap-4 border-t p-4"
    >
      {/* Visual mode card selector */}
      <OutputModeCards
        value={outputMode as OutputMode}
        onChange={handleModeChange}
      />

      {/* Mode-specific options - only shown when relevant */}
      {isAnimated && (
        <div className="bg-muted/30 grid grid-cols-1 gap-3 rounded-md border p-3 lg:grid-cols-2">
          {/* Sequence sub-options */}
          {isSequence && (
            <Field>
              <FieldLabel htmlFor="cp-seq-segments">
                Number of segments
              </FieldLabel>
              <RangeNumberInput
                id="cp-seq-segments"
                value={opts.animSegments ?? DEFAULTS.animSegments}
                min={1}
                max={12}
                onChange={(v) => setOpts({ ...opts, animSegments: v })}
                unbounded
                hardMin={1}
                hardMax={60}
              />
            </Field>
          )}
          {isSequence && (
            <Field>
              <div className="flex items-center gap-2">
                <FieldLabel htmlFor="cp-seq-mode">Render mode</FieldLabel>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="size-5 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="About Render mode options"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="max-w-72 text-xs leading-relaxed">
                    <p className="font-medium mb-1">Render mode options</p>
                    <ul className="space-y-1">
                      <li>
                        <strong>Static:</strong> Captures one frame per segment
                        and holds it for the duration. Fast, no audio.
                      </li>
                      <li>
                        <strong>Video:</strong> Plays each segment
                        frame-by-frame with canvas composition. No audio.
                      </li>
                      <li>
                        <strong>Video with audio:</strong> Uses FFmpeg to cut
                        and merge video segments directly, preserving audio.
                        Header and timecode overlays are disabled in this mode.
                      </li>
                    </ul>
                  </PopoverContent>
                </Popover>
              </div>
              <Select
                value={opts.sequenceMode ?? DEFAULTS.sequenceMode}
                onValueChange={(v) => {
                  const mode = v as SavedOptions["sequenceMode"];
                  setOpts({
                    ...opts,
                    sequenceMode: mode,
                  });
                }}
              >
                <SelectTrigger id="cp-seq-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="static">Static (hold frame)</SelectItem>
                  <SelectItem value="video">Video (play segment)</SelectItem>
                  <SelectItem value="video_with_audio">
                    Video with audio
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {/* Output format - applies to both animated and sequence */}
          <Field>
            <FieldLabel htmlFor="cp-anim-format">Output format</FieldLabel>
            <Select
              value={opts.animFormat ?? DEFAULTS.animFormat}
              disabled={isVideoWithAudio}
              onValueChange={(v) =>
                setOpts({
                  ...opts,
                  animFormat: v as SavedOptions["animFormat"],
                })
              }
            >
              <SelectTrigger id="cp-anim-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="webp">WebP</SelectItem>
                <SelectItem value="mp4">MP4</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {/* Duration */}
          <Field>
            <FieldLabel htmlFor="cp-anim-duration">Duration</FieldLabel>
            <RangeNumberInput
              id="cp-anim-duration"
              value={opts.animDuration ?? DEFAULTS.animDuration}
              min={1}
              max={10}
              onChange={(v) => setOpts({ ...opts, animDuration: v })}
              suffix="s"
              unbounded
              hardMin={1}
              hardMax={3600}
            />
          </Field>
          {/* FPS */}
          <Field>
            <FieldLabel htmlFor="cp-anim-fps">FPS</FieldLabel>
            <RangeNumberInput
              id="cp-anim-fps"
              value={opts.animFps ?? DEFAULTS.animFps}
              min={1}
              max={60}
              onChange={(v) => setOpts({ ...opts, animFps: v })}
              suffix="fps"
              unbounded
              hardMin={1}
              hardMax={60}
            />
          </Field>
          {/* WebP method - only for WebP format */}
          {opts.animFormat !== "mp4" && (
            <Field>
              <FieldLabel htmlFor="cp-anim-method">WebP method</FieldLabel>
              <RangeNumberInput
                id="cp-anim-method"
                value={opts.webpMethod ?? DEFAULTS.webpMethod}
                min={0}
                max={6}
                onChange={(v) => setOpts({ ...opts, webpMethod: v })}
              />
            </Field>
          )}
          {/* WebP quality - only for WebP format */}
          {opts.animFormat !== "mp4" && (
            <Field>
              <FieldLabel htmlFor="cp-anim-quality">WebP quality</FieldLabel>
              <RangeNumberInput
                id="cp-anim-quality"
                value={opts.webpQuality ?? DEFAULTS.webpQuality}
                min={5}
                max={100}
                onChange={(v) => setOpts({ ...opts, webpQuality: v })}
                suffix="%"
              />
            </Field>
          )}
        </div>
      )}

      {/* Gallery-specific options */}
      {isGallery && (
        <div className="bg-muted/30 grid grid-cols-1 gap-3 rounded-md border p-3">
          <Field>
            <FieldLabel htmlFor="cp-gallery-count">Number of frames</FieldLabel>
            <RangeNumberInput
              id="cp-gallery-count"
              value={opts.galleryCount ?? DEFAULTS.galleryCount ?? 6}
              min={1}
              max={20}
              onChange={(v) => setOpts({ ...opts, galleryCount: v })}
              unbounded
              hardMin={1}
              hardMax={100}
            />
          </Field>
          <Field orientation="horizontal">
            <Switch
              id="cp-chk-gallery-original"
              label="Original resolution"
              checked={
                opts.galleryOriginalResolution ??
                DEFAULTS.galleryOriginalResolution
              }
              onCheckedChange={(checked) => {
                const val = checked === true;
                setOpts({ ...opts, galleryOriginalResolution: val });
              }}
            />
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="size-6 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="About Original resolution"
                >
                  <Info className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="max-w-72 text-xs leading-relaxed">
                <p className="font-medium mb-1">Original resolution</p>
                <p>
                  When enabled, each frame is captured at the video's native
                  resolution instead of the configured cell width. This produces
                  larger file sizes but preserves full image quality.
                </p>
              </PopoverContent>
            </Popover>
          </Field>
        </div>
      )}

      {/* Fit-to-upload-limits - static/animated grid only */}
      {showLimitFit && (
        <div className="bg-muted/30 flex flex-col gap-3 rounded-md border p-3">
          <Field orientation="horizontal">
            <Switch
              id="cp-chk-limit-fit"
              label="Fit to upload limits"
              checked={limitFitEnabled}
              onCheckedChange={(checked) =>
                setOpts({ ...opts, limitFitEnabled: checked === true })
              }
            />
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="size-6 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="About Fit to upload limits"
                >
                  <Info className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="max-w-72 text-xs leading-relaxed">
                <p className="font-medium mb-1">Fit to upload limits</p>
                <p>
                  When enabled, the output width is automatically reduced (never
                  increased) so the canvas stays within the max side/megapixel
                  limits below, and quality is lowered as needed to stay under
                  the max file size. If it can't get under the size limit even
                  at the lowest quality, you'll get a warning after generation
                  instead of a silently oversized file.
                </p>
                <p className="mt-1">
                  Not available for MP4 output — it has no quality control to
                  shrink with. Switch Output format to WebP for animated grids.
                </p>
              </PopoverContent>
            </Popover>
          </Field>

          {limitFitEnabled && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="cp-limit-side">Max side (px)</FieldLabel>
                <RangeNumberInput
                  id="cp-limit-side"
                  value={opts.limitMaxSidePx ?? DEFAULTS.limitMaxSidePx!}
                  min={480}
                  max={12_000}
                  onChange={(v) => setOpts({ ...opts, limitMaxSidePx: v })}
                  unbounded
                  hardMin={240}
                  hardMax={50_000}
                />
              </Field>
              {outputMode === "static" ? (
                <Field>
                  <FieldLabel htmlFor="cp-limit-mp">Max megapixels</FieldLabel>
                  <RangeNumberInput
                    id="cp-limit-mp"
                    value={opts.limitMaxMegapixels ?? DEFAULTS.limitMaxMegapixels!}
                    min={1}
                    max={100}
                    onChange={(v) => setOpts({ ...opts, limitMaxMegapixels: v })}
                    unbounded
                    hardMin={1}
                    hardMax={1000}
                  />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="cp-limit-anim-mp">
                    Max megapixels (all frames)
                  </FieldLabel>
                  <RangeNumberInput
                    id="cp-limit-anim-mp"
                    value={
                      opts.limitMaxAnimMegapixels ?? DEFAULTS.limitMaxAnimMegapixels!
                    }
                    min={1}
                    max={50}
                    onChange={(v) =>
                      setOpts({ ...opts, limitMaxAnimMegapixels: v })
                    }
                    unbounded
                    hardMin={1}
                    hardMax={1000}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="cp-limit-mb">Max file size (MB)</FieldLabel>
                <RangeNumberInput
                  id="cp-limit-mb"
                  value={opts.limitMaxFileSizeMB ?? DEFAULTS.limitMaxFileSizeMB!}
                  min={1}
                  max={25}
                  onChange={(v) => setOpts({ ...opts, limitMaxFileSizeMB: v })}
                  suffix="MB"
                  unbounded
                  hardMin={1}
                  hardMax={5000}
                />
              </Field>
            </div>
          )}

          {limitFitEnabled &&
            outputMode === "animated" &&
            opts.animFormat === "mp4" && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Output format is MP4 — these limits won't be enforced. Switch
                to WebP for a shrinkable animated output.
              </p>
            )}
        </div>
      )}
    </Section>
  );
}

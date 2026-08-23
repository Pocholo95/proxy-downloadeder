import { Film, Maximize } from "lucide-react";
import { useSettingsStore } from "@/store/settingsStore";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldSet,
  FieldSeparator,
} from "@/components/ui/field";
import RangeNumberInput from "@/components/control/RangeNumberInput";

export default function AnimationsTab() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <FieldSet className="p-4 rounded-lg border bg-muted/30 min-w-0">
      <Field>
        <FieldLabel>
          <Film className="size-4 inline mr-1" />
          Animation Estimates: Max Frames
        </FieldLabel>
        <FieldDescription>
          Warning threshold for total frame count in animated output. Values
          above this limit are highlighted as potentially problematic for upload
          hosts. Set to 0 for no limit.
        </FieldDescription>
        <RangeNumberInput
          id="estimation-max-frames"
          value={settings.estimationMaxFrames}
          min={0}
          max={1800}
          unbounded
          hardMax={3600}
          step={5}
          onChange={(v) =>
            updateSettings({
              estimationMaxFrames: Math.max(0, v),
            })
          }
        />
      </Field>

      <FieldSeparator />

      <Field>
        <FieldLabel>
          <Maximize className="size-4 inline mr-1" />
          Animation Estimates: Max Pixels
        </FieldLabel>
        <FieldDescription>
          Warning threshold for total pixel count (canvas area × frames) in
          animated output. Values above this limit are highlighted as
          potentially problematic for upload hosts. Set to 0 for no limit.
        </FieldDescription>
        {(() => {
          const pixelStep =
            settings.estimationMaxPixels < 1_000_000 ? 100_000 : 1_000_000;
          return (
            <RangeNumberInput
              id="estimation-max-pixels"
              value={settings.estimationMaxPixels}
              min={0}
              max={150_000_000}
              unbounded
              hardMax={1_500_000_000}
              step={pixelStep}
              textInputWidth="120px"
              onChange={(v) =>
                updateSettings({
                  estimationMaxPixels: Math.max(0, v),
                })
              }
            />
          );
        })()}
      </Field>
    </FieldSet>
  );
}

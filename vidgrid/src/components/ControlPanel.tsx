import { Card, CardContent } from "@/components/ui/card";
import PresetsRow from "./control/PresetsRow";
import GridSection from "./control/GridSection";
import OutputModesSection from "./control/OutputModesSection";
import OverlaysSection from "./control/OverlaysSection";
import StyleSection from "./control/StyleSection";
import type { AppSettings, SavedOptions, SectionStates } from "../types";

interface Props {
  opts: SavedOptions;
  setOpts: (
    updater: SavedOptions | ((prev: SavedOptions) => SavedOptions),
  ) => void;
  presets: AppSettings["presets"];
  setPresets: (p: AppSettings["presets"]) => void;
}

export default function ControlPanel({
  opts,
  setOpts,
  presets,
  setPresets,
}: Props) {
  const sections: SectionStates = {
    grid: opts.sectionStates?.grid ?? true,
    style: opts.sectionStates?.style ?? true,
    modes: opts.sectionStates?.modes ?? true,
    overlays: opts.sectionStates?.overlays ?? true,
  };

  // Function updater reads the latest store state, so multiple rapid toggles
  // (e.g. Shift+click syncing siblings) don't suffer from stale closures.
  const toggleSection = (key: keyof SectionStates) => {
    setOpts((prev) => {
      const current = {
        grid: prev.sectionStates?.grid ?? true,
        style: prev.sectionStates?.style ?? true,
        modes: prev.sectionStates?.modes ?? true,
        overlays: prev.sectionStates?.overlays ?? true,
      };
      return {
        ...prev,
        sectionStates: { ...current, [key]: !current[key] },
      };
    });
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Generation Options</h2>
        <PresetsRow
          opts={opts}
          setOpts={setOpts}
          presets={presets}
          setPresets={setPresets}
        />
        <OutputModesSection
          opts={opts}
          setOpts={setOpts}
          expanded={sections.modes}
          onToggle={() => toggleSection("modes")}
          groupKey="control-panel"
        />
        <GridSection
          opts={opts}
          setOpts={setOpts}
          expanded={sections.grid}
          onToggle={() => toggleSection("grid")}
          groupKey="control-panel"
        />
        <OverlaysSection
          opts={opts}
          setOpts={setOpts}
          expanded={sections.overlays}
          onToggle={() => toggleSection("overlays")}
          groupKey="control-panel"
        />
        <StyleSection
          opts={opts}
          setOpts={setOpts}
          expanded={sections.style}
          onToggle={() => toggleSection("style")}
          groupKey="control-panel"
        />
      </CardContent>
    </Card>
  );
}

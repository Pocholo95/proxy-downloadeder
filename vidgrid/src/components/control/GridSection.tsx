import { useState } from "react";
import { Grid3x3 } from "lucide-react";
import { templateFromUniform } from "../../gridTemplate";
import GridTemplateEditor from "../GridTemplateEditor";
import GridPreview from "../GridPreview";
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
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import Section from "./Section";
import RangeNumberInput from "./RangeNumberInput";
import { DEFAULTS } from "../../constants";
import type { GridTemplate, SavedOptions, VrMode } from "../../types";

interface Props {
  opts: SavedOptions;
  setOpts: (o: SavedOptions) => void;
  expanded: boolean;
  onToggle: () => void;
  groupKey?: string;
}

export default function GridSection({
  opts,
  setOpts,
  expanded,
  onToggle,
  groupKey,
}: Props) {
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [confirmDiscardTemplate, setConfirmDiscardTemplate] = useState(false);

  const outputMode = opts.outputMode ?? DEFAULTS.outputMode;
  const isGridLocked = outputMode === "sequence" || outputMode === "gallery";
  const isGallery = outputMode === "gallery";
  const galleryOriginalRes =
    isGallery &&
    (opts.galleryOriginalResolution ?? DEFAULTS.galleryOriginalResolution);
  const hasTemplate = !!(
    opts.gridTemplate && opts.gridTemplate.cells.length > 0
  );
  const isCustomTemplate = hasTemplate;

  const handleToggleTemplate = (checked: boolean | "indeterminate") => {
    if (checked === true) {
      setOpts({
        ...opts,
        gridTemplate: templateFromUniform(
          Math.max(1, opts.cols),
          Math.max(1, opts.rows),
        ),
      });
      setShowTemplateEditor(true);
    } else {
      // Always confirm before disabling to warn the user their template
      // edits will not be preserved.
      setConfirmDiscardTemplate(true);
    }
  };

  const confirmDiscardAndDisableTemplate = () => {
    setOpts({ ...opts, gridTemplate: undefined });
    setConfirmDiscardTemplate(false);
  };

  const handleSaveTemplate = (tpl: GridTemplate) => {
    setOpts({ ...opts, gridTemplate: tpl });
    setShowTemplateEditor(false);
  };

  const editorTemplate =
    opts.gridTemplate && opts.gridTemplate.cells.length > 0
      ? opts.gridTemplate
      : templateFromUniform(Math.max(1, opts.cols), Math.max(1, opts.rows));

  const cellCount = opts.gridTemplate?.cells.length ?? 0;
  const rowCount = opts.gridTemplate
    ? new Set(opts.gridTemplate.cells.map((c) => c.y)).size
    : 0;

  // In gallery mode with original resolution, the section has nothing to show
  // (width is hidden, grid is locked). Hide it entirely.
  if (isGallery && galleryOriginalRes) {
    return null;
  }

  return (
    <>
      <Section
        label="Layout & Dimensions"
        expanded={expanded}
        onToggle={onToggle}
        groupKey={groupKey}
        bodyClassName="sm:grid-cols-1 lg:grid-cols-2"
      >
        {!galleryOriginalRes && (
          <Field>
            <FieldLabel htmlFor="cp-width">
              {isGallery ? "Image width (px)" : "Output width (px)"}
            </FieldLabel>
            <RangeNumberInput
              id="cp-width"
              value={opts.width}
              min={240}
              max={3840}
              step={10}
              onChange={(v) => setOpts({ ...opts, width: v })}
              suffix="px"
              unbounded
              hardMin={240}
              hardMax={16384}
            />
          </Field>
        )}
        {!isGridLocked && (
          <Field>
            <FieldLabel htmlFor="cp-spacing">Cell spacing (px)</FieldLabel>
            <RangeNumberInput
              id="cp-spacing"
              value={opts.spacing}
              min={0}
              max={48}
              onChange={(v) => setOpts({ ...opts, spacing: v })}
              suffix="px"
            />
          </Field>
        )}
        {!isGridLocked && !isCustomTemplate && (
          <>
            <Field>
              <FieldLabel htmlFor="cp-cols">Grid columns</FieldLabel>
              <RangeNumberInput
                id="cp-cols"
                value={opts.cols}
                min={1}
                max={12}
                onChange={(v) => setOpts({ ...opts, cols: v })}
                unbounded
                hardMax={50}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cp-rows">Grid rows</FieldLabel>
              <RangeNumberInput
                id="cp-rows"
                value={opts.rows}
                min={1}
                max={12}
                onChange={(v) => setOpts({ ...opts, rows: v })}
                unbounded
                hardMax={50}
              />
            </Field>
          </>
        )}
        {!isGridLocked && (
          <div className="bg-muted/30 flex flex-col gap-3 rounded-md border p-3 lg:col-span-2">
            <Field orientation="horizontal">
              <Switch
                id="cp-tpl-toggle"
                label="Custom grid template"
                checked={isCustomTemplate}
                onCheckedChange={handleToggleTemplate}
              />
            </Field>
            {isCustomTemplate && opts.gridTemplate && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Left: grid preview */}
                <div className="bg-card overflow-x-auto rounded-md border p-2">
                  <GridPreview template={opts.gridTemplate} />
                </div>
                {/* Right: summary + edit button */}
                <div className="flex flex-col justify-center gap-2">
                  <span className="text-muted-foreground text-sm text-center">
                    {cellCount} cell{cellCount !== 1 ? "s" : ""}
                    {" · "}
                    {rowCount} row{rowCount !== 1 ? "s" : ""}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setShowTemplateEditor(true)}
                    title="Open the Grid Template Editor"
                  >
                    <Grid3x3 className="size-4" />
                    Edit Grid
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* VR mode - moved from OutputModesSection */}
        <Field>
          <FieldLabel htmlFor="cp-vr">VR Video</FieldLabel>
          <Select
            value={opts.vrMode ?? DEFAULTS.vrMode}
            onValueChange={(v) => setOpts({ ...opts, vrMode: v as VrMode })}
          >
            <SelectTrigger id="cp-vr" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="sbs-left">SBS - Crop Left Eye</SelectItem>
              <SelectItem value="sbs-right">SBS - Crop Right Eye</SelectItem>
              <SelectItem value="tb-left">TB - Crop Top (Left Eye)</SelectItem>
              <SelectItem value="tb-right">
                TB - Crop Bottom (Right Eye)
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Section>

      {showTemplateEditor && (
        <GridTemplateEditor
          template={editorTemplate}
          cols={Math.max(1, opts.cols)}
          rows={Math.max(1, opts.rows)}
          onSave={handleSaveTemplate}
          onClose={() => setShowTemplateEditor(false)}
        />
      )}

      <AlertDialog
        open={confirmDiscardTemplate}
        onOpenChange={setConfirmDiscardTemplate}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable custom grid template?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current grid template will not be preserved. If you want to
              keep it, save it in a preset first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscardAndDisableTemplate}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

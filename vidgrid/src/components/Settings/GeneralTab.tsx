import { Sun, Moon, Monitor } from "lucide-react";
import { useSettingsStore } from "@/store/settingsStore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemDescription,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldSet,
  FieldSeparator,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

export default function GeneralTab() {
  const settings = useSettingsStore((s) => s.settings);
  const handleThemeChange = useSettingsStore((s) => s.handleThemeChange);
  const handleShowPreviewChange = useSettingsStore(
    (s) => s.handleShowPreviewChange,
  );

  return (
    <FieldSet className="p-4 rounded-lg border bg-muted/30 min-w-0">
      <Field orientation="responsive">
        <FieldLabel>
          <Moon className="size-4" /> Theme
        </FieldLabel>
        <Select
          value={settings.theme}
          onValueChange={(v: "dark" | "light" | "dimmed" | "classic") =>
            handleThemeChange(v)
          }
        >
          <SelectTrigger className="w-full min-w-20 truncate">
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value="dark"
              className="flex items-center gap-2 min-w-0"
            >
              <Moon className="size-4 shrink-0" /> Dark
              <SelectItemDescription>
                Default dark theme with muted colors
              </SelectItemDescription>
            </SelectItem>
            <SelectItem
              value="dimmed"
              className="flex items-center gap-2 min-w-0"
            >
              <div className="size-4 relative shrink-0 flex items-end justify-center">
                <Moon className="size-full opacity-50" />
                <Sun className="absolute size-[60%] top-[-30%]" />
              </div>{" "}
              Dimmed
              <SelectItemDescription>
                Reduced eye strain, softer than light
              </SelectItemDescription>
            </SelectItem>
            <SelectItem
              value="light"
              className="flex items-center gap-2 min-w-0"
            >
              <Sun className="size-4 shrink-0" /> Light
              <SelectItemDescription>
                Bright light theme for daytime use
              </SelectItemDescription>
            </SelectItem>
            <SelectItem
              value="classic"
              className="flex items-center gap-2 min-w-0"
            >
              <Monitor className="size-4 shrink-0" /> Classic
              <SelectItemDescription>
                Original navy and blue palette
              </SelectItemDescription>
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <FieldSeparator />

      <Field orientation="horizontal">
        <Switch
          id="show-previews"
          checked={settings.showPreview}
          onCheckedChange={handleShowPreviewChange}
        />
        <FieldContent>
          <FieldLabel htmlFor="show-previews">Show Previews</FieldLabel>
          <FieldLabel htmlFor="show-previews">
            <FieldDescription>
              Display thumbnail previews in the tasks list
            </FieldDescription>
          </FieldLabel>
        </FieldContent>
      </Field>
    </FieldSet>
  );
}

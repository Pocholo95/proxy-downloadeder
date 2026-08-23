import {
  Download,
  Code,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
} from "lucide-react";
import { useSettingsStore } from "@/store/settingsStore";
import UserscriptViewer from "@/components/UserscriptViewer";
import {
  downloadUserscript,
  detectCORSTunnelAvailable,
  getCORSStatus,
} from "@/lib/cors-tunnel";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldSet,
  FieldSeparator,
} from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useState, useCallback, useEffect } from "react";

type TunnelStatus = "checking" | "available" | "outdated" | "unavailable";

interface CORSStatusProps {
  dialogOpen: boolean;
}

export default function CORSStatus({ dialogOpen }: CORSStatusProps) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>("checking");
  const [installedVersion, setInstalledVersion] = useState<
    string | undefined
  >();
  const [showUserscriptViewer, setShowUserscriptViewer] = useState(false);

  const checkTunnel = useCallback(async () => {
    setTunnelStatus("checking");
    try {
      const ok = await detectCORSTunnelAvailable();
      const state = getCORSStatus();
      if (ok) {
        setTunnelStatus("available");
      } else if (state.versionMismatch) {
        setInstalledVersion(state.installedVersion);
        setTunnelStatus("outdated");
      } else {
        setTunnelStatus("unavailable");
      }
    } catch {
      setTunnelStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    if (dialogOpen) {
      checkTunnel();
    }
  }, [dialogOpen, checkTunnel]);

  return (
    <>
      <FieldSet className="p-4 rounded-lg border bg-muted/30 min-w-0">
        <Field>
          <FieldLabel>CORS Tunnel UserScript</FieldLabel>
          <FieldDescription>
            Some upload hosts block requests from external websites (CORS).
            Installing this userscript (e.g.{" "}
            <a
              href="https://tampermonkey.net"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Tampermonkey
            </a>
            ) bypasses the restriction so uploads work seamlessly.
          </FieldDescription>

          {/* Status indicator */}
          <div className="mb-2 flex items-center gap-2 text-sm">
            {tunnelStatus === "checking" && (
              <>
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Checking…</span>
              </>
            )}
            {tunnelStatus === "available" && (
              <>
                <CheckCircle className="size-4 text-green-500" />
                <span className="text-green-600 dark:text-green-400">
                  Installed & up to date
                </span>
              </>
            )}
            {tunnelStatus === "outdated" && (
              <>
                <AlertCircle className="size-4 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-400">
                  Outdated (v{installedVersion}) - Update required
                </span>
              </>
            )}
            {tunnelStatus === "unavailable" && (
              <>
                <XCircle className="size-4 text-red-500" />
                <span className="text-red-600 dark:text-red-400">
                  Not detected
                </span>
              </>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={downloadUserscript}
              className="shrink-0"
            >
              <Download className="size-3 mr-1" />
              Download
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowUserscriptViewer(true)}
              className="shrink-0"
            >
              <Code className="size-3 mr-1" />
              View Code
            </Button>
          </div>
        </Field>

        <FieldSeparator />

        <Field orientation="horizontal">
          <Switch
            id="cors-help-modal"
            checked={!!settings.corsModalDismissed}
            onCheckedChange={(dismissed) =>
              updateSettings({ corsModalDismissed: dismissed })
            }
          />
          <FieldContent>
            <FieldLabel htmlFor="cors-help-modal">
              Don't show CORS help on upload failure
            </FieldLabel>
            <FieldLabel htmlFor="cors-help-modal">
              <FieldDescription>
                When enabled, the CORS help modal will not be displayed when an
                upload is blocked by CORS restrictions
              </FieldDescription>
            </FieldLabel>
          </FieldContent>
        </Field>
      </FieldSet>

      <UserscriptViewer
        open={showUserscriptViewer}
        onClose={() => setShowUserscriptViewer(false)}
      />
    </>
  );
}

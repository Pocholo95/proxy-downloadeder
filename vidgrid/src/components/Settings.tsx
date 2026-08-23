import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "@/store/settingsStore";
import UserscriptViewer from "./UserscriptViewer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import GeneralTab from "./Settings/GeneralTab";
import AnimationsTab from "./Settings/AnimationsTab";
import UploadsTab from "./Settings/UploadsTab";

export default function Settings() {
  const open = useSettingsStore((s) => s.showSettingsDialog);
  const handleCloseSettingsDialog = useSettingsStore(
    (s) => s.handleCloseSettingsDialog,
  );

  const [activeTab, setActiveTab] = useState("general");
  const [showUserscriptViewer, setShowUserscriptViewer] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setActiveTab("general");
      setShowUserscriptViewer(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => saveButtonRef.current?.focus(), 0);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && handleCloseSettingsDialog()}
    >
      <DialogContent className="sm:max-w-2xl lg:max-w-3xl h-[70vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure the app. Changes are saved immediately.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="uploads">Uploads</TabsTrigger>
            <TabsTrigger value="animations">Animations</TabsTrigger>
          </TabsList>

          {/* General Tab */}
          <TabsContent
            value="general"
            className="overflow-y-auto flex-1 min-h-0 pr-2"
          >
            <GeneralTab />
          </TabsContent>

          {/* Uploads Tab */}
          <TabsContent
            value="uploads"
            className="overflow-y-auto flex-1 min-h-0 pr-2"
          >
            <UploadsTab dialogOpen={open} />
          </TabsContent>

          {/* Animations Tab */}
          <TabsContent
            value="animations"
            className="overflow-y-auto flex-1 min-h-0 pr-2"
          >
            <AnimationsTab />
          </TabsContent>
        </Tabs>
      </DialogContent>

      <UserscriptViewer
        open={showUserscriptViewer}
        onClose={() => setShowUserscriptViewer(false)}
      />
    </Dialog>
  );
}

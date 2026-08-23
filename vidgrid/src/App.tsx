import { useCallback, useRef } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { autoAnimate } from "@formkit/auto-animate";
import { yieldToBrowser } from "@/lib/utils";
import type { VideoSource } from "@/types";

import { PROJECT_NAME } from "./constants";
import { useTaskStore } from "@/store/taskStore";
import { useProcessingStore } from "@/store/processingStore";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUploadStore } from "@/store/uploadStore";
import { useProcessor } from "@/hooks/useProcessor";
import { useUpload } from "@/hooks/useUpload";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";

import ControlPanel from "./components/ControlPanel";
import TaskList from "./components/TaskList";
import PreviewModal from "./components/PreviewModal";
import CORSHelpModal from "./components/CORSHelpModal";
import CORSOutdatedModal from "./components/CORSOutdatedModal";
import Footer from "./components/Footer";
import Settings from "./components/Settings";
import { Button } from "./components/ui/button";

export default function App() {
  // --- Stores ---
  const items = useTaskStore((s) => s.items);
  const setItems = useTaskStore((s) => s.setItems);
  const updateItem = useTaskStore((s) => s.updateItem);

  const showCORSHelpModal = useUploadStore((s) => s.showCORSHelpModal);
  const handleCloseCORSHelpModal = useUploadStore(
    (s) => s.handleCloseCORSHelpModal,
  );
  const showCORSOutdatedModal = useUploadStore((s) => s.showCORSOutdatedModal);
  const handleCloseCORSOutdatedModal = useUploadStore(
    (s) => s.handleCloseCORSOutdatedModal,
  );

  const opts = useUiStore((s) => s.opts);
  const setOpts = useUiStore((s) => s.setOpts);
  const previewUrl = useUiStore((s) => s.previewUrl);
  const setPreviewUrl = useUiStore((s) => s.setPreviewUrl);
  const downloadAll = useUiStore((s) => s.downloadAll);
  const galleryPreviewTaskId = useUiStore((s) => s.galleryPreviewTaskId);
  const galleryPreviewIndex = useUiStore((s) => s.galleryPreviewIndex);
  const setGalleryPreview = useUiStore((s) => s.setGalleryPreview);

  const settings = useSettingsStore((s) => s.settings);
  const handleOpenSettingsDialog = useSettingsStore(
    (s) => s.handleOpenSettingsDialog,
  );
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // --- Hooks ---
  const processor = useProcessor(updateItem);
  const { requestCancel, forceCancel } = processor;
  const isProcessing = useProcessingStore((s) => s.isProcessing);
  const upload = useUpload();

  // --- Keyboard shortcut: Ctrl+Enter to toggle Start/Cancel ---
  const hasQueuedFiles = items.some((i) => i.status === "queued");
  const allMetadataReady = items.length > 0 && items.every((i) => !!i.metadata);

  const handleToggleProcessing = useCallback(() => {
    if (isProcessing) {
      requestCancel();
    } else if (hasQueuedFiles && allMetadataReady) {
      const queued = items.filter((it) => it.status === "queued");
      processor.processAll(queued, opts);
    }
  }, [
    isProcessing,
    hasQueuedFiles,
    allMetadataReady,
    items,
    opts,
    requestCancel,
    processor.processAll,
  ]);

  useKeyboardShortcut({
    key: "Enter",
    ctrl: true,
    callback: handleToggleProcessing,
    deps: [handleToggleProcessing],
  });

  // --- DOM refs ---
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mainRef = useCallback((el: HTMLDivElement | null) => {
    if (el) autoAnimate(el);
  }, []);

  // --- File handling ---
  const handleSourcesChange = useCallback(
    async (sources: VideoSource[]) => {
      await processor.analyzeFiles(sources, (item) => {
        setItems((prev) => [...prev, item]);
        return yieldToBrowser();
      });
    },
    [processor.analyzeFiles, setItems],
  );

  // --- Start processing ---
  const handleStart = useCallback(async () => {
    const queued = items.filter((it) => it.status === "queued");
    await processor.processAll(queued, opts);
  }, [items, opts, processor.processAll]);

  // --- Cancel processing ---
  const handleCancel = useCallback(() => {
    requestCancel();
  }, [requestCancel]);

  // --- Upload handlers ---
  const handleUploadItem = useCallback(
    (id: string) => upload.uploadItem(id),
    [upload.uploadItem],
  );

  const handleUploadAll = useCallback(() => {
    upload.uploadAll(settings.destinations);
  }, [upload.uploadAll, settings.destinations]);

  // --- Clear ---
  const onClear = useCallback(async () => {
    setItems(() => []);
    await yieldToBrowser();
    await processor.resetState();
    upload.resetUploadState();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [setItems, processor.resetState, upload.resetUploadState]);

  // --- Preview ---
  const handleClosePreview = useCallback(() => {
    setPreviewUrl(null);
    setGalleryPreview(null);
  }, [setPreviewUrl, setGalleryPreview]);

  // --- Derived gallery images from task store ---
  const galleryTask = galleryPreviewTaskId
    ? items.find((i) => i.id === galleryPreviewTaskId)
    : null;
  const galleryImages = galleryTask?.galleryImages;

  return (
    <div ref={mainRef} className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
      <header className="bg-card text-card-foreground flex items-start justify-between gap-4 rounded-xl border p-4 shadow-sm">
        <div className="flex items-center gap-4 flex-1">
          <a
            href="/"
            aria-label="Go to homepage"
            className="focus-visible:ring-ring/50 inline-flex shrink-0 rounded-md focus-visible:ring-2 focus-visible:outline-none"
          >
            <img src="favicon.svg" alt="Logo" className="size-14 rounded-md" />
          </a>
          <div className="min-w-0 flex flex-col gap-1">
            <h1 className="text-base min-[360px]:text-xl font-semibold leading-none tracking-tight text-nowrap">
              {PROJECT_NAME}
            </h1>
            <p className="text-muted-foreground text-sm hidden min-[360px]:block">
              Thumbnail Grids for Videos
            </p>
            <p className="text-muted-foreground text-sm hidden sm:block">
              Client-side only processing, no upload required!
            </p>
          </div>
        </div>

        <Button
          onClick={handleOpenSettingsDialog}
          variant={"outline"}
          size={"icon"}
          aria-label="Open settings"
        >
          <SettingsIcon className="size-4" />
        </Button>
      </header>

      <TaskList
        onSourcesChange={handleSourcesChange}
        onUploadAll={handleUploadAll}
        onDownloadAll={downloadAll}
        onPreview={setPreviewUrl}
        onUpload={handleUploadItem}
        onStart={handleStart}
        onCancel={handleCancel}
        onForceCancel={forceCancel}
        onClear={onClear}
      />

      <ControlPanel
        opts={opts}
        setOpts={setOpts}
        presets={settings.presets}
        setPresets={(p) => {
          updateSettings({ presets: p });
        }}
      />

      {previewUrl && (
        <PreviewModal
          url={previewUrl}
          onClose={handleClosePreview}
          galleryImages={galleryImages}
          galleryIndex={galleryPreviewIndex}
          onGalleryIndexChange={(idx) =>
            setGalleryPreview(galleryPreviewTaskId, idx)
          }
        />
      )}

      <CORSHelpModal
        open={showCORSHelpModal}
        onClose={handleCloseCORSHelpModal}
      />

      <CORSOutdatedModal
        open={showCORSOutdatedModal}
        onClose={handleCloseCORSOutdatedModal}
      />

      <Footer />

      {/* Settings Dialog */}
      <Settings />
    </div>
  );
}

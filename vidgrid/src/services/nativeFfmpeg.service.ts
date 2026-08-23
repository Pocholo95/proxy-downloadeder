/**
 * Native FFmpeg service -- talks to real ffmpeg via the local Python
 * backend's HTTP API (desktop/api.py, desktop/ffmpeg_runner.py, called
 * through src/services/nativeApi.ts) instead of ffmpeg.wasm. Implements
 * the same IFFmpegService contract gridRenderer.service.ts already depends
 * on, so its control flow is unchanged.
 *
 * One instance is bound to one taskId (constructor param, or later
 * re-targeted via setTaskId -- used by the still-sequential stage-3 batch
 * loop the same way the old WASM singleton reused one instance across
 * items). Stage 4's concurrent batch processor will instead construct one
 * instance per in-flight task instead of calling setTaskId.
 */

import type { IFFmpegService } from "../types/service";
import { nativeApi } from "./nativeApi";
import {
  getAndClearLogs as bridgeGetAndClearLogs,
  pushManualLog,
  setGlobalLogSubscriber,
  subscribeProgress,
  unsubscribeProgress,
  clearTask,
} from "./nativeBridgeEvents";
import { errlog } from "../utils";
import { bytesToBase64, base64ToBytes } from "../lib/base64";

/** Best-effort "-t <seconds>" scrape for progress-ratio computation. */
function extractDurationHint(args: string[]): number | null {
  const idx = args.indexOf("-t");
  if (idx === -1 || idx + 1 >= args.length) return null;
  const val = parseFloat(args[idx + 1]);
  return Number.isFinite(val) ? val : null;
}

export class NativeFfmpegService implements IFFmpegService {
  private taskId: string;
  private busy = false;
  private abortController: AbortController | null = null;
  private readonly progressHandlers = new Set<
    (data: { progress: number }) => void
  >();

  public constructor(taskId: string) {
    this.taskId = taskId;
  }

  /** - Lifecycle */

  public async init(): Promise<void> {
    /* Real ffmpeg.exe is resolved on the Python side; nothing to lazy-load. */
  }

  public isReady(): boolean {
    return true;
  }

  public async destroy(): Promise<void> {
    await this.reset();
  }

  public async reset(): Promise<void> {
    try {
      await nativeApi.resetTask(this.taskId);
    } catch (e) {
      errlog("[NativeFfmpeg] reset_task failed:", e);
    }
    clearTask(this.taskId);
  }

  public async reinit(): Promise<void> {
    /* No broken-heap concept for a real subprocess; nothing to do. */
  }

  /** - Input Management */

  public async bindInputPath(path: string): Promise<void> {
    await nativeApi.bindInputPath(this.taskId, path);
  }

  /** - FFmpeg Operations */

  public async exec(args: string[]): Promise<void> {
    this.busy = true;
    const durationHint = extractDurationHint(args);
    subscribeProgress(this.taskId, this._onBridgeProgress);
    try {
      await nativeApi.execFfmpeg(this.taskId, args, durationHint);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg);
    } finally {
      unsubscribeProgress(this.taskId, this._onBridgeProgress);
      this.busy = false;
    }
  }

  public async writeData(path: string, data: Uint8Array): Promise<void> {
    await nativeApi.writeTaskFile(this.taskId, path, bytesToBase64(data));
  }

  public async readData(path: string): Promise<Uint8Array> {
    const b64 = await nativeApi.readTaskFile(this.taskId, path);
    return base64ToBytes(b64);
  }

  public async listDir(path: string): Promise<unknown[]> {
    return nativeApi.listTaskDir(this.taskId, path);
  }

  public async deleteFile(path: string): Promise<void> {
    try {
      await nativeApi.deleteTaskFile(this.taskId, path);
    } catch {
      /* best-effort cleanup, matches ffmpeg.service.ts's semantics */
    }
  }

  /** - Log Management */

  public onLog(
    callback:
      ((taskId: string, logs: string[], totalLines: number) => void) | null,
  ): void {
    setGlobalLogSubscriber(callback);
  }

  public onProgress(
    callback: ((data: { progress: number }) => void) | null,
  ): void {
    if (callback) this.progressHandlers.add(callback);
  }

  public offProgress(
    callback: ((data: { progress: number }) => void) | null,
  ): void {
    if (callback) this.progressHandlers.delete(callback);
  }

  public setTaskId(id: string | null): void {
    if (id) this.taskId = id;
  }

  public getAndClearLogs(taskId: string): string[] {
    return bridgeGetAndClearLogs(taskId);
  }

  /** - Abort Control */

  public setAbortController(): AbortController {
    this.abortController = new AbortController();
    return this.abortController;
  }

  public abortCurrent(): void {
    this.abortController?.abort();
    nativeApi
      .abortTask(this.taskId)
      .catch((e) => errlog("[NativeFfmpeg] abort_task failed:", e));
  }

  public getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /** - Logging Control */

  public setLoggingEnabled(_enabled: boolean): void {
    /* Real ffmpeg CLI logging has no WASM-boundary-crossing cost to guard against. */
  }

  public appendLog(line: string): void {
    pushManualLog(this.taskId, line);
  }

  /** - State Queries */

  public getBusyState(): boolean {
    return this.busy;
  }

  public getBrokenState(): boolean {
    return false;
  }

  /** - Private Helpers */

  private readonly _onBridgeProgress = (data: { progress: number }): void => {
    this.progressHandlers.forEach((cb) => cb(data));
  };
}

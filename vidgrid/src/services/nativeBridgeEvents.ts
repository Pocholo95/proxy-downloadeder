/**
 * Fan-out point for ffmpeg log/progress events pushed from the Python
 * backend (desktop/events.py's push_log/push_progress) over a Server-Sent
 * Events stream at /api/events -- replaces the old pywebview
 * window.evaluate_js bridge now that the UI runs in the user's regular
 * browser tab instead of an embedded native webview.
 *
 * Logs use a single global subscriber: useProcessorStatus.ts registers one
 * app-wide `onLog((taskId, logs, total) => updateItem(taskId, {...}))`
 * callback and dispatches by the taskId it's given, so a single subscriber
 * that just forwards every task's lines works for both the sequential
 * batch loop (one task active at a time) and later N-concurrent batches
 * (Python already tags each line with the right task_id).
 *
 * Progress is scoped per taskId instead: gridRenderer.service.ts registers
 * and unregisters a fresh progress handler tightly around each individual
 * exec() call *on a specific NativeFfmpegService instance*, so routing by
 * taskId keeps concurrent tasks' progress from crossing streams.
 */

type LogCallback = (taskId: string, logs: string[], totalLines: number) => void;
type ProgressCallback = (data: { progress: number }) => void;

type BridgeEvent =
  | { type: "log"; taskId: string; line: string }
  | { type: "progress"; taskId: string; ratio: number };

const logBuffers = new Map<string, string[]>();
const logTotals = new Map<string, number>();
const progressSubscribers = new Map<string, Set<ProgressCallback>>();

let globalLogSubscriber: LogCallback | null = null;

function appendLog(taskId: string, line: string): void {
  const buf = logBuffers.get(taskId) ?? [];
  buf.push(line);
  logBuffers.set(taskId, buf);
  const total = (logTotals.get(taskId) ?? 0) + 1;
  logTotals.set(taskId, total);
  globalLogSubscriber?.(taskId, buf, total);
}

function emitProgress(taskId: string, ratio: number): void {
  progressSubscribers.get(taskId)?.forEach((cb) => cb({ progress: ratio }));
}

let eventSource: EventSource | null = null;

function ensureConnected(): void {
  if (eventSource) return;
  eventSource = new EventSource("/api/events");
  eventSource.onmessage = (ev: MessageEvent<string>) => {
    let msg: BridgeEvent;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "log") appendLog(msg.taskId, msg.line);
    else if (msg.type === "progress") emitProgress(msg.taskId, msg.ratio);
  };
  // EventSource auto-reconnects on transient errors; nothing to do here.
}

ensureConnected();

export function setGlobalLogSubscriber(cb: LogCallback | null): void {
  globalLogSubscriber = cb;
}

export function subscribeProgress(taskId: string, cb: ProgressCallback): void {
  let set = progressSubscribers.get(taskId);
  if (!set) {
    set = new Set();
    progressSubscribers.set(taskId, set);
  }
  set.add(cb);
}

export function unsubscribeProgress(
  taskId: string,
  cb: ProgressCallback,
): void {
  progressSubscribers.get(taskId)?.delete(cb);
}

/** Manually push a log line (bypasses the Python bridge) -- mirrors IFFmpegService.appendLog. */
export function pushManualLog(taskId: string, line: string): void {
  appendLog(taskId, line);
}

export function getAndClearLogs(taskId: string): string[] {
  const logs = logBuffers.get(taskId) ?? [];
  logBuffers.delete(taskId);
  logTotals.delete(taskId);
  return logs;
}

/** Drop all buffered state for a finished/reset task. */
export function clearTask(taskId: string): void {
  logBuffers.delete(taskId);
  logTotals.delete(taskId);
  progressSubscribers.delete(taskId);
}

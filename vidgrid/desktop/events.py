"""Fan-out for ffmpeg log/progress events to connected Server-Sent Events
(SSE) clients, landing in src/services/nativeBridgeEvents.ts's EventSource
handler. Replaces the old pywebview window.evaluate_js bridge now that the
UI runs in the user's regular browser instead of an embedded webview.
"""

import json
import queue
import threading

_lock = threading.Lock()
_subscribers: "set[queue.Queue[str]]" = set()


def subscribe() -> "queue.Queue[str]":
    q: "queue.Queue[str]" = queue.Queue()
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: "queue.Queue[str]") -> None:
    with _lock:
        _subscribers.discard(q)


def _publish(payload: dict) -> None:
    data = json.dumps(payload)
    with _lock:
        subs = list(_subscribers)
    for q in subs:
        q.put(data)


def push_log(task_id: str, line: str) -> None:
    _publish({"type": "log", "taskId": task_id, "line": line})


def push_progress(task_id: str, ratio: float) -> None:
    _publish({"type": "progress", "taskId": task_id, "ratio": ratio})

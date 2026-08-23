"""Desktop entrypoint: serves the built dist/ folder + a JSON API + media
files locally via desktop/media_server.py, and opens it in the user's
regular browser.

Runs the app as a local web server rather than an embedded native webview
(the old pywebview-based shell) -- this sidesteps WebKitGTK/GTK rendering
bugs on some Linux + NVIDIA + Wayland setups, keeps Windows and Linux on
the exact same code path instead of two different native webview backends,
and lets file pickers and output saving use the browser's own native
mechanisms (<input type=file>, downloads) instead of a second native-UI
toolkit.
"""

import os
import sys
import threading
import time
import webbrowser

from . import media_server as _media_server
from .api import Api
from .media_server import MediaServer
from .paths import dist_dir


def _idle_sweep_loop(api: Api, idle_seconds: float, interval_seconds: float) -> None:
    """Runs forever on its own daemon thread, periodically cleaning up
    task sessions and /media/ tokens nobody's touched in idle_seconds --
    see api.py's sweep_idle_sessions and media_server.py's
    prune_media_registry for what "idle" means for each. Meant for a
    long-running server deployment: a plain one-session desktop run would
    just quit before this ever fires, so it's harmless there either way."""
    while True:
        time.sleep(interval_seconds)
        try:
            n_sessions = api.sweep_idle_sessions(idle_seconds)
            n_media = _media_server.prune_media_registry(idle_seconds)
            if n_sessions or n_media:
                print(f"[idle sweep] cleaned {n_sessions} task session(s), {n_media} media token(s)")
        except Exception as e:
            print(f"[idle sweep] error: {type(e).__name__}: {e}")


def main() -> None:
    # stdout is block-buffered (not line-buffered) whenever it's not a real
    # TTY -- e.g. piped to a file/log collector, as under supervisord in the
    # combined Docker image. Without this, log lines (this file's own
    # prints, the idle sweep's) can sit invisible in the buffer for a long
    # time, or forever if the process is ever killed rather than exited
    # cleanly. A plain terminal run is unaffected (already a TTY).
    sys.stdout.reconfigure(line_buffering=True)

    dist = dist_dir()
    if not dist.is_dir():
        raise SystemExit(
            f"dist/ not found at {dist}. Run `npm run build` in the repo first."
        )

    host = os.environ.get("VIDGRID_HOST", "127.0.0.1")
    port = int(os.environ.get("VIDGRID_PORT", "0"))

    api = Api()
    server = MediaServer(str(dist), api, host=host, port=port)
    server.start()

    # 0 (or unset default here would be nonzero -- see below) disables the
    # sweep entirely, e.g. for a plain desktop run where it's pointless.
    idle_minutes = float(os.environ.get("VIDGRID_IDLE_MINUTES", "60"))
    sweep_minutes = float(os.environ.get("VIDGRID_SWEEP_INTERVAL_MINUTES", "10"))
    if idle_minutes > 0:
        threading.Thread(
            target=_idle_sweep_loop,
            args=(api, idle_minutes * 60, sweep_minutes * 60),
            daemon=True,
        ).start()

    # In a container there's no browser to open (and no display for one to
    # open into) -- webbrowser.open() can raise webbrowser.Error there with
    # nothing registered to launch, which would otherwise kill the process
    # before it ever starts serving.
    if not os.environ.get("VIDGRID_NO_BROWSER"):
        try:
            webbrowser.open(server.base_url)
        except webbrowser.Error:
            pass

    listen_addr = f"{host}:{server.port}"
    print(f"VidGrid listening on {listen_addr} ({server.base_url})")
    print("Press Ctrl+C here to stop the server.")

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


if __name__ == "__main__":
    main()

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
import time
import webbrowser

from .api import Api
from .media_server import MediaServer
from .paths import dist_dir


def main() -> None:
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

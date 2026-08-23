# ── Stage 1: build VidGrid's frontend (Vite/React) ──────────────────────
# Only this stage needs Node — the built dist/ is static files, and
# VidGrid's own backend (desktop/) is Python stdlib only, no npm at runtime.
FROM node:20-slim AS vidgrid-frontend
WORKDIR /build
COPY vidgrid/package.json vidgrid/package-lock.json ./
RUN npm ci
COPY vidgrid/ ./
RUN npm run build

# ── Stage 2: final image ─────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# ffmpeg: used by this app for a lossless remux (-c copy -movflags
# +faststart, relocates an MP4's moov atom to the front so the browser can
# stream/seek before the whole file has downloaded) and by yt-dlp to mux
# separately-downloaded video+audio streams into one file; used by VidGrid
# to sample frames and encode its thumbnail-grid/animated outputs. Neither
# app uses GPU acceleration — both run ffmpeg's regular software encoders,
# so this needs no GPU/driver passthrough regardless of the host.
# supervisor: runs proxy-downloader and VidGrid as two processes in one
# container (see supervisord.conf) — Docker wants a single foreground
# process, and this is it.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg supervisor \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-webui.txt ./
RUN pip install --no-cache-dir -r requirements-webui.txt

COPY downloader.py webui.py ./
COPY proxy_downloader ./proxy_downloader

# VidGrid: its Python backend (desktop/) has no dependencies beyond the
# stdlib at runtime (requirements-desktop.txt's pyinstaller is only for
# building a standalone .exe/binary, not needed to just run the server),
# and its frontend is the static dist/ built in stage 1.
COPY vidgrid/desktop ./vidgrid/desktop
COPY --from=vidgrid-frontend /build/dist ./vidgrid/dist

COPY supervisord.conf /etc/supervisor/conf.d/apps.conf

RUN mkdir -p /downloads /app/config /app/state
VOLUME ["/downloads", "/app/config", "/app/state"]

ENV DOWNLOAD_DIR=/downloads \
    STATE_DIR=/app/state \
    PORT=8080 \
    VIDGRID_HOST=0.0.0.0 \
    VIDGRID_PORT=8090 \
    VIDGRID_NO_BROWSER=1 \
    VIDGRID_SHARED_DIR=/downloads

EXPOSE 8080 8090

CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/apps.conf"]

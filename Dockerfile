FROM python:3.12-slim

WORKDIR /app

# ffmpeg: used for a lossless remux (-c copy -movflags +faststart) that
# relocates an MP4's moov atom to the front so the browser can stream/seek
# it before the whole file has downloaded (no video/audio re-encoding), and
# by yt-dlp to mux separately-downloaded video+audio streams into one file.
# aria2: the actual fetch engine (resumable, multi-connection) for every
# download that doesn't need per-chunk proxy rotation -- see
# proxy_downloader/core/aria2.py. Proxy-pool downloads stay on `requests`,
# since aria2 can't hop proxies mid-download the way this app's own speed-
# based rotation does.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg aria2 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-webui.txt ./
RUN pip install --no-cache-dir -r requirements-webui.txt

COPY downloader.py webui.py ./
COPY proxy_downloader ./proxy_downloader

RUN mkdir -p /downloads /app/config /app/state
VOLUME ["/downloads", "/app/config", "/app/state"]

ENV DOWNLOAD_DIR=/downloads \
    STATE_DIR=/app/state \
    PORT=8080

EXPOSE 8080


# A single worker process is required: job state lives in-memory in that
# process (see proxy_downloader/webui/jobs.py). Threads still let it serve
# several UI requests concurrently while a download runs on the background
# job-worker thread.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "8", \
     "proxy_downloader.webui.app:app"]

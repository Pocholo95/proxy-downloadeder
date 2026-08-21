"""Flask web UI for the proxy downloader — a thin HTTP front-end over the
same core/proxy/sites engine the CLI uses. See jobs.py for the job manager
that actually drives downloads on a background thread.
"""
import os

from flask import Flask, jsonify, request, render_template, send_file, after_this_request

from .. import sites  # noqa: F401  (import triggers site provider registration)
from . import files as files_api
from .jobs import JobManager

OUTPUT_DIR = os.environ.get("DOWNLOAD_DIR", "/downloads")
STATE_DIR = os.environ.get("STATE_DIR", "/app/state")

app = Flask(__name__)
manager = JobManager(base_output_dir=OUTPUT_DIR, state_dir=STATE_DIR)


@app.get("/")
def index():
    return render_template("index.html", default_output_dir=OUTPUT_DIR)


@app.get("/api/sites")
def api_list_sites():
    return jsonify(manager.list_sites())


@app.post("/api/sites/<name>/proxy")
def api_set_site_proxy(name):
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    try:
        manager.set_site_proxy(name, action)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@app.get("/api/jobs")
def api_list_jobs():
    return jsonify([j.to_dict() for j in manager.list_jobs()])


@app.post("/api/jobs")
def api_create_job():
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    value = data.get("value", "")
    output_dir = data.get("output_dir") or None
    proxy_mode = data.get("proxy_mode", "auto")
    speed = data.get("speed")
    try:
        speed = int(speed) if speed not in (None, "") else None
        job = manager.create_job(kind, value, output_dir=output_dir,
                                  proxy_mode=proxy_mode, speed=speed)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict()), 201


@app.get("/api/jobs/<job_id>")
def api_get_job(job_id):
    job = manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job.to_dict())


@app.get("/api/jobs/<job_id>/log")
def api_get_job_log(job_id):
    job = manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return job.log_text(), 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.post("/api/jobs/<job_id>/cancel")
def api_cancel_job(job_id):
    ok = manager.cancel(job_id)
    if not ok:
        return jsonify({"error": "job not cancellable (already running/finished, or not found)"}), 409
    return jsonify({"ok": True})


@app.get("/api/files")
def api_list_files():
    rel = request.args.get("path", "")
    try:
        rel_norm, entries = files_api.list_dir(OUTPUT_DIR, rel)
    except files_api.UnsafePath:
        return jsonify({"error": "invalid path"}), 400
    except (FileNotFoundError, NotADirectoryError):
        return jsonify({"error": "not found"}), 404
    return jsonify({"path": rel_norm, "entries": entries})


@app.delete("/api/files")
def api_delete_file():
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    try:
        files_api.delete_path(OUTPUT_DIR, rel)
    except files_api.UnsafePath as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.get("/api/files/download")
def api_download_file():
    rel = request.args.get("path", "")
    try:
        path, name, is_temp = files_api.prepare_download(OUTPUT_DIR, rel)
    except files_api.UnsafePath:
        return jsonify({"error": "invalid path"}), 400
    except FileNotFoundError:
        return jsonify({"error": "not found"}), 404

    if is_temp:
        @after_this_request
        def _cleanup(response):
            try:
                os.remove(path)
            except OSError:
                pass
            return response

    return send_file(path, as_attachment=True, download_name=name)


def main():
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

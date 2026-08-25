"""Flask web UI for the proxy downloader — a thin HTTP front-end over the
same core/proxy/sites engine the CLI uses. See jobs.py for the job manager
that actually drives downloads on a background thread.
"""
import os
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, render_template, send_file, after_this_request
from werkzeug.utils import secure_filename

from .. import sites  # noqa: F401  (import triggers site provider registration)
from .. import proxy_sources
from . import files as files_api
from . import upload_sites
from . import video_optimize
from .jobs import JobManager
from .upload_jobs import UploadManager
from .ytdlp_jobs import YtdlpManager
from .sniff_jobs import SniffManager

OUTPUT_DIR = os.environ.get("DOWNLOAD_DIR", "/downloads")
STATE_DIR = os.environ.get("STATE_DIR", "/app/state")
UPLOAD_TMP_DIR = os.path.join(STATE_DIR, "upload_tmp")

app = Flask(__name__)
manager = JobManager(base_output_dir=OUTPUT_DIR, state_dir=STATE_DIR)
upload_manager = UploadManager(state_dir=STATE_DIR, tmp_dir=UPLOAD_TMP_DIR)
ytdlp_manager = YtdlpManager(base_output_dir=OUTPUT_DIR, state_dir=STATE_DIR)
sniff_manager = SniffManager(base_output_dir=OUTPUT_DIR, state_dir=STATE_DIR)


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


@app.get("/api/proxy-sources")
def api_list_proxy_sources():
    return jsonify(proxy_sources.list_sources())


@app.post("/api/proxy-sources")
def api_add_proxy_source():
    data = request.get_json(silent=True) or {}
    kind = data.get("type")
    try:
        if kind == "list":
            source_id = proxy_sources.add_list_source(data.get("name"), data.get("url"))
        elif kind == "gateway":
            source_id = proxy_sources.add_gateway_source(
                data.get("name"), data.get("host"), data.get("port"),
                data.get("username"), data.get("password"), data.get("scheme", "http"),
            )
        else:
            return jsonify({"error": "type debe ser 'list' o 'gateway'"}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"id": source_id}), 201


@app.post("/api/proxy-sources/<source_id>/activate")
def api_activate_proxy_source(source_id):
    try:
        proxy_sources.set_active(source_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@app.delete("/api/proxy-sources/<source_id>")
def api_delete_proxy_source(source_id):
    try:
        proxy_sources.delete_source(source_id)
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
        return jsonify({"error": "job not cancellable (already finished, or not found)"}), 409
    return jsonify({"ok": True})


@app.post("/api/jobs/<job_id>/retry")
def api_retry_job(job_id):
    try:
        job = manager.retry_job(job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict()), 201


@app.delete("/api/jobs/<job_id>")
def api_delete_job(job_id):
    try:
        ok = manager.delete_job(job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/jobs/clear-finished")
def api_clear_finished():
    removed = manager.clear_finished()
    return jsonify({"ok": True, "removed": removed})


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


@app.post("/api/files/rename")
def api_rename_file():
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    new_name = data.get("new_name", "")
    try:
        new_rel, clean_name = files_api.rename_path(OUTPUT_DIR, rel, new_name)
    except files_api.UnsafePath as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError:
        return jsonify({"error": "not found"}), 404
    except FileExistsError as e:
        return jsonify({"error": str(e)}), 409
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "path": new_rel, "name": clean_name})


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


@app.get("/api/files/preview")
def api_preview_file():
    rel = request.args.get("path", "")
    try:
        path, kind = files_api.prepare_preview(OUTPUT_DIR, rel)
    except files_api.UnsafePath:
        return jsonify({"error": "invalid path"}), 400
    except FileNotFoundError:
        return jsonify({"error": "not found"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 415
    # conditional=True (Flask's default) enables Range requests, needed for
    # video/audio seeking — inline, not attachment, so it renders in-page.
    return send_file(path, as_attachment=False, conditional=True)


@app.post("/api/files/optimize")
def api_optimize_file():
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    try:
        target = files_api.safe_path(OUTPUT_DIR, rel)
    except files_api.UnsafePath:
        return jsonify({"error": "invalid path"}), 400
    if not target.is_file():
        return jsonify({"error": "not found"}), 404
    try:
        video_optimize.optimize_video(target)
    except video_optimize.OptimizeError as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True})


@app.get("/api/uploads/sites")
def api_list_upload_sites():
    return jsonify(upload_manager.list_upload_sites())


@app.post("/api/uploads/account/<site>")
def api_set_upload_account(site):
    data = request.get_json(silent=True) or {}
    try:
        label = upload_manager.set_account(site, data.get("token"))
    except (ValueError, upload_sites.UploadError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "label": label})


@app.delete("/api/uploads/account/<site>")
def api_clear_upload_account(site):
    upload_manager.clear_account(site)
    return jsonify({"ok": True})


@app.get("/api/uploads/folders/<site>")
def api_list_upload_folders(site):
    try:
        folders = upload_manager.list_folders(site)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except upload_sites.UploadError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify(folders)


@app.post("/api/uploads/folders/<site>")
def api_create_upload_folder(site):
    data = request.get_json(silent=True) or {}
    try:
        folder = upload_manager.create_folder(site, data.get("name"), data.get("parent_id"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except upload_sites.UploadError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify(folder), 201


@app.get("/api/uploads/jobs")
def api_list_upload_jobs():
    return jsonify([j.to_dict() for j in upload_manager.list_jobs()])


@app.get("/api/uploads/jobs/<job_id>")
def api_get_upload_job(job_id):
    job = upload_manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job.to_dict())


@app.post("/api/uploads/jobs")
def api_create_upload_job():
    site = request.form.get("site") or (request.get_json(silent=True) or {}).get("site")
    folder_id = request.form.get("folder_id") or (request.get_json(silent=True) or {}).get("folder_id")
    folder_name = request.form.get("folder_name") or (request.get_json(silent=True) or {}).get("folder_name")

    try:
        if "file" in request.files:
            f = request.files["file"]
            if not f.filename:
                return jsonify({"error": "no file"}), 400
            name = secure_filename(f.filename) or "upload.bin"
            Path(UPLOAD_TMP_DIR).mkdir(parents=True, exist_ok=True)
            tmp_path = Path(UPLOAD_TMP_DIR) / f"{uuid.uuid4().hex}-{name}"
            f.save(tmp_path)
            job = upload_manager.create_job(site, tmp_path, f.filename,
                                             dest_folder_id=folder_id, dest_folder_name=folder_name,
                                             is_temp_source=True)
        else:
            rel = (request.get_json(silent=True) or {}).get("path", "")
            source_path = files_api.safe_path(OUTPUT_DIR, rel)
            if not source_path.is_file():
                return jsonify({"error": "not found"}), 404
            job = upload_manager.create_job(site, source_path, source_path.name,
                                             dest_folder_id=folder_id, dest_folder_name=folder_name,
                                             is_temp_source=False)
    except files_api.UnsafePath:
        return jsonify({"error": "invalid path"}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify(job.to_dict()), 201


@app.post("/api/uploads/jobs/<job_id>/retry")
def api_retry_upload_job(job_id):
    try:
        job = upload_manager.retry_job(job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict()), 201


@app.delete("/api/uploads/jobs/<job_id>")
def api_delete_upload_job(job_id):
    try:
        ok = upload_manager.delete_job(job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/uploads/clear-finished")
def api_clear_finished_uploads():
    removed = upload_manager.clear_finished()
    return jsonify({"ok": True, "removed": removed})


@app.get("/api/ytdlp/jobs")
def api_list_ytdlp_jobs():
    return jsonify([j.to_dict() for j in ytdlp_manager.list_jobs()])


@app.post("/api/ytdlp/jobs")
def api_create_ytdlp_job():
    data = request.get_json(silent=True) or {}
    try:
        job = ytdlp_manager.create_job(data.get("url", ""), output_dir=data.get("output_dir") or None,
                                        proxy_mode=data.get("proxy_mode", "auto"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict()), 201


@app.get("/api/ytdlp/jobs/<job_id>")
def api_get_ytdlp_job(job_id):
    job = ytdlp_manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job.to_dict())


@app.get("/api/ytdlp/jobs/<job_id>/log")
def api_get_ytdlp_job_log(job_id):
    job = ytdlp_manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return job.log_text(), 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.post("/api/ytdlp/jobs/<job_id>/cancel")
def api_cancel_ytdlp_job(job_id):
    ok = ytdlp_manager.cancel(job_id)
    if not ok:
        return jsonify({"error": "job not cancellable (already finished, or not found)"}), 409
    return jsonify({"ok": True})


@app.delete("/api/ytdlp/jobs/<job_id>")
def api_delete_ytdlp_job(job_id):
    try:
        ok = ytdlp_manager.delete_job(job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/ytdlp/clear-finished")
def api_clear_finished_ytdlp():
    removed = ytdlp_manager.clear_finished()
    return jsonify({"ok": True, "removed": removed})


@app.get("/api/sniff/jobs")
def api_list_sniff_jobs():
    return jsonify([j.to_dict() for j in sniff_manager.list_jobs()])


@app.post("/api/sniff/jobs")
def api_create_sniff_job():
    data = request.get_json(silent=True) or {}
    try:
        job = sniff_manager.create_job(data.get("url", ""), output_dir=data.get("output_dir") or None)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict()), 201


@app.get("/api/sniff/jobs/<job_id>")
def api_get_sniff_job(job_id):
    job = sniff_manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job.to_dict())


@app.get("/api/sniff/jobs/<job_id>/log")
def api_get_sniff_job_log(job_id):
    job = sniff_manager.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return job.log_text(), 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.post("/api/sniff/jobs/<job_id>/download")
def api_confirm_sniff_download(job_id):
    data = request.get_json(silent=True) or {}
    try:
        job = sniff_manager.confirm_download(job_id, data.get("candidate_ids") or [])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict())


@app.post("/api/sniff/jobs/<job_id>/cancel")
def api_cancel_sniff_job(job_id):
    ok = sniff_manager.cancel(job_id)
    if not ok:
        return jsonify({"error": "job not cancellable (already finished, or not found)"}), 409
    return jsonify({"ok": True})


@app.delete("/api/sniff/jobs/<job_id>")
def api_delete_sniff_job(job_id):
    try:
        ok = sniff_manager.delete_job(job_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.post("/api/sniff/clear-finished")
def api_clear_finished_sniff():
    removed = sniff_manager.clear_finished()
    return jsonify({"ok": True, "removed": removed})


_EXTENSION_HEADER_ALLOWLIST = {"referer", "origin", "user-agent", "cookie"}


@app.post("/api/extension/download")
def api_extension_download():
    """For extras/violentmonkey/video-catcher.user.js — the browser-side
    equivalent of sniffer.py's candidate detection, run in the user's own
    real browser instead of a headless one here, so there's no "sniffing"
    phase to run server-side: this goes straight to downloading the one
    candidate the user picked. No auth (same trust model as the rest of
    this app — Tailscale/LAN only), but headers are still filtered server-
    side to the same small allowlist sniffer.py itself captures, regardless
    of what the client sends, since this is the one endpoint here that
    takes a client-supplied header dict at all."""
    data = request.get_json(silent=True) or {}
    raw_headers = data.get("headers") or {}
    headers = {k: v for k, v in raw_headers.items() if k.lower() in _EXTENSION_HEADER_ALLOWLIST}
    try:
        job = sniff_manager.create_direct_job(
            data.get("page_url", ""), data.get("url", ""),
            headers=headers, filename=data.get("filename") or None,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(job.to_dict()), 201


def main():
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

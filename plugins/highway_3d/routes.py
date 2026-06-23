"""Plugin-registered FastAPI routes for the 3dhighway visualization plugin.

Registered by feedBack core via plugin.json's "routes" field — the
loader at plugins/__init__.py:589–604 imports this module and calls
setup(app, context). context["config_dir"] points at the feedBack
data directory; we namespace user uploads under
{config_dir}/plugin_uploads/highway_3d/.

This module owns the upload/serve/delete endpoints for the `video` bg
style (issue #19 follow-up). Single deterministic slot — each upload
replaces the previous file, no orphan accumulation. localStorage on
the renderer side stores only the filename, never the bytes.
"""

import asyncio
import os
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from starlette.datastructures import UploadFile

PLUGIN_ID = "highway_3d"
ALLOWED_VIDEO_EXTS = {"mp4", "webm"}
ALLOWED_VIDEO_MIMES = {"video/mp4", "video/webm"}
MAX_VIDEO_BYTES = 50 * 1024 * 1024  # 50 MB raw

# Filenames the GET endpoint accepts. Tightened to the exact slot
# pattern this plugin produces — anything else (leftover upload-*.part
# temp files from a crashed upload, future schema additions, manual
# disk edits) gets a 404 rather than being served. The previous
# permissive regex would have happily streamed a `.part` file to a
# client that knew the name.
SLOT_FILENAME_RE = re.compile(r"^current\.(mp4|webm)$")


def setup(app: FastAPI, context: dict) -> None:
    config_dir = Path(context["config_dir"])
    upload_dir = config_dir / "plugin_uploads" / PLUGIN_ID
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Serialises the atomic replace + other-ext cleanup so two concurrent
    # uploads of different extensions (e.g. mp4 and webm) can't both finish
    # streaming before either cleans up, leaving both files on disk. Streaming
    # itself (the slow part) happens outside the lock; only the final
    # replace + cleanup is held under it — so concurrent uploads of the *same*
    # extension still overlap for all but the last microsecond.
    _slot_lock = asyncio.Lock()

    @app.post(f"/api/plugins/{PLUGIN_ID}/files")
    async def upload_file(request: Request):
        # Pre-parse Content-Length guard — fires before ANY body reading.
        #
        # FastAPI only reads request.form() when the handler/dependency
        # explicitly asks for it. By accepting `Request` directly (rather
        # than `file: UploadFile = File(...)`), we get headers without
        # consuming the body. If Content-Length already indicates the
        # upload is too large, we return 413 immediately — python-multipart
        # never buffers a byte to disk.
        #
        # Clients that omit or forge Content-Length fall through to the
        # streaming chunk-count cap in _do_upload, which remains as a
        # defence-in-depth fallback.
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                cl_int = int(cl)
            except ValueError:
                raise HTTPException(400, "Invalid Content-Length header.")
            if cl_int < 0:
                raise HTTPException(400, "Invalid Content-Length header.")
            if cl_int > MAX_VIDEO_BYTES:
                raise HTTPException(
                    413,
                    f"Upload exceeds {MAX_VIDEO_BYTES // (1024 * 1024)} MB limit.",
                )

        # Body is only consumed here, after the Content-Length pre-check.
        form = await request.form()
        try:
            file = form.get("file")
            if not isinstance(file, UploadFile):
                raise HTTPException(400, "Expected a file upload in field 'file'.")
            try:
                return await _do_upload(file)
            finally:
                try:
                    await file.close()
                except Exception:
                    pass
        finally:
            # Release the form object (closes any remaining SpooledTemporaryFile
            # references that weren't already closed by file.close() above).
            try:
                await form.close()
            except Exception:
                pass

    async def _do_upload(file: UploadFile):
        # Extension whitelist is the primary guard — file.filename
        # (and thus the extension) is always present on a real upload,
        # whereas content_type is unreliable: some OS / browser combos
        # report it as empty or as the generic application/octet-stream
        # for valid .mp4 / .webm files. This mirrors settings.html's
        # client-side fallback so a working browser doesn't 400 here
        # after passing the client check. Server-side raw decoding
        # is left to the browser's <video> element on play.
        ext = (Path(file.filename or "").suffix.lstrip(".") or "").lower()
        if ext not in ALLOWED_VIDEO_EXTS:
            raise HTTPException(400, "Filename must end in .mp4 or .webm.")
        # MIME check applies only when the client supplied something
        # specific. Empty / octet-stream / None mean "browser couldn't
        # tell" — fall through to the extension whitelist that already
        # passed above.
        if (
            file.content_type
            and file.content_type != "application/octet-stream"
            and file.content_type not in ALLOWED_VIDEO_MIMES
        ):
            raise HTTPException(400, "Only MP4 and WebM are allowed.")

        # Stream the body to a temp file so we never hold the full 50 MB
        # in memory (and never doubled — the previous version buffered
        # chunks AND a joined bytes object). Writes go through
        # run_in_threadpool so the event loop isn't blocked by a
        # multi-second disk write. Atomic os.replace at the end means
        # a server crash mid-upload leaves the previous slot file
        # intact rather than a half-written current.<ext>.
        out_name = f"current.{ext}"
        out_path = upload_dir / out_name
        # mkstemp on the same filesystem as out_path is required for
        # os.replace to be atomic. Suffix marks the partial so a stray
        # leftover from a crashed upload is obvious on inspection.
        fd, tmp_name = await run_in_threadpool(
            tempfile.mkstemp, dir=str(upload_dir), prefix="upload-", suffix=".part"
        )
        tmp_path = Path(tmp_name)
        bytes_read = 0
        try:
            # Wrap the raw fd in a Python file object so writes are
            # guaranteed-complete: os.write can return a short write on
            # some platforms / fd states and would silently truncate the
            # upload. The buffered file object loops internally and
            # raises on real errors.
            #
            # If fdopen itself fails, the fd hasn't been wrapped yet, so
            # the outer try's tmpf.close path can't reach it — close
            # manually here. The outer except still unlinks tmp_path.
            try:
                tmpf = await run_in_threadpool(os.fdopen, fd, "wb")
            except BaseException:
                try:
                    await run_in_threadpool(os.close, fd)
                except OSError:
                    pass
                raise
            try:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    bytes_read += len(chunk)
                    if bytes_read > MAX_VIDEO_BYTES:
                        raise HTTPException(
                            413,
                            f"Video exceeds {MAX_VIDEO_BYTES // (1024 * 1024)} MB cap.",
                        )
                    await run_in_threadpool(tmpf.write, chunk)
            finally:
                # Close before any rename / unlink to avoid Windows
                # file-locking surprises. Close also flushes the
                # buffer so the bytes are on disk before os.replace.
                await run_in_threadpool(tmpf.close)

            # Reject empty uploads before the atomic rename. Without
            # this guard, a misbehaving client (or a multipart body
            # whose file part is empty) would replace the slot with a
            # 0-byte file that the renderer then tries — and fails —
            # to play. Existing slot stays untouched; the temp file
            # is cleaned up by the outer except.
            if bytes_read == 0:
                raise HTTPException(400, "Empty upload — file is 0 bytes.")

            # Hold the slot lock for the atomic replace + other-ext
            # cleanup. Streaming (above) happens outside the lock so
            # concurrent uploads of different extensions can overlap
            # for most of their duration. Only the final commit is
            # serialised. Under the lock there are no concurrent
            # writers, so we can safely delete the opposite slot
            # without a snapshot — whichever upload acquires the lock
            # second simply supersedes the first, and the first
            # upload's cleanup (which already ran) may have removed
            # the second's now-absent file, or the second's cleanup
            # removes the first's file now. Either way at most one
            # slot file survives after the lock is released.
            async with _slot_lock:
                await run_in_threadpool(os.replace, str(tmp_path), str(out_path))
                for e in ALLOWED_VIDEO_EXTS - {ext}:
                    try:
                        await run_in_threadpool((upload_dir / f"current.{e}").unlink)
                    except OSError:
                        # Another process holding the file (antivirus,
                        # in-flight GET) shouldn't 500 the upload. The
                        # new file is already in place; the stale one
                        # will get retried on the next upload or Clear.
                        pass
        except BaseException:
            # Any failure (size cap, write error, even cancellation):
            # remove the temp file so we don't leak partial uploads on
            # disk. unlink_missing_ok would be cleaner but isn't on
            # older Python versions.
            try:
                await run_in_threadpool(tmp_path.unlink)
            except OSError:
                pass
            raise

        return {
            "url": f"/api/plugins/{PLUGIN_ID}/files/{out_name}",
            "name": out_name,
            "size": bytes_read,
        }

    @app.get(f"/api/plugins/{PLUGIN_ID}/files/{{filename}}")
    async def get_file(filename: str):
        if not SLOT_FILENAME_RE.match(filename):
            raise HTTPException(404, "Not found.")
        path = upload_dir / filename
        # Defense-in-depth: even with the regex above, resolve and
        # confirm the resolved path stays inside upload_dir. Catches
        # any future regex regression or symlink trickery.
        try:
            resolved = path.resolve()
            resolved.relative_to(upload_dir.resolve())
        except (OSError, ValueError):
            raise HTTPException(404, "Not found.")
        if not resolved.is_file():
            raise HTTPException(404, "Not found.")
        ext = resolved.suffix.lstrip(".").lower()
        media = {"mp4": "video/mp4", "webm": "video/webm"}.get(
            ext, "application/octet-stream"
        )
        # The slot URL is stable across re-uploads (we always overwrite
        # current.<ext> in place), so without explicit cache headers a
        # browser or upstream proxy will happily serve the previous
        # video after a Replace operation. `no-cache` lets the cache
        # store a copy but forces revalidation on every load — paired
        # with the Last-Modified / ETag headers FileResponse adds, the
        # browser sends If-Modified-Since and gets a 304 when unchanged.
        return FileResponse(
            resolved,
            media_type=media,
            headers={
                "Cache-Control": "no-cache",
                # nosniff prevents the browser from second-guessing the
                # MIME we declared. The MIME is fixed to video/mp4 or
                # video/webm by the slot pattern, but a malicious
                # upload could try to sneak past via an allowed
                # extension carrying e.g. HTML; nosniff keeps the
                # browser from rendering it as anything other than a
                # video stream.
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.delete(f"/api/plugins/{PLUGIN_ID}/files")
    async def delete_files():
        # Slot-level clear: removes every current.* in the upload dir
        # regardless of extension. This is the only delete operation
        # the client needs — the previous per-filename DELETE could
        # leak the other extension's file (e.g. clearing current.mp4
        # while current.webm survives) when client and server got out
        # of sync about which slot was active.
        #
        # Best-effort + always 200: file-locking on Windows (an
        # in-flight GET, antivirus, an OS file scanner) can transiently
        # block unlink, and a 500 response would silently leave the
        # client's localStorage in a "still has video" state because
        # the UI doesn't update on a failed clear. The user's actual
        # intent — "stop using this video" — is best served by
        # returning success so the client clears its pointer and the
        # next render uses the fallback style. Any leftover file
        # comes back in `leftover` for visibility; operators or the
        # next upload's pre-cleanup loop will handle it.
        # Hold the slot lock so a concurrent upload's os.replace() can't
        # sneak a new current.* into the slot between our glob and our
        # unlink calls. Without the lock, a DELETE that interleaves with
        # an upload could return "cleared" while the upload's replace
        # commits a fresh file immediately after the unlink.
        async with _slot_lock:
            slot_paths = await run_in_threadpool(
                lambda: list(upload_dir.glob("current.*"))
            )
            deleted = []
            leftover = []
            for path in slot_paths:
                try:
                    await run_in_threadpool(path.unlink)
                    deleted.append(path.name)
                except OSError:
                    leftover.append({"name": path.name, "error": "unlink failed"})
        return JSONResponse({"ok": True, "deleted": deleted, "leftover": leftover})

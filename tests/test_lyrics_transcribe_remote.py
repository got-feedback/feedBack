"""The remote transcription REQUEST — the thing that was never tested and never worked.

`transcribe_vocals_remote()` POSTed the vocal stem to `/align`. That endpoint is *forced
alignment*: "here are the lyrics, tell me when each word is sung". Its `text` field is required,
and we have no lyrics — transcribing them is the entire point. So the server rejected every
request with a 422 from FastAPI's validation layer, before its handler ever ran, and remote
transcription had never worked for anybody (feedBack-plugin-stem-splitter#17).

Nothing caught it because every test of this module tested the *mapper* — `_whisperx_to_sloppak`,
fed a hand-written dict. The mapper was always fine. The request was never exercised, and the
request was the bug.

So these tests assert the request: which endpoint, and how `language` is carried. Both are
invisible to a mapper test, and both are wrong in ways that fail quietly rather than loudly.
"""
from pathlib import Path
from unittest import mock

import pytest

from lyrics_transcribe import transcribe_vocals_remote

_ALIGNED = {
    "segments": [{
        "start": 1.0, "end": 2.0, "text": "hello world",
        "words": [
            {"word": "hello", "start": 1.0, "end": 1.4, "score": 0.9},
            {"word": "world", "start": 1.5, "end": 2.0, "score": 0.9},
        ],
    }]
}


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload if payload is not None else _ALIGNED
        self.text = text

    def json(self):
        return self._payload


@pytest.fixture
def vocals(tmp_path: Path) -> Path:
    p = tmp_path / "vocals.ogg"
    p.write_bytes(b"not really ogg, we never decode it here")
    return p


def _post_call(vocals: Path, resp: _Resp, **kw):
    with mock.patch("requests.post", return_value=resp) as post:
        out = transcribe_vocals_remote(vocals, "http://server:7865", **kw)
    return post.call_args, out


def test_it_posts_to_transcribe_not_align(vocals):
    """THE regression. /align requires `text`; we have none, so it 422s every time."""
    call, out = _post_call(vocals, _Resp())

    url = call.args[0]
    assert url.endswith("/transcribe"), (
        f"posted to {url!r} — /align is forced alignment and its `text` field is required, so "
        f"this request is rejected with a 422 before the server's handler ever runs"
    )
    assert "/align" not in url
    assert out, "a successful transcription must return syllables"


def test_the_language_hint_is_a_form_field_not_a_query_param(vocals):
    """The server reads `language` with Form(""). Sent as a query param it is silently ignored —
    so an explicit hint does nothing, Whisper's auto-detection quietly decides instead, and the
    wrong wav2vec2 aligner gets loaded. It "works", it's just wrong: the failure mode that hides
    for months."""
    call, _ = _post_call(vocals, _Resp(), language="es")

    assert (call.kwargs.get("data") or {}).get("language") == "es", (
        "the language hint must ride in the form body — the server reads Form('language'), and "
        "a query param is dropped without a word"
    )
    assert "language" not in (call.kwargs.get("params") or {})


def test_no_language_sends_no_hint(vocals):
    # Absent is not the empty string: "" would pin detection to a language named "".
    call, _ = _post_call(vocals, _Resp())
    assert not (call.kwargs.get("data") or {})


def test_the_file_is_sent_as_a_multipart_upload(vocals):
    call, _ = _post_call(vocals, _Resp())
    files = call.kwargs.get("files") or {}
    assert "file" in files, "the server reads File('file')"
    assert files["file"][0] == "vocals.ogg"


def test_an_api_key_is_sent_as_a_bearer_token(vocals):
    call, _ = _post_call(vocals, _Resp(), api_key="secret")
    assert (call.kwargs.get("headers") or {})["Authorization"] == "Bearer secret"


def test_an_instrumental_is_an_answer_not_a_crash(vocals):
    # The server returns 200 + no segments for a stem with no singing in it. That is a valid
    # answer ("this song has no vocals"), and it must not read as a failure.
    _, out = _post_call(vocals, _Resp(payload={"segments": [], "language": "en"}))
    assert out == []


def test_a_server_error_surfaces_the_whole_body(vocals):
    """The error body IS the diagnosis. A 422's JSON names the field it rejected; a 500's
    traceback answers on its last line. The old 300-char cap decapitated both — which is how
    this bug stayed invisible: the message explaining it was inside the part that got cut."""
    tb = "Traceback (most recent call last):\n" + ("  File x, line 1\n" * 40) + \
         "RuntimeError: CUDA out of memory"
    assert len(tb) > 300 and "CUDA out of memory" not in tb[:300]

    with pytest.raises(RuntimeError) as exc:
        _post_call(vocals, _Resp(status=500, text=tb))
    assert "CUDA out of memory" in str(exc.value)


def test_truncation_keeps_the_exception_line_not_just_the_header():
    """A traceback's ANSWER is its last line. Head-only truncation throws it away.

    This is the same mistake as the 300-char cap, one level up: cutting off precisely the part
    the function exists to preserve. A 4000-char window that contains "Traceback (most recent
    call last)" and none of the exception is a window onto nothing."""
    from lyrics_transcribe import _MAX_ERR_BODY, _err_body

    frames = "".join(f'  File "/app/server.py", line {i}, in run\n    step()\n'
                     for i in range(2000))          # far over the cap on its own
    tb = "Traceback (most recent call last):\n" + frames + \
         "RuntimeError: CUDA out of memory. Tried to allocate 2.20 GiB"

    body = _err_body(_Resp(text=tb))
    assert len(body) <= _MAX_ERR_BODY
    assert "CUDA out of memory" in body, (
        "the exception line is the diagnosis — a truncation that drops it keeps the part that "
        "says work was happening and discards the part that says what went wrong"
    )
    assert "Traceback (most recent call last)" in body, "the head is context worth keeping too"
    assert "truncated" in body


def test_the_cap_is_a_bound_not_a_suggestion():
    """The truncation marker must fit INSIDE _MAX_ERR_BODY, not be appended past it.

    Otherwise the cap is advisory, and the callers who trust it — a log line, a job record
    persisted to disk and re-read on every load — are the ones that get surprised."""
    from lyrics_transcribe import _MAX_ERR_BODY, _err_body

    body = _err_body(_Resp(text="x" * 500_000))
    assert len(body) <= _MAX_ERR_BODY, (
        f"body is {len(body)} chars, over the {_MAX_ERR_BODY} cap it claims to enforce"
    )
    assert "truncated" in body and "500000" in body


def test_trailing_whitespace_is_not_content():
    # A 300-char JSON body followed by 3900 blanks is not a long body, and cutting real content
    # to make room for whitespace would be a silly way to lose the diagnosis.
    from lyrics_transcribe import _err_body

    payload = '{"detail":"nope"}'
    assert _err_body(_Resp(text=payload + " " * 8000)) == payload


def test_a_404_explains_that_the_server_is_too_old(vocals):
    """A bare "404" sends someone hunting for a typo in their URL. The real answer is that their
    server predates the endpoint, and only we can know that."""
    with pytest.raises(RuntimeError) as exc:
        _post_call(vocals, _Resp(status=404, text='{"detail":"Not Found"}'))
    msg = str(exc.value)
    assert "404" in msg
    assert "/transcribe" in msg
    assert "predates" in msg or "Update the server" in msg


class TestEverythingFailsAsRuntimeError:
    """The docstring promises one failure mode: RuntimeError. The caller
    (`_maybe_transcribe_lyrics`) catches exactly that so one song's failed lyrics don't take down
    the batch around it. A transport error escaping as requests.RequestException walks straight
    past that handler — turning "this song's lyrics failed" into "the whole batch died"."""

    def test_a_connection_failure(self, vocals):
        import requests
        with mock.patch("requests.post",
                        side_effect=requests.ConnectionError("name resolution failed")):
            with pytest.raises(RuntimeError, match="could not reach"):
                transcribe_vocals_remote(vocals, "http://nope:7865")

    def test_a_timeout(self, vocals):
        import requests
        with mock.patch("requests.post", side_effect=requests.Timeout("timed out")):
            with pytest.raises(RuntimeError, match="could not reach"):
                transcribe_vocals_remote(vocals, "http://server:7865")

    def test_an_unreadable_stem(self, tmp_path):
        missing = tmp_path / "gone.ogg"      # never created
        with pytest.raises(RuntimeError, match="could not read"):
            transcribe_vocals_remote(missing, "http://server:7865")

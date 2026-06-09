"""Backend jobs registry for plugin-owned long-running work.

This is a server-side companion to the browser jobs capability host. It keeps
only redaction-safe public job state; plugin backends remain responsible for
private execution payloads such as local filenames, subprocess handles, and
artifact paths.
"""

from __future__ import annotations

import datetime as _dt
import re
import threading
import uuid
from collections import deque
from typing import Any, Callable

_SCHEMA = "slopsmith.jobs.diagnostics.v1"
_STATES = {
    "queued",
    "running",
    "paused",
    "cancellation-requested",
    "cancelled",
    "completed",
    "failed",
    "provider-unavailable",
    "orphaned",
}
_TERMINAL_STATES = {"cancelled", "completed", "failed", "provider-unavailable", "orphaned"}
_ACTIVE_STATES = {"queued", "running", "paused", "cancellation-requested"}
_FAILURE_CATEGORIES = {
    "invalid-input",
    "permission-denied",
    "provider-unavailable",
    "unsupported-operation",
    "timeout",
    "cancellation",
    "external-dependency",
    "storage",
    "provider-failure",
    "unknown",
}
_PRIORITY_ORDER = {
    "user-approved-interactive": 0,
    "background-maintenance": 1,
}
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.:-]+")
_MAX_LABEL = 120
_MAX_REASON = 240
_MAX_STEP = 80
_MAX_HISTORY_PER_JOB = 50
_MAX_TERMINAL_JOBS = 50
_MAX_OUTCOMES = 100
_MAX_BRIDGE_HITS = 100


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_id(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    text = _SAFE_ID_RE.sub("-", text)[:160].strip("-_.:")
    return text or default


def _safe_text(value: Any, default: str = "", limit: int = _MAX_REASON) -> str:
    if value is None:
        return default
    text = str(value).replace("\x00", " ").strip()
    if not text:
        return default
    # Conservative path/URL/secret scrubbing. Callers should pass safe text
    # already; this protects support surfaces from accidents.
    text = re.sub(r"https?://\S+", "<url>", text)
    text = re.sub(r"(?i)(token|secret|api[_-]?key|password|pwd)=([^\s&]+)", r"\1=<redacted>", text)
    text = re.sub(r"/Users/[^\s]+", "<path>", text)
    text = re.sub(r"[A-Za-z]:\\[^\s]+", "<path>", text)
    if len(text) > limit:
        text = text[: max(0, limit - 3)].rstrip() + "..."
    return text


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _progress(source: Any = None) -> dict:
    data = source if isinstance(source, dict) else {}
    raw_mode = data.get("mode")
    mode = raw_mode if raw_mode in {"determinate", "indeterminate", "step-only"} else ("determinate" if data.get("percent") is not None else "indeterminate")
    percent = None
    if mode == "determinate":
        percent = max(0.0, min(100.0, _number(data.get("percent"), 0.0)))
    return {
        "mode": mode,
        "percent": percent,
        "step": _safe_text(data.get("step") or data.get("currentStep"), "", _MAX_STEP),
        "message": _safe_text(data.get("message") or data.get("safeMessage"), "", _MAX_REASON),
        "updatedAt": _now(),
    }


def _result(outcome: str, payload: dict | None = None, reason: str = "") -> dict:
    out = {"outcome": outcome, "status": "applied" if outcome in {"handled", "queued", "completed", "cancelled", "failed", "timeout", "retry-started"} else "rejected"}
    if payload:
        out["payload"] = payload
    if reason:
        out["reason"] = _safe_text(reason)
    return out


class BackendJobs:
    """Thread-safe, redaction-safe backend jobs state."""

    def __init__(self, *, log=None) -> None:
        self._log = log
        self._lock = threading.RLock()
        self._providers: dict[str, dict] = {}
        self._jobs: dict[str, dict] = {}
        self._terminal_ids: deque[str] = deque(maxlen=_MAX_TERMINAL_JOBS)
        self._outcomes: deque[dict] = deque(maxlen=_MAX_OUTCOMES)
        self._bridge_hits: deque[dict] = deque(maxlen=_MAX_BRIDGE_HITS)
        self._subscribers: set[Callable[[dict], None]] = set()

    def subscribe(self, callback: Callable[[dict], None]) -> Callable[[], None]:
        with self._lock:
            self._subscribers.add(callback)

        def unsubscribe() -> None:
            with self._lock:
                self._subscribers.discard(callback)

        return unsubscribe

    def _emit(self, event: str, payload: dict | None = None) -> None:
        message = {"type": event, **(payload or {})}
        with self._lock:
            subscribers = list(self._subscribers)
        for callback in subscribers:
            try:
                callback(message)
            except Exception as exc:  # noqa: BLE001
                if self._log:
                    self._log.warning("backend jobs subscriber failed: %s", exc)

    def _remember_outcome(self, operation: str, outcome: str, extra: dict | None = None) -> None:
        entry = {"at": _now(), "operation": _safe_id(operation, "operation"), "outcome": _safe_id(outcome, "handled")}
        if extra:
            for key in ("jobId", "providerId", "requesterId", "category", "safeReason"):
                if extra.get(key) is not None:
                    entry[key] = _safe_text(extra[key]) if key == "safeReason" else _safe_id(extra[key], "")
        self._outcomes.append(entry)

    def _history(self, job: dict, kind: str, message: str, extra: dict | None = None) -> None:
        entry = {"at": _now(), "kind": _safe_id(kind, "event"), "message": _safe_text(message)}
        if extra:
            entry.update(extra)
        job.setdefault("history", []).append(entry)
        if len(job["history"]) > _MAX_HISTORY_PER_JOB:
            del job["history"][: len(job["history"]) - _MAX_HISTORY_PER_JOB]

    def _provider_summary(self, provider: dict) -> dict:
        return {
            "providerId": provider["providerId"],
            "pluginId": provider.get("pluginId"),
            "label": provider.get("label"),
            "jobTypes": list(provider.get("jobTypes") or []),
            "actions": list(provider.get("actions") or []),
            "capacity": dict(provider.get("capacity") or {}),
            "available": bool(provider.get("available", True)),
            "recoverySupport": dict(provider.get("recoverySupport") or {}),
            "updatedAt": provider.get("updatedAt"),
        }

    def _job_summary(self, job: dict, *, include_history: bool = True) -> dict:
        summary = {
            "jobId": job["jobId"],
            "providerId": job["providerId"],
            "requesterId": job.get("requesterId"),
            "jobType": job.get("jobType"),
            "state": job.get("state"),
            "priority": job.get("priority"),
            "safeLabel": job.get("safeLabel"),
            "target": dict(job.get("target") or {}),
            "inputs": dict(job.get("inputs") or {}),
            "progress": dict(job.get("progress") or {}),
            "createdAt": job.get("createdAt"),
            "queuedAt": job.get("queuedAt"),
            "startedAt": job.get("startedAt"),
            "updatedAt": job.get("updatedAt"),
            "terminalAt": job.get("terminalAt"),
            "terminalOutcome": dict(job.get("terminalOutcome") or {}) if job.get("terminalOutcome") else None,
            "retryable": bool(job.get("retryable")),
            "externallyManaged": bool(job.get("externallyManaged")),
            "attempt": int(job.get("attempt", 1)),
        }
        if include_history:
            summary["history"] = list(job.get("history") or [])
        return summary

    def register_provider(self, provider: dict) -> dict:
        provider_id = _safe_id(provider.get("providerId") or provider.get("id"), "")
        if not provider_id:
            return _result("validation-failed", reason="providerId is required")
        job_types = [_safe_id(j, "") for j in provider.get("jobTypes", []) if _safe_id(j, "")]
        if not job_types:
            return _result("validation-failed", reason="jobTypes are required")
        actions = [_safe_id(a, "") for a in provider.get("actions", []) if _safe_id(a, "")]
        now = _now()
        normalized = {
            "providerId": provider_id,
            "pluginId": _safe_id(provider.get("pluginId") or provider.get("plugin_id"), provider_id),
            "label": _safe_text(provider.get("label") or provider_id, provider_id, _MAX_LABEL),
            "jobTypes": job_types,
            "actions": actions,
            "capacity": provider.get("capacity") if isinstance(provider.get("capacity"), dict) else {},
            "available": bool(provider.get("available", True)),
            "recoverySupport": provider.get("recoverySupport") if isinstance(provider.get("recoverySupport"), dict) else {},
            "updatedAt": now,
        }
        with self._lock:
            self._providers[provider_id] = normalized
            self._remember_outcome("register-provider", "handled", {"providerId": provider_id})
        self._emit("provider-registered", {"provider": self._provider_summary(normalized)})
        return _result("handled", {"provider": self._provider_summary(normalized)})

    def unregister_provider(self, provider_id: str) -> dict:
        provider_id = _safe_id(provider_id, "")
        with self._lock:
            provider = self._providers.pop(provider_id, None)
            if not provider:
                return _result("no-owner", reason="provider not found")
            self._remember_outcome("unregister-provider", "handled", {"providerId": provider_id})
        self._emit("provider-unregistered", {"providerId": provider_id})
        return _result("handled")

    def adopt(self, *, provider_id: str, job_type: str, job_id: str | None = None, state: str = "running", requester_id: str | None = None, safe_label: str | None = None, target: dict | None = None, inputs: dict | None = None, priority: str = "user-approved-interactive", progress: dict | None = None, category: str | None = None, safe_reason: str | None = None, result_summary: str | None = None, retryable: bool = False, externally_managed: bool = True) -> dict:
        provider_id = _safe_id(provider_id, "")
        job_type = _safe_id(job_type, "")
        if not provider_id or not job_type:
            return _result("validation-failed", reason="provider_id and job_type are required")
        job_id = _safe_id(job_id, "") or f"job-{uuid.uuid4().hex[:12]}"
        desired_state = _safe_id(state, "running")
        if desired_state not in _STATES and desired_state not in {"done", "error"}:
            desired_state = "running"
        if desired_state == "done":
            desired_state = "completed"
        if desired_state == "error":
            desired_state = "failed"
        now = _now()
        with self._lock:
            provider = self._providers.get(provider_id)
            if provider and job_type not in provider.get("jobTypes", []):
                return _result("no-handler", reason="provider does not handle job type")
            job = self._jobs.get(job_id)
            if job and job.get("state") in _TERMINAL_STATES:
                return _result("stale", {"job": self._job_summary(job)}, "job is terminal")
            if not job:
                job = {
                    "jobId": job_id,
                    "providerId": provider_id,
                    "requesterId": _safe_id(requester_id, provider_id),
                    "jobType": job_type,
                    "state": desired_state,
                    "priority": _safe_id(priority, "user-approved-interactive"),
                    "safeLabel": _safe_text(safe_label or job_type, job_type, _MAX_LABEL),
                    "target": self._safe_ref_dict(target, prefix="target"),
                    "inputs": self._safe_ref_dict(inputs, prefix="input"),
                    "progress": _progress(progress),
                    "createdAt": now,
                    "queuedAt": now if desired_state == "queued" else None,
                    "startedAt": now if desired_state == "running" else None,
                    "updatedAt": now,
                    "terminalAt": None,
                    "terminalOutcome": None,
                    "retryable": False,
                    "externallyManaged": bool(externally_managed),
                    "attempt": 1,
                    "history": [],
                }
                self._jobs[job_id] = job
                self._history(job, "event", "Job adopted from backend provider")
            else:
                job.update({
                    "safeLabel": _safe_text(safe_label or job.get("safeLabel"), job.get("safeLabel", job_type), _MAX_LABEL),
                    "target": self._safe_ref_dict(target, prefix="target") or job.get("target") or {},
                    "inputs": self._safe_ref_dict(inputs, prefix="input") or job.get("inputs") or {},
                    "updatedAt": now,
                    "externallyManaged": bool(externally_managed),
                })
                if progress is not None:
                    job["progress"] = _progress(progress)
            if desired_state in _TERMINAL_STATES:
                self._settle_locked(job, desired_state, category=category, safe_reason=safe_reason, result_summary=result_summary, retryable=retryable)
                event = desired_state
                outcome = desired_state
            else:
                job["state"] = desired_state
                job["updatedAt"] = _now()
                if desired_state == "running":
                    job["startedAt"] = job.get("startedAt") or job["updatedAt"]
                if desired_state == "queued":
                    job["queuedAt"] = job.get("queuedAt") or job["updatedAt"]
                self._history(job, "event", f"Job adopted as {desired_state}")
                self._remember_outcome("adopt", "handled", {"jobId": job_id, "providerId": provider_id, "requesterId": job.get("requesterId")})
                event = "started" if desired_state in {"running", "cancellation-requested"} else desired_state
                outcome = "handled"
            summary = self._job_summary(job)
        self._emit(event, {"job": self._job_summary(job, include_history=False)})
        return _result(outcome, {"job": summary})

    def _safe_ref_dict(self, data: dict | None, *, prefix: str) -> dict:
        if not isinstance(data, dict):
            return {}
        out: dict[str, str] = {}
        for key in ("safeRef", "safeFingerprint", "logicalJobKey", "backendJobId", "bulkJobId"):
            if key in data:
                out[key] = _safe_id(data.get(key), "")
        if not out:
            for key in ("id", "ref", "fingerprint"):
                if data.get(key):
                    out[f"{prefix}Ref"] = _safe_id(data.get(key), "")
                    break
        return {k: v for k, v in out.items() if v}

    def update_progress(self, provider_id: str, job_id: str, progress: dict | None = None) -> dict:
        provider_id = _safe_id(provider_id, "")
        job_id = _safe_id(job_id, "")
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.get("providerId") != provider_id:
                return _result("no-target", reason="job not found")
            if job.get("state") in _TERMINAL_STATES:
                self._remember_outcome("progress", "stale", {"jobId": job_id, "providerId": provider_id, "requesterId": job.get("requesterId"), "safeReason": "progress after terminal state"})
                return _result("stale", {"job": self._job_summary(job)}, "job is terminal")
            job["progress"] = _progress(progress)
            job["updatedAt"] = job["progress"]["updatedAt"]
            self._history(job, "progress", job["progress"].get("message") or job["progress"].get("step") or job["progress"].get("mode"), {"progress": dict(job["progress"])})
            self._remember_outcome("progress", "handled", {"jobId": job_id, "providerId": provider_id, "requesterId": job.get("requesterId")})
            summary = self._job_summary(job)
        self._emit("progress", {"job": self._job_summary(job, include_history=False)})
        return _result("handled", {"job": summary})

    def complete(self, provider_id: str, job_id: str, result: dict | None = None) -> dict:
        return self._terminal(provider_id, job_id, "completed", result or {})

    def fail(self, provider_id: str, job_id: str, result: dict | None = None) -> dict:
        result = dict(result or {})
        status = "provider-unavailable" if result.get("status") == "provider-unavailable" else "failed"
        return self._terminal(provider_id, job_id, status, result)

    def cancelled(self, provider_id: str, job_id: str, result: dict | None = None) -> dict:
        return self._terminal(provider_id, job_id, "cancelled", result or {})

    def mark_provider_unavailable(self, provider_id: str, safe_reason: str = "Provider unavailable") -> dict:
        provider_id = _safe_id(provider_id, "")
        changed: list[dict] = []
        with self._lock:
            provider = self._providers.get(provider_id)
            if provider:
                provider["available"] = False
                provider["updatedAt"] = _now()
            for job in self._jobs.values():
                if job.get("providerId") == provider_id and job.get("state") in _ACTIVE_STATES:
                    self._settle_locked(job, "provider-unavailable", category="provider-unavailable", safe_reason=safe_reason, result_summary="Provider unavailable")
                    changed.append(self._job_summary(job, include_history=False))
            self._remember_outcome("provider-unavailable", "provider-unavailable", {"providerId": provider_id, "safeReason": safe_reason})
        for job in changed:
            self._emit("provider-unavailable", {"job": job})
        return _result("provider-unavailable", {"jobs": changed})

    def _terminal(self, provider_id: str, job_id: str, state: str, result: dict) -> dict:
        provider_id = _safe_id(provider_id, "")
        job_id = _safe_id(job_id, "")
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.get("providerId") != provider_id:
                return _result("no-target", reason="job not found")
            if job.get("state") in _TERMINAL_STATES:
                return _result("stale", {"job": self._job_summary(job)}, "job is terminal")
            self._settle_locked(
                job,
                state,
                category=result.get("category"),
                safe_reason=result.get("safeReason") or result.get("safe_reason") or result.get("reason"),
                result_summary=result.get("resultSummary") or result.get("summary"),
                retryable=bool(result.get("retryable")),
            )
            summary = self._job_summary(job)
        event = "completed" if state == "completed" else ("cancelled" if state == "cancelled" else ("provider-unavailable" if state == "provider-unavailable" else "failed"))
        self._emit(event, {"job": self._job_summary(job, include_history=False)})
        return _result("completed" if state == "completed" else ("cancelled" if state == "cancelled" else "failed"), {"job": summary})

    def _settle_locked(self, job: dict, state: str, *, category: str | None = None, safe_reason: str | None = None, result_summary: str | None = None, retryable: bool = False) -> None:
        if state not in _TERMINAL_STATES:
            state = "failed"
        terminal_at = _now()
        category = _safe_id(category, "")
        if state == "completed":
            category = ""
        elif category not in _FAILURE_CATEGORIES:
            category = "unknown"
        job["state"] = state
        job["retryable"] = bool(retryable)
        job["terminalAt"] = terminal_at
        job["updatedAt"] = terminal_at
        job["terminalOutcome"] = {
            "status": state,
            "category": category or None,
            "retryable": bool(retryable),
            "safeReason": _safe_text(safe_reason or ("Completed" if state == "completed" else state.replace("-", " "))),
            "resultSummary": _safe_text(result_summary or ("Completed" if state == "completed" else state.replace("-", " "))),
        }
        if job["jobId"] not in self._terminal_ids:
            self._terminal_ids.append(job["jobId"])
        self._history(job, "event", f"Job {state}")
        self._remember_outcome(state, state, {"jobId": job["jobId"], "providerId": job["providerId"], "requesterId": job.get("requesterId"), "category": category, "safeReason": job["terminalOutcome"].get("safeReason")})

    def record_bridge_hit(self, bridge_id: str, detail: dict | None = None) -> dict:
        bridge_id = _safe_id(bridge_id, "")
        if not bridge_id:
            return _result("validation-failed", reason="bridge id required")
        data = detail if isinstance(detail, dict) else {}
        hit = {
            "at": _now(),
            "bridgeId": bridge_id,
            "providerId": _safe_id(data.get("providerId"), ""),
            "jobType": _safe_id(data.get("jobType"), ""),
            "operation": _safe_id(data.get("operation"), ""),
            "safeReason": _safe_text(data.get("safeReason") or data.get("reason"), ""),
        }
        hit = {k: v for k, v in hit.items() if v}
        with self._lock:
            self._bridge_hits.append(hit)
            self._remember_outcome("record-bridge-hit", "handled", {"providerId": hit.get("providerId"), "safeReason": hit.get("safeReason")})
        self._emit("bridge-hit", {"bridgeHit": hit})
        return _result("handled", {"bridgeHit": hit})

    def list_jobs(self, filters: dict | None = None) -> dict:
        filters = filters if isinstance(filters, dict) else {}
        include_terminal = filters.get("includeTerminal", True) is not False
        with self._lock:
            jobs = []
            for job in self._jobs.values():
                if filters.get("providerId") and job.get("providerId") != filters.get("providerId"):
                    continue
                if filters.get("jobType") and job.get("jobType") != filters.get("jobType"):
                    continue
                if filters.get("state") and job.get("state") != filters.get("state"):
                    continue
                if not include_terminal and job.get("state") in _TERMINAL_STATES:
                    continue
                jobs.append(self._job_summary(job, include_history=False))
            jobs.sort(key=lambda j: (_PRIORITY_ORDER.get(j.get("priority"), 99), j.get("createdAt") or ""))
            providers = [self._provider_summary(p) for p in self._providers.values()]
        return {"schema": _SCHEMA, "jobs": jobs, "providers": providers}

    def inspect(self, job_id: str) -> dict:
        job_id = _safe_id(job_id, "")
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return _result("no-target", reason="job not found")
            provider = self._providers.get(job.get("providerId"))
            return _result("handled", {"job": self._job_summary(job), "provider": self._provider_summary(provider) if provider else None})

    def snapshot(self) -> dict:
        with self._lock:
            providers = [self._provider_summary(p) for p in self._providers.values()]
            active = []
            queued = []
            paused = []
            recent_terminal = []
            for job in self._jobs.values():
                summary = self._job_summary(job)
                state = job.get("state")
                if state == "queued":
                    queued.append(summary)
                elif state == "paused":
                    paused.append(summary)
                elif state in _TERMINAL_STATES:
                    if job["jobId"] in self._terminal_ids:
                        recent_terminal.append(summary)
                else:
                    active.append(summary)
            recent_terminal.sort(key=lambda j: j.get("terminalAt") or "")
            return {
                "schema": _SCHEMA,
                "backendIntegrated": True,
                "providers": providers,
                "jobs": {
                    "active": active,
                    "queued": queued,
                    "paused": paused,
                    "recentTerminal": recent_terminal[-_MAX_TERMINAL_JOBS:],
                },
                "bridgeHits": list(self._bridge_hits),
                "recentOutcomes": list(self._outcomes),
                "limits": {
                    "maxHistoryPerJob": _MAX_HISTORY_PER_JOB,
                    "maxTerminalJobs": _MAX_TERMINAL_JOBS,
                    "maxOutcomes": _MAX_OUTCOMES,
                    "maxBridgeHits": _MAX_BRIDGE_HITS,
                },
                "notes": ["Backend jobs contain redaction-safe summaries only; plugin-private execution payloads remain with provider backends."],
            }

    def reset_for_tests(self) -> None:
        with self._lock:
            self._providers.clear()
            self._jobs.clear()
            self._terminal_ids.clear()
            self._outcomes.clear()
            self._bridge_hits.clear()


backend_jobs = BackendJobs()

from jobs_backend import BackendJobs
import asyncio


def test_backend_jobs_adopt_progress_and_complete_redacts_raw_payloads():
    jobs = BackendJobs()
    jobs.register_provider({
        "providerId": "provider.test",
        "pluginId": "plugin_test",
        "label": "Test Provider",
        "jobTypes": ["test.convert"],
        "actions": ["status"],
    })

    adopted = jobs.adopt(
        provider_id="provider.test",
        job_type="test.convert",
        job_id="backend-1",
        state="queued",
        requester_id="plugin_test",
        safe_label="Convert Example Song",
        target={"safeRef": "target-abc", "backendJobId": "backend-1"},
        inputs={"safeFingerprint": "input-abc"},
    )
    assert adopted["outcome"] == "handled"

    progressed = jobs.update_progress(
        "provider.test",
        "backend-1",
        {"mode": "determinate", "percent": 42, "step": "convert", "message": "/Users/example/Secret.sloppak token=abc"},
    )
    assert progressed["outcome"] == "handled"

    completed = jobs.complete("provider.test", "backend-1", {"resultSummary": "Wrote /Users/example/out.sloppak"})
    assert completed["outcome"] == "completed"

    snapshot = jobs.snapshot()
    text = str(snapshot)
    assert "provider.test" in text
    assert "target-abc" in text
    assert "Secret.sloppak" not in text
    assert "token=abc" not in text
    assert "/Users/example" not in text
    assert snapshot["jobs"]["recentTerminal"][0]["state"] == "completed"


def test_backend_jobs_provider_unavailable_settles_active_jobs():
    jobs = BackendJobs()
    jobs.register_provider({
        "providerId": "provider.test",
        "jobTypes": ["test.convert"],
    })
    jobs.adopt(provider_id="provider.test", job_type="test.convert", job_id="backend-2", state="running")

    result = jobs.mark_provider_unavailable("provider.test", "backend stopped")
    snapshot = jobs.snapshot()

    assert result["outcome"] == "provider-unavailable"
    assert snapshot["jobs"]["active"] == []
    assert snapshot["jobs"]["recentTerminal"][0]["state"] == "provider-unavailable"


def test_backend_jobs_dispatches_private_provider_action_and_redacts_payload():
    calls = []
    jobs = BackendJobs()

    def cancel_handler(request):
        calls.append(request)
        return {
            "outcome": "cancelled",
            "payload": {
                "jobId": request["job"]["jobId"],
                "rawPath": "/Users/example/Secret.sloppak",
            },
        }

    jobs.register_provider({
        "providerId": "provider.test",
        "jobTypes": ["test.convert"],
        "actions": ["job.status"],
        "callbacks": {"job.cancel": cancel_handler},
    })
    jobs.adopt(provider_id="provider.test", job_type="test.convert", job_id="backend-3", state="queued")

    result = asyncio.run(jobs.dispatch_action("backend-3", "cancel", {"requesterId": "test"}))

    assert result["outcome"] == "cancelled"
    assert result["payload"] == {"jobId": "backend-3"}
    assert calls[0]["job"]["jobId"] == "backend-3"
    assert "rawPath" not in str(result)


def test_backend_jobs_retry_requires_user_action_and_retryable_failed_job():
    jobs = BackendJobs()
    jobs.register_provider({
        "providerId": "provider.test",
        "jobTypes": ["test.convert"],
        "callbacks": {"job.retry": lambda request: {"outcome": "retry-started", "payload": {"jobId": "backend-4b", "sourceJobId": request["job"]["jobId"]}}},
    })
    jobs.adopt(provider_id="provider.test", job_type="test.convert", job_id="backend-4", state="queued")
    jobs.fail("provider.test", "backend-4", {"retryable": True, "safeReason": "failed"})

    denied = asyncio.run(jobs.dispatch_action("backend-4", "retry", {"requesterId": "test"}))
    allowed = asyncio.run(jobs.dispatch_action("backend-4", "retry", {"requesterId": "test", "authorization": "user-action"}))

    assert denied["outcome"] == "user-action-required"
    assert allowed["outcome"] == "retry-started"
    assert allowed["payload"] == {"jobId": "backend-4b", "sourceJobId": "backend-4"}


def test_backend_jobs_provider_unavailable_and_orphaned_are_applied_outcomes():
    jobs = BackendJobs()
    jobs.register_provider({
        "providerId": "provider.test",
        "jobTypes": ["test.convert"],
    })
    jobs.adopt(provider_id="provider.test", job_type="test.convert", job_id="backend-5", state="running")
    unavailable = jobs.mark_provider_unavailable("provider.test", "offline")

    assert unavailable["outcome"] == "provider-unavailable"
    assert unavailable["status"] == "applied"


def test_backend_jobs_unregister_provider_orphans_active_jobs():
    jobs = BackendJobs()
    jobs.register_provider({
        "providerId": "provider.test",
        "jobTypes": ["test.convert"],
    })
    jobs.adopt(provider_id="provider.test", job_type="test.convert", job_id="backend-6", state="queued")

    removed = jobs.unregister_provider("provider.test")
    inspect = jobs.inspect("backend-6")

    assert removed["outcome"] == "handled"
    assert removed["status"] == "applied"
    assert removed["payload"]["orphanedJobs"][0]["jobId"] == "backend-6"
    assert inspect["payload"]["job"]["state"] == "orphaned"


def test_backend_jobs_adopt_emits_cancellation_requested_event():
    jobs = BackendJobs()
    jobs.register_provider({
        "providerId": "provider.test",
        "jobTypes": ["test.convert"],
    })
    seen = []
    unsubscribe = jobs.subscribe(lambda event: seen.append(event.get("type")))
    try:
        jobs.adopt(
            provider_id="provider.test",
            job_type="test.convert",
            job_id="backend-7",
            state="cancellation-requested",
        )
    finally:
        unsubscribe()

    assert "cancellation-requested" in seen
    assert "started" not in seen

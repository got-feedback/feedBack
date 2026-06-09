from jobs_backend import BackendJobs


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
        {"mode": "determinate", "percent": 42, "step": "convert", "message": "/Users/example/Secret.psarc token=abc"},
    )
    assert progressed["outcome"] == "handled"

    completed = jobs.complete("provider.test", "backend-1", {"resultSummary": "Wrote /Users/example/out.sloppak"})
    assert completed["outcome"] == "completed"

    snapshot = jobs.snapshot()
    text = str(snapshot)
    assert "provider.test" in text
    assert "target-abc" in text
    assert "Secret.psarc" not in text
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

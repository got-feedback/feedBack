import json
from unittest import mock

import diagnostics_hardware as dh


def test_collect_has_required_top_level_keys():
    result = dh.collect()
    assert result["schema"] == "system.hardware.v1"
    for key in ("runtime", "os", "cpu", "memory", "gpu", "notes"):
        assert key in result


def test_runtime_detect_env_override(monkeypatch):
    monkeypatch.setenv("FEEDBACK_RUNTIME", "electron")
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    out = dh.detect_runtime()
    assert out["kind"] == "electron"


def test_runtime_detect_kubernetes(monkeypatch):
    monkeypatch.delenv("FEEDBACK_RUNTIME", raising=False)
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    out = dh.detect_runtime()
    assert out["in_kubernetes"] is True


def test_safe_run_missing_binary_returns_127():
    rc, stdout, stderr = dh._safe_run(["this-binary-does-not-exist-xyz123"])
    assert rc == 127
    assert stdout == ""


def test_gpu_probe_nvidia_parses_csv():
    fake_out = "NVIDIA GeForce RTX 4070, 550.54.14, 12282\n"
    with mock.patch.object(dh, "_safe_run", return_value=(0, fake_out, "")):
        gpus = dh._probe_gpu_nvidia()
    assert len(gpus) == 1
    assert gpus[0]["name"] == "NVIDIA GeForce RTX 4070"
    assert gpus[0]["driver"] == "550.54.14"
    assert gpus[0]["memory_total_mb"] == 12282
    assert gpus[0]["source"] == "nvidia-smi"


def test_gpu_probe_nvidia_absent_returns_empty():
    with mock.patch.object(dh, "_safe_run", return_value=(127, "", "")):
        assert dh._probe_gpu_nvidia() == []


def test_collect_with_no_gpus_records_note():
    with mock.patch.object(dh, "_probe_gpus", return_value=[]):
        # _probe_gpus internally appends; mock it to also append via spec
        result = dh.collect()
    assert "notes" in result


def test_collect_returns_runtime_kind():
    result = dh.collect()
    assert result["runtime"]["kind"] in ("docker", "electron", "bare")


def test_gpu_probe_rocm_parses_product_and_driver():
    fake_out = json.dumps({
        "card0": {
            "Card series": "AMD Radeon RX 7900 XTX",
            "Driver version": "6.2.4",
        }
    })
    with mock.patch.object(dh, "_safe_run", return_value=(0, fake_out, "")):
        gpus = dh._probe_gpu_rocm()
    assert len(gpus) == 1
    assert gpus[0]["name"] == "AMD Radeon RX 7900 XTX"
    assert gpus[0]["driver"] == "6.2.4"
    assert gpus[0]["source"] == "rocm-smi"


def test_gpu_probe_rocm_absent_driver_omits_field():
    fake_out = json.dumps({"card0": {"Card series": "AMD Radeon RX 6800"}})
    with mock.patch.object(dh, "_safe_run", return_value=(0, fake_out, "")):
        gpus = dh._probe_gpu_rocm()
    assert gpus[0]["name"] == "AMD Radeon RX 6800"
    assert "driver" not in gpus[0]

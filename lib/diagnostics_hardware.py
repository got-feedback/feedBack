"""Backend hardware probe for diagnostic bundles.

Produces a `system.hardware.v1`-shaped dict — see
docs/diagnostics-bundle-spec.md.

All probes are best-effort and never raise. Missing tools, missing
permissions, container masking — every case yields a structured note in
the output rather than a 500 on the export endpoint.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
from pathlib import Path

from env_compat import getenv_compat

SCHEMA = "system.hardware.v1"


def _safe_run(cmd: list[str], timeout: float = 2.0) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return 127, "", ""


def detect_runtime() -> dict:
    """Cheap runtime-kind detection (env var + cgroup checks, no subprocess).

    Exported as a public function so callers that don't need the full
    hardware probe can still obtain the runtime kind without paying for
    nvidia-smi / psutil CPU probes.
    """
    out: dict = {"kind": "bare", "in_docker": False, "in_kubernetes": False}
    env_runtime = (getenv_compat("FEEDBACK_RUNTIME", "") or "").strip().lower()
    if env_runtime in ("electron", "docker", "bare"):
        out["kind"] = env_runtime
    if Path("/.dockerenv").exists():
        out["in_docker"] = True
        if out["kind"] == "bare":
            out["kind"] = "docker"
    cgroup = Path("/proc/1/cgroup")
    if cgroup.exists():
        try:
            txt = cgroup.read_text(errors="ignore")
            if "docker" in txt or "containerd" in txt or "kubepods" in txt:
                out["in_docker"] = True
                if out["kind"] == "bare":
                    out["kind"] = "docker"
        except OSError:
            pass
    if os.environ.get("KUBERNETES_SERVICE_HOST"):
        out["in_kubernetes"] = True
    if out["kind"] == "bare":
        try:
            import psutil  # type: ignore

            parent = psutil.Process(os.getppid()).name().lower()
            if "electron" in parent or "feedBack" in parent:
                out["kind"] = "electron"
        except Exception:
            pass
    return out


def _probe_os() -> dict:
    return {
        "system": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
    }


def _probe_cpu(notes: list[str]) -> dict:
    out: dict = {
        "brand": None,
        "arch": platform.machine(),
        "cores_logical": os.cpu_count(),
        "cores_physical": None,
        "freq_mhz_current": None,
        "freq_mhz_max": None,
    }
    try:
        import psutil  # type: ignore

        out["cores_physical"] = psutil.cpu_count(logical=False)
        freq = psutil.cpu_freq()
        if freq:
            out["freq_mhz_current"] = round(freq.current) if freq.current else None
            out["freq_mhz_max"] = round(freq.max) if freq.max else None
    except Exception as e:
        notes.append(f"psutil cpu probe failed: {e}")
    try:
        import cpuinfo  # type: ignore

        info = cpuinfo.get_cpu_info() or {}
        out["brand"] = info.get("brand_raw") or info.get("brand") or None
    except Exception as e:
        notes.append(f"py-cpuinfo probe failed: {e}")
        # Fallback: platform.processor() is reliable on Windows + some Linux,
        # useless on macOS Apple Silicon (returns 'arm').
        proc = platform.processor()
        if proc and proc.lower() not in ("arm", "i386"):
            out["brand"] = proc
    return out


def _probe_memory(notes: list[str]) -> dict:
    out: dict = {"total_bytes": None, "available_bytes": None}
    try:
        import psutil  # type: ignore

        vm = psutil.virtual_memory()
        out["total_bytes"] = int(vm.total)
        out["available_bytes"] = int(vm.available)
    except Exception as e:
        notes.append(f"psutil memory probe failed: {e}")
    return out


def _probe_gpu_nvidia() -> list[dict]:
    rc, stdout, _ = _safe_run(
        [
            "nvidia-smi",
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader,nounits",
        ]
    )
    if rc != 0 or not stdout.strip():
        return []
    gpus: list[dict] = []
    for line in stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            mem_mb = int(parts[2])
        except ValueError:
            mem_mb = None
        gpus.append({
            "source": "nvidia-smi",
            "name": parts[0],
            "driver": parts[1],
            "memory_total_mb": mem_mb,
        })
    return gpus


def _probe_gpu_rocm() -> list[dict]:
    rc, stdout, _ = _safe_run(
        ["rocm-smi", "--showproductname", "--showdriverversion", "--json"]
    )
    if rc != 0 or not stdout.strip():
        return []
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return []
    gpus: list[dict] = []
    for card_id, card in (data or {}).items():
        if not isinstance(card, dict):
            continue
        gpu: dict = {
            "source": "rocm-smi",
            "id": card_id,
            "name": card.get("Card series") or card.get("Card model") or "AMD GPU",
        }
        driver = card.get("Driver version") or card.get("driver_version")
        if driver:
            gpu["driver"] = driver
        gpus.append(gpu)
    return gpus


def _probe_gpu_macos() -> list[dict]:
    if platform.system() != "Darwin":
        return []
    rc, stdout, _ = _safe_run(
        ["system_profiler", "SPDisplaysDataType", "-json"], timeout=4.0
    )
    if rc != 0 or not stdout.strip():
        return []
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return []
    gpus: list[dict] = []
    for card in data.get("SPDisplaysDataType", []) or []:
        gpus.append({
            "source": "system_profiler",
            "name": card.get("sppci_model") or card.get("_name") or "GPU",
            "vendor": card.get("spdisplays_vendor"),
            "metal_support": card.get("spdisplays_metalfamily"),
        })
    return gpus


def _probe_gpus(notes: list[str]) -> list[dict]:
    gpus: list[dict] = []
    gpus.extend(_probe_gpu_nvidia())
    gpus.extend(_probe_gpu_rocm())
    gpus.extend(_probe_gpu_macos())
    if not gpus:
        notes.append(
            "no GPU probes succeeded — nvidia-smi/rocm-smi/system_profiler absent or denied"
        )
    return gpus


def collect() -> dict:
    """Build a `system.hardware.v1` dict. Never raises."""
    notes: list[str] = []
    runtime = detect_runtime()
    cpu = _probe_cpu(notes)
    memory = _probe_memory(notes)
    gpu = _probe_gpus(notes)
    if runtime["in_docker"]:
        notes.append(
            "container masks host CPU/RAM — values reflect container limits, not host"
        )
    return {
        "schema": SCHEMA,
        "runtime": runtime,
        "os": _probe_os(),
        "cpu": cpu,
        "memory": memory,
        "gpu": gpu,
        "notes": notes,
    }

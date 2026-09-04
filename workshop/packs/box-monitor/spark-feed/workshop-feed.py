#!/usr/bin/env python3
"""Spark-local Workshop feed collector. Read-only. Operator install on Spark.

Writes ~/.local/share/go7-workshop/feed.json (override GO7_WORKSHOP_FEED).
Failed refresh does not overwrite the last valid file.
Does not start or stop Bloom, write leftover.json, or call spark-broker.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

FEED_PATH = Path(os.environ.get("GO7_WORKSHOP_FEED", os.path.expanduser("~/.local/share/go7-workshop/feed.json")))
CKPT_ROOT = Path(os.path.expanduser("~/workloads/creative-llm/checkpoints"))
GATEWAY = os.environ.get("GO7_INFERENCE_GATEWAY", "http://127.0.0.1:8788")
KEY_FILE = Path(os.environ.get("GO7_INFERENCE_OWNER_KEY", os.path.expanduser("~/.config/go7-inference/client-keys/owner")))
SCHEMA = "go7-workshop-feed/v0"


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def run(cmd: list[str], timeout: float = 5.0) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "").strip()
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def nvidia_smi(field: str) -> float | None:
    rc, out = run(["nvidia-smi", f"--query-gpu={field}", "--format=csv,noheader,nounits"])
    if rc != 0 or not out:
        return None
    try:
        return float(out.splitlines()[0].replace(" [N/A]", "").strip())
    except ValueError:
        return None


def train_name_match_count() -> int | None:
    rc, out = run(["pgrep", "-f", "train_pretrain.py"])
    if rc not in (0, 1):
        return None
    return len([ln for ln in out.splitlines() if ln.strip()])


def latest_json() -> Path | None:
    if not CKPT_ROOT.is_dir():
        return None
    found = [p for p in CKPT_ROOT.rglob("latest.json") if p.is_file()]
    if not found:
        return None
    return max(found, key=lambda p: p.stat().st_mtime)


def tok_per_param(path: Path | None) -> float | None:
    if path is None:
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    tokens = data.get("tokens_seen") or data.get("tokens") or data.get("n_tokens")
    params = data.get("n_params") or data.get("params") or data.get("parameter_count")
    try:
        if tokens is None or params is None or float(params) == 0:
            return None
        return float(tokens) / float(params)
    except (TypeError, ValueError):
        return None


def probe_unit() -> str | None:
    rc, out = run(["systemctl", "--user", "is-active", "bloom-v40-probe.service"])
    if rc == 0 and out == "active":
        return "active"
    if out in ("inactive", "failed", "dead"):
        return "inactive"
    return None


def port_30000_up() -> bool:
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(("127.0.0.1", 30000))
        return True
    except OSError:
        return False
    finally:
        s.close()


def qwen_parked() -> bool | None:
    rc, out = run(["systemctl", "--user", "is-active", "qwen38-sglang.service"])
    if rc not in (0, 3, 4) and not out:
        return None
    active = out == "active"
    if active or port_30000_up():
        return False
    return True


def gateway_models() -> list[str] | None:
    if not KEY_FILE.is_file():
        return None
    try:
        token = KEY_FILE.read_text().strip()
    except OSError:
        return None
    if not token:
        return None

    def get(path: str) -> tuple[int, str]:
        req = urllib.request.Request(
            GATEWAY.rstrip("/") + path,
            headers={"Authorization": "Bearer " + token},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, ""
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, ""

    ready_code, _ = get("/readyz")
    if ready_code != 200:
        return None
    code, body = get("/v1/models")
    if code != 200 or not body:
        return None
    try:
        payload = json.loads(body)
        data = payload.get("data") or []
        names = [str(item.get("id")) for item in data if isinstance(item, dict) and item.get("id")]
        return names or None
    except json.JSONDecodeError:
        return None


def collect() -> dict:
    errors: list[str] = []
    gpu = nvidia_smi("utilization.gpu")
    watts = nvidia_smi("power.draw")
    if gpu is None or watts is None:
        errors.append("nvidia-smi")
    nproc = train_name_match_count()
    if nproc is None:
        errors.append("pgrep")
        one = None
    else:
        one = nproc == 1
        if nproc >= 2:
            errors.append("two-trainers")
    latest = latest_json()
    if latest is None:
        errors.append("no-latest-json")
    tpp = tok_per_param(latest)
    unit = probe_unit()
    parked = qwen_parked()
    if unit == "active" and parked is False:
        errors.append("qwen-up-during-train")
    models = gateway_models()
    if models is None:
        errors.append("infer-down-or-unready")
    return {
        "schema": SCHEMA,
        "asOf": utcnow(),
        "host": socket.gethostname(),
        "gpuUtilPercent": gpu,
        "powerWatts": watts,
        "oneWriter": one,
        "trainNameMatchCount": nproc,
        "tokPerParam": tpp,
        "last8Toks": None,
        "latestJson": str(latest) if latest else None,
        "exclusiveSidecar": {"probeUnit": unit, "qwenParked": parked},
        "models": models,
        "errors": errors,
    }


def valid_doc(doc: object) -> bool:
    return isinstance(doc, dict) and doc.get("schema") == SCHEMA and isinstance(doc.get("asOf"), str)


def atomic_write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n")
    os.replace(tmp, path)


def main() -> int:
    try:
        doc = collect()
    except Exception:
        return 1
    if not valid_doc(doc):
        return 1
    atomic_write(FEED_PATH, doc)
    if "--print" in sys.argv:
        print(json.dumps(doc, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

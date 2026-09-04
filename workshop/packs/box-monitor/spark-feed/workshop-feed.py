#!/usr/bin/env python3
"""Spark-local Workshop feed collector. Read-only. Operator install on Spark.

Writes ~/.local/share/go7-workshop/feed.json (override GO7_WORKSHOP_FEED).
Failed refresh does not overwrite the last valid file.
Does not start or stop Bloom, write leftover.json, or call spark-broker.

Four sources, in this order. Nothing talks to NVIDIA Sync.
  1. Identity  lease file + process table + probe unit + fence units
  2. Live      the exclusive log's [step] lines (tqdm writes \\r; converted)
  3. Durable   latest.json, frozen at the last save
  4. Box       nvidia-smi name / util / watts (memory is N/A on UMA; never invented)
The rate is the last-8 window over live [step] lines. The sidecar's whole-run
tok/s and latest.json tokens_per_sec are never published.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
FEED_PATH = Path(os.environ.get("GO7_WORKSHOP_FEED", str(HOME / ".local/share/go7-workshop/feed.json")))
WORKLOAD = Path(os.environ.get("GO7_WORKSHOP_WORKLOAD", str(HOME / "workloads/creative-llm")))
CKPT_ROOT = WORKLOAD / "checkpoints"
LEASE_PATH = WORKLOAD / "ACTIVE_GPU_JOB.json"
LOG_DIR = WORKLOAD / "logs/exclusive-probes"
GATEWAY = os.environ.get("GO7_INFERENCE_GATEWAY", "http://127.0.0.1:8788")
KEY_FILE = Path(os.environ.get("GO7_INFERENCE_OWNER_KEY", str(HOME / ".config/go7-inference/client-keys/owner")))
SCHEMA = "go7-workshop-feed/v0"
TRAIN_NAME = "train_pretrain.py"
PROBE_UNIT = "bloom-v40-probe.service"
FENCE_UNITS = ("qwen38-sglang.service", "bloom-v40-500m.service")
LAST8_WINDOW_S = 480
WARMUP_S = 60
LOG_TAIL_BYTES = 256 * 1024
LOG_TAIL_LINES = 40
GPU_IDLE_S = 180

STEP_RE = re.compile(r"\[step (\d+)\]([^\n]*)")
KV_RE = re.compile(r"([A-Za-z_/]+)=([^\s]+)")


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def to_float(text: str) -> float | None:
    try:
        return float(text.replace(",", ""))
    except (TypeError, ValueError):
        return None


def parse_step_lines(text: str) -> list[dict]:
    """[step N] train_loss=… tokens_seen=… t/param=… tok/s=… elapsed_s=…  → dicts, in order.

    tqdm rewrites lines with carriage returns; treat every \\r as a line break.
    Lines missing tokens_seen or elapsed_s are skipped.
    """
    rows: list[dict] = []
    for match in STEP_RE.finditer(text.replace("\r", "\n")):
        kv = {k: v for k, v in KV_RE.findall(match.group(2))}
        tokens = to_float(kv.get("tokens_seen", ""))
        elapsed = to_float(kv.get("elapsed_s", ""))
        if tokens is None or elapsed is None:
            continue
        rows.append({
            "step": int(match.group(1)),
            "tokens": tokens,
            "elapsed": elapsed,
            "loss": to_float(kv.get("train_loss", "")),
            "tpp": to_float(kv.get("t/param", "")),
        })
    return rows


def last8_rate(rows: list[dict], window_s: float = LAST8_WINDOW_S, warmup_s: float = WARMUP_S) -> float | None:
    """Δtokens / Δelapsed over [step] rows whose elapsed falls in the last `window_s`.

    Skips the first `warmup_s` (compile). If the post-warmup window is shorter than
    `window_s`, uses all of it. Needs two rows and forward time; else None.
    """
    if len(rows) < 2:
        return None
    last = rows[-1]
    floor = max(warmup_s, last["elapsed"] - window_s)
    picked = [r for r in rows if r["elapsed"] >= floor]
    if len(picked) < 2:
        picked = [r for r in rows if r["elapsed"] >= warmup_s]
    if len(picked) < 2:
        return None
    first = picked[0]
    dt = last["elapsed"] - first["elapsed"]
    dtok = last["tokens"] - first["tokens"]
    if dt <= 0 or dtok < 0:
        return None
    return dtok / dt


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


def nvidia_smi_text(field: str) -> str | None:
    rc, out = run(["nvidia-smi", f"--query-gpu={field}", "--format=csv,noheader"])
    if rc != 0 or not out:
        return None
    return out.splitlines()[0].strip() or None


def train_pids() -> list[int] | None:
    """pids whose command line names train_pretrain.py. A count, never a kill list."""
    rc, out = run(["pgrep", "-f", TRAIN_NAME])
    if rc not in (0, 1):
        return None
    pids = []
    for ln in out.splitlines():
        try:
            pids.append(int(ln.strip()))
        except ValueError:
            continue
    return pids


def read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def lease() -> dict | None:
    """ACTIVE_GPU_JOB.json: kind, pid, detail (yaml), started_utc."""
    data = read_json(LEASE_PATH)
    if data is None:
        return None
    pid = data.get("pid")
    try:
        pid = int(pid) if pid is not None else None
    except (TypeError, ValueError):
        pid = None
    detail = data.get("detail") or data.get("yaml") or data.get("config")
    return {
        "kind": data.get("kind") if isinstance(data.get("kind"), str) else None,
        "pid": pid,
        "yaml": str(detail) if detail else None,
        "startedUtc": data.get("started_utc") if isinstance(data.get("started_utc"), str) else None,
    }


def latest_json() -> Path | None:
    if not CKPT_ROOT.is_dir():
        return None
    found = [p for p in CKPT_ROOT.rglob("latest.json") if p.is_file()]
    if not found:
        return None
    return max(found, key=lambda p: p.stat().st_mtime)


def _num(data: dict, *keys: str) -> float | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _bool(data: dict, key: str) -> bool | None:
    value = data.get(key)
    return value if isinstance(value, bool) else None


def durable(path: Path | None) -> dict | None:
    """latest.json fields that matter. tokens_per_sec is deliberately not read."""
    if path is None:
        return None
    data = read_json(path)
    if data is None:
        return None
    try:
        saved_at = iso(path.stat().st_mtime)
    except OSError:
        saved_at = None
    return {
        "step": _num(data, "step"),
        "tokensSeen": _num(data, "tokens_seen", "tokens", "n_tokens"),
        "tokPerParam": _num(data, "tokens_per_param", "t_per_param"),
        "targetTokens": _num(data, "target_tokens"),
        "targetTokPerParam": _num(data, "target_tokens_per_param"),
        "tokensPerStep": _num(data, "tokens_per_step"),
        "paramCount": _num(data, "param_count", "n_params", "params", "parameter_count"),
        "trainLoss": _num(data, "train_loss"),
        "valLoss": _num(data, "val_loss"),
        "jobComplete": _bool(data, "job_complete"),
        "undertrainedFlag": _bool(data, "undertrained_flag"),
        "runName": data.get("run_name") if isinstance(data.get("run_name"), str) else None,
        "savedAt": saved_at,
    }


def tok_per_param(dur: dict | None) -> float | None:
    if not dur:
        return None
    if dur.get("tokPerParam") is not None:
        return dur["tokPerParam"]
    tokens, params = dur.get("tokensSeen"), dur.get("paramCount")
    if tokens is None or not params:
        return None
    return tokens / params


def newest_log() -> Path | None:
    if not LOG_DIR.is_dir():
        return None
    found = [p for p in LOG_DIR.glob("*.log") if p.is_file()]
    if not found:
        return None
    return max(found, key=lambda p: p.stat().st_mtime)


def read_tail(path: Path, max_bytes: int = LOG_TAIL_BYTES) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def live(path: Path | None) -> tuple[dict | None, str | None]:
    """Last [step] line plus the last-8 rate, and a clean tail for the Job log pack."""
    if path is None:
        return None, None
    text = read_tail(path)
    rows = parse_step_lines(text)
    clean = [ln for ln in text.replace("\r", "\n").splitlines() if ln.strip()]
    tail = "\n".join(clean[-LOG_TAIL_LINES:]) if clean else None
    if not rows:
        return None, tail
    last = rows[-1]
    try:
        log_as_of = iso(path.stat().st_mtime)
    except OSError:
        log_as_of = None
    return {
        "step": last["step"],
        "tokensSeen": last["tokens"],
        "trainLoss": last["loss"],
        "tokPerParam": last["tpp"],
        "elapsedS": last["elapsed"],
        "last8TokS": last8_rate(rows),
        "logAsOf": log_as_of,
    }, tail


def derived(live_row: dict | None, dur: dict | None) -> dict:
    """The widget formulas, published so the desk only formats.

    tpp = tokens_seen / param_count; remain = target − live tokens; pct = 100 × tokens / target;
    hours_to_floor = remain / last-8 / 3600; s/it = tokens_per_step / last-8. None when an input is missing.
    Never from the sidecar whole-run rate. job_complete / undertrained_flag are not touched here.
    """
    live_row = live_row or {}
    dur = dur or {}
    tokens = live_row.get("tokensSeen") if live_row.get("tokensSeen") is not None else dur.get("tokensSeen")
    params = dur.get("paramCount")
    target = dur.get("targetTokens")
    rate = live_row.get("last8TokS")
    tpp = live_row.get("tokPerParam")
    if tpp is None and tokens is not None and params:
        tpp = tokens / params
    if tpp is None:
        tpp = dur.get("tokPerParam")
    remain = max(0.0, target - tokens) if tokens is not None and target is not None else None
    pct = min(100.0, 100.0 * tokens / target) if tokens is not None and target else None
    hours = remain / rate / 3600.0 if remain is not None and rate else None
    sec_per_it = dur["tokensPerStep"] / rate if dur.get("tokensPerStep") is not None and rate else None
    ahead = live_row["step"] - dur["step"] if live_row.get("step") is not None and dur.get("step") is not None else None
    return {
        "tokPerParam": tpp,
        "targetTokPerParam": dur.get("targetTokPerParam"),
        "pct": pct,
        "remainTokens": remain,
        "hoursToFloor": hours,
        "secPerIt": sec_per_it,
        "stepsAhead": ahead,
    }


def unit_active(unit: str) -> bool | None:
    rc, out = run(["systemctl", "--user", "is-active", unit])
    if rc == 0 and out == "active":
        return True
    if out in ("inactive", "failed", "dead", "activating", "deactivating"):
        return out == "activating"
    return None


def probe_unit() -> str | None:
    active = unit_active(PROBE_UNIT)
    if active is None:
        return None
    return "active" if active else "inactive"


def job_flags(nproc: int | None, probe: str | None, parked: bool | None, gpu: float | None,
              dur: dict | None, prev: dict | None, now_s: float) -> tuple[list[str], dict]:
    """The four abort signals plus the small state they need across runs.

    State rides in the feed itself (`state`), so a failed run keeps the last good one.
    """
    flags: list[str] = []
    state: dict = {}
    if nproc is not None and nproc >= 2:
        flags.append("two-trainers")
    if probe == "active" and parked is False:
        flags.append("qwen-up-during-train")
    prev_state = (prev or {}).get("state") or {}
    if gpu is not None and gpu <= 0 and nproc:
        since = prev_state.get("gpuIdleSince")
        since = since if isinstance(since, (int, float)) else now_s
        state["gpuIdleSince"] = since
        if now_s - since >= GPU_IDLE_S:
            flags.append("gpu-idle")
    prev_step = ((prev or {}).get("job") or {}).get("durable", {}).get("step") if prev else None
    cur_step = (dur or {}).get("step")
    if isinstance(prev_step, (int, float)) and isinstance(cur_step, (int, float)) and cur_step < prev_step:
        flags.append("step-backwards")
    return flags, state


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


def collect(prev: dict | None = None, now_s: float | None = None) -> dict:
    now_s = now_s if now_s is not None else datetime.now(timezone.utc).timestamp()
    errors: list[str] = []
    # 4. Box
    gpu = nvidia_smi("utilization.gpu")
    watts = nvidia_smi("power.draw")
    gpu_name = nvidia_smi_text("name")
    if gpu is None or watts is None:
        errors.append("nvidia-smi")
    # 1. Identity
    pids = train_pids()
    nproc = None if pids is None else len(pids)
    if nproc is None:
        errors.append("pgrep")
        one = None
    else:
        one = nproc == 1
        if nproc >= 2:
            errors.append("two-trainers")
    owner = lease()
    if owner is None:
        errors.append("no-lease")
    else:
        owner["pidMatch"] = (owner["pid"] in pids) if (pids is not None and owner["pid"] is not None) else None
    unit = probe_unit()
    parked = qwen_parked()
    if unit == "active" and parked is False:
        errors.append("qwen-up-during-train")
    fence = [{"unit": u.removesuffix(".service"), "active": unit_active(u)} for u in FENCE_UNITS]
    # 3. Durable
    latest = latest_json()
    if latest is None:
        errors.append("no-latest-json")
    dur = durable(latest)
    tpp = tok_per_param(dur)
    # 2. Live
    log = newest_log()
    live_row, tail = live(log)
    if live_row is None:
        errors.append("no-live-log")
    models = gateway_models()
    if models is None:
        errors.append("infer-down-or-unready")
    flags, state = job_flags(nproc, unit, parked, gpu, dur, prev, now_s)
    return {
        "schema": SCHEMA,
        "asOf": utcnow(),
        "host": socket.gethostname(),
        "gpuUtilPercent": gpu,
        "powerWatts": watts,
        "oneWriter": one,
        "trainNameMatchCount": nproc,
        "tokPerParam": tpp,
        # Whole-run tok/s is not a score. The desk reads job.live.last8TokS.
        "last8Toks": None,
        "latestJson": str(latest) if latest else None,
        "exclusiveSidecar": {"probeUnit": unit, "qwenParked": parked},
        "models": models,
        "job": {
            "lease": owner,
            "live": live_row,
            "durable": dur,
            "derived": derived(live_row, dur),
            "fence": fence,
            "flags": flags,
            "gpuName": gpu_name,
        },
        "jobLogTail": tail,
        "state": state,
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
    prev = read_json(FEED_PATH)
    if prev is not None and not valid_doc(prev):
        prev = None
    try:
        doc = collect(prev)
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

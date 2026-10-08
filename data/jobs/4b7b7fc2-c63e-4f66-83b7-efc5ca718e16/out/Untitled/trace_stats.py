"""Per-node latency from a run's JSONL trace — the designer-side aggregator.

The generated runtime brackets every node execution in a `node_span` record
(runtime/trace.py):

    {"kind": "node_span", "node": "Research", "node_kind": "agent", "span": "s7",
     "parent": "s3", "total_ms": 6820.4, "self_ms": 120.7,
     "llm_ms": 6510.2, "tool_ms": 180.9}

`total_ms` is INCLUSIVE (the node plus everything it ran); `self_ms` excludes child
spans. That distinction is the whole point: a While/For-Each/pool/orchestrator node
is "slow" only because its children are, and you want to optimize the child.

This module is plain stdlib and imports nothing from the runtime fragments (which
aren't importable standalone), so the canvas overlay and the Run History tab can
both use it on any `traces/*.jsonl` file.
"""

from __future__ import annotations

import json
import os


def read_spans(path: str) -> list:
    """The `node_span` records of one trace file (empty list if unreadable)."""
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or '"node_span"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                # Python traces key the event as "kind", the TS backend as "t".
                if rec.get("kind") == "node_span" or rec.get("t") == "node_span":
                    out.append(rec)
    except OSError:
        return []
    return out


def node_stats(spans: list) -> dict:
    """{node: {calls, total_ms, self_ms, llm_ms, tool_ms, max_ms, kind}} — mirrors the
    runtime's node_span_stats so the designer and the eval grader agree on the numbers."""
    out = {}
    for s in spans or []:
        e = out.setdefault(str(s.get("node", "?")), {
            "calls": 0, "total_ms": 0.0, "self_ms": 0.0,
            "llm_ms": 0.0, "tool_ms": 0.0, "max_ms": 0.0,
            "kind": s.get("node_kind", "")})
        t = float(s.get("total_ms", 0) or 0)
        e["calls"] += 1
        e["total_ms"] = round(e["total_ms"] + t, 1)
        e["self_ms"] = round(e["self_ms"] + float(s.get("self_ms", 0) or 0), 1)
        e["llm_ms"] = round(e["llm_ms"] + float(s.get("llm_ms", 0) or 0), 1)
        e["tool_ms"] = round(e["tool_ms"] + float(s.get("tool_ms", 0) or 0), 1)
        e["max_ms"] = round(max(e["max_ms"], t), 1)
    return out


def run_stats(path: str) -> dict:
    """Everything the latency views need for one trace file:
    {nodes: {...}, wall_ms, slowest, hot: {node: 0..1}}.

    `wall_ms` is the run's wall clock (first→last record). `hot` normalizes each
    node's SELF time to 0..1 for heat colouring — self time, not total, so a
    container doesn't glow merely for containing slow children."""
    spans = read_spans(path)
    nodes = node_stats(spans)
    wall = 0.0
    try:
        with open(path, encoding="utf-8") as f:
            ts = [json.loads(l).get("ts") for l in f if l.strip()]
        ts = [t for t in ts if isinstance(t, (int, float))]
        if len(ts) >= 2:
            wall = round((max(ts) - min(ts)) * 1000.0, 1)
    except (OSError, ValueError):
        pass
    peak = max((v["self_ms"] for v in nodes.values()), default=0.0)
    hot = {k: (round(v["self_ms"] / peak, 3) if peak > 0 else 0.0)
           for k, v in nodes.items()}
    slowest = max(nodes.items(), key=lambda kv: kv[1]["self_ms"])[0] if nodes else ""
    return {"nodes": nodes, "wall_ms": wall, "slowest": slowest, "hot": hot}


def latest_trace(traces_dir: str) -> str:
    """Newest *.jsonl in `traces_dir`, or "" — the run the latency overlay defaults to."""
    try:
        files = [os.path.join(traces_dir, f) for f in os.listdir(traces_dir)
                 if f.endswith(".jsonl")]
    except OSError:
        return ""
    if not files:
        return ""
    return max(files, key=lambda p: os.path.getmtime(p))


def fmt_ms(ms: float) -> str:
    """Compact duration for a node badge: 780ms / 6.8s / 1m03s."""
    try:
        ms = float(ms)
    except (TypeError, ValueError):
        return ""
    if ms < 1000:
        return "%dms" % int(round(ms))
    if ms < 60000:
        return "%.1fs" % (ms / 1000.0)
    m, s = divmod(int(round(ms / 1000.0)), 60)
    return "%dm%02ds" % (m, s)


# ── fleet aggregation: many runs -> operational rates ────────────────────────
# The per-run views above answer "why was THIS run slow". They cannot answer "how
# often do runs fail", which is what you need once agents actually serve traffic.
# Every rate below is derived from events the runtime ALREADY writes — no new
# instrumentation, no LLM call, no extra dependency. Point it at a traces/ directory
# (or several, one per service in a fleet) and it reads them.

_TERMINAL_PREFIXES = ("[budget]", "[blocked", "[denied]", "[error]", "[interrupt]")


def _events(path: str):
    """Every record of one trace file, tolerating truncated/partial lines.

    A trace being written while we read it is normal, so a bad final line is skipped
    rather than losing the whole file."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except OSError:
        return


def _kind(rec: dict) -> str:
    """Python traces key the event as `kind`, the TypeScript backend as `t`."""
    return str(rec.get("kind") or rec.get("t") or "")


def _pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def _quantile(xs: list, q: float) -> float:
    """Nearest-rank percentile — no numpy, and exact for the small N in play."""
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return round(s[i], 1)


def fleet_stats(traces_dir, since_hours: float = 0) -> dict:
    """Aggregate every trace in `traces_dir` into operational rates.

    `traces_dir` may be one path or a list of them (one per service in a fleet).
    `since_hours` > 0 keeps only files modified within that window.

    Returns {files, runs, rates, counts, latency_ms, tokens}: `rates` are percentages
    of runs, `counts` are raw event totals.

    On the hallucination line: `fabricated_citation` counts runs where cite_check
    found a source the answer cited but retrieval never served. That is a genuine
    ONLINE signal — deterministic and already recorded — but it is a PROXY, not
    faithfulness: it catches invented sources, not wrong statements attached to real
    ones. RAGAS faithfulness runs only inside an eval, never on live traffic.
    """
    dirs = [traces_dir] if isinstance(traces_dir, str) else list(traces_dir or [])
    paths = []
    for d in dirs:
        try:
            paths += [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".jsonl")]
        except OSError:
            continue
    if since_hours and since_hours > 0:
        import time as _t
        cut = _t.time() - since_hours * 3600.0
        paths = [p for p in paths if os.path.getmtime(p) >= cut]

    runs = finished = errored = suspended = stopped_early = 0
    counts = {}
    walls, tok_in, tok_out, tok_cached = [], 0, 0, 0
    for p in sorted(paths):
        saw_start = saw_end = False
        ts = []
        for rec in _events(p):
            k = _kind(rec)
            counts[k] = counts.get(k, 0) + 1
            if isinstance(rec.get("ts"), (int, float)):
                ts.append(rec["ts"])
            if k == "run_start":
                saw_start = True
            elif k == "run_error":
                errored += 1
            elif k == "run_suspended":
                suspended += 1
            elif k == "run_end":
                saw_end = True
                res = str(rec.get("result") or "").lstrip().lower()
                if res.startswith(_TERMINAL_PREFIXES):
                    stopped_early += 1
                u = rec.get("usage") or {}
                # run_end's usage is {agent: {...}} on graph runs and flat on some
                # paths — sum whichever shape shows up rather than assuming one.
                _vals = list(u.values()) if u and isinstance(
                    next(iter(u.values()), None), dict) else [u]
                for _v in _vals:
                    tok_in += int((_v or {}).get("input_tokens", 0) or 0)
                    tok_out += int((_v or {}).get("output_tokens", 0) or 0)
                    tok_cached += int((_v or {}).get("cached_tokens", 0) or 0)
            elif k == "tool_result":
                if str(rec.get("result") or "").lstrip().startswith("[ERROR]"):
                    counts["tool_error"] = counts.get("tool_error", 0) + 1
            elif k == "guardrail" and rec.get("action") == "block":
                counts["guardrail_block"] = counts.get("guardrail_block", 0) + 1
        if not (saw_start or saw_end):
            continue                        # not a run trace
        runs += 1
        finished += 1 if saw_end else 0
        if len(ts) >= 2:
            walls.append((max(ts) - min(ts)) * 1000.0)

    def c(*names):
        return sum(counts.get(n, 0) for n in names)

    tool_calls = c("tool_call")
    return {
        "files": len(paths),
        "runs": runs,
        "rates": {
            # A run that never wrote run_end neither finished nor errored — it was
            # KILLED. That silent bucket is usually the interesting one.
            "finished": _pct(finished, runs),
            "errored": _pct(errored, runs),
            "suspended": _pct(suspended, runs),
            "stopped_early": _pct(stopped_early, runs),
            "incomplete": _pct(max(0, runs - finished - errored), runs),
            "with_tool_error": _pct(c("tool_error"), runs),
            "with_retry": _pct(c("retry"), runs),
            "with_failover": _pct(c("failover"), runs),
            "with_guardrail_block": _pct(c("guardrail_block"), runs),
            "with_hitl": _pct(c("hitl", "hitl_review"), runs),
            "with_remote_error": _pct(c("remote_error"), runs),
            "with_empty_retrieval": _pct(c("empty_retry"), runs),
            "fabricated_citation": _pct(c("cite_check"), runs),
            "groundedness_fail": _pct(c("groundedness"), runs),
            "tool_error_of_calls": _pct(c("tool_error"), tool_calls),
            "duplicate_of_calls": _pct(c("tool_duplicate"), tool_calls),
            "cache_hit_of_calls": _pct(c("tool_cache_hit"), tool_calls),
        },
        "counts": {k: counts[k] for k in sorted(counts)},
        "latency_ms": {"p50": _quantile(walls, 0.50),
                       "p95": _quantile(walls, 0.95),
                       "max": round(max(walls), 1) if walls else 0.0},
        # cache_hit_pct is a TREND signal, not an exact rate: a provider that
        # reports nothing reads the same as a provider that cached nothing.
        # Zero across repeated similar runs is the finding worth chasing.
        "tokens": {"in": tok_in, "out": tok_out, "cached": tok_cached,
                   "cache_hit_pct": _pct(tok_cached, tok_in)},
    }


def format_fleet(st: dict) -> str:
    """The same numbers as a readable block (what the CLI prints)."""
    pct = "%"
    L = ["runs: %d   (from %d trace file(s))" % (st["runs"], st["files"]),
         "latency: p50 %s   p95 %s   max %s" % (fmt_ms(st["latency_ms"]["p50"]),
                                                fmt_ms(st["latency_ms"]["p95"]),
                                                fmt_ms(st["latency_ms"]["max"])),
         "tokens:  %d in / %d out   (%d cached, %.1f%% of input)"
         % (st["tokens"]["in"], st["tokens"]["out"],
            st["tokens"].get("cached", 0),
            st["tokens"].get("cache_hit_pct", 0.0)),
         "",
         "rates (" + pct + " of runs, except the *_of_calls lines)"]
    for k, v in st["rates"].items():
        L.append("  %-24s %6.1f%s" % (k, v, pct))
    L.append("")
    L.append("top events")
    for k, n in sorted(st["counts"].items(), key=lambda kv: -kv[1])[:12]:
        L.append("  %-24s %6d" % (k, n))
    return "\n".join(L)


if __name__ == "__main__":                  # CLI: usable without the designer
    import argparse
    _ap = argparse.ArgumentParser(
        description="Aggregate agent trace files into operational rates.")
    _ap.add_argument("traces", nargs="*", default=["traces"],
                     help="one or more traces/ directories (default: ./traces)")
    _ap.add_argument("--since", type=float, default=0, metavar="HOURS",
                     help="only traces modified in the last N hours")
    _ap.add_argument("--json", action="store_true", help="machine-readable output")
    _a = _ap.parse_args()
    _st = fleet_stats(_a.traces or ["traces"], since_hours=_a.since)
    print(json.dumps(_st, indent=2) if _a.json else format_fleet(_st))

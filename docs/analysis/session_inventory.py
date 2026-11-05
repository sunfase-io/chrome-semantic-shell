#!/usr/bin/env python3
"""Record session identities/watermarks; compare new and appended sessions without exporting content.

OpenCode keeps V2 sessions in session_v2/session_message; sessions that were never migrated remain only in the
legacy session/part tables. Both stores are inventoried. Each baseline records an analysis cutoff per source, so a
review of one source never marks the other source as analyzed.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

SOURCES = ("opencode", "codex")


@contextmanager
def readonly(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        yield db
    finally:
        db.close()


def file_digest(path, count=None):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        remaining = path.stat().st_size if count is None else count
        while remaining:
            part = stream.read(min(1024 * 1024, remaining))
            if not part:
                break
            digest.update(part)
            remaining -= len(part)
    return digest.hexdigest()


def summarize(rows):
    # Hash the stored representation, never return conversation text.
    digest = hashlib.sha256()
    count = high = created = 0
    for row_id, changed, born, body in rows:
        digest.update(json.dumps([row_id, changed, body], ensure_ascii=False).encode())
        count += 1
        high = max(high, changed or 0)
        created = max(created, born or 0)
    return {"part_count": count, "part_updated_watermark_ms": high, "message_created_watermark_ms": created,
            "fingerprint": digest.hexdigest()}


def opencode_sessions(db):
    sessions = {}
    v2 = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")} >= {"session_v2", "session_message"}
    if v2:
        for sid, created, updated in db.execute("SELECT id, time_created, time_updated FROM session_v2"):
            rows = db.execute("SELECT id, time_updated, time_created, data FROM session_message WHERE session_id=? ORDER BY seq",
                              (sid,))
            sessions[sid] = {"source": "opencode", "store": "v2", "id": sid, "created_ms": created, "updated_ms": updated,
                             **summarize(rows)}
    for sid, created, updated in db.execute("SELECT id, time_created, time_updated FROM session"):
        if sid in sessions:
            continue
        rows = db.execute("SELECT id, time_updated, time_created, data FROM part WHERE session_id=? ORDER BY id", (sid,))
        sessions[sid] = {"source": "opencode", "store": "legacy", "id": sid, "created_ms": created, "updated_ms": updated,
                         **summarize(rows)}
    return sessions


def inventory(home):
    sessions = {}
    with readonly(home / ".codex/state_5.sqlite") as db:
        for sid, filename in db.execute("SELECT id, rollout_path FROM threads"):
            path = Path(filename)
            if not path.is_file():
                sessions[f"codex:{sid}"] = {"source": "codex", "id": sid, "path": str(path), "missing": True}
                continue
            sessions[f"codex:{sid}"] = {"source": "codex", "id": sid, "path": str(path),
                                      "bytes": path.stat().st_size, "fingerprint": file_digest(path)}
    with readonly(home / ".local/share/opencode/opencode.db") as db:
        sessions.update({f"opencode:{sid}": entry for sid, entry in opencode_sessions(db).items()})
    return sessions


def differences(before, after):
    result = {"new": [], "changed": [], "missing": [], "unchanged": 0}
    for key, entry in after.items():
        old = before.get(key)
        if old is None:
            result["new"].append({"key": key, "id": entry["id"]})
            continue
        if entry["source"] == "opencode" and old.get("store", "legacy") != entry.get("store", "legacy"):
            # A store migration rewrites rows, so fingerprints are not comparable; new messages still are.
            if entry.get("message_created_watermark_ms", 0) > old.get("part_updated_watermark_ms", 0):
                result["changed"].append({"key": key, "id": entry["id"], "store_migrated": True,
                                          "messages_created_after_ms": old.get("part_updated_watermark_ms", 0)})
            else:
                result["unchanged"] += 1
            continue
        if entry.get("fingerprint") == old.get("fingerprint"):
            result["unchanged"] += 1
            continue
        change = {"key": key, "id": entry["id"]}
        if entry["source"] == "codex" and not entry.get("missing") and old.get("bytes") is not None:
            size = old["bytes"]
            if entry["bytes"] >= size and file_digest(Path(entry["path"]), size) == old["fingerprint"]:
                with Path(entry['path']).open('rb') as stream:
                    stream.seek(max(0, size-1024*1024))
                    tail = stream.read(min(size, 1024*1024))
                end = tail.rfind(b'\n')
                change["append_from_byte"] = max(0, size-len(tail))+end+1 if end >= 0 else 0
            else:
                change["rescan_required"] = True
        elif entry["source"] == "opencode":
            change["parts_updated_after_ms"] = old.get("part_updated_watermark_ms", 0)
            change["watermark_inclusive"] = True
            change["include_updated_existing_parts"] = True
        result["changed"].append(change)
    result["missing"] = sorted(set(before) - set(after))
    return result


def coverage(baseline):
    """Per-source analysis cutoff in epoch ms; schema 1 baselines covered both sources with one cutoff."""
    if "coverage" in baseline:
        return {source: datetime.fromisoformat(item["analysis_cutoff_utc"]).timestamp() * 1000
                for source, item in baseline["coverage"].items()}
    cutoff = datetime.fromisoformat(baseline["analysis_cutoff_utc"]).timestamp() * 1000
    return {source: cutoff for source in SOURCES}


def tool_inputs(store, body):
    data = json.loads(body)
    if store == "legacy":
        if data.get("type") == "tool":
            yield data.get("tool"), json.dumps(data.get("state", {}).get("input"), ensure_ascii=False)
        return
    for item in data.get("content", []):
        if isinstance(item, dict) and item.get("type") == "tool":
            yield item.get("name"), json.dumps(item.get("state", {}).get("input"), ensure_ascii=False)


def pending(home, baseline, keywords, exclude):
    """List OpenCode sessions with tool calls mentioning a keyword after the opencode analysis cutoff."""
    cutoff = coverage(baseline)["opencode"]
    skip = set(baseline.get("excluded_session_ids", [])) | set(exclude)
    found = []
    with readonly(home / ".local/share/opencode/opencode.db") as db:
        meta = {sid: (title, directory, parent, "v2") for sid, title, directory, parent in
                db.execute("SELECT id, title, directory, parent_id FROM session_v2")}
        for sid, title, directory, parent in db.execute("SELECT id, title, directory, parent_id FROM session"):
            meta.setdefault(sid, (title, directory, parent, "legacy"))
        hits = {}
        queries = (("v2", "SELECT session_id, data FROM session_message WHERE type='assistant' AND time_created > ? AND ("
                    + " OR ".join("instr(data, ?) > 0" for _ in keywords) + ")"),
                   ("legacy", "SELECT session_id, data FROM part WHERE time_created > ? AND session_id NOT IN "
                    "(SELECT id FROM session_v2) AND (" + " OR ".join("instr(data, ?) > 0" for _ in keywords) + ")"))
        for store, sql in queries:
            for sid, body in db.execute(sql, (cutoff, *keywords)):
                if sid in skip:
                    continue
                counts = hits.setdefault(sid, {"tool_calls": 0, "skill_loads": 0})
                for name, text in tool_inputs(store, body):
                    if any(keyword in text for keyword in keywords):
                        counts["skill_loads" if name == "skill" else "tool_calls"] += 1
        for sid, counts in hits.items():
            if not any(counts.values()):
                continue
            title, directory, parent, store = meta.get(sid, (None, None, None, None))
            found.append({"id": sid, "title": title, "directory": directory, "child": bool(parent), "store": store,
                          **counts})
    return sorted(found, key=lambda item: item["id"], reverse=True)


def capture(args, current):
    if args.baseline.exists():
        raise ValueError("Baseline already exists; use a new dated path to preserve review history")
    summary = json.loads(args.analysis_summary.read_text(encoding="utf-8")) if args.analysis_summary else {}
    previous = json.loads(args.previous.read_text(encoding="utf-8")) if args.previous else None
    carried = set(args.carry_sources)
    if carried and not previous:
        raise ValueError("--carry-sources requires --previous")
    if carried - set(SOURCES):
        raise ValueError(f"unknown source in --carry-sources: {sorted(carried - set(SOURCES))}")
    analyzed = [s for s in SOURCES if s not in carried]
    cutoff = summary.get("generated_utc")
    if analyzed and not cutoff:
        raise ValueError("analysis summary must provide generated_utc for analyzed sources")
    covered = {source: {"analysis_cutoff_utc": cutoff} for source in analyzed}
    if previous:
        old = coverage(previous)
        for source in carried:
            covered[source] = {"analysis_cutoff_utc": datetime.fromtimestamp(old[source] / 1000, timezone.utc).isoformat(),
                               "carried_from": args.previous.name}
    sessions = {key: entry for key, entry in current.items() if entry["source"] not in carried}
    if previous:
        sessions.update({key: entry for key, entry in previous["sessions"].items() if entry["source"] in carried})
    # Preserve the analyzed Codex byte/hash watermarks, even if an existing session grew between analysis and capture.
    originals = {s["filename"]: s for s in summary.get("codex_snapshots", [])}
    for entry in sessions.values():
        if entry["source"] == "codex" and "codex" not in carried and Path(entry["path"]).name in originals:
            old = originals[Path(entry["path"]).name]
            entry.update(bytes=old["bytes"], fingerprint=old["sha256"])
    ids = list(previous.get("analyzed_usage_session_ids", [])) if previous else []
    ids += [s["session_id"] for s in summary.get("all_using_sessions", []) if s["session_id"] not in ids]
    excluded = list(previous.get("excluded_session_ids", [])) if previous else []
    excluded += [sid for sid in summary.get("excluded_session_ids", []) if sid not in excluded]
    record = {"schema_version": 2, "captured_utc": datetime.now(timezone.utc).isoformat(), "coverage": covered,
              "analysis_summary": args.analysis_summary.name if args.analysis_summary else None,
              "analyzed_usage_session_ids": ids, "excluded_session_ids": excluded,
              "exclusion_reason": "current browser automation implementation/research session family",
              "sessions": sessions}
    args.baseline.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"baseline": str(args.baseline), "sessions": len(sessions), "coverage": covered,
                      "analyzed_usage_sessions": len(ids)}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["capture", "diff", "pending"])
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--analysis-summary", type=Path)
    parser.add_argument("--previous", type=Path, help="earlier baseline whose carried sources are preserved")
    parser.add_argument("--carry-sources", nargs="*", default=[], help="sources not analyzed in this review")
    parser.add_argument("--keyword", action="append", help="pending: tool-input keyword (default chrome-shell)")
    parser.add_argument("--exclude", action="append", default=[], help="pending: session id to skip (e.g. current)")
    args = parser.parse_args()
    if args.mode == "capture":
        capture(args, inventory(args.home))
        return
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    if args.mode == "pending":
        print(json.dumps(pending(args.home, baseline, args.keyword or ["chrome-shell"], args.exclude),
                         ensure_ascii=False, indent=2))
        return
    current = inventory(args.home)
    result = differences(baseline["sessions"], current)
    result["excluded_session_ids"] = baseline.get("excluded_session_ids", [])
    result["coverage"] = baseline.get("coverage")
    cutoff_ms = coverage(baseline)["opencode"]
    result["opencode_changed_since_analysis_cutoff"] = [
        e["id"] for e in current.values() if e["source"] == "opencode"
        and max(e.get("part_updated_watermark_ms", 0), e.get("message_created_watermark_ms", 0)) > cutoff_ms
    ]
    result["opencode_created_since_analysis_cutoff"] = [
        e["id"] for e in current.values() if e["source"] == "opencode" and e["created_ms"] > cutoff_ms
    ]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

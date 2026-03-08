#!/usr/bin/env python3
"""
Apply approved architect items.
Reads JSON from stdin: { entity_type, entity_id, proposal_id, proposal_path, items: [...] }
Prints results JSON to stdout.

Each item may include:
  id            — stable UUID from proposal.json (required for history tracking)
  status        — accepted | rejected | ignored (default: accepted if kind=ticket/subproject/modify/close)
  rejection_reason — optional, stored in proposal_items
"""

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
PM_PATH   = REPO_ROOT / "infra" / "ProjectManagement"

sys.path.insert(0, str(PM_PATH))
import db as pm_db
pm_db.init_db()

def _now():
    return datetime.now(timezone.utc).isoformat()

def _root_project(entity_type, entity_id):
    import sqlite3
    conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
    conn.row_factory = sqlite3.Row
    if entity_type == "project":
        row = conn.execute(
            "SELECT name FROM projects WHERE name = ? AND is_default = 0 AND parent_id IS NULL",
            (entity_id,),
        ).fetchone()
        conn.close()
        return row["name"] if row else entity_id
    # subproject or ticket — walk up to root
    pid = int(entity_id)
    if entity_type == "ticket":
        t = conn.execute("SELECT project_id FROM tickets WHERE id = ?", (pid,)).fetchone()
        pid = t["project_id"] if t else pid
    while True:
        p = conn.execute(
            "SELECT id, name, parent_id, is_default FROM projects WHERE id = ?", (pid,)
        ).fetchone()
        if not p:
            break
        if p["parent_id"] is None and not p["is_default"]:
            conn.close()
            return p["name"]
        pid = p["parent_id"]
    conn.close()
    return str(entity_id)

def _sp_name(entity_type, entity_id):
    """Return the sub-project name if entity is a subproject, else None."""
    if entity_type != "subproject":
        return None
    import sqlite3
    conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
    conn.row_factory = sqlite3.Row
    p = conn.execute("SELECT name FROM projects WHERE id = ?", (int(entity_id),)).fetchone()
    conn.close()
    return p["name"] if p else None


def _archive_proposal(proposal_path: Path, proposal_id: str, entity_type: str,
                       entity_id: str, mode: str, generated_at: str, archive_reason: str):
    """Copy proposal.json to proposals/TIMESTAMP.json and record in DB."""
    proposals_dir = proposal_path.parent / "proposals"
    proposals_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    archive_file = proposals_dir / f"{ts}-{archive_reason}.json"
    shutil.copy2(proposal_path, archive_file)
    pm_db.archive_proposal(
        id=proposal_id,
        entity_type=entity_type,
        entity_id=str(entity_id),
        mode=mode,
        generated_at=generated_at,
        archive_reason=archive_reason,
        file_path=str(archive_file),
    )
    return archive_file


def run(payload):
    entity_type   = payload["entity_type"]
    entity_id     = payload["entity_id"]
    items         = payload["items"]
    proposal_id   = payload.get("proposal_id", "")
    proposal_path = Path(payload["proposal_path"]) if payload.get("proposal_path") else None
    generated_at  = payload.get("generated_at", _now())
    mode          = payload.get("mode", "architect")

    root_project = _root_project(entity_type, entity_id)
    default_sp   = _sp_name(entity_type, entity_id)

    created   = []
    modified  = []
    closed    = []
    errors    = []

    # title → ticket_id for block resolution
    title_to_id = {}

    # item_id → ticket_id for proposal_items index
    item_ticket_map = {}

    # Build set of existing ticket titles under this entity for dedup
    existing_titles = {t["title"].strip().lower() for t in pm_db.list_tickets(root_project)}

    # Pass 1: sub-projects
    for item in items:
        if item["kind"] != "subproject":
            continue
        if item.get("status") == "rejected":
            continue
        try:
            pm_db.create_sub_project(root_project, item["name"], item.get("description", ""))
            created.append({"kind": "subproject", "name": item["name"]})
        except Exception as e:
            errors.append({"kind": "subproject", "name": item["name"], "error": str(e)})

    # Pass 2: tickets
    for item in items:
        if item["kind"] != "ticket":
            continue
        if item.get("status") in ("rejected", "ignored"):
            continue
        if item["title"].strip().lower() in existing_titles:
            errors.append({"kind": "ticket", "title": item["title"], "error": f"Ticket '{item['title']}' already exists — skipped"})
            continue
        sp = item.get("sub_project") or default_sp
        try:
            t = pm_db.create_ticket(
                project_name=root_project,
                title=item["title"],
                description=item.get("description", ""),
                sub_project_name=sp,
                priority=item.get("priority", "medium"),
            )
            tid = t["id"]
            title_to_id[item["title"]] = tid
            if item.get("id"):
                item_ticket_map[item["id"]] = tid
            created.append({"kind": "ticket", "id": tid, "title": item["title"]})
            existing_titles.add(item["title"].strip().lower())

            # Write per-ticket plan.md if provided
            plan_md = item.get("plan_md", "")
            if plan_md:
                import re
                import sqlite3
                slug = re.sub(r"[^a-z0-9-]", "", item["title"].lower().replace(" ", "-"))[:40]
                conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
                conn.row_factory = sqlite3.Row
                ticket_row = conn.execute(
                    "SELECT project_id FROM tickets WHERE id = ?", (tid,)
                ).fetchone()
                parts = []
                pid = ticket_row["project_id"] if ticket_row else None
                while pid:
                    p = conn.execute(
                        "SELECT name, parent_id, is_default FROM projects WHERE id = ?", (pid,)
                    ).fetchone()
                    if not p: break
                    if not p["is_default"]:
                        parts.insert(0, p["name"])
                    pid = p["parent_id"]
                conn.close()
                cfg_conn = sqlite3.connect(str(PM_PATH / "data" / "pm.db"))
                cfg = cfg_conn.execute(
                    "SELECT value FROM scryer_config WHERE key = 'scryer_root'"
                ).fetchone()
                cfg_conn.close()
                if cfg and cfg[0] and parts:
                    plan_path_ticket = Path(cfg[0]).expanduser().joinpath(*parts) / f"T{tid}-{slug}" / "plan.md"
                    plan_path_ticket.parent.mkdir(parents=True, exist_ok=True)
                    plan_path_ticket.write_text(plan_md)

        except Exception as e:
            errors.append({"kind": "ticket", "title": item["title"], "error": str(e)})

    # Pass 3: modify (re-architect)
    for item in items:
        if item["kind"] != "modify":
            continue
        if item.get("status") in ("rejected", "ignored"):
            continue
        try:
            kwargs = {k: v for k, v in item.items()
                      if k not in ("kind", "id", "status", "rejection_reason", "human_feedback", "revisions")}
            pm_db.update_ticket(item["id"], actor="agent", **kwargs)
            if item.get("id"):
                item_ticket_map[item["id"]] = item["id"]  # item UUID → ticket id (same for modify)
            modified.append({"id": item["id"]})
        except Exception as e:
            errors.append({"kind": "modify", "id": item.get("id"), "error": str(e)})

    # Pass 4: close (re-architect)
    for item in items:
        if item["kind"] != "close":
            continue
        if item.get("status") in ("rejected", "ignored"):
            continue
        try:
            pm_db.add_comment(item["id"], f"Closed by architect: {item.get('reason', '')}", actor="agent")
            pm_db.update_ticket(item["id"], actor="agent", state="Closed")
            closed.append({"id": item["id"]})
        except Exception as e:
            errors.append({"kind": "close", "id": item.get("id"), "error": str(e)})

    # Pass 5: blocking dependencies
    for item in items:
        if item["kind"] != "ticket":
            continue
        if item.get("status") in ("rejected", "ignored"):
            continue
        blocker_id = title_to_id.get(item["title"])
        if not blocker_id:
            continue
        for blocked_title in item.get("blocks", []):
            blocked_id = title_to_id.get(blocked_title)
            if blocked_id:
                try:
                    pm_db.set_blocks(blocker_id, blocked_id)
                except Exception:
                    pass

    # Pass 6: write proposal_items index for all items
    if proposal_id:
        now = _now()
        for item in items:
            item_uuid = item.get("id")
            if not item_uuid:
                continue
            item_status = item.get("status", "accepted")
            # If status is still "pending" at apply time, treat as accepted for ticket/subproject,
            # ignored for anything else
            if item_status == "pending":
                item_status = "accepted" if item["kind"] in ("ticket", "subproject", "modify", "close") else "ignored"
            ticket_id = item_ticket_map.get(item_uuid)
            # For modify/close, the ticket_id is the item's "id" field (numeric ticket id)
            if item["kind"] in ("modify", "close") and not ticket_id:
                ticket_id = item.get("ticket_id") or (item.get("id") if str(item.get("id", "")).isdigit() else None)
            try:
                pm_db.upsert_proposal_item(
                    id=item_uuid,
                    proposal_id=proposal_id,
                    kind=item["kind"],
                    entity_type=entity_type,
                    entity_id=str(entity_id),
                    ticket_id=int(ticket_id) if ticket_id and str(ticket_id).isdigit() else None,
                    status=item_status,
                    rejection_reason=item.get("rejection_reason"),
                    resolved_at=now,
                )
            except Exception:
                pass

    # Archive proposal.json
    if proposal_path and proposal_path.exists():
        try:
            _archive_proposal(
                proposal_path=proposal_path,
                proposal_id=proposal_id,
                entity_type=entity_type,
                entity_id=str(entity_id),
                mode=mode,
                generated_at=generated_at,
                archive_reason="applied",
            )
            # Mark proposal.json as applied
            data = json.loads(proposal_path.read_text())
            data["_status"] = "applied"
            proposal_path.write_text(json.dumps(data, indent=2))
        except Exception as e:
            errors.append({"kind": "archive", "error": str(e)})

    pm_db.log_action(
        "architect_applied",
        f"Architect proposal applied: {len(created)} created, {len(modified)} modified, {len(closed)} closed",
        {"created": len(created), "modified": len(modified), "closed": len(closed), "errors": len(errors)},
        actor="human",
    )

    return {"created": created, "modified": modified, "closed": closed, "errors": errors}


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read())
    result  = run(payload)
    print(json.dumps(result))

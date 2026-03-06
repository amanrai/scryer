#!/usr/bin/env python3
"""
Show dependencies for each ticket in tickets.list.

tickets.list format: one ticket per line, e.g. MCORE-5

Required env vars (loaded from .env):
  PLANE_API_KEY
  PLANE_WORKSPACE_SLUG
"""

import os
import sys
import json
import urllib.request
import urllib.error
from pathlib import Path

# Load .env from script directory
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

API_BASE = "https://api.plane.so/api/v1"


def get(path, api_key):
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, headers={
        "X-API-Key": api_key,
        "User-Agent": "Mozilla/5.0",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} for {url}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)


def fetch_all_pages(path, api_key):
    results = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        data = get(f"{path}{sep}page={page}&per_page=100", api_key)
        if isinstance(data, list):
            results.extend(data)
            break
        batch = data.get("results", [])
        results.extend(batch)
        if not data.get("next"):
            break
        page += 1
    return results


def main():
    api_key = os.environ.get("PLANE_API_KEY")
    workspace = os.environ.get("PLANE_WORKSPACE_SLUG")

    if not api_key:
        print("Error: PLANE_API_KEY not set.", file=sys.stderr)
        sys.exit(1)
    if not workspace:
        print("Error: PLANE_WORKSPACE_SLUG not set.", file=sys.stderr)
        sys.exit(1)

    list_file = Path(__file__).parent / "tickets.list"
    ticket_refs = [l.strip() for l in list_file.read_text().splitlines() if l.strip() and not l.startswith("#")]

    if not ticket_refs:
        print("tickets.list is empty.")
        return

    # Build identifier → project map
    all_projects = fetch_all_pages(f"/workspaces/{workspace}/projects/", api_key)
    project_by_id = {p["id"]: p for p in all_projects}
    project_by_identifier = {p["identifier"]: p for p in all_projects}

    # Cache: issue_id → issue dict (for label lookups on related issues)
    issue_cache = {}

    def lookup_issue_by_id(issue_id):
        if issue_id in issue_cache:
            return issue_cache[issue_id]
        # Search across all projects
        for project in all_projects:
            pid = project["id"]
            identifier = project.get("identifier", "")
            issues = fetch_all_pages(
                f"/workspaces/{workspace}/projects/{pid}/issues/?id={issue_id}", api_key
            )
            for i in issues:
                if i["id"] == issue_id:
                    i["_identifier"] = f"{identifier}-{i['sequence_id']}"
                    issue_cache[issue_id] = i
                    return i
        return None

    for ref in ticket_refs:
        if "-" not in ref:
            print(f"\n[{ref}] — invalid format, expected e.g. MCORE-5")
            continue

        proj_id_str, _, seq_str = ref.rpartition("-")
        project = project_by_identifier.get(proj_id_str.upper())
        if not project:
            print(f"\n[{ref}] — unknown project '{proj_id_str}'")
            continue

        pid = project["id"]
        try:
            seq = int(seq_str)
        except ValueError:
            print(f"\n[{ref}] — invalid sequence number '{seq_str}'")
            continue

        issues = fetch_all_pages(
            f"/workspaces/{workspace}/projects/{pid}/issues/?sequence_id={seq}", api_key
        )
        match = next((i for i in issues if i["sequence_id"] == seq), None)
        if not match:
            print(f"\n[{ref}] — ticket not found")
            continue

        issue_id = match["id"]
        issue_cache[issue_id] = {**match, "_identifier": ref}

        relations = get(f"/workspaces/{workspace}/projects/{pid}/issues/{issue_id}/relations/", api_key)

        print(f"\n{ref}: {match['name']}")

        rel_types = [
            ("blocked_by",  "Blocked by"),
            ("blocking",    "Blocking"),
            ("relates_to",  "Relates to"),
            ("duplicate",   "Duplicate of"),
            ("start_after", "Start after"),
            ("finish_after","Finish after"),
        ]

        has_any = False
        for key, label in rel_types:
            ids = relations.get(key, [])
            if not ids:
                continue
            has_any = True
            print(f"  {label}:")
            for rid in ids:
                related = lookup_issue_by_id(rid)
                if related:
                    print(f"    {related['_identifier']}: {related['name']}")
                else:
                    print(f"    {rid} (not found)")

        if not has_any:
            print("  No dependencies.")


if __name__ == "__main__":
    main()

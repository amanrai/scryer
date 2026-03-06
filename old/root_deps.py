#!/usr/bin/env python3
"""
Walk the blocked_by dependency tree for a ticket and find root dependencies
(tickets that are not blocked by anything else).

tickets.list should contain a single ticket, e.g. MCORE-5

Required env vars (loaded from .env):
  PLANE_API_KEY
  PLANE_WORKSPACE_SLUG
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from collections import deque

# Load .env
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

API_BASE = "https://api.plane.so/api/v1"


def get(path, api_key, retries=5):
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, headers={
        "X-API-Key": api_key,
        "User-Agent": "Mozilla/5.0",
    })
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** attempt
                print(f"  [rate limited, retrying in {wait}s...]", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"HTTP {e.code} for {url}: {e.read().decode()}", file=sys.stderr)
            sys.exit(1)
    print(f"Failed after {retries} retries: {url}", file=sys.stderr)
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
    ticket_refs = [l.strip() for l in list_file.read_text().splitlines()
                   if l.strip() and not l.startswith("#")]

    if not ticket_refs:
        print("tickets.list is empty.")
        return

    start_ref = ticket_refs[0]

    # Build project lookup maps
    all_projects = fetch_all_pages(f"/workspaces/{workspace}/projects/", api_key)
    project_by_identifier = {p["identifier"]: p for p in all_projects}

    # Prefetch all issues from all projects into a UUID cache
    print("Loading issues from all projects...")
    issue_cache = {}
    for project in all_projects:
        pid = project["id"]
        identifier = project.get("identifier", "")
        issues = fetch_all_pages(f"/workspaces/{workspace}/projects/{pid}/issues/", api_key)
        for i in issues:
            ref = f"{identifier}-{i['sequence_id']}"
            issue_cache[i["id"]] = {**i, "_ref": ref, "_pid": pid}
    print(f"Loaded {len(issue_cache)} issues.\n")

    def resolve_issue_by_ref(ref):
        """Look up an issue by 'PROJ-N' string from the cache."""
        proj_str, _, seq_str = ref.rpartition("-")
        project = project_by_identifier.get(proj_str.upper())
        if not project:
            return None
        pid = project["id"]
        try:
            seq = int(seq_str)
        except ValueError:
            return None
        return next((i for i in issue_cache.values()
                     if i["_pid"] == pid and i["sequence_id"] == seq), None)

    def resolve_issue_by_id(issue_id):
        return issue_cache.get(issue_id)

    def get_blocked_by(issue):
        pid = issue["_pid"]
        iid = issue["id"]
        relations = get(f"/workspaces/{workspace}/projects/{pid}/issues/{iid}/relations/", api_key)
        return relations.get("blocked_by", [])

    # BFS up the dependency tree
    start = resolve_issue_by_ref(start_ref)
    if not start:
        print(f"Ticket {start_ref} not found.")
        return

    print(f"Tracing dependencies from: {start_ref} — {start['name']}\n")

    visited = set()       # issue IDs we've processed
    # parents[id] = set of IDs that block it (its blocked_by)
    parents = {}
    # issue metadata by id
    all_issues = {start["id"]: start}

    queue = deque([start["id"]])
    visited.add(start["id"])

    while queue:
        current_id = queue.popleft()
        current = all_issues[current_id]
        blocked_by_ids = get_blocked_by(current)
        parents[current_id] = set(blocked_by_ids)

        for bid in blocked_by_ids:
            if bid not in visited:
                visited.add(bid)
                resolved = resolve_issue_by_id(bid)
                if resolved:
                    all_issues[bid] = resolved
                    queue.append(bid)

    # Root tickets: those whose blocked_by list is empty
    roots = [iid for iid, deps in parents.items() if not deps]

    # Print the full dependency tree (indented)
    def print_tree(issue_id, depth=0, seen=None):
        if seen is None:
            seen = set()
        issue = all_issues.get(issue_id)
        ref = issue["_ref"] if issue else issue_id
        name = issue["name"] if issue else "(unknown)"
        indent = "  " * depth
        marker = "* " if issue_id in roots else ""
        print(f"{indent}{marker}{ref}: {name}")
        if issue_id in seen:
            return
        seen.add(issue_id)
        for dep_id in sorted(parents.get(issue_id, []), key=lambda i: all_issues.get(i, {}).get("_ref", "")):
            print_tree(dep_id, depth + 1, seen)

    print("Dependency tree (* = root, no further dependencies):\n")
    print_tree(start["id"])

    print(f"\nRoot tickets ({len(roots)}):")
    for rid in roots:
        issue = all_issues.get(rid)
        if issue:
            print(f"  {issue['_ref']}: {issue['name']}")


if __name__ == "__main__":
    main()

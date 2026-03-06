#!/usr/bin/env python3
"""
Count open tickets per project in a Plane.so workspace.

Required env vars:
  PLANE_API_KEY          - your Plane personal access token
  PLANE_WORKSPACE_SLUG   - your workspace slug (e.g. "my-org")
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
# "Open" state groups in Plane (excludes completed and cancelled)
OPEN_GROUPS = {"backlog", "unstarted", "started"}


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
    """Fetch paginated results, return flat list of all results."""
    results = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        data = get(f"{path}{sep}page={page}&per_page=100", api_key)
        # Plane returns either a list or a dict with 'results'
        if isinstance(data, list):
            results.extend(data)
            break
        else:
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
        print("Error: PLANE_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)
    if not workspace:
        print("Error: PLANE_WORKSPACE_SLUG environment variable not set.", file=sys.stderr)
        sys.exit(1)

    print(f"Workspace: {workspace}\n")

    # Load allowed identifiers from projects.list
    list_file = Path(__file__).parent / "projects.list"
    allowed = {line.strip() for line in list_file.read_text().splitlines() if line.strip()}

    projects = fetch_all_pages(f"/workspaces/{workspace}/projects/", api_key)
    projects = [p for p in projects if p.get("identifier") in allowed]

    if not projects:
        print("No matching projects found.")
        return

    name_width = max(len(p.get("name", "")) for p in projects)

    for project in sorted(projects, key=lambda p: p.get("name", "")):
        pid = project["id"]
        name = project.get("name", pid)
        identifier = project.get("identifier", "")

        # Get states for this project and collect open state IDs
        states = fetch_all_pages(f"/workspaces/{workspace}/projects/{pid}/states/", api_key)
        open_state_ids = {s["id"] for s in states if s.get("group") in OPEN_GROUPS}

        if not open_state_ids:
            print(f"  {name:{name_width}}  ({identifier})  — no open states defined")
            continue

        # Fetch all issues and count those in open states
        issues = fetch_all_pages(f"/workspaces/{workspace}/projects/{pid}/issues/", api_key)
        open_count = sum(1 for i in issues if i.get("state") in open_state_ids)

        print(f"  {name:{name_width}}  ({identifier:>6})  {open_count:>4} open")


if __name__ == "__main__":
    main()

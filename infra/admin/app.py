import sys
import os
import json
import socket
from pathlib import Path
from flask import Flask, render_template, redirect, url_for, request, flash

sys.path.insert(0, str(Path(__file__).parent.parent / "ProjectManagement"))
import db

db.init_db()

app = Flask(__name__)
app.secret_key = "pm-admin-dev-secret"

CONFIG_PATH = Path(__file__).parent / "config.json"
PID_FILE    = Path(__file__).parent / "server.pid"

STATE_COLORS = {
    "Unopened":       "secondary",
    "In Progress":    "primary",
    "Agent Finished": "info",
    "In Review":      "warning",
    "Needs Tests":    "dark",
    "Needs Input":    "orange",
    "Closed":         "success",
}


@app.context_processor
def inject_constants():
    return {
        "valid_states": db.VALID_STATES,
        "state_colors": STATE_COLORS,
    }


def load_config() -> dict:
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {"host": "0.0.0.0", "port": 5050}


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------

@app.route("/logs")
def logs():
    return render_template("logs.html", logs=db.get_logs())


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html",
                           projects=db.list_projects(),
                           all_projects=db.get_all_projects())


@app.route("/projects/create", methods=["POST"])
def create_project():
    name        = request.form["name"].strip()
    description = request.form.get("description", "").strip()
    parent_name = request.form.get("parent_name") or None
    code_path   = request.form.get("code_path", "").strip()
    try:
        db.create_project(name, description, parent_name, code_path)
        db.log_action("create_project", f"Created project '{name}'",
                      {"name": name, "parent": parent_name, "code_path": code_path})
        flash(f"Project '{name}' created.", "success")
        return redirect(url_for("project_detail", name=name))
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(url_for("index"))


@app.route("/projects/<name>")
def project_detail(name):
    project = db.get_project(name)
    if not project:
        flash(f"Project '{name}' not found.", "danger")
        return redirect(url_for("index"))
    parent = db.get_project_by_id(project["parent_id"]) if project["parent_id"] else None
    return render_template("project.html",
                           project=project,
                           parent=parent,
                           sub_projects=db.list_sub_projects(name),
                           tickets=db.list_tickets(name),
                           all_projects=db.get_all_projects())


@app.route("/projects/<name>/update", methods=["POST"])
def update_project(name):
    new_name    = request.form.get("name", "").strip()
    description = request.form.get("description", "")
    code_path   = request.form.get("code_path", "").strip()
    try:
        updated = db.update_project(
            name,
            new_name=new_name if new_name and new_name != name else None,
            description=description,
            code_path=code_path,
        )
        db.log_action("update_project", f"Updated project '{name}'",
                      {"old_name": name, "new_name": updated["name"], "description": description,
                       "code_path": code_path})
        flash("Project updated.", "success")
        return redirect(url_for("project_detail", name=updated["name"]))
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(url_for("project_detail", name=name))


@app.route("/projects/<name>/delete", methods=["POST"])
def delete_project(name):
    next_url = request.form.get("next") or url_for("index")
    try:
        db.delete_project(name)
        db.log_action("delete_project", f"Deleted project '{name}'", {"name": name})
        flash(f"'{name}' deleted.", "success")
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(url_for("project_detail", name=name))
    return redirect(next_url)


@app.route("/projects/<name>/set-parent", methods=["POST"])
def set_project_parent(name):
    parent_name = request.form.get("parent_name") or None
    try:
        db.set_project_parent(name, parent_name)
        db.log_action("set_project_parent",
                      f"Set '{name}' parent to '{parent_name or 'none (root)'}'",
                      {"project": name, "parent": parent_name})
        flash("Parent updated.", "success")
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("project_detail", name=name))


@app.route("/projects/<name>/sub-projects/create", methods=["POST"])
def create_sub_project(name):
    sp_name     = request.form["name"].strip()
    description = request.form.get("description", "").strip()
    try:
        db.create_sub_project(name, sp_name, description)
        db.log_action("create_sub_project", f"Created sub-project '{sp_name}' in '{name}'",
                      {"name": sp_name, "parent": name})
        flash(f"Sub-project '{sp_name}' created.", "success")
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("project_detail", name=name))


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------

@app.route("/tickets/create", methods=["POST"])
def create_ticket():
    project_name     = request.form["project_name"].strip()
    sub_project_name = request.form.get("sub_project_name") or None
    title            = request.form["title"].strip()
    description      = request.form.get("description", "").strip()
    priority         = request.form.get("priority", "medium")
    state            = request.form.get("state", "Unopened")
    next_url         = request.form.get("next") or url_for("project_detail", name=project_name)
    try:
        ticket = db.create_ticket(project_name, title, description, sub_project_name, priority, state)
        db.log_action("create_ticket", f"Created ticket #{ticket['id']} '{title}'",
                      {"id": ticket["id"], "title": title, "project": project_name,
                       "sub_project": sub_project_name, "priority": priority, "state": state})
        flash("Ticket created.", "success")
        return redirect(url_for("ticket_detail", ticket_id=ticket["id"]))
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(next_url)


@app.route("/tickets/<int:ticket_id>")
def ticket_detail(ticket_id):
    ticket = db.get_ticket(ticket_id)
    if not ticket:
        flash("Ticket not found.", "danger")
        return redirect(url_for("index"))
    seen, unique_tickets = set(), []
    for p in db.get_all_projects():
        for t in db.list_tickets(p["name"]):
            if t["id"] != ticket_id and t["id"] not in seen:
                seen.add(t["id"])
                unique_tickets.append(t)
    return render_template("ticket.html",
                           ticket=ticket,
                           all_projects=db.get_all_projects(),
                           all_tickets=unique_tickets)


@app.route("/tickets/<int:ticket_id>/update", methods=["POST"])
def update_ticket(ticket_id):
    changes = {k: request.form.get(k) for k in ("title", "description", "state", "priority")
               if request.form.get(k)}
    try:
        db.update_ticket(ticket_id, **{k: v or None for k, v in changes.items()})
        db.log_action("update_ticket", f"Updated ticket #{ticket_id}",
                      {"id": ticket_id, "changes": changes})
        flash("Ticket updated.", "success")
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


@app.route("/tickets/<int:ticket_id>/delete", methods=["POST"])
def delete_ticket(ticket_id):
    next_url = request.form.get("next") or url_for("index")
    ticket   = db.get_ticket(ticket_id)
    title    = ticket["title"] if ticket else str(ticket_id)
    try:
        db.delete_ticket(ticket_id)
        db.log_action("delete_ticket", f"Deleted ticket #{ticket_id} '{title}'",
                      {"id": ticket_id, "title": title})
        flash("Ticket deleted.", "success")
        return redirect(next_url)
    except ValueError as e:
        flash(str(e), "danger")
        return redirect(url_for("ticket_detail", ticket_id=ticket_id))


@app.route("/tickets/<int:ticket_id>/move", methods=["POST"])
def move_ticket(ticket_id):
    project_name     = request.form["project_name"].strip()
    sub_project_name = request.form.get("sub_project_name") or None
    try:
        db.move_ticket(ticket_id, project_name, sub_project_name)
        dest = f"{project_name}" + (f" > {sub_project_name}" if sub_project_name else "")
        db.log_action("move_ticket", f"Moved ticket #{ticket_id} to '{dest}'",
                      {"id": ticket_id, "project": project_name, "sub_project": sub_project_name})
        flash("Ticket moved.", "success")
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------

@app.route("/tickets/<int:ticket_id>/comments/create", methods=["POST"])
def add_comment(ticket_id):
    content = request.form["content"].strip()
    try:
        comment = db.add_comment(ticket_id, content)
        db.log_action("add_comment", f"Added comment to ticket #{ticket_id}",
                      {"ticket_id": ticket_id, "comment_id": comment["id"]})
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


@app.route("/comments/<int:comment_id>/update", methods=["POST"])
def update_comment(comment_id):
    ticket_id = int(request.form["ticket_id"])
    content   = request.form["content"].strip()
    try:
        db.update_comment(comment_id, content)
        db.log_action("update_comment", f"Updated comment #{comment_id} on ticket #{ticket_id}",
                      {"comment_id": comment_id, "ticket_id": ticket_id})
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


@app.route("/comments/<int:comment_id>/delete", methods=["POST"])
def delete_comment(comment_id):
    ticket_id = int(request.form["ticket_id"])
    try:
        db.delete_comment(comment_id)
        db.log_action("delete_comment", f"Deleted comment #{comment_id} from ticket #{ticket_id}",
                      {"comment_id": comment_id, "ticket_id": ticket_id})
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------

@app.route("/tickets/<int:ticket_id>/blocks/add", methods=["POST"])
def add_block(ticket_id):
    other_id  = int(request.form["other_ticket_id"])
    direction = request.form.get("direction", "blocks")
    try:
        if direction == "blocks":
            db.set_blocks(ticket_id, other_id)
            db.log_action("add_block", f"Ticket #{ticket_id} blocks #{other_id}",
                          {"blocker": ticket_id, "blocked": other_id})
        else:
            db.set_blocks(other_id, ticket_id)
            db.log_action("add_block", f"Ticket #{ticket_id} blocked by #{other_id}",
                          {"blocker": other_id, "blocked": ticket_id})
        flash("Dependency added.", "success")
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


@app.route("/tickets/<int:ticket_id>/blocks/remove", methods=["POST"])
def remove_block(ticket_id):
    other_id  = int(request.form["other_ticket_id"])
    direction = request.form.get("direction", "blocks")
    try:
        if direction == "blocks":
            db.remove_blocks(ticket_id, other_id)
        else:
            db.remove_blocks(other_id, ticket_id)
        db.log_action("remove_block", f"Removed block between #{ticket_id} and #{other_id}",
                      {"ticket_id": ticket_id, "other_id": other_id})
    except ValueError as e:
        flash(str(e), "danger")
    return redirect(url_for("ticket_detail", ticket_id=ticket_id))


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cfg = load_config()
    PID_FILE.write_text(str(os.getpid()))
    app.run(debug=True, host=cfg["host"], port=cfg["port"], use_reloader=False)

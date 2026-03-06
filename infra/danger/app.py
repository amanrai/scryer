import sys
import os
import json
import signal
import socket
import subprocess
import time
from pathlib import Path
from flask import Flask, render_template, redirect, url_for, request, flash

sys.path.insert(0, str(Path(__file__).parent.parent / "ProjectManagement"))
import db

db.init_db()

app = Flask(__name__)
app.secret_key = "pm-danger-dev-secret"

USER_SERVER_DIR    = Path(__file__).parent.parent / "admin"
USER_CONFIG_PATH   = USER_SERVER_DIR / "config.json"
USER_PID_FILE      = USER_SERVER_DIR / "server.pid"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_user_config() -> dict:
    if USER_CONFIG_PATH.exists():
        with open(USER_CONFIG_PATH) as f:
            return json.load(f)
    return {"host": "0.0.0.0", "port": 5050}


def save_user_config(cfg: dict) -> None:
    with open(USER_CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


def available_interfaces() -> list[tuple[str, str]]:
    ifaces = [
        ("127.0.0.1", "Loopback only — 127.0.0.1"),
        ("0.0.0.0",   "All interfaces — 0.0.0.0"),
    ]
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        if local_ip not in ("127.0.0.1", "0.0.0.0"):
            ifaces.append((local_ip, f"Local network — {local_ip}"))
    except Exception:
        pass
    return ifaces


def user_server_running() -> bool:
    if not USER_PID_FILE.exists():
        return False
    try:
        pid = int(USER_PID_FILE.read_text().strip())
        os.kill(pid, 0)  # signal 0 = just check existence
        return True
    except (ValueError, ProcessLookupError, PermissionError):
        return False


def kill_user_server() -> None:
    if not USER_PID_FILE.exists():
        return
    try:
        pid = int(USER_PID_FILE.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
    except (ValueError, ProcessLookupError):
        pass


def start_user_server() -> None:
    subprocess.Popen(
        [sys.executable, str(USER_SERVER_DIR / "app.py")],
        start_new_session=True,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    cfg = load_user_config()
    return render_template("index.html",
                           cfg=cfg,
                           interfaces=available_interfaces(),
                           running=user_server_running())


@app.route("/bind", methods=["POST"])
def update_bind():
    host = request.form["host"].strip()
    port = int(request.form.get("port", 5050))
    kill_user_server()
    save_user_config({"host": host, "port": port})
    start_user_server()
    return render_template("restarting.html", host=host, port=port)


@app.route("/reset", methods=["POST"])
def reset():
    if request.form.get("confirm", "").strip() != "RESET":
        flash("Type RESET exactly to confirm.", "warning")
        return redirect(url_for("index"))
    db.reset_db()
    flash("Database wiped and reinitialised.", "success")
    return redirect(url_for("index"))


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5001, use_reloader=False)

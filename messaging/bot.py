"""
Scryer Discord bot — messaging adapter.
- Connects to Discord, ensures #scryer-updates exists
- Tails the pm.db logs table and posts new entries to #scryer-updates
- Exposes POST /notify on port 7655 (lightweight escape hatch)
- Listens for incoming messages (routing to be added later)
"""

import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import discord
from aiohttp import web

# ── Config ────────────────────────────────────────────────────────────────────

DB_PATH = Path(__file__).parent.parent / "infra" / "ProjectManagement" / "data" / "pm.db"

UPDATES_CHANNEL = "scryer-updates"
NOTIFY_PORT     = 7655

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("scryer.bot")


def get_config():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT key, value FROM scryer_config WHERE key IN ('discord_token', 'discord_server_id')"
    ).fetchall()
    conn.close()
    return {k: v for k, v in rows}


# ── DB helpers ────────────────────────────────────────────────────────────────

def _ticket_info(ticket_id: int) -> tuple[str, str]:
    """Return (title, location_path) for a ticket."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        ticket = conn.execute(
            "SELECT title, project_id FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        if not ticket:
            return "", ""

        parts = []
        pid = ticket["project_id"]
        while pid:
            p = conn.execute(
                "SELECT name, parent_id, is_default FROM projects WHERE id = ?", (pid,)
            ).fetchone()
            if not p:
                break
            if not p["is_default"]:
                parts.insert(0, p["name"])
            pid = p["parent_id"]

        return ticket["title"], " > ".join(parts)
    finally:
        conn.close()


def _format_log(row) -> str | None:
    """Convert a logs row into a Discord message. Returns None to suppress."""
    action    = row["action"]
    ticket_id = row["ticket_id"]
    details   = {}
    try:
        details = json.loads(row["details"] or "{}")
    except Exception:
        pass

    actor = row["actor"] if "actor" in row.keys() else "human"
    actor_tag = f" _[{actor}]_" if actor else ""

    if ticket_id:
        title, location = _ticket_info(ticket_id)
        prefix      = f"[{location}] " if location else ""
        ticket_part = f"T{ticket_id} \u2014 {title}: " if title else f"T{ticket_id}: "
    else:
        prefix      = ""
        ticket_part = ""

    if action == "state_change":
        to_state = details.get("to", row["message"])
        return f"\U0001f504 {prefix}{ticket_part}\u2192 **{to_state}**{actor_tag}"
    elif action == "comment":
        content = details.get("content", row["message"])
        snippet = content[:200] + ("\u2026" if len(content) > 200 else "")
        return f"\U0001f4ac {prefix}{ticket_part}{snippet}{actor_tag}"
    elif action in ("create_ticket", "create", "ticket_created"):
        return f"\u2705 {prefix}{ticket_part}created{actor_tag}"
    elif action == "delete":
        return None
    else:
        msg = row["message"]
        return f"\U0001f4cc {prefix}{msg}{actor_tag}" if msg else None


# ── Bot ───────────────────────────────────────────────────────────────────────

intents = discord.Intents.default()
intents.message_content = True
intents.messages = True


class ScryerBot(discord.Client):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._updates_channel: discord.TextChannel | None = None
        self._last_log_id: int = 0
        self._tail_task: asyncio.Task | None = None

    def _init_last_log_id(self):
        conn = sqlite3.connect(DB_PATH)
        row = conn.execute("SELECT MAX(id) FROM logs").fetchone()
        conn.close()
        self._last_log_id = row[0] or 0

    async def on_ready(self):
        log.info(f"Connected as {self.user} (id: {self.user.id})")

        guild = self.guilds[0] if self.guilds else None
        if guild:
            self._updates_channel = discord.utils.get(guild.text_channels, name=UPDATES_CHANNEL)
            if self._updates_channel is None:
                self._updates_channel = await guild.create_text_channel(
                    UPDATES_CHANNEL,
                    topic="Scryer system activity feed — logs, agent events, ticket updates",
                )
                log.info(f"Created #{UPDATES_CHANNEL}")
            else:
                log.info(f"Found #{UPDATES_CHANNEL}")


        self._init_last_log_id()
        # Cancel any previous tail loop (can fire on reconnects) before starting a fresh one
        if self._tail_task and not self._tail_task.done():
            self._tail_task.cancel()
        self._tail_task = asyncio.ensure_future(self._tail_logs())

    async def _send_update(self, text: str):
        if self._updates_channel is None:
            return
        try:
            await self._updates_channel.send(text[:1990])
        except Exception as e:
            print(f"[send_update ERROR] {e}", flush=True)

    async def _tail_logs(self):
        """Poll pm.db logs table every second and post new entries to #scryer-updates."""
        while True:
            await asyncio.sleep(1)
            if self._updates_channel is None:
                continue
            try:
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT id, action, message, details, ticket_id, created_at "
                    "FROM logs WHERE id > ? ORDER BY id ASC",
                    (self._last_log_id,)
                ).fetchall()
                conn.close()

                for row in rows:
                    self._last_log_id = row["id"]
                    msg = _format_log(row)
                    if msg:
                        await self._send_update(msg)
            except Exception as e:
                print(f"[tail_logs ERROR] {e}", flush=True)

    async def handle_notify(self, request: web.Request) -> web.Response:
        """POST /notify — escape hatch for direct pushes not going through pm.db."""
        try:
            data = await request.json()
        except Exception:
            return web.Response(status=400, text="bad json")

        event        = data.get("event", "update")
        location     = data.get("location", "")
        ticket_id    = data.get("ticket_id")
        ticket_title = data.get("ticket_title", "")
        detail       = data.get("detail", "")

        prefix      = f"[{location}] " if location else ""
        ticket_part = f"T{ticket_id} \u2014 {ticket_title}: " if ticket_id else ""

        if event == "state_change":
            msg = f"\U0001f504 {prefix}{ticket_part}\u2192 **{detail}**"
        elif event == "comment":
            msg = f"\U0001f4ac {prefix}{ticket_part}{detail}"
        else:
            msg = f"\U0001f4cc {prefix}{ticket_part}{detail}"

        await self._send_update(msg)
        return web.Response(status=200, text="ok")

    async def on_message(self, message: discord.Message):
        if message.author == self.user:
            return

        ts = datetime.now(timezone.utc).isoformat()
        in_thread = isinstance(message.channel, discord.Thread)
        channel_name = message.channel.parent.name if in_thread else message.channel.name
        thread_id = message.channel.id if in_thread else None

        log.info(
            f"[{ts}] #{channel_name}"
            + (f" (thread {thread_id})" if in_thread else "")
            + f" | {message.author.name}: {message.content[:120]}"
        )


# ── Entry point ───────────────────────────────────────────────────────────────

async def main():
    config = get_config()
    token  = config.get("discord_token", "").strip()
    if not token:
        log.error("No discord_token found in scryer_config. Set it in Global Config.")
        raise SystemExit(1)

    bot = ScryerBot(intents=intents)

    app = web.Application()
    app.router.add_post("/notify", bot.handle_notify)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", NOTIFY_PORT)
    await site.start()
    log.info(f"Notify endpoint on http://127.0.0.1:{NOTIFY_PORT}/notify")

    log.info("Starting Scryer Discord bot...")
    async with bot:
        await bot.start(token)


if __name__ == "__main__":
    asyncio.run(main())

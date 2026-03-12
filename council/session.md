---

## Council session context

**Ticket ID:** {ticket_id}
**Your Member ID:** {member_id}
**Entity under review:**

{entity_summary}

---

## Council API

Three helper scripts are in your directory. Use them — do not use curl, MCP tools, or explore the filesystem.

**Your member_id: {member_id}**

**Read the discussion:**
```
python3 state.py
```

**Post your analysis** (only if you have something new to add):
```
python3 comment.py "your analysis text here"
```

**Signal you are done** (required — always call this):
```
python3 submit.py <turn_id> true
python3 submit.py <turn_id> false
```

## Your turn

Wait silently until you receive: **COUNCIL TURN GRANTED: ...**
Do not act until you receive it.

When your turn is granted:
1. Run `python3 state.py` to read the full discussion.
2. If you have something new to add: run `python3 comment.py "..."`, then `python3 submit.py <turn_id> true`.
3. If you have nothing new: run `python3 submit.py <turn_id> false`.
4. No other actions. Read and comment only.

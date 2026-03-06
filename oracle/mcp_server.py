"""
Oracle MCP server — exposes ask_oracle and get_startup_context as MCP tools.
Register with: claude mcp add oracle-local -- python3 /path/to/oracle/mcp_server.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from mcp.server.fastmcp import FastMCP
import oracle

mcp = FastMCP("OracleAgent")


@mcp.tool()
def ask_oracle(ticket_id: int | None, question: str, calling_agent: str = "agent") -> str:
    """
    Ask the oracle a question about a ticket's context.

    The oracle reconstructs state from the ticket's comment thread, recent
    activity logs, and plan.md files, then reasons over them to answer.

    ticket_id: the ticket you are currently working on
    question: a specific, scoped question (not a vague request for context)
    calling_agent: your identifier, e.g. "claude-T16" (used for logging)

    Returns JSON: {"type": "answer"|"caution"|"block", "content": str}

    On "block": the ticket has been moved to Needs Input and the human has
    been notified. Stop work and wait for the ticket to return to In Progress.
    """
    try:
        result = oracle.ask(ticket_id, question, calling_agent)
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"type": "error", "content": str(e)})


@mcp.tool()
def get_startup_context(ticket_id: int) -> str:
    """
    Get the full starting context package for a ticket.
    Called by the orchestrator when instantiating an agent for a ticket.
    Returns a formatted context string ready to prepend to the agent's system prompt.
    """
    try:
        return oracle.build_startup_context(ticket_id)
    except Exception as e:
        return f"Error building context: {e}"


if __name__ == "__main__":
    mcp.run()

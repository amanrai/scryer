import os
import re
import pty
import fcntl
import struct
import termios
import subprocess
import threading
import select
import time
import shlex
import shutil
from datetime import datetime, timezone
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room

TMUX = '/opt/homebrew/bin/tmux'

_NVM_INIT = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

AGENT_DIRS = {
    'claude': os.path.expanduser('~/Code/TestingAgents/Claude'),
    'codex':  os.path.expanduser('~/Code/TestingAgents/Codex'),
    'gemini': os.path.expanduser('~/Code/TestingAgents/Gemini'),
}

AGENT_COMMANDS = {
    'claude': 'unset CLAUDECODE && claude',
    'codex':  f'{_NVM_INIT} && nvm use 22 && codex',
    'gemini': f'{_NVM_INIT} && nvm use 22 && gemini',
}

# File written to workdir that the agent auto-loads as project context
AGENT_CONTEXT_FILES = {
    'claude': 'CLAUDE.md',
    'codex':  'AGENTS.md',
    'gemini': 'task.md',   # no auto-load; passed as CLI arg instead
}

TRIGGER = 'Execute the task.'

SCRYER_ROOT = os.path.expanduser('~/Code/plane.so')

SANDBOX_SHELL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sandbox_shell.py')
SANDBOX_LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sandbox.log')

RESUME_COMMANDS = {
    'claude': f'cd {SCRYER_ROOT} && unset CLAUDECODE && claude --continue',
    'codex':  f'cd {SCRYER_ROOT} && ' + _NVM_INIT + ' && nvm use 22 && codex --continue',
    'gemini': f'cd {SCRYER_ROOT} && ' + _NVM_INIT + ' && nvm use 22 && gemini --continue',
}

# Maps tool IDs to Claude --allowedTools syntax
CLAUDE_TOOL_FLAGS = {
    'ls':        'Bash(ls*)',
    'rg':        'Bash(rg*)',
    'find':      'Bash(find*)',
    'lsof':      'Bash(lsof*)',
    'python3':   'Bash(python3*)',
    'python':    'Bash(python*)',
    'pip':       'Bash(pip*)',
    'WebSearch': 'WebSearch',
}

# Gemini --allowed-tools names (shell command names)
GEMINI_ALLOWED_TOOLS = ['ls', 'rg', 'find', 'lsof', 'python3', 'python', 'pip']

app = Flask(__name__)
app.config['SECRET_KEY'] = 'tmux-test-secret'
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')

# socket_id -> {master, proc, session_name, owned}
sessions = {}


_ANSI_ESCAPE = re.compile(r'\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')


def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE.sub('', text)


def _read_loop(sid, master_fd):
    while True:
        try:
            r, _, _ = select.select([master_fd], [], [], 1.0)
        except (ValueError, OSError):
            break
        if not r:
            continue
        try:
            data = os.read(master_fd, 4096)
        except OSError:
            break
        if not data:
            break
        text = data.decode('utf-8', errors='replace')
        socketio.emit('output', text, room=sid)

        # Write to conversation log if this session has one
        state = sessions.get(sid)
        if state and state.get('conv_log_path'):
            try:
                with open(state['conv_log_path'], 'a', encoding='utf-8') as f:
                    f.write(_strip_ansi(text))
            except OSError:
                pass

    socketio.emit('session_ended', {}, room=sid)
    sessions.pop(sid, None)


def _preflight_check():
    """Check required system dependencies. Returns dict of name -> bool."""
    results = {}

    # Direct path check for tmux
    results['tmux'] = os.path.isfile(TMUX)

    # which-based checks for system tools
    for name in ('docker', 'git'):
        results[name] = shutil.which(name) is not None

    # Agent CLIs may live under nvm shims — use a login shell to find them
    for name in ('claude', 'codex', 'gemini'):
        r = subprocess.run(
            ['bash', '-lc', f'command -v {name}'],
            capture_output=True,
        )
        results[name] = (r.returncode == 0)

    return results


def _list_tmux_sessions():
    result = subprocess.run(
        [TMUX, 'list-sessions', '-F',
         '#{session_name}\t#{session_created}\t#{session_windows}\t#{session_attached}'],
        capture_output=True, text=True
    )
    sessions_list = []
    for line in result.stdout.strip().splitlines():
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) != 4:
            continue
        name, created_epoch, windows, attached = parts
        try:
            created = time.strftime('%H:%M:%S', time.localtime(int(created_epoch)))
        except (ValueError, OSError):
            created = '?'
        sessions_list.append({
            'name': name,
            'created': created,
            'windows': int(windows),
            'attached': attached == '1',
        })
    return sessions_list


def _attach_pty(sid, session_name, owned, cols, rows):
    """Open a PTY, attach tmux to it, start the read loop."""
    master_fd, slave_fd = pty.openpty()
    _set_winsize(master_fd, rows, cols)

    proc = subprocess.Popen(
        [TMUX, 'attach-session', '-t', session_name],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
    )
    os.close(slave_fd)

    sessions[sid] = {
        'master': master_fd,
        'proc': proc,
        'session_name': session_name,
        'owned': owned,
    }

    t = threading.Thread(target=_read_loop, args=(sid, master_fd), daemon=True)
    t.start()


@app.route('/')
def index():
    return render_template('index.html')


@socketio.on('connect')
def on_connect():
    join_room(request_sid())
    emit('session_list', _list_tmux_sessions())
    emit('preflight_result', _preflight_check())


@socketio.on('preflight')
def on_preflight():
    emit('preflight_result', _preflight_check())


@socketio.on('disconnect')
def on_disconnect():
    _cleanup(request_sid())


@socketio.on('list_sessions')
def on_list_sessions():
    emit('session_list', _list_tmux_sessions())


@socketio.on('spawn')
def on_spawn(data):
    sid = request_sid()
    cols = data.get('cols', 220)
    rows = data.get('rows', 50)
    agent = data.get('agent', 'claude')
    markdown = data.get('markdown', '')
    allowed_tools = data.get('allowed_tools', list(CLAUDE_TOOL_FLAGS.keys()))
    permissions_mode = data.get('permissions_mode', 'restricted')
    workdir = AGENT_DIRS.get(agent, os.path.expanduser('~'))
    base_command = AGENT_COMMANDS.get(agent, AGENT_COMMANDS['claude'])

    # Clear the working directory
    for f in os.listdir(workdir):
        fp = os.path.join(workdir, f)
        if os.path.isfile(fp):
            os.remove(fp)

    # Write markdown to agent-native context file
    if markdown:
        context_file = AGENT_CONTEXT_FILES.get(agent, 'task.md')
        with open(os.path.join(workdir, context_file), 'w') as f:
            f.write(markdown)

    # Build permission flags per agent
    if agent == 'claude':
        if permissions_mode == 'skip':
            base_command = f'{base_command} --permission-mode acceptEdits'
        elif permissions_mode == 'restricted' and allowed_tools:
            flags = ','.join(CLAUDE_TOOL_FLAGS[t] for t in allowed_tools if t in CLAUDE_TOOL_FLAGS)
            if flags:
                base_command = f'{base_command} --allowedTools {shlex.quote(flags)}'
        elif permissions_mode == 'combined' and allowed_tools:
            flags = ','.join(CLAUDE_TOOL_FLAGS[t] for t in allowed_tools if t in CLAUDE_TOOL_FLAGS)
            if flags:
                base_command = f'{base_command} --allowedTools {shlex.quote(flags)} --permission-mode acceptEdits'
    elif agent == 'gemini':
        base_command = f'{base_command} --approval-mode auto_edit'

    # Codex and Gemini accept prompt as a CLI arg — no delayed send-keys needed
    if agent in ('codex', 'gemini'):
        if agent == 'gemini' and markdown:
            prompt_arg = f"{markdown}\n\n{TRIGGER}"
        else:
            prompt_arg = TRIGGER if markdown else ''
        if prompt_arg:
            if agent == 'gemini':
                # Use = syntax to prevent yargs misinterpreting leading dashes in the prompt
                flag = f'--prompt-interactive={shlex.quote(prompt_arg)}'
            else:
                flag = shlex.quote(prompt_arg)
            command = f'cd {shlex.quote(workdir)} && {base_command} {flag}'
        else:
            command = f'cd {shlex.quote(workdir)} && {base_command}'
        trigger = None
    else:
        # Claude: start interactive, send trigger after delay
        trigger = TRIGGER if markdown else None
        command = f'cd {shlex.quote(workdir)} && {base_command}'
    # Use caller-supplied name when given (enables Watch to find this session later)
    session_name = data.get('session_name') or f'{agent}-{sid[:8]}'

    _detach(sid)
    subprocess.run([TMUX, 'kill-session', '-t', session_name], capture_output=True)

    # Extract ticket_id from session_name (e.g. "claude-ticket-42" -> "42")
    sandbox_ticket_id = session_name.split('-')[-1] if session_name else ''

    sandbox_env = []
    if os.path.isfile(SANDBOX_SHELL):
        sandbox_env = [
            '-e', f'SHELL={SANDBOX_SHELL}',
            '-e', f'SANDBOX_REAL_SHELL=/bin/bash',
            '-e', f'SANDBOX_TICKET_ID={sandbox_ticket_id}',
            '-e', f'SANDBOX_LOG_FILE={SANDBOX_LOG_FILE}',
        ]

    subprocess.run(
        [TMUX, 'new-session', '-d', '-s', session_name,
         '-x', str(cols), '-y', str(rows)] + sandbox_env,
        check=True
    )
    subprocess.run(
        [TMUX, 'send-keys', '-t', session_name, command, 'Enter'],
        check=True
    )

    _attach_pty(sid, session_name, owned=True, cols=cols, rows=rows)
    emit('attached', {'session': session_name})

    input_delay = max(3, min(30, data.get('input_delay', 5)))

    if trigger:
        def _send_trigger():
            time.sleep(input_delay)
            subprocess.run([TMUX, 'send-keys', '-t', session_name, trigger],
                           capture_output=True)
            subprocess.run([TMUX, 'send-keys', '-t', session_name, 'Enter'],
                           capture_output=True)
        threading.Thread(target=_send_trigger, daemon=True).start()


@socketio.on('resume')
def on_resume(data):
    sid = request_sid()
    agent = data.get('agent', 'claude')
    cols = data.get('cols', 220)
    rows = data.get('rows', 50)
    workdir = data.get('workdir') or None
    if not workdir:
        emit('workdir_error', {
            'message': (
                'Could not resolve the planning folder for this project. '
                'Make sure Scryer root is configured (⚙ Global Config) and the project folder exists.'
            )
        })
        return
    fresh = data.get('fresh', False)
    startup_input = data.get('startup_input', '')

    # When starting a fresh session, strip all Claude Code session env vars so the
    # new process doesn't inherit and attach to whatever session spawned this server.
    _CLAUDE_UNSET = (
        'unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT '
        'CLAUDE_CODE_IS_NESTED CLAUDE_CODE_SKIP_TELEMETRY 2>/dev/null'
    )

    # Determine whether a previous conversation exists in the workdir to continue
    has_prior_session = os.path.isdir(os.path.join(workdir, '.claude'))

    if agent == 'codex':
        cmd_suffix = f'{_NVM_INIT} && nvm use 22 && codex' + ('' if fresh else (' --continue' if has_prior_session else ''))
    elif agent == 'gemini':
        cmd_suffix = f'{_NVM_INIT} && nvm use 22 && gemini' + ('' if fresh else (' --continue' if has_prior_session else ''))
    else:
        if fresh or not has_prior_session:
            cmd_suffix = f'{_CLAUDE_UNSET} && claude'
        else:
            cmd_suffix = 'unset CLAUDECODE && claude --continue'
    command = f'cd {shlex.quote(workdir)} && {cmd_suffix}'

    session_name = f'resume-{agent}-{sid[:8]}'

    _detach(sid)
    subprocess.run([TMUX, 'kill-session', '-t', session_name], capture_output=True)
    subprocess.run(
        [TMUX, 'new-session', '-d', '-s', session_name, '-x', str(cols), '-y', str(rows)],
        check=True,
    )
    subprocess.run([TMUX, 'send-keys', '-t', session_name, command, 'Enter'], check=True)
    time.sleep(0.5)

    _attach_pty(sid, session_name, owned=True, cols=cols, rows=rows)
    emit('attached', {'session': session_name})

    # Inject session_id and scope into the startup_input so the agent knows its session context
    if fresh and startup_input:
        scope_type = data.get('scope_type', '')   # e.g. 'project', 'subproject', 'ticket'
        scope_id   = data.get('scope_id', '')     # numeric entity ID as string
        if scope_type and scope_id:
            scope_note = (
                f'\n\nSession ID: {session_name}\n'
                f'Scope: {scope_type} {scope_id}\n'
                f'Call register_scope(session_id="{session_name}", entity_type="{scope_type}", entity_id={scope_id}) '
                f'as your first MCP call to activate write scoping.'
            )
            startup_input = startup_input + scope_note

    # Set up conversation log file in {workdir}/.planning/conversations/{timestamp}.md
    try:
        conv_dir = os.path.join(workdir, '.planning', 'conversations')
        os.makedirs(conv_dir, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        conv_log_path = os.path.join(conv_dir, f'{ts}.md')
        # Write header
        with open(conv_log_path, 'w', encoding='utf-8') as f:
            f.write(f'# Planning session — {agent} — {ts}\n\n')
        if sid in sessions:
            sessions[sid]['conv_log_path'] = conv_log_path
    except OSError:
        pass  # Non-fatal — logging is best-effort

    if fresh and startup_input:
        def _send_startup():
            time.sleep(3)
            subprocess.run(
                [TMUX, 'send-keys', '-t', session_name, startup_input, 'Enter'],
                capture_output=True,
            )
        threading.Thread(target=_send_startup, daemon=True).start()


@socketio.on('attach')
def on_attach(data):
    sid = request_sid()
    session_name = data.get('session')
    cols = data.get('cols', 220)
    rows = data.get('rows', 50)

    if not session_name:
        return

    # Verify session exists before attaching; emit error event if not
    check = subprocess.run([TMUX, 'has-session', '-t', session_name], capture_output=True)
    if check.returncode != 0:
        emit('session_not_found', {'session': session_name})
        return

    _detach(sid)
    _attach_pty(sid, session_name, owned=False, cols=cols, rows=rows)
    emit('attached', {'session': session_name})


@socketio.on('detach')
def on_detach():
    sid = request_sid()
    _detach(sid)
    emit('detached', {})
    emit('session_list', _list_tmux_sessions())


@socketio.on('kill_session')
def on_kill_session(data):
    session_name = data.get('session')
    if session_name:
        subprocess.run([TMUX, 'kill-session', '-t', session_name], capture_output=True)
    emit('session_list', _list_tmux_sessions())


@socketio.on('input')
def on_input(data):
    sid = request_sid()
    state = sessions.get(sid)
    if state:
        try:
            os.write(state['master'], data.encode('utf-8'))
        except OSError:
            pass


@socketio.on('resize')
def on_resize(data):
    sid = request_sid()
    state = sessions.get(sid)
    if not state:
        return
    cols = data.get('cols', 80)
    rows = data.get('rows', 24)
    _set_winsize(state['master'], rows, cols)
    subprocess.run(
        [TMUX, 'resize-window', '-t', state['session_name'],
         '-x', str(cols), '-y', str(rows)],
        capture_output=True
    )


def _set_winsize(fd, rows, cols):
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def _detach(sid):
    """Close PTY and terminate attach process, but leave tmux session alive."""
    state = sessions.pop(sid, None)
    if not state:
        return
    try:
        os.close(state['master'])
    except OSError:
        pass
    try:
        state['proc'].terminate()
    except Exception:
        pass


def _cleanup(sid):
    """Detach PTY on disconnect. Tmux sessions are never auto-killed — agents run independently of browser connections."""
    _detach(sid)


def request_sid():
    return request.sid


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5055, debug=False, allow_unsafe_werkzeug=True)

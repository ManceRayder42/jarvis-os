---
name: jarvis-setup
description: Launch the local setup page to configure the Jarvis memory hub
allowed-tools:
  - Bash(node:*)
---

Launch the Jarvis setup server and hand the user its URL.

## Task

1. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/setup/server.mjs"
   ```
2. The server binds `127.0.0.1` on an OS-assigned port, mints a one-time
   token, and prints a single `http://127.0.0.1:<port>/?token=<token>` URL to
   stdout before it starts listening. Read that URL from the command output.
3. Tell the user to open the URL in their browser. Do not try to open it for
   them or fetch it yourself — it's a page they interact with directly (hub
   path, feature toggles).
4. The server is self-managing: it heartbeats with the open tab, exits on its
   own once the tab closes or after 10 minutes idle, and is a child of this
   terminal session. Nothing else to start, stop, or clean up.
5. If the command fails to start (port bind error, missing Node, etc.), show
   the actual error to the user rather than guessing at a fix.

Do not run this server in the background and move on — its whole job is a
short-lived interactive setup, so wait for the user to confirm they've
finished (or tell you to cancel) before continuing with anything else.

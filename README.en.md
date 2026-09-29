# RemoteCodex uni-app

[English](README.en.md) | [中文](README.md)  
Repository: [qmdq/remote-codex-app](https://github.com/qmdq/remote-codex-app)  
Companion PC backend: [qmdq/remote-codex-backend](https://github.com/qmdq/remote-codex-backend)

RemoteCodex is a mobile Codex Agent tool built with uni-app, Vue 3, and WebSocket. It provides Codex Agent capabilities on a phone: task chat, thinking/command/file-edit timelines, multiple sessions, file preview and editing, terminal access, and remote screen control. Codex calls, command execution, and file modifications do not run on the phone; they are securely performed by the remote PC Agent.

It is useful for following Codex work away from the computer and for LAN-based debugging, file inspection, and demos.

## Capabilities

- **Codex Agent capabilities:** start or interrupt tasks, switch models, choose sandbox modes, manage multiple sessions, and sync historical sessions and PC Codex chat history.
- **Temporary chats:** start a read-only question without selecting a directory; request folder access from chat and approve a manually selected folder on the PC to convert it into a regular project.
- **Codex-style timeline:** expand thinking, commands, file edits, and messages by state; render Markdown; recover missed events by `seq` after reconnecting.
- **File workbench:** browse project files; preview text, images, and HTML; edit text; upload or capture images from the chat input.
- **Remote control:** CPU, memory, disk, and network metrics; PTY terminal; screen subscription; basic touch and keyboard input.
- **Secure connection:** request pairing with a six-digit code, approve on PC, save the device token locally, and reconnect automatically.

## Preview

<div align="center">
  <img src="docs/screenshots/screenshot-1.png" width="49%" alt="RemoteCodex chat interface">
  <img src="docs/screenshots/screenshot-2.png" width="49%" alt="RemoteCodex session and task state">
  <br>
  <img src="docs/screenshots/screenshot-3.png" width="49%" alt="RemoteCodex file preview">
  <img src="docs/screenshots/screenshot-4.png" width="49%" alt="RemoteCodex remote screen">
</div>

## Features

- PC WebSocket connection, automatic reconnection, and local device-token storage
- Device-token request through a six-digit pairing code
- Project list, project creation, and project selection
- Create temporary chats without selecting a PC directory; file, upload, and write controls stay disabled until authorization
- Automatic discovery of local Codex projects, with one-click import inside allowed roots
- Codex task sending, sandbox-mode selection, and interruption
- Model list read from the PC Codex configuration, with in-session switching
- Syncing of local Codex rollout chat history into the session page
- Project file browsing; line-numbered text, image, and HTML WebView previews
- Image selection/capture in chat input; uploaded images can be referenced by Codex and previewed in bubbles
- Realtime event timeline with `seq`-based recovery after disconnects
- PC CPU, memory, disk, and network metrics
- PC screen-frame subscription (`mss` and `Pillow` are required on the backend)
- Remote terminal in the selected project directory; full PTY on Windows after installing `pywinpty`

## Run

1. Open the app repository folder in HBuilderX.
2. Choose **Run to Browser**, **Run to Device**, or **Run to Emulator**.
3. Open **Devices**. If the phone is not paired, choose **Start pairing**.
4. Enter the PC Agent address, for example:

   ```text
   ws://192.168.1.20:7800
   ```

5. Generate a pairing code on the PC by opening the `admin console` URL printed by the backend and choosing **Generate pairing code**.

For LAN access, copy the backend LAN template and start the Agent:

```powershell
Copy-Item config.local.example.json config.mobile.json
.\.venv\Scripts\python.exe -m app serve --config config.mobile.json
```

Then set `projects.allowed_roots` in `config.mobile.json` to the directories you want to authorize. The configuration listens on `0.0.0.0:7800`; on Windows, allow Python through the private network on first startup.

6. Return to the pairing page, enter the six-digit code, and request pairing.
7. Approve the pending request in the PC console. The app saves `device_token`, switches to paired state, and connects automatically.

## Temporary Chats and Directory Authorization

Choose **New temporary chat** on the Projects page to start a read-only conversation without selecting a directory. The app hides the private scratch path and shows only a **Temporary** badge. Files, image uploads, write mode, and file previews remain blocked.

When Codex needs project files, choose **Authorize directory** in the chat toolbar. The PC console shows a directory-authorization request; browse to a real project folder inside an allowed root and choose **Authorize current directory**. The app restores file capabilities automatically and converts the chat into a regular project. If the request is rejected or expires, it can be submitted again.

## License

GPL-3.0-or-later. Closed-source commercial integration or redistribution requires separate commercial authorization from the author.

## Protocol Conventions

The app keeps the backend's `v: 1` envelope:

```json
{
  "v": 1,
  "id": "request-id",
  "type": "turn.start",
  "payload": {
    "project_id": "prj_xxx",
    "prompt": "Fix the failing test",
    "sandbox": "workspace_write"
  }
}
```

The project page's **Sync** action reads the `cwd` values from the PC's `CODEX_HOME/sessions` and calls:

- `codex.project.list`: discover Codex working directories and return recent-use time, session count, and import eligibility.
- `codex.project.import`: register allowed working directories in the Agent project list; repeated imports reuse the existing project.

Event messages use `codex.event` / `agent.event`. The app deduplicates them by `seq`; after reconnecting or switching projects it calls `event.replay` to restore the timeline.

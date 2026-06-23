# PAI Installer v5.0

> Install [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/PAI) with a single command.

## Quick Start

```bash
bash PAI-Install/install.sh
```

On Windows PowerShell:

```powershell
.\install.ps1
```

That's it. The script handles everything:

1. Detects your operating system and installed tools
2. Lets you choose **Claude Code**, **Codex**, or **OpenCode** as the target agent framework
3. Installs **Bun**, **Git**, and the selected agent CLI if missing
4. Launches a guided Web UI installer
5. Walks you through identity, voice, and configuration
6. Links memory and USER context through `~/.pai/`
7. Validates the installation before finishing

### Requirements

- macOS, Linux, or Windows PowerShell
- **bash** and **curl** on macOS/Linux, or PowerShell on Windows
- Internet connection

Everything else (Bun, Git, and the selected agent CLI) is installed automatically.

### RTK Command Reduction

PAI's Codex runtime can use RTK (Rust Token Killer) to compact shell-command output before it reaches the agent context. RTK is a single Rust binary from <https://github.com/rtk-ai/rtk>; upstream documents typical token reduction of 60-90% on common developer commands.

Install RTK before using command-reduction workflows:

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

Other supported install paths:

```bash
brew install rtk
cargo install --git https://github.com/rtk-ai/rtk
```

Windows users can download `rtk-x86_64-pc-windows-msvc.zip` from the RTK releases page, extract `rtk.exe`, and put it on PATH. For WSL-based PAI, install RTK inside WSL.

Verify:

```bash
rtk --version
rtk gain
which rtk
```

### Interceptor for Browser Verification

PAI expects web verification to use Interceptor, which drives your real Chrome or Brave session through a browser extension and local CLI. Interceptor is installed outside the core PAI installer because Chrome/Brave require a manual unpacked-extension load step and Windows may require native-messaging registration.

On Windows with WSL, install Interceptor on the Windows side first so it uses your real Windows Chrome profile and existing logins. Do not copy a Windows Chrome profile into Linux Chrome; cookies and passwords are encrypted by Windows DPAPI and will not reliably work in WSL/Linux.

The validated Windows + WSL path is:

1. Put the Windows release binary at `%USERPROFILE%\bin\interceptor.exe` and add `%USERPROFILE%\bin` to the Windows user PATH.
2. If Windows blocks the binary with `Application Control policy` / `Malicious binary reputation`, disable Smart App Control while keeping normal Microsoft Defender and Firewall enabled.
3. Load the Chrome extension from `C:\Users\<USER>\Projects\Interceptor\extension\dist`, not `C:\Users\<USER>\Projects\Interceptor\dist`.
4. Register Chrome native messaging under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host` with the default value pointing at a Windows manifest whose `path` is `C:\Users\<USER>\Projects\Interceptor\daemon\interceptor-daemon.exe`.
5. Add a WSL shim at `~/.local/bin/interceptor` that forwards to `/mnt/c/Users/<USER>/bin/interceptor.exe`.

After setup, verify from WSL:

```bash
command -v interceptor
rtk which interceptor
interceptor --version
interceptor status --verbose
```

Expected healthy state is `daemon: running`, `transport: tcp:127.0.0.1:19221`, and `extension: reachable`. Full troubleshooting lives in the Interceptor skill workflow `Workflows/SetupWindowsWSL.md`.

---

## Updating an Existing Install

For small fixes after the full installer has already run, use the hotfix updater at the release root. It reads `hotfix-manifest.json`, backs up touched files to `~/.pai/BACKUPS/`, and overlays only managed PAI files. It does not overwrite `USER`, `MEMORY`, auth, env files, framework config, or hook trust state.

From a cloned checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Releases\v5.0.0\.claude\update-installed.ps1 -Framework codex -SourceDir .
```

macOS/Linux/WSL:

```bash
bash ./Releases/v5.0.0/.claude/update-installed.sh --framework codex --source-dir .
```

From a machine that already has PAI installed but needs the latest updater from this fork:

```powershell
$u = "https://raw.githubusercontent.com/haydencj/Personal_AI_Infrastructure/pai-codex-flawless-runtime/Releases/v5.0.0/.claude/update-installed.ps1"
$p = Join-Path $env:TEMP "pai-update-installed.ps1"
Invoke-WebRequest $u -OutFile $p
powershell -NoProfile -ExecutionPolicy Bypass -File $p -Framework codex
```

macOS/Linux/WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/haydencj/Personal_AI_Infrastructure/pai-codex-flawless-runtime/Releases/v5.0.0/.claude/update-installed.sh | bash -s -- --framework codex
```

Use `-Framework claude` or `-Framework opencode` for those targets, or omit `-Framework` to let the updater read `~/.pai/framework.json`.

Use `--framework claude` or `--framework opencode` with the shell updater. When the source directory points at a git checkout, the updater runs `git fetch --prune` and `git pull --ff-only` before copying files. Pass `-NoPull` in PowerShell or `--no-pull` in Bash when testing uncommitted local changes.

Rollback restores the files touched by the hotfix from the newest backup:

```bash
BACKUP="$(ls -dt ~/.pai/BACKUPS/hotfix-* | head -1)"
cp -a "$BACKUP"/. "$CODEX_HOME"/
```

PowerShell:

```powershell
$backup = Get-ChildItem "$HOME\.pai\BACKUPS" -Directory -Filter "hotfix-*" | Sort-Object Name -Descending | Select-Object -First 1
Get-ChildItem -LiteralPath $backup.FullName -Force | Copy-Item -Destination $env:CODEX_HOME -Recurse -Force
```

---

## MCP Profiles

PAI ships MCP profile files under `MCPs/`; they are not installed on demand by `k -m`.

Available shortcuts:

```bash
k mcp list
k mcp set dev-work
k -m dev
```

Credential-bearing profiles use environment variable names only. Set the relevant tokens in your shell before launching PAI:

```bash
export API_TOKEN="..."       # Bright Data MCP
export APIFY_TOKEN="..."     # Apify MCP
```

`dev-work` currently enables shadcn and Supabase. Supabase uses its hosted MCP endpoint and still requires the normal browser authentication flow in the MCP client. Use development/non-production Supabase projects, and prefer read-only/project-scoped access for sensitive data.

`security` and `minimal` are intentionally present as safe empty profiles until vetted security/base MCP servers are added.

---

## Runtime Doctor

After install or after returning to PAI later, run:

```bash
k doctor
```

The doctor verifies Codex config, instructions, MCP profile files, hook adapter behavior, hook-trigger observability, a temp-HOME Codex fresh-install smoke test, and Pulse health routes.

If the doctor reports optional warnings, add the relevant credentials before using that feature:

```bash
export ELEVENLABS_API_KEY="..."  # real TTS audio
export TELEGRAM_BOT_TOKEN="..."  # Telegram chat/alerts
export API_TOKEN="..."           # Bright Data MCP
export APIFY_TOKEN="..."         # Apify MCP
```

These are deliberately not committed into PAI profile files. They belong in your shell/session secret store or framework `.env`.

---

## Installation Steps

The installer runs 9 steps in dependency order:

| # | Step | What It Does |
|---|------|-------------|
| 1 | **System Detection** | Detects OS, architecture, shell, installed tools (Bun, Git, selected agent CLI), timezone, and any existing PAI installation |
| 2 | **Prerequisites** | Installs missing tools: Git via Xcode CLT or package manager, Bun via official installer, and the selected agent CLI |
| 3 | **API Keys** | Auto-completes - key collection happens during the Voice step |
| 4 | **Identity** | Prompts for your name, AI assistant name, timezone, and a personal catchphrase |
| 5 | **PAI Repository** | Clones or copies the PAI tree into the selected framework home |
| 6 | **Configuration** | Generates framework-native config, `.env`, directory structure, global memory links, `k`/`pai` shell aliases, and patches version files |
| 7 | **DA Voice + Pulse** | Collects ElevenLabs API key, selects voice type (Female/Male/Custom), and configures Pulse. macOS installs via launchd; Windows installs via a per-user scheduled task. |
| 8 | **Telegram Bot (Optional)** | Adds Telegram bot credentials for Pulse notifications and chat if you provide a bot token. |
| 9 | **Validation** | Verifies directory structure, settings file, API keys, Pulse health on 31337, shell aliases, and framework-native hooks/config. |

### Voice + Pulse Setup

The voice step handles Digital Assistant voice configuration **and** Pulse install in one cohesive step:

1. Collects or auto-discovers your ElevenLabs API key (checks the global PAI env plus compatible framework env files)
2. Validates the key against the ElevenLabs API
3. On macOS, **asks (Y/n) to install Pulse** as a launchd service. On Windows, **asks (Y/n) to install Pulse** as a per-user scheduled task and starts it immediately.
4. Presents voice selection: **Female** (Rachel), **Male** (Adam), or **Custom Voice ID** with audio previews
5. On macOS, **asks (Y/n) to install the Pulse menu bar app** - adds a status icon to your macOS menu bar, second launchd plist, auto-starts on login
6. Tests TTS via Pulse with a personalized greeting using your name and AI name

In PAI 5.0 the standalone voice server was absorbed into Pulse: there is no separate process - Pulse on port 31337 embeds the voice module, the Life Dashboard, observability, and scheduled jobs.

Voice + Pulse are optional. Skip the ElevenLabs key and the installer continues without voice. Skip the Pulse install and you can run it later from the active framework home (`k framework status` shows the path). macOS: `bash <framework-home>/PAI/PULSE/manage.sh install`. Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File <framework-home>/PAI/PULSE/manage.ps1 install`.

### Graceful Degradation

The installer is designed to recover from partial failures:

- No ElevenLabs key -> voice features skipped, Pulse can still install for dashboard + observability
- No existing PAI -> fresh install (vs. upgrade if detected)
- Pulse install declined or fails -> configuration saved, voice notifications unavailable until Pulse is installed manually
- Menu bar install declined or fails -> Pulse keeps running; menu bar can be installed later
- Selected agent CLI not installed -> attempts installation, continues if it fails
- Port conflicts -> installer port configurable via `PAI_INSTALL_PORT` environment variable

---

## Architecture

### Two-Layer Design

1. **Bootstrap** (`install.sh`) - Pure bash. Only needs bash + curl. Installs Bun and Git, then hands off to the TypeScript installer.
2. **Engine + UI** (`engine/` + `web/` + `public/`) - TypeScript (Bun). All install logic, web server, and frontend.

### Launch Modes

The installer supports three modes via `main.ts`:

| Mode | Command | Description |
|------|---------|-------------|
| **GUI** (default) | `--mode gui` | Launches Electron window wrapping the web server. Audio autoplay works. This is what `install.sh` uses. |
| **Web** | `--mode web` | Starts the Bun HTTP/WebSocket server on port 1337. Open in any browser. |
| **CLI** | `--mode cli` | Terminal-only wizard with ANSI colors and progress bars. No browser needed. |

GUI mode auto-installs Electron dependencies on first run and clears macOS quarantine flags.

### Directory Structure

```
PAI-Install/
|-- install.sh              # Bash bootstrap entry point
|-- main.ts                 # Mode router (gui/web/cli)
|-- generate-welcome.ts     # Welcome audio generator (build-time)
|
|-- engine/                 # Core install logic (shared across all modes)
|   |-- types.ts            # TypeScript interfaces (InstallState, messages, events)
|   |-- detect.ts           # System detection (OS, tools, existing install)
|   |-- steps.ts            # Step definitions + dependency graph
|   |-- actions.ts          # Install action functions (clone, configure, voice, etc.)
|   |-- config-gen.ts       # Fallback settings.json generator
|   |-- validate.ts         # Post-install validation checks
|   |-- state.ts            # State persistence (resume interrupted installs)
|   `-- index.ts            # Re-exports
|
|-- web/                    # Web server (GUI and Web modes)
|   |-- server.ts           # Bun HTTP + WebSocket server (port 1337)
|   `-- routes.ts           # WebSocket message handler + install orchestrator
|
|-- cli/                    # CLI frontend
|   |-- index.ts            # CLI entry point
|   `-- display.ts          # ANSI colors, progress bars, banners
|
|-- public/                 # Static web assets
|   |-- index.html          # Single-page application shell
|   |-- styles.css          # Dark theme with glassmorphic effects
|   |-- app.js              # Frontend JavaScript (WebSocket client, UI rendering)
|   `-- assets/             # Logos, fonts, welcome audio, voice previews
|
|-- electron/               # Electron native wrapper
|   |-- main.js             # Spawns Bun server + opens BrowserWindow
|   `-- package.json        # Electron dependency
|
`-- README.md               # This file
```

---

## WebSocket Protocol

The Web UI communicates with the install engine over WebSocket. The server runs on `ws://localhost:1337/ws`.

### Client -> Server

| Type | Payload | Description |
|------|---------|-------------|
| `client_ready` | - | Client connected and ready |
| `start_install` | - | User clicked "Begin Installation" |
| `user_input` | `{ requestId, value }` | Response to a text/password input prompt |
| `user_choice` | `{ requestId, value }` | Response to a multiple-choice prompt |

### Server -> Client

| Type | Payload | Description |
|------|---------|-------------|
| `connected` | - | Connection acknowledged |
| `step_update` | `{ step, status }` | Step status changed (pending/active/completed/skipped/failed) |
| `detection_result` | `{ data }` | System detection results (OS, tools, existing install) |
| `message` | `{ role, content, speak? }` | Chat message (assistant/system/error) |
| `input_request` | `{ id, prompt, inputType, placeholder }` | Request text/password input from user |
| `choice_request` | `{ id, prompt, choices[] }` | Request selection from options |
| `progress` | `{ step, percent, detail }` | Progress bar update for long operations |
| `validation_result` | `{ checks[] }` | Array of validation check results |
| `install_complete` | `{ summary }` | Installation finished with summary data |
| `error` | `{ message }` | Error message |

Messages include a `replayed` flag for reconnect replay - replayed messages skip animations and TTS.

### Message Flow Example

```
Client                          Server
  |                               |
  |-- client_ready --------------->|
  |<---------------- connected ----|
  |                               |
  |-- start_install -------------->|
  |<------------- step_update -----|  (system-detect -> active)
  |<--------- detection_result ----|  (OS, tools, etc.)
  |<------------- step_update -----|  (system-detect -> completed)
  |                               |
  |<--------- input_request -------|  ("What is your name?")
  |-- user_input ----------------->|
  |<------------- message ---------|  ("Welcome, {{PRINCIPAL_NAME}}!")
  |                               |
  |<--------- choice_request ------|  ("Select voice type")
  |-- user_choice ---------------->|
  |<------------- progress --------|  (voice server install: 40%)
  |<------------- step_update -----|  (voice -> completed)
  |                               |
  |<----- validation_result -------|  (all checks)
  |<----- install_complete --------|  (summary card)
```

---

## Configuration

### Settings Merge Strategy

PAI ships a complete `settings.json` template in the release repository. This template includes:

- **Hooks** - 20+ event hooks for session management, security, voice, etc.
- **Status line** - Terminal status bar configuration
- **Spinner verbs** - Activity indicator messages
- **Context files** - Files loaded into Claude Code context

The installer **does NOT generate hooks or status line config**. Instead, it:

1. Clones the PAI repository (which includes the full `settings.json` template)
2. Merges only user-specific fields into the existing template:
   - `principal` - user name, timezone
   - `daidentity` - AI name, voice ID, personality
   - `env` - PAI_DIR, PROJECTS_DIR
   - `pai` - version info
3. Preserves all hooks, status line, spinner verbs, and context files from the template

This ensures fresh installs get the full PAI configuration without the installer needing to know about every hook.

### Generated Files

| File | Location | Contents |
|------|----------|----------|
| `settings.json` | selected framework home (`~/.claude`, `~/.codex`, or `~/.config/opencode`) | Merged PAI settings and environment |
| Native instructions | `CLAUDE.md` or `AGENTS.md` | Framework-specific operating instructions |
| Native config | `settings.json`, `config.toml`, or `opencode.json` | Claude, Codex, or OpenCode configuration |
| Global data | `~/.pai/MEMORY` and `~/.pai/USER` | Shared memory and user context preserved across framework switches |
| `.env` | global PAI config plus compatible framework env files | Voice/API credentials |
| Shell aliases | shell profile | `k` and `pai` wrappers that launch the active framework with `PAI_DATA_DIR` |

### Directory Structure Created

```
~/.pai/
|-- framework.json
|-- MEMORY/
|   |-- WORK/
|   |-- STATE/
|   |-- LEARNING/
|   `-- VOICE/
`-- USER/

<framework home>/
|-- CLAUDE.md or AGENTS.md
|-- settings.json / config.toml / opencode.json
|-- PAI/
|   |-- MEMORY -> ~/.pai/MEMORY
|   `-- USER -> ~/.pai/USER
|-- hooks/
`-- skills/
```

### Banner and Counts

On first launch after installation, the PAI banner displays system statistics (skills, hooks, workflows, signals, files). These counts are:

1. **Calculated by the installer** during the Configuration step (initial values)
2. **Updated by the StopOrchestrator hook** at the end of each Claude Code session

The Algorithm version displayed in the banner reads from `PAI/Algorithm/LATEST`.

---

## Web UI Features

- **Electron wrapper** - Opens in a controlled 1280x820 window with audio autoplay enabled
- **Dark theme** - Deep navy/black with PAI blue accents and glassmorphic card effects
- **Step sidebar** - All 9 steps with live status indicators (pending/active/completed/skipped/failed)
- **Progress bar** - Header shows overall completion percentage
- **Voice previews** - Listen to Female/Male voice samples before selecting
- **Welcome audio** - Pre-recorded MP3 plays on launch
- **Auto-reconnect** - WebSocket reconnects on disconnect with 2-second retry and full message replay
- **Input masking** - API keys are masked in the chat display (shows first 8 chars only)
- **Choice buttons** - Styled selection cards with descriptions and optional audio previews

---

## Post-Installation

After the installer completes, open a terminal and run:

```powershell
. $PROFILE; k
```

On zsh/bash, reload your shell profile and run `k`:

```bash
source ~/.zshrc && k
```

This reloads your shell config and launches PAI for the first time. The installer creates both `k` and `pai`; `k` is the short daily command.

### First-run: populate your personal context

Once PAI is running, kick off the phased interview to populate your TELOS, identity, preferences, and life dimensions.

For Codex:

```
$Interview
```

For Claude Code:

```
/interview
```

The interview is conversational and resumable. It runs in 4 phases:

1. **Phase 1 - Foundational TELOS:** Mission, Goals, Problems, Strategies, Challenges, Narratives, Beliefs, Wisdom, Models, Frames
2. **Phase 2 - IDEAL_STATE:** Health, Money, Freedom, Relationships, Creative
3. **Phase 3 - Preferences:** Books, Authors, Bands, Movies, Restaurants, Food, Learning, Civic
4. **Phase 4 - Identity:** Light review of PRINCIPAL_IDENTITY and current state

Each section is skippable. If you have existing data (Obsidian, Notion, journals, prior PAI install), bring it in via the `Migrate` skill **before** running the interview - it intakes external content, classifies chunks against the PAI taxonomy, and writes them into the right files with provenance, so the interview only fills the genuine gaps.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `bun: command not found` | Run `curl -fsSL https://bun.sh/install \| bash` then restart terminal |
| Port 1337 in use | Set `PAI_INSTALL_PORT=8080` before running install.sh |
| ElevenLabs key invalid | Verify at elevenlabs.io - ensure no trailing spaces, key starts with `xi-` or `sk_` |
| Permission denied | macOS/Linux: run `chmod -R 755 <framework-home>`. Windows: rerun PowerShell normally, not from a restricted directory, and close processes using the target framework home. |
| `k` or `pai` command not found | PowerShell: run `. $PROFILE`. zsh/bash: run `source ~/.zshrc` or `source ~/.bashrc`. |
| Startup self-check reports PAI issues | Run `k doctor` for full diagnostics. Optional credential reminders are warnings; critical failures identify the config, hook, Pulse, or install surface to repair. |
| Pulse / voice notifications not working | Check port 31337 is free. macOS: restart Pulse with `bash <framework-home>/PAI/PULSE/manage.sh restart`. Windows: restart Pulse with `powershell -NoProfile -ExecutionPolicy Bypass -File <framework-home>/PAI/PULSE/manage.ps1 restart`. |
| Pulse menu bar icon missing | macOS only: install or reinstall from the active framework home with `bash <framework-home>/PAI/PULSE/MenuBar/install.sh`. Verify launchd plist: `ls ~/Library/LaunchAgents/com.pai.pulse-menubar.plist`. |
| Banner shows wrong algorithm version | Check `<framework-home>/PAI/Algorithm/LATEST` contains the correct version |
| Banner counts all show 0 | Normal on first launch - counts populate after your first Claude Code session ends |
| WebSocket "Connection lost" | The installer auto-reconnects. If persistent, check if another process is using port 1337 |
| Electron window blank | Try `--mode web` instead and open `http://localhost:1337` in your browser |

### Recovery

The installer saves state to disk. If interrupted, re-run `install.sh` - it will detect the existing installation and offer to resume or start fresh.

---

## Development

### Running Locally

```bash
# Web mode (development)
bun run PAI-Install/main.ts --mode web

# CLI mode
bun run PAI-Install/main.ts --mode cli

# GUI mode (Electron - installs deps on first run)
bun run PAI-Install/main.ts --mode gui
```

### Key Design Decisions

- **No framework dependencies** - Frontend is vanilla JavaScript. No React, no build step.
- **Bun-native server** - Uses `Bun.serve()` for HTTP and WebSocket in one process.
- **Async Pulse install** - Pulse install via `manage.sh install` uses async `spawn` (not `execSync`) to avoid blocking the event loop and killing WebSocket connections. PAI 5.0 absorbed the standalone voice server into Pulse on port 31337 - there is no separate voice-server process.
- **Safe process cleanup** - Port cleanup uses `lsof -sTCP:LISTEN` to kill only the listening process, not client connections.
- **Template-based settings** - Installer merges user fields into the release template rather than generating a complete settings.json from scratch.

---

## Known Limitations

- **Platform bootstrap differs** - macOS/Linux use `install.sh`; Windows uses `install.ps1` and CLI mode.
- **Internet connection required** - Downloads tools, clones repository, validates API keys
- **Voice requires ElevenLabs** - Voice synthesis is optional but needs an ElevenLabs API key
- **Single-user** - Installs into the selected framework home for the current user only
- **Electron optional** - If Electron fails to install, use `--mode web` or `--mode cli` as fallback

## License

Part of [PAI - Personal AI Infrastructure](https://github.com/danielmiessler/PAI).

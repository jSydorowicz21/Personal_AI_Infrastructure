# PAI â€” Personal AI Infrastructure

> **PAI is a Life OS.** Scaffolding that turns your AI from a chatbot you talk to into a system that runs your life â€” knows your goals, people, workflows, current state, and ideal state, and continuously hill-climbs you from one to the other.

**Status:** Version 5.0.0 | **License:** [MIT](./LICENSE)

---

## What you get

- **A Digital Assistant (DA)** â€” named by you, voiced by you, running as a peer. Ships with a generic "PAI" DA on free public ElevenLabs voices so you can hear it out of the box; `/interview` personalizes it.
- **The Algorithm** â€” a structured problem-solving framework (OBSERVE â†’ THINK â†’ PLAN â†’ BUILD â†’ EXECUTE â†’ VERIFY â†’ LEARN) that the DA runs for non-trivial tasks.
- **Pulse** - a local daemon on port 31337 that provides voice notifications, observability, scheduled tasks, and a Life Dashboard. Runs as a macOS launchd service or Windows per-user scheduled task; the menu bar app is macOS-only.
- **Skills** â€” 40+ composable capabilities (research, creative writing, security assessment, Cloudflare deploys, voice, etc.) that the DA self-selects at runtime.
- **Memory** â€” persistent typed storage that compounds across sessions (KNOWLEDGE for durable notes, WORK for active projects, LEARNING for meta-patterns).
- **TELOS** â€” your mission, goals, beliefs, challenges, and wisdom captured in structured files so the DA can frame every recommendation against who you are and what you're trying to do.

---

## Quick Start

### Prerequisites

- macOS, Linux, or Windows PowerShell
- One supported agent CLI: Claude Code, Codex, or OpenCode
- The API key required by your selected agent CLI
- An [ElevenLabs API key](https://elevenlabs.io/) (optional â€” enables voice notifications)

### Important: existing config is backed up and merged

If you already use Claude Code, Codex, or OpenCode, the installer first copies the selected framework home to a timestamped backup before laying down PAI.

For Codex, existing `config.toml` settings are preserved and PAI is added as a managed block. Shared memory and USER context live in `~/.pai/`, so switching frameworks does not fork your personal state.

### Install

macOS/Linux:

```bash
./install.sh
```

Windows PowerShell:

```powershell
.\install.ps1
```

The installer will:
1. Check/install Bun and Git
2. Let you choose Claude Code, Codex, or OpenCode
3. Back up the selected framework home and install the PAI tree
4. Generate framework-native instructions, config, hooks/plugins, prompts, and agents
5. Link shared memory and USER context through `~/.pai/`
6. Create both `k` and `pai` shell commands
7. Configure optional ElevenLabs voice, Pulse, and Telegram
8. Run validation before finishing

### First session

After install completes, reload your shell profile and start PAI with `k`.

Windows PowerShell:

```powershell
. $PROFILE; k
```

macOS/Linux:

```bash
source ~/.zshrc && k
```

In your first PAI session, run `/interview` to personalize your DA with your mission, goals, challenges, and preferences. The scaffold files at `$PAI_DATA_DIR/USER/` are functional defaults; the interview upgrades them to your real identity.

---

## Updating an existing install

For small fixes after PAI is already installed, use the installed hotfix updater instead of re-running the full installer. It fetches the release bundle, reads `hotfix-manifest.json`, backs up anything it touches under `~/.pai/BACKUPS/`, and overlays only managed PAI files. It does not overwrite `USER`, `MEMORY`, auth, env files, framework config, or hook trust state.

From a cloned checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Releases\v5.0.0\.claude\update-installed.ps1 -Framework codex -SourceDir .
```

macOS/Linux/WSL:

```bash
bash ./Releases/v5.0.0/.claude/update-installed.sh --framework codex --source-dir .
```

For a machine that already has PAI installed but does not have the updated script locally:

```powershell
$u = "https://raw.githubusercontent.com/jSydorowicz21/Personal_AI_Infrastructure/pai-codex-windows-installer/Releases/v5.0.0/.claude/update-installed.ps1"
$p = Join-Path $env:TEMP "pai-update-installed.ps1"
Invoke-WebRequest $u -OutFile $p
powershell -NoProfile -ExecutionPolicy Bypass -File $p -Framework codex
```

macOS/Linux/WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/jSydorowicz21/Personal_AI_Infrastructure/pai-codex-windows-installer/Releases/v5.0.0/.claude/update-installed.sh | bash -s -- --framework codex
```

Use `-Framework claude` or `-Framework opencode` for those targets, or omit `-Framework` to let the updater read `~/.pai/framework.json`.

Use `--framework claude` or `--framework opencode` with the shell updater. When the source directory points at a git checkout, the updater runs `git fetch --prune` and `git pull --ff-only` before copying files. Pass `-NoPull` in PowerShell or `--no-pull` in Bash when testing uncommitted local changes.

---

## Architecture at a glance

```
<framework-home>/
├── CLAUDE.md / AGENTS.md       # framework instructions + context routing
├── settings/config files       # framework-native config + DA identity
â”œâ”€â”€ PAI/                         # the engine
â”‚   â”œâ”€â”€ ALGORITHM/v3.29.0.md     # the universal problem-solving framework
â”‚   â”œâ”€â”€ DOCUMENTATION/           # every subsystem fully documented
â”‚   â”œâ”€â”€ PULSE/                   # daemon, menu bar, voice server, scheduled tasks
â”‚   â”œâ”€â”€ TOOLS/                   # CLI utilities (Inference, GenerateTelosSummary, etc.)
â”‚   â””â”€â”€ USER/                    # YOUR scaffolds â€” ABOUTME, TELOS/, DA_IDENTITY, etc.
├── skills/ or shared skill link # 40+ composable capabilities
â”œâ”€â”€ agents/                      # specialist subagent definitions
├── hooks/plugins/              # framework-native lifecycle integration
└── MEMORY/USER links           # routes to shared state in ~/.pai/
```

The DA reads the selected framework instructions at every session start. Those instructions route to your shared identity, DA personality, projects, and TELOS under `~/.pai/USER/`.

---

## Post-install customization

- **DA identity + voice** â€” `/interview` personalizes your DA's name, voice, personality, and relationship framing.
- **TELOS** â€” `/interview` (TELOS phase) populates your mission, goals, beliefs, challenges, wisdom.
- **Voice pronunciation** â€” edit `$PAI_DATA_DIR/USER/pronunciations.json` for custom phonetic overrides.
- **Pulse port** â€” defaults to 31337, bound to loopback. Set `PAI_PULSE_BIND_ALL=1` in `<framework-home>/.env` if you need LAN access (phone, other machines).
- **Menu bar app** - macOS-only: `bash <framework-home>/PAI/PULSE/MenuBar/install.sh` builds and installs the Swift menu bar app.

---

## Documentation

- **System architecture:** [PAI/DOCUMENTATION/PAISystemArchitecture.md](./PAI/DOCUMENTATION/PAISystemArchitecture.md)
- **Life OS thesis:** [PAI/DOCUMENTATION/LifeOs/LifeOsThesis.md](./PAI/DOCUMENTATION/LifeOs/LifeOsThesis.md)
- **Algorithm spec:** [PAI/ALGORITHM/v3.29.0.md](./PAI/ALGORITHM/v3.29.0.md)
- **Skill system:** [PAI/DOCUMENTATION/Skills/SkillSystem.md](./PAI/DOCUMENTATION/Skills/SkillSystem.md)
- **Hook system:** [PAI/DOCUMENTATION/Hooks/HookSystem.md](./PAI/DOCUMENTATION/Hooks/HookSystem.md)
- **Pulse system:** [PAI/DOCUMENTATION/Pulse/PulseSystem.md](./PAI/DOCUMENTATION/Pulse/PulseSystem.md) (path is case-insensitive on macOS APFS; on Linux use `PAI/PULSE/`)
- **Memory system:** [PAI/DOCUMENTATION/Memory/MemorySystem.md](./PAI/DOCUMENTATION/Memory/MemorySystem.md)
- **Installer details:** [PAI/PAI-Install/README.md](./PAI/PAI-Install/README.md)

---

## Troubleshooting

**"Installer/server.ts not found":** The top-level `./install` delegates to `PAI/PAI-Install/install.sh`. Run that directly if the delegation fails.

**"Voice server not found":** The voice server lives at `PAI/PULSE/VoiceServer/` (not `~/.claude/VoiceServer/`). Recent installer versions detect both paths; if you're on an older build, re-run `./install`.

**Pulse won't start / port 31337 conflict:** Check whether another process is listening on 31337. macOS/Linux: `lsof -i :31337`. Windows: `netstat -ano -p tcp | findstr 31337`.

**Menu bar icon doesn't appear:** `launchctl list | grep pai` should show `com.pai.pulse-menubar` loaded. If not, run `bash PAI/PULSE/MenuBar/install.sh`.

**Existing framework config conflicts:** The installer creates a timestamped backup first. Codex config is merged additively; if something looks wrong, compare against the generated backup directory.

---

## Philosophy

PAI treats AI as infrastructure, not a feature. The same reason you have a filesystem, a shell, and an init system â€” you need durable scaffolding the model can operate within. Naked chat is not enough. PAI is the Life OS: a layer above Claude Code that knows who you are, what you're building, who matters to you, and where you're trying to go.

You name your DA. You configure your voice. You capture your TELOS. The DA reads all of it at every session and operates as a peer, not a tool.

---

## Contributing

Issues and discussions are welcome via the repository. Architecture changes go through the upgrade process described in the Algorithm spec.

---

*Licensed under [MIT](./LICENSE).*

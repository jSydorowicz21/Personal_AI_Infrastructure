/**
 * PAI Installer v5.0 — Validation
 * Verifies installation completeness after all steps run.
 */

import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import type { InstallState, ValidationCheck, InstallSummary, EngineEventHandler } from "./types";
import { PAI_VERSION } from "./types";
import { homedir, tmpdir } from "os";
import { getPaiConfigDir, getPaiDataDir } from "./frameworks";
import type { FrameworkTarget } from "./types";

/**
 * Check if Pulse is running. PAI 5.0 absorbed the standalone voice server
 * into Pulse on port 31337 — Pulse serves /notify for voice + the Life
 * Dashboard + observability. Probe /notify with an empty silent payload.
 * Any 2xx-4xx response means Pulse is up and the route is registered.
 */
async function checkPulseHealth(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:31337/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "", voice_enabled: false }),
      signal: AbortSignal.timeout(2000),
    });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

function checkWindowsPulseTask(): boolean {
  if (process.platform !== "win32") return false;
  const res = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    "if (Get-ScheduledTask -TaskName 'PAI Pulse' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
  ], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return res.status === 0;
}

function shellRcFile(): { path: string; display: string; sourceCommand: string } {
  if (process.platform === "win32" && process.env.PAI_POWERSHELL_PROFILE) {
    return {
      path: process.env.PAI_POWERSHELL_PROFILE,
      display: "$PROFILE",
      sourceCommand: ". $PROFILE",
    };
  }

  const userShell = process.env.SHELL || "";
  if (process.platform === "win32" && !userShell) {
    const candidates = [
      process.env.OneDrive ? join(process.env.OneDrive, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1") : "",
      process.env.OneDrive ? join(process.env.OneDrive, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1") : "",
      join(homedir(), "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      join(homedir(), "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    ].filter(Boolean);
    const path = candidates.find((candidate) => existsSync(candidate)) || candidates[0];
    return {
      path,
      display: "$PROFILE",
      sourceCommand: ". $PROFILE",
    };
  }
  if (userShell.includes("fish")) {
    return {
      path: join(homedir(), ".config", "fish", "config.fish"),
      display: "~/.config/fish/config.fish",
      sourceCommand: "source ~/.config/fish/config.fish",
    };
  }
  if (userShell.includes("bash")) {
    return {
      path: join(homedir(), ".bashrc"),
      display: "~/.bashrc",
      sourceCommand: "source ~/.bashrc",
    };
  }
  return {
    path: join(homedir(), ".zshrc"),
    display: "~/.zshrc",
    sourceCommand: "source ~/.zshrc",
  };
}

function pulseManualStartCommand(paiDir: string): string {
  const pulseDir = join(paiDir, "PAI", "PULSE");
  return process.platform === "win32"
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(join(pulseDir, "manage.ps1"))} start`
    : `bash ${join(pulseDir, "manage.sh")} install`;
}

/**
 * Run the SecurityPipeline.hook.ts as Claude Code would, with a benign Bash
 * payload. The hook MUST exit 0 (allow) and MUST NOT print "patterns file
 * missing — fail-closed". A failure here means PATTERNS.yaml is unreachable
 * to the hook at runtime even if the file appears to exist on disk — the
 * exact bug that left fresh installs unable to run any Bash command.
 *
 * Returns { passed, detail }. `passed=false` is CRITICAL: every Bash call
 * the user makes will be denied until this is fixed.
 */
function checkSecurityHookSmoke(
  paiDir: string,
  framework?: FrameworkTarget,
  throughAdapter = false
): { passed: boolean; detail: string } {
  const hooksDir = join(paiDir, "hooks");
  const hookPath = throughAdapter
    ? join(hooksDir, "FrameworkHookAdapter.ts")
    : join(hooksDir, "SecurityPipeline.hook.ts");
  if (!existsSync(hookPath)) {
    return { passed: false, detail: `Hook not found at ${throughAdapter ? "hooks/FrameworkHookAdapter.ts" : "hooks/SecurityPipeline.hook.ts"}` };
  }
  const patternsPath = join(getPaiDataDir(), "USER", "SECURITY", "PATTERNS.yaml");
  if (!existsSync(patternsPath)) {
    return { passed: false, detail: `PATTERNS.yaml not found at ${patternsPath} — hook will fail-close on every Bash call` };
  }
  // Synthetic benign payload that should ALWAYS be allowed. Mirrors Claude Code's hook input shape.
  const payload = JSON.stringify({
    sessionId: "smoke-test",
    hookEventName: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "echo pai-smoke-test" },
  });
  try {
    const args = throughAdapter
      ? [hookPath, "--framework", framework?.id || "codex", "--target", "SecurityPipeline.hook.ts"]
      : [hookPath];
    const res = spawnSync(process.execPath, args, {
      input: payload,
      encoding: "utf-8",
      timeout: process.platform === "win32" ? 20000 : 8000,
      // Match Claude Code: no inherited zshrc, minimal env. HOME and PATH only.
      env: {
        HOME: homedir(),
        PATH: process.env.PATH || "",
        PAI_DIR: join(paiDir, "PAI"),
        PAI_DATA_DIR: getPaiDataDir(),
        PAI_FRAMEWORK: framework?.id || "claude",
        PAI_FRAMEWORK_DIR: paiDir,
        PAI_SETTINGS_PATH: join(paiDir, "settings.json"),
        PAI_CONFIG_DIR: stateConfigDirFallback(paiDir),
      },
    });
    const stderr = (res.stderr || "").toString();
    if (res.status !== 0) {
      const failureParts = [
        `status=${res.status}`,
        res.signal ? `signal=${res.signal}` : "",
        res.error ? `error=${res.error.message}` : "",
        stderr.trim() ? `stderr=${stderr.trim().slice(0, 160)}` : "",
      ].filter(Boolean);
      return { passed: false, detail: `Hook failed: ${failureParts.join("; ") || "no failure detail"}` };
    }
    if (/patterns file missing|fail-closed/i.test(stderr)) {
      return { passed: false, detail: `Hook printed fail-closed message: ${stderr.trim().slice(0, 160)}` };
    }
    return {
      passed: true,
      detail: throughAdapter
        ? "adapter normalized payload; echo allowed; PATTERNS.yaml loaded"
        : "echo allowed; PATTERNS.yaml loaded; no fail-closed message",
    };
  } catch (err: any) {
    return { passed: false, detail: `Hook execution threw: ${err?.message || String(err)}` };
  }
}

function stateConfigDirFallback(_paiDir: string): string {
  return getPaiConfigDir();
}

function checkOpenCodePluginBuild(paiDir: string): { passed: boolean; detail: string } {
  const pluginPath = join(paiDir, "plugins", "pai-opencode.ts");
  if (!existsSync(pluginPath)) {
    return { passed: false, detail: "Plugin not found at plugins/pai-opencode.ts" };
  }

  const outPath = join(tmpdir(), `pai-opencode-plugin-${Date.now()}.js`);
  try {
    const res = spawnSync(process.execPath, ["build", pluginPath, "--outfile", outPath, "--target", "bun"], {
      encoding: "utf-8",
      timeout: 10000,
      env: { HOME: homedir(), PATH: process.env.PATH || "" },
    });
    if (res.status !== 0) {
      const stderr = (res.stderr || "").toString().trim();
      return { passed: false, detail: `Plugin build failed: ${stderr.slice(0, 180) || "no stderr"}` };
    }
    return { passed: true, detail: "Plugin builds successfully" };
  } catch (err: any) {
    return { passed: false, detail: `Plugin build threw: ${err?.message || String(err)}` };
  } finally {
    try {
      rmSync(outPath, { force: true });
    } catch {}
  }
}

/**
 * Run all validation checks against the current state.
 */
export async function runValidation(state: InstallState, emit?: EngineEventHandler): Promise<ValidationCheck[]> {
  if (emit) {
    await emit({ event: "step_start", step: "validation" });
    await emit({
      event: "section_header",
      sectionId: "FINAL-VALIDATION",
      title: "FINAL VALIDATION",
      subtitle: "Verifying the install before handing control back to you",
      stepNumber: 9,
    });
  }

  const paiDir = state.detection?.paiDir || join(homedir(), ".claude");
  const configDir = state.detection?.configDir || join(homedir(), ".config", "PAI");
  const framework = state.detection?.framework;
  const dataDir = getPaiDataDir();
  const checks: ValidationCheck[] = [];

  // 1. settings.json exists and is valid JSON
  const settingsPath = join(paiDir, "settings.json");
  const settingsExists = existsSync(settingsPath);
  let settingsValid = false;
  let settings: any = null;

  if (settingsExists) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      settingsValid = true;
    } catch {
      settingsValid = false;
    }
  }

  checks.push({
    name: "settings.json",
    passed: settingsExists && settingsValid,
    detail: settingsValid
      ? "Valid configuration file"
      : settingsExists
        ? "File exists but invalid JSON"
        : "File not found",
    critical: true,
  });

  if (framework) {
    const instructionPath = join(paiDir, framework.instructionFile);
    checks.push({
      name: `${framework.displayName} instructions`,
      passed: existsSync(instructionPath),
      detail: existsSync(instructionPath) ? `Present at ${instructionPath}` : `${framework.instructionFile} missing`,
      critical: true,
    });

    if (framework.id === "codex") {
      const codexConfigPath = join(paiDir, "config.toml");
      const codexHooksPath = join(paiDir, "hooks.json");
      const codexPromptPath = join(paiDir, "prompts", "cs.md");
      const codexInterviewPromptPath = join(paiDir, "prompts", "interview.md");
      const codexAgentPath = join(paiDir, "agents", "engineer.toml");
      const codexSkillPath = join(paiDir, "skills", "ContextSearch", "SKILL.md");
      const memoryDeletePath = join(paiDir, "PAI", "TOOLS", "MemoryDelete.ts");
      const codexPromptContent = existsSync(codexPromptPath) ? readFileSync(codexPromptPath, "utf-8") : "";
      const codexInterviewPromptContent = existsSync(codexInterviewPromptPath) ? readFileSync(codexInterviewPromptPath, "utf-8") : "";
      checks.push({
        name: "Codex config.toml",
        passed: existsSync(codexConfigPath),
        detail: existsSync(codexConfigPath) ? "Present" : "Missing",
        critical: true,
      });
      checks.push({
        name: "Codex hooks.json",
        passed: existsSync(codexHooksPath),
        detail: existsSync(codexHooksPath) ? "Present" : "Missing",
        critical: true,
      });
      checks.push({
        name: "Codex home skills",
        passed: existsSync(codexSkillPath),
        detail: existsSync(codexSkillPath) ? "ContextSearch present in Codex home skills" : "ContextSearch missing from Codex home skills",
        critical: false,
      });
      checks.push({
        name: "Codex command prompts",
        passed: existsSync(codexPromptPath) && !codexPromptContent.includes('Skill("'),
        detail: existsSync(codexPromptPath)
          ? !codexPromptContent.includes('Skill("')
            ? "PAI commands generated as Codex prompts"
            : "prompts/cs.md still contains Claude-style Skill(...) redirect"
          : "prompts/cs.md missing",
        critical: false,
      });
      checks.push({
        name: "Codex Interview skill bridge",
        passed: existsSync(codexInterviewPromptPath) && codexInterviewPromptContent.includes("$Interview") && !codexInterviewPromptContent.includes('Skill("'),
        detail: existsSync(codexInterviewPromptPath)
          ? codexInterviewPromptContent.includes("$Interview") && !codexInterviewPromptContent.includes('Skill("')
            ? "prompts/interview.md falls back to Codex skill mention syntax"
            : "prompts/interview.md does not invoke the Interview skill in Codex form"
          : "prompts/interview.md missing",
        critical: false,
      });
      checks.push({
        name: "Codex native agents",
        passed: existsSync(codexAgentPath),
        detail: existsSync(codexAgentPath) ? "PAI agents generated as TOML" : "agents/engineer.toml missing",
        critical: false,
      });
      checks.push({
        name: "Codex memory deletion",
        passed: existsSync(memoryDeletePath),
        detail: existsSync(memoryDeletePath) ? "MemoryDelete.ts installed" : "PAI/TOOLS/MemoryDelete.ts missing",
        critical: true,
      });
    } else if (framework.id === "opencode") {
      const openCodeConfigPath = join(paiDir, "opencode.json");
      const openCodePluginPath = join(paiDir, "plugins", "pai-opencode.ts");
      const openCodeCommandPath = join(paiDir, "commands", "cs.md");
      const openCodeAgentPath = join(paiDir, "agents", "Engineer.md");
      const openCodeAgentContent = existsSync(openCodeAgentPath) ? readFileSync(openCodeAgentPath, "utf-8") : "";
      const openCodeCommandContent = existsSync(openCodeCommandPath) ? readFileSync(openCodeCommandPath, "utf-8") : "";
      checks.push({
        name: "OpenCode config",
        passed: existsSync(openCodeConfigPath),
        detail: existsSync(openCodeConfigPath) ? "Present" : "Missing",
        critical: true,
      });
      checks.push({
        name: "OpenCode PAI plugin",
        passed: existsSync(openCodePluginPath),
        detail: existsSync(openCodePluginPath) ? "Present in plugins/pai-opencode.ts" : "Missing from plugins/",
        critical: true,
      });
      checks.push({
        name: "OpenCode commands",
        passed: existsSync(openCodeCommandPath)
          && !openCodeCommandContent.includes("argument-hint:")
          && !openCodeCommandContent.includes('Skill("'),
        detail: existsSync(openCodeCommandPath)
          ? !openCodeCommandContent.includes("argument-hint:") && !openCodeCommandContent.includes('Skill("')
            ? "PAI commands generated as OpenCode markdown"
            : "commands/cs.md still contains Claude-only frontmatter or Skill(...) redirect"
          : "commands/cs.md missing",
        critical: false,
      });
      checks.push({
        name: "OpenCode native agents",
        passed: existsSync(openCodeAgentPath) && !openCodeAgentContent.includes("initialPrompt:"),
        detail: existsSync(openCodeAgentPath)
          ? !openCodeAgentContent.includes("initialPrompt:")
            ? "PAI agents generated as OpenCode markdown"
            : "agents/Engineer.md still contains Claude-only frontmatter"
          : "agents/Engineer.md missing",
        critical: false,
      });
    }
  }

  // 2. Required settings fields
  if (settings) {
    checks.push({
      name: "Principal name",
      passed: !!settings.principal?.name,
      detail: settings.principal?.name ? `Set to: ${settings.principal.name}` : "Not configured",
      critical: true,
    });

    checks.push({
      name: "AI identity",
      passed: !!settings.daidentity?.name,
      detail: settings.daidentity?.name ? `Set to: ${settings.daidentity.name}` : "Not configured",
      critical: true,
    });

    checks.push({
      name: "PAI version",
      passed: !!settings.pai?.version,
      detail: settings.pai?.version ? `v${settings.pai.version}` : "Not set",
      critical: false,
    });

    checks.push({
      name: "Timezone",
      passed: !!settings.principal?.timezone,
      detail: settings.principal?.timezone || "Not configured",
      critical: false,
    });
  }

  // 3. Directory structure
  const requiredDirs = [
    { path: "skills", name: "Skills directory" },
    { path: "MEMORY", name: "Memory directory" },
    { path: "MEMORY/STATE", name: "State directory" },
    { path: "MEMORY/WORK", name: "Work directory" },
    { path: "hooks", name: "Hooks directory" },
    { path: "Plans", name: "Plans directory" },
  ];

  for (const dir of requiredDirs) {
    const fullPath = join(paiDir, dir.path);
    checks.push({
      name: dir.name,
      passed: existsSync(fullPath),
      detail: existsSync(fullPath) ? "Present" : "Missing",
      critical: dir.path === "skills" || dir.path === "MEMORY",
    });
  }

  const globalMemoryPath = join(dataDir, "MEMORY");
  checks.push({
    name: "Global memory store",
    passed: existsSync(globalMemoryPath),
    detail: existsSync(globalMemoryPath) ? `Present at ${globalMemoryPath}` : "Missing",
    critical: true,
  });

  const globalUserPath = join(dataDir, "USER");
  checks.push({
    name: "Global USER context store",
    passed: existsSync(globalUserPath),
    detail: existsSync(globalUserPath) ? `Present at ${globalUserPath}` : "Missing",
    critical: true,
  });

  const frameworkMemoryPath = join(paiDir, "PAI", "MEMORY");
  checks.push({
    name: "Framework memory path",
    passed: existsSync(frameworkMemoryPath),
    detail: existsSync(frameworkMemoryPath) ? `Available at ${frameworkMemoryPath}` : "Missing PAI/MEMORY",
    critical: true,
  });

  const frameworkUserPath = join(paiDir, "PAI", "USER");
  checks.push({
    name: "Framework USER context path",
    passed: existsSync(frameworkUserPath),
    detail: existsSync(frameworkUserPath) ? `Available at ${frameworkUserPath}` : "Missing PAI/USER",
    critical: true,
  });

  // 4. Representative PAI skill present
  const skillPath = join(paiDir, "skills", "ContextSearch", "SKILL.md");
  checks.push({
    name: "PAI skill library",
    passed: existsSync(skillPath),
    detail: existsSync(skillPath) ? "ContextSearch present" : "ContextSearch missing — install PAI skills to enable",
    critical: false,
  });

  // 5. ElevenLabs key stored — check all three possible locations
  const envPaths = [
    join(configDir, ".env"),
    join(paiDir, ".env"),
    join(homedir(), ".env"),
  ];
  let elevenLabsKeyStored = false;
  let elevenLabsKeyLocation = "";
  for (const ep of envPaths) {
    if (existsSync(ep)) {
      try {
        const envContent = readFileSync(ep, "utf-8");
        if (envContent.includes("ELEVENLABS_API_KEY=") &&
            !envContent.includes("ELEVENLABS_API_KEY=\n")) {
          elevenLabsKeyStored = true;
          elevenLabsKeyLocation = ep;
          break;
        }
      } catch {}
    }
  }

  checks.push({
    name: "ElevenLabs API key",
    passed: elevenLabsKeyStored,
    detail: elevenLabsKeyStored ? `Stored in ${elevenLabsKeyLocation}` : state.collected.elevenLabsKey ? "Collected but not saved" : "Not configured",
    critical: false,
  });

  // 6. DA voice configured in settings (nested under voices.main.voiceId)
  const voiceId = settings?.daidentity?.voices?.main?.voiceId;
  const voiceIdConfigured = !!voiceId;

  checks.push({
    name: "DA voice ID",
    passed: voiceIdConfigured,
    detail: voiceIdConfigured ? `Voice ID: ${voiceId.substring(0, 8)}...` : "Not configured",
    critical: false,
  });

  // 7. Pulse running — embeds voice + dashboard + observability (PAI 5.0)
  const pulseHealthy = await checkPulseHealth();
  const pulseInstallCommand = pulseManualStartCommand(paiDir);

  checks.push({
    name: "Pulse (voice + dashboard)",
    passed: pulseHealthy,
    detail: pulseHealthy
      ? "Running on localhost:31337"
      : `Not reachable — install via: ${pulseInstallCommand}`,
    critical: false,
  });

  if (process.platform === "darwin") {
  // 7b. Pulse launchd plist present (auto-start on login)
  const pulsePlist = join(homedir(), "Library", "LaunchAgents", "com.pai.pulse.plist");
  const pulsePlistInstalled = existsSync(pulsePlist);
  checks.push({
    name: "Pulse launchd agent",
    passed: pulsePlistInstalled,
    detail: pulsePlistInstalled
      ? "Installed at ~/Library/LaunchAgents/com.pai.pulse.plist"
      : "Not installed — Pulse will not auto-start on login",
    critical: false,
  });
  } else if (process.platform === "win32") {
    const taskInstalled = checkWindowsPulseTask();
    checks.push({
      name: "Pulse startup task",
      passed: taskInstalled,
      detail: taskInstalled
        ? "Installed as scheduled task: PAI Pulse"
        : `Not installed — install via: powershell -NoProfile -ExecutionPolicy Bypass -File ${JSON.stringify(join(paiDir, "PAI", "PULSE", "manage.ps1"))} install`,
      critical: false,
    });
  } else {
    checks.push({
      name: "Pulse auto-start",
      passed: true,
      detail: "Skipped on this OS; launchd auto-start is macOS-only",
      critical: false,
    });
  }

  // 8. Shell alias configured
  const rcFile = shellRcFile();
  let aliasConfigured = false;
  if (existsSync(rcFile.path)) {
    try {
      const rcContent = readFileSync(rcFile.path, "utf-8");
      const paiConfigured = rcContent.includes("alias pai") || rcContent.includes("function pai");
      const kConfigured = rcContent.includes("alias k") || rcContent.includes("function k");
      const pathConfigured = rcContent.includes("PAI_DIR")
        && (process.platform !== "win32" || rcContent.includes("Initialize-PAIEnvironment"));
      aliasConfigured = rcContent.includes("# PAI alias") && paiConfigured && kConfigured && pathConfigured;
    } catch {}
  }

  checks.push({
    name: "Shell aliases (k, pai)",
    passed: aliasConfigured,
    detail: aliasConfigured ? `Configured in ${rcFile.display}` : `Not found — run: ${rcFile.sourceCommand}`,
    critical: true,
  });

  // 9. SecurityPipeline smoke test — runs the actual hook with a benign Bash
  // payload. Catches the v5.0 fail-closed regression where PATTERNS.yaml was
  // missing from the public template, leaving every fresh install unable to
  // execute Bash commands. CRITICAL — if this fails, the install is broken.
  if (!framework || framework.id === "claude") {
    const securitySmoke = checkSecurityHookSmoke(paiDir, framework);
    checks.push({
      name: "SecurityPipeline hook (smoke test)",
      passed: securitySmoke.passed,
      detail: securitySmoke.detail,
      critical: true,
    });
  } else if (framework.id === "codex") {
    const securitySmoke = checkSecurityHookSmoke(paiDir, framework, true);
    checks.push({
      name: "Codex SecurityPipeline adapter (smoke test)",
      passed: securitySmoke.passed,
      detail: securitySmoke.detail,
      critical: true,
    });
  } else if (framework.id === "opencode") {
    const pluginBuild = checkOpenCodePluginBuild(paiDir);
    checks.push({
      name: "OpenCode PAI plugin (build)",
      passed: pluginBuild.passed,
      detail: pluginBuild.detail,
      critical: true,
    });

    const securitySmoke = checkSecurityHookSmoke(paiDir, framework, true);
    checks.push({
      name: "OpenCode SecurityPipeline adapter (smoke test)",
      passed: securitySmoke.passed,
      detail: securitySmoke.detail,
      critical: true,
    });
  } else {
    checks.push({
      name: "SecurityPipeline hook (framework adaptation)",
      passed: false,
      detail: `${framework.displayName} hook/plugin adapter is not enabled yet`,
      critical: false,
    });
  }

  return checks;
}

/**
 * Generate install summary from state.
 */
export function generateSummary(state: InstallState): InstallSummary {
  const framework = state.detection?.framework;
  const hasVoiceKey = !!state.collected.elevenLabsKey;
  const voiceEnabled = hasVoiceKey || (state.completedSteps.includes("voice") && process.platform === "darwin");
  const voiceMode = hasVoiceKey
    ? "elevenlabs"
    : state.completedSteps.includes("voice") && process.platform === "darwin"
      ? "macos-say"
      : "disabled";
  return {
    paiVersion: PAI_VERSION,
    framework: framework?.id || state.collected.framework || "claude",
    frameworkName: framework?.displayName || "Claude Code",
    principalName: state.collected.principalName || "User",
    aiName: state.collected.aiName || "PAI",
    timezone: state.collected.timezone || "UTC",
    voiceEnabled,
    voiceMode,
    catchphrase: state.collected.catchphrase || "",
    installType: state.installType || "fresh",
    completedSteps: state.completedSteps.length,
    totalSteps: 9,
  };
}

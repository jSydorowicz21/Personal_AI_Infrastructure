#!/usr/bin/env bun
/**
 * CodexNativeRuntimeSmokeTest
 *
 * Source-level regression checks for the product-critical native Codex paths:
 * Algorithm execution, Pulse AI jobs, Pulse chat modules, and Pulse static build.
 *
 * These are wiring/source-string guards only — they confirm the launchers are
 * shaped correctly but do NOT execute anything. The end-to-end runtime proof
 * (that runFrameworkAgent() and inference() actually spawn `codex exec` with the
 * contracted sandbox/flags/stdin) lives in CodexFrameworkAgentExecutionSmokeTest.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const releaseRoot = resolve(import.meta.dir, "..", "..");
const paiRoot = join(releaseRoot, "PAI");
const checks: Check[] = [];

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

function walkTextFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "cache"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(path, acc);
    else if (/\.(ts|tsx|js|html|txt|json|md|css)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

const frameworkAgent = read(join(paiRoot, "TOOLS", "lib", "framework-agent.ts"));
const algorithm = read(join(paiRoot, "TOOLS", "algorithm.ts"));
const paiCli = read(join(paiRoot, "TOOLS", "pai.ts"));
const configGen = read(join(paiRoot, "PAI-Install", "engine", "config-gen.ts"));
const inferenceTool = read(join(paiRoot, "TOOLS", "Inference.ts"));
const transcriptParser = read(join(paiRoot, "TOOLS", "TranscriptParser.ts"));
const transcriptRoots = read(join(paiRoot, "TOOLS", "lib", "transcripts.ts"));
const costAggregator = read(join(paiRoot, "PULSE", "Performance", "cost-aggregator.ts"));
const bannerSources = [
  "Banner.ts",
  "BannerNeofetch.ts",
  "BannerMatrix.ts",
  "BannerRetro.ts",
  "NeofetchBanner.ts",
].map((file) => read(join(paiRoot, "TOOLS", file))).join("\n");
const promptProcessing = read(join(releaseRoot, "hooks", "PromptProcessing.hook.ts"));
const hookAdapter = read(join(releaseRoot, "hooks", "FrameworkHookAdapter.ts"));
const rtkHook = read(join(releaseRoot, "hooks", "RtkPreToolUse.hook.js"));
const telosSummaryHook = read(join(releaseRoot, "hooks", "TelosSummarySync.hook.ts"));
const tabSetter = read(join(releaseRoot, "hooks", "lib", "tab-setter.ts"));
const isaUtils = read(join(releaseRoot, "hooks", "lib", "isa-utils.ts"));
const codexHookTriggerSmoke = read(join(paiRoot, "TOOLS", "CodexHookTriggerSmokeTest.ts"));
const codexRealSessionHookProof = read(join(paiRoot, "TOOLS", "CodexRealSessionHookProof.ts"));
const changeDetection = read(join(releaseRoot, "hooks", "lib", "change-detection.ts"));
const docCrossRefIntegrity = read(join(releaseRoot, "hooks", "handlers", "DocCrossRefIntegrity.ts"));
const rebuildArchSummary = read(join(releaseRoot, "hooks", "handlers", "RebuildArchSummary.ts"));
const systemIntegrity = read(join(releaseRoot, "hooks", "handlers", "SystemIntegrity.ts"));
const branchValidation = read(join(paiRoot, "TOOLS", "CodexBranchValidation.ts"));
const opencodePlugin = read(join(releaseRoot, "plugins", "pai-opencode.ts"));
const pulseManage = read(join(paiRoot, "PULSE", "manage.ps1"));
const pulseLib = read(join(paiRoot, "PULSE", "lib.ts"));
const pulse = read(join(paiRoot, "PULSE", "pulse.ts"));
const githubWork = read(join(paiRoot, "PULSE", "checks", "github-work.ts"));
const telegram = read(join(paiRoot, "PULSE", "modules", "telegram.ts"));
const imessage = read(join(paiRoot, "PULSE", "modules", "imessage.ts"));
const pulseToml = read(join(paiRoot, "PULSE", "PULSE.toml"));
const pulsePackage = read(join(paiRoot, "PULSE", "package.json"));
const setup = read(join(paiRoot, "PULSE", "setup.ts"));
const nextConfig = read(join(paiRoot, "PULSE", "Observability", "next.config.ts"));
const claudeAgentSdkPackage = ["@anthropic-ai", "claude-agent-sdk"].join("/");

check(
  "framework agent launches Codex exec with workspace-write",
  frameworkAgent.includes('"codex"') &&
    frameworkAgent.includes('"exec"') &&
    frameworkAgent.includes('"--sandbox"') &&
    frameworkAgent.includes('"workspace-write"') &&
    frameworkAgent.indexOf('if (framework === "codex")') < frameworkAgent.indexOf('Bun.which("claude")'),
  "PAI/TOOLS/lib/framework-agent.ts (source shape; runtime: CodexFrameworkAgentExecutionSmokeTest)",
);

check(
  "Inference chooses Codex before Claude fallback",
  inferenceTool.includes('const framework = getActiveFramework()') &&
    inferenceTool.includes('const useOpenCode = framework === "opencode"') &&
    inferenceTool.includes('const useCodex = !useOpenCode && (framework === "codex"') &&
    inferenceTool.indexOf('if (useCodex)') < inferenceTool.indexOf("spawn('claude'"),
  "PAI/TOOLS/Inference.ts (source shape; runtime: CodexFrameworkAgentExecutionSmokeTest)",
);

check(
  "Prompt classifier reads bounded transcript context",
  promptProcessing.includes("DEFAULT_CLASSIFIER_CONTEXT_BYTES") &&
    promptProcessing.includes("PAI_PROMPT_CLASSIFIER_CONTEXT_BYTES") &&
    promptProcessing.includes("DEFAULT_CLASSIFIER_CONTEXT_TURNS") &&
    promptProcessing.includes("PAI_PROMPT_CLASSIFIER_CONTEXT_TURNS") &&
    promptProcessing.includes("readFileTail(transcriptPath, classifierContextBytes())") &&
    promptProcessing.includes("getRecentContext(data.transcript_path, classifierContextTurns(), !isFirstPrompt)") &&
    !promptProcessing.includes("const content = readFileSync(transcriptPath, 'utf-8');"),
  "hooks/PromptProcessing.hook.ts",
);

check(
  "PromptProcessing resolves provider-native session transcripts",
  promptProcessing.includes("findSessionJsonlInDir") &&
    promptProcessing.includes("join(frameworkDir, 'sessions')") &&
    promptProcessing.includes("data.transcript_path") &&
    !promptProcessing.includes("Bun.spawnSync(['find'"),
  "hooks/PromptProcessing.hook.ts",
);

check(
  "Algorithm uses framework agent launcher",
  algorithm.includes("buildFrameworkAgentCommand") &&
    !/spawnSync\(\s*["']claude["']/.test(algorithm) &&
    !/spawn\(\s*["']claude["']/.test(algorithm) &&
    !/Bun\.spawn\(\s*\[\s*["']claude["']/.test(algorithm) &&
    !algorithm.includes("--bare"),
  "loop, parallel, interactive, and ideate modes",
);

check(
  "Pulse cron jobs use active AI launcher",
  pulseLib.includes("export async function spawnAI") &&
    pulseLib.includes("export const spawnClaude = spawnAI") &&
    pulse.includes("spawnAI") &&
    !pulse.includes("spawnClaude"),
  "legacy alias remains in lib only",
);

check(
  "Pulse worker uses framework agent launcher",
  githubWork.includes("runFrameworkAgent") &&
    !githubWork.includes('Bun.which("claude")') &&
    !githubWork.includes("claudePath") &&
    !githubWork.includes("claude --print"),
  "PAI/PULSE/checks/github-work.ts",
);

check(
  "Pulse chat modules route from active framework state",
    telegram.includes("await inference({") &&
    imessage.includes("await inference({") &&
    !telegram.includes(claudeAgentSdkPackage) &&
    !imessage.includes(claudeAgentSdkPackage) &&
    !pulsePackage.includes(claudeAgentSdkPackage),
  "Telegram and iMessage use PAI Inference, not Claude Agent SDK",
);

check(
  "PAI one-shot prompt uses Codex exec stdin",
  paiCli.includes('"exec", "--sandbox", "workspace-write"') &&
    paiCli.includes('new Blob([prompt])') &&
    !paiCli.includes('["claude", "-p", prompt]'),
  "PAI/TOOLS/pai.ts",
);

check(
  "PAI CLI update/version paths are Windows-native",
  paiCli.includes("spawnSync([process.execPath, BANNER_SCRIPT]") &&
    paiCli.includes("function frameworkCliPackage") &&
    paiCli.includes("function getGlobalCliPackageVersion") &&
    paiCli.includes('join(process.env.APPDATA, "npm", "node_modules")') &&
    paiCli.includes('process.platform === "win32"') &&
    paiCli.includes("getGlobalCliPackageVersion(frameworkCliPackage(framework))") &&
    paiCli.includes('spawnSync([process.execPath, "install", "-g", frameworkCliPackage(activeFramework)]') &&
    paiCli.includes("result.stderr?.toString()") &&
    paiCli.includes("...frameworkEnv(root, framework)"),
  "PAI/TOOLS/pai.ts",
);

check(
  "PAI CLI MCP profile detection avoids readlink child process",
  paiCli.includes("realpathSync(ACTIVE_MCP)") &&
    !paiCli.includes('Bun.spawnSync(["readlink"'),
  "PAI/TOOLS/pai.ts",
);

check(
  "Codex hook generation avoids encoded PowerShell",
  configGen.includes("function windowsBunExe") &&
    configGen.includes("FrameworkHookAdapter.ts") &&
    configGen.includes("windowsCommandArg(windowsBunExe())") &&
    !configGen.includes("-EncodedCommand") &&
    !configGen.includes("powershell.exe") &&
    !configGen.includes("hookCommandPowerShell") &&
    !paiCli.includes("powerShellEncodedCommand") &&
    !paiCli.includes("-EncodedCommand"),
  "PAI/PAI-Install/engine/config-gen.ts and PAI/TOOLS/pai.ts",
);

check(
  "Framework hook adapter derives PAI env fallback",
  hookAdapter.includes("const frameworkDir = resolve(join(hooksDir, \"..\"))") &&
    hookAdapter.includes("PAI_DIR: paiDir") &&
    hookAdapter.includes("PAI_DATA_DIR: dataDir") &&
    hookAdapter.includes("PAI_FRAMEWORK_DIR: frameworkDir") &&
    hookAdapter.includes("PAI_CONFIG_DIR: configDir"),
  "hooks/FrameworkHookAdapter.ts",
);

check(
  "Framework AI launchers hide child windows on Windows",
  frameworkAgent.includes("windowsHide: true") &&
    inferenceTool.match(/windowsHide:\s*true/g)?.length >= 3 &&
    algorithm.includes("windowsHide: true") &&
    paiCli.includes("windowsHide: true"),
  "PAI/TOOLS/Inference.ts, algorithm.ts, pai.ts, and lib/framework-agent.ts",
);

check(
  "PAI banner startup avoids Windows-visible POSIX probes",
  paiCli.includes("spawnSync([process.execPath, BANNER_SCRIPT]") &&
    paiCli.includes("windowsHide: true") &&
    bannerSources.includes("process.stdout.columns") &&
    (bannerSources.match(/process\.platform !== "win32" && \(!width \|\| width <= 0\)/g)?.length ?? 0) >= 10 &&
    (bannerSources.match(/windowsHide:\s*true/g)?.length ?? 0) >= 11,
  "PAI/TOOLS/Banner*.ts and pai.ts",
);

check(
  "RTK hook rejects Windows-unsafe rewrites without fast bypass",
  rtkHook.includes("isWindowsUnsafeRtkRewrite") &&
    rtkHook.includes("windows_unsafe_rtk_rewrite") &&
    rtkHook.includes("isWindowsUnresolvableRtkRewrite") &&
    rtkHook.includes("windows_unresolvable_rtk_rewrite") &&
    !rtkHook.includes("fast_bypass"),
  "hooks/RtkPreToolUse.hook.js",
);

check(
  "Telos summary hook avoids shell exec on regeneration",
  telosSummaryHook.includes("spawnSync(process.execPath, [GENERATOR]") &&
    telosSummaryHook.includes("windowsHide: true") &&
    !telosSummaryHook.includes("execSync"),
  "hooks/TelosSummarySync.hook.ts",
);

check(
  "Tab setter avoids shell exec for terminal metadata",
  tabSetter.includes("spawnSync(resolved, args") &&
    tabSetter.includes("findExecutable(command)") &&
    tabSetter.includes("windowsHide: true") &&
    tabSetter.includes("JSON.parse(liveOutput)") &&
    !tabSetter.includes("execSync") &&
    !tabSetter.includes("| jq"),
  "hooks/lib/tab-setter.ts",
);

check(
  "ISA utils reads subagent tail without shell exec",
  isaUtils.includes("function readTailLines") &&
    isaUtils.includes("readSync(fd, buffer") &&
    isaUtils.includes("readTailLines(eventsPath, 200)") &&
    !isaUtils.includes("execSync") &&
    !isaUtils.includes("tail -200") &&
    !isaUtils.includes("require('child_process')"),
  "hooks/lib/isa-utils.ts",
);

check(
  "Codex hook proof utilities keep child windows hidden",
  codexHookTriggerSmoke.includes("windowsHide: true") &&
    codexRealSessionHookProof.includes("windowsHide: true"),
  "PAI/TOOLS/CodexHookTriggerSmokeTest.ts and CodexRealSessionHookProof.ts",
);

check(
  "Pulse Windows launcher avoids visible shim windows",
  pulseManage.includes("npm\\node_modules\\bun") &&
    pulseManage.includes("bin\\bun.exe") &&
    pulseManage.includes("Test-Path -LiteralPath $candidate") &&
    pulseManage.includes("-WindowStyle Hidden") &&
    pulseManage.includes("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass"),
  "PAI/PULSE/manage.ps1",
);

check(
  "Stop transcript parser understands Codex response_item events",
  transcriptParser.includes("entry?.type === 'response_item'") &&
    transcriptParser.includes("entry.payload?.type === 'message'") &&
    transcriptParser.includes("entry.payload?.type === 'function_call'") &&
    transcriptParser.includes("requestuserinput"),
  "PAI/TOOLS/TranscriptParser.ts",
);

check(
  "Shared transcript roots discover provider-native session trees",
  transcriptRoots.includes("getClaudeProjectDirs") &&
    transcriptRoots.includes('return getClaudeProjectDirs(root)') &&
    transcriptRoots.includes('join(root, "sessions")') &&
    transcriptRoots.includes('join(getPaiDataDir(), "TRANSCRIPTS", "opencode")'),
  "PAI/TOOLS/lib/transcripts.ts",
);

check(
  "Pulse cost aggregator parses Codex token_count events",
  costAggregator.includes("getFrameworkSessionRoots") &&
    costAggregator.includes("payload?.type !== \"token_count\"") &&
    costAggregator.includes("total_token_usage") &&
    costAggregator.includes("codex-subscription") &&
    costAggregator.includes('billingSource = "subscription"') &&
    !costAggregator.includes('join(FRAMEWORK_DIR, "projects")'),
  "PAI/PULSE/Performance/cost-aggregator.ts",
);

check(
  "Integrity change detection understands Codex writes and patches",
  changeDetection.includes("entry.type === 'response_item'") &&
    changeDetection.includes("entry.payload?.type === 'function_call'") &&
    changeDetection.includes("parseModifiedFilePaths") &&
    changeDetection.includes("*** Begin Patch"),
  "hooks/lib/change-detection.ts",
);

check(
  "Doc integrity uses shared provider-aware modified-file parser",
  docCrossRefIntegrity.includes("parseModifiedFilePaths") &&
    !docCrossRefIntegrity.includes("entry.type === 'assistant' && entry.message?.content"),
  "hooks/handlers/DocCrossRefIntegrity.ts",
);

check(
  "Doc integrity keeps provider inference opt-in",
  docCrossRefIntegrity.includes("function docInferenceEnabled") &&
    docCrossRefIntegrity.includes("PAI_DOC_INFERENCE") &&
    docCrossRefIntegrity.includes("PAI_DOC_INTEGRITY_INFERENCE") &&
    docCrossRefIntegrity.includes("level: 'fast'") &&
    docCrossRefIntegrity.includes("timeout: 5000") &&
    docCrossRefIntegrity.includes("Skipped; set PAI_DOC_INFERENCE=1"),
  "hooks/handlers/DocCrossRefIntegrity.ts",
);

check(
  "Arch summary rebuild watches active framework instruction files",
  rebuildArchSummary.includes('"DOCUMENTATION", "ARCHITECTURE_SUMMARY.md"') &&
    rebuildArchSummary.includes('"TOOLS", "ArchitectureSummaryGenerator.ts"') &&
    rebuildArchSummary.includes('"AGENTS.md"') &&
    rebuildArchSummary.includes('"RTK.md"') &&
    rebuildArchSummary.includes("process.execPath") &&
    !rebuildArchSummary.includes('spawn("bun"') &&
    !rebuildArchSummary.includes('"PAI_ARCHITECTURE_SUMMARY.md"') &&
    !rebuildArchSummary.includes('"Tools/ArchitectureSummaryGenerator.ts"'),
  "hooks/handlers/RebuildArchSummary.ts",
);

check(
  "Integrity maintenance stays hidden on Windows",
  systemIntegrity.includes("process.execPath") &&
    systemIntegrity.includes("windowsHide: true") &&
    !systemIntegrity.includes("spawn('bun'") &&
    !systemIntegrity.includes('spawn("bun"'),
  "hooks/handlers/SystemIntegrity.ts",
);

check(
  "Branch validation avoids visible Windows cmd shims",
  branchValidation.includes('command === "bun" ? process.execPath') &&
    branchValidation.includes("windowsHide: true") &&
    !branchValidation.includes("const resolvedCommand = Bun.which(command) || command;"),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "Branch validation keeps deep probes opt-in locally",
  branchValidation.includes('type ValidationMode = "safe" | "deep"') &&
    branchValidation.includes('process.env.GITHUB_ACTIONS === "true"') &&
    branchValidation.includes("safe local mode; pass --deep") &&
    branchValidation.includes('if (validationMode === "deep")') &&
    branchValidation.includes("Deep validation probes skipped"),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "Branch validation uses Codex-targeted framework smoke",
  branchValidation.includes('"PAI/TOOLS/FrameworkSmokeTest.ts", "--framework", "codex"') &&
    !branchValidation.includes('"PAI/TOOLS/FrameworkSmokeTest.ts"], { timeout: 240_000 }'),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "OpenCode plugin bounds hook adapter dispatch",
  opencodePlugin.includes("DEFAULT_HOOK_TIMEOUT_MS") &&
    opencodePlugin.includes("PAI_OPENCODE_HOOK_TIMEOUT_MS") &&
    opencodePlugin.includes("--timeout-ms") &&
    opencodePlugin.includes("timeout: timeout + 5_000") &&
    opencodePlugin.includes("windowsHide: true"),
  "plugins/pai-opencode.ts",
);

check(
  "OpenCode prompt hooks receive transcript context",
  opencodePlugin.includes("function workingDirectory(input: JsonObject)") &&
    opencodePlugin.includes("transcript_path: transcriptPath(input)") &&
    opencodePlugin.includes("const promptPayload = {") &&
    opencodePlugin.includes('runHook("PromptProcessing.hook.ts", promptPayload)') &&
    opencodePlugin.includes('observe("SatisfactionCapture.hook.ts", promptPayload)') &&
    opencodePlugin.includes("transcript_path: transcriptPath(event)"),
  "plugins/pai-opencode.ts",
);

check(
  "Pulse config teaches ai job type",
  pulseToml.includes('type = "ai"') &&
    !pulseToml.includes('type = "claude"') &&
    setup.includes('type = "ai"') &&
    !setup.includes('type = "claude"'),
  "legacy type remains accepted by loader",
);

check(
  "Pulse static export pins tracing root",
  nextConfig.includes("outputFileTracingRoot") &&
    nextConfig.includes("pai-pulse-static") &&
    !nextConfig.includes("Date.now()"),
  "PAI/PULSE/Observability/next.config.ts",
);

const outFiles = walkTextFiles(join(paiRoot, "PULSE", "Observability", "out"));
const staleOut = outFiles.filter((path) => read(path).includes("~/.claude/PAI/USER"));
check(
  "Pulse static export has no stale Claude USER path",
  staleOut.length === 0,
  staleOut.length ? staleOut.slice(0, 8).join("\n") : `${outFiles.length} exported text files scanned`,
);

check(
  "Pulse static export includes referenced logo",
  existsSync(join(paiRoot, "PULSE", "Observability", "public", "pai-logo.png")) &&
    existsSync(join(paiRoot, "PULSE", "Observability", "out", "pai-logo.png")),
  "public/pai-logo.png and out/pai-logo.png",
);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nCodex native runtime smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll Codex native runtime checks passed.");

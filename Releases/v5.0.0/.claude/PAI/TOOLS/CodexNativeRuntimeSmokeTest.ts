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
const installActions = read(join(paiRoot, "PAI-Install", "engine", "actions.ts"));
const installDetect = read(join(paiRoot, "PAI-Install", "engine", "detect.ts"));
const inferenceTool = read(join(paiRoot, "TOOLS", "Inference.ts"));
const transcriptParser = read(join(paiRoot, "TOOLS", "TranscriptParser.ts"));
const transcriptRoots = read(join(paiRoot, "TOOLS", "lib", "transcripts.ts"));
const architectureSummaryGenerator = read(join(paiRoot, "TOOLS", "ArchitectureSummaryGenerator.ts"));
const costAggregator = read(join(paiRoot, "PULSE", "Performance", "cost-aggregator.ts"));
const costTracker = read(join(paiRoot, "TOOLS", "CostTracker.ts"));
const removeBg = read(join(paiRoot, "TOOLS", "RemoveBg.ts"));
const forgeProgress = read(join(paiRoot, "TOOLS", "ForgeProgress.ts"));
const anvilProgress = read(join(paiRoot, "TOOLS", "AnvilProgress.ts"));
const crossVendorAudit = read(join(paiRoot, "TOOLS", "CrossVendorAudit.ts"));
const docCheck = read(join(paiRoot, "TOOLS", "DocCheck.ts"));
const gmailTool = read(join(paiRoot, "TOOLS", "gmail.ts"));
const referenceCheck = read(join(paiRoot, "TOOLS", "ReferenceCheck.ts"));
const bannerSources = [
  "Banner.ts",
  "BannerNeofetch.ts",
  "BannerMatrix.ts",
  "BannerRetro.ts",
  "NeofetchBanner.ts",
].map((file) => read(join(paiRoot, "TOOLS", file))).join("\n");
const promptProcessing = read(join(releaseRoot, "hooks", "PromptProcessing.hook.ts"));
const hookAdapter = read(join(releaseRoot, "hooks", "FrameworkHookAdapter.ts"));
const smartApprover = read(join(releaseRoot, "hooks", "SmartApprover.hook.ts"));
const checkpointPerIsc = read(join(releaseRoot, "hooks", "CheckpointPerISC.hook.ts"));
const rtkHook = read(join(releaseRoot, "hooks", "RtkPreToolUse.hook.js"));
const hookPathHelpers = read(join(releaseRoot, "hooks", "lib", "paths.ts"));
const toolActivityTracker = read(join(releaseRoot, "hooks", "ToolActivityTracker.hook.ts"));
const telosSummaryHook = read(join(releaseRoot, "hooks", "TelosSummarySync.hook.ts"));
const tabSetter = read(join(releaseRoot, "hooks", "lib", "tab-setter.ts"));
const isaUtils = read(join(releaseRoot, "hooks", "lib", "isa-utils.ts"));
const restoreContext = read(join(releaseRoot, "hooks", "RestoreContext.hook.ts"));
const patternInspector = read(join(releaseRoot, "hooks", "security", "inspectors", "PatternInspector.ts"));
const codexHookTriggerSmoke = read(join(paiRoot, "TOOLS", "CodexHookTriggerSmokeTest.ts"));
const codexRealSessionHookProof = read(join(paiRoot, "TOOLS", "CodexRealSessionHookProof.ts"));
const changeDetection = read(join(releaseRoot, "hooks", "lib", "change-detection.ts"));
const docCrossRefIntegrity = read(join(releaseRoot, "hooks", "handlers", "DocCrossRefIntegrity.ts"));
const rebuildArchSummary = read(join(releaseRoot, "hooks", "handlers", "RebuildArchSummary.ts"));
const systemIntegrity = read(join(releaseRoot, "hooks", "handlers", "SystemIntegrity.ts"));
const updateCounts = read(join(releaseRoot, "hooks", "handlers", "UpdateCounts.ts"));
const branchValidation = read(join(paiRoot, "TOOLS", "CodexBranchValidation.ts"));
const frameworkSmoke = read(join(paiRoot, "TOOLS", "FrameworkSmokeTest.ts"));
const frameworkCommandResolutionSmoke = read(join(paiRoot, "TOOLS", "FrameworkCommandResolutionSmokeTest.ts"));
const hotfixUpdateRollbackSmoke = read(join(paiRoot, "TOOLS", "HotfixUpdateRollbackSmokeTest.ts"));
const junctionSafeUpdateSmoke = read(join(paiRoot, "TOOLS", "JunctionSafeUpdateSmokeTest.ts"));
const memoryDeleteSmoke = read(join(paiRoot, "TOOLS", "MemoryDeleteSmokeTest.ts"));
const paiSecurityAuditSmoke = read(join(paiRoot, "TOOLS", "PaiSecurityAuditSmokeTest.ts"));
const checkpointTool = read(join(paiRoot, "TOOLS", "Checkpoint.ts"));
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
  "Codex classifier inference stays small and isolated",
  inferenceTool.includes('const CODEX_DEFAULT_CLASSIFIER_MODEL = "gpt-5.3-codex-spark"') &&
    inferenceTool.includes('if (level !== "smart" && process.env.PAI_CODEX_MODEL_CLASSIFIER)') &&
    inferenceTool.includes('if (level !== "smart")') &&
    inferenceTool.includes("return CODEX_DEFAULT_CLASSIFIER_MODEL") &&
    inferenceTool.includes('fast: "low"') &&
    inferenceTool.includes('"--ignore-user-config"') &&
    inferenceTool.includes('"--ignore-rules"') &&
    inferenceTool.includes('"--disable", "memories"') &&
    inferenceTool.includes('"--disable", "plugins"') &&
    inferenceTool.includes('"--sandbox", "read-only"') &&
    inferenceTool.includes('"-c", `model_reasoning_effort="${codexReasoning}"`') &&
    inferenceTool.includes('"-c", `plan_mode_reasoning_effort="${codexReasoning}"`'),
  "PAI/TOOLS/Inference.ts (runtime argv proof: CodexFrameworkAgentExecutionSmokeTest)",
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
  "Core PAI tools use Windows-aware home helper",
  algorithm.includes('import { homeDir, memoryPath } from "./lib/paths"') &&
    algorithm.includes("const HOME = homeDir()") &&
    !algorithm.includes('const HOME = process.env.HOME || "~"') &&
    costTracker.includes("homeDir, memoryPath") &&
    costTracker.includes("const HOME = homeDir()") &&
    !costTracker.includes("process.env.HOME ?? process.env.USERPROFILE") &&
    architectureSummaryGenerator.includes('import { getFrameworkDir, getPaiDir, homeDir } from "./lib/paths"') &&
    architectureSummaryGenerator.includes("const HOME = homeDir()") &&
    !architectureSummaryGenerator.includes('process.env.HOME || process.env.USERPROFILE || ""'),
  "PAI/TOOLS/algorithm.ts, CostTracker.ts, and ArchitectureSummaryGenerator.ts",
);

check(
  "SmartApprover uses active framework home helper",
  hookPathHelpers.includes("export function homeDir()") &&
    smartApprover.includes("import { getFrameworkDir, homeDir, userPath } from './lib/paths'") &&
    smartApprover.includes("const HOME = homeDir()") &&
    !smartApprover.includes("from 'os'"),
  "hooks/SmartApprover.hook.ts and hooks/lib/paths.ts",
);

check(
  "Checkpoint allowlists use active home and hidden git probes",
  checkpointPerIsc.includes("import { getFrameworkDir, homeDir } from './lib/paths'") &&
    checkpointPerIsc.includes("const HOME = homeDir()") &&
    !checkpointPerIsc.includes("from 'node:os'") &&
    checkpointPerIsc.includes("windowsHide: true") &&
    checkpointTool.includes("import { getFrameworkDir, homeDir, memoryPath } from './lib/paths'") &&
    checkpointTool.includes("const HOME = homeDir()") &&
    !checkpointTool.includes("from 'node:os'") &&
    checkpointTool.includes("windowsHide: true"),
  "hooks/CheckpointPerISC.hook.ts and PAI/TOOLS/Checkpoint.ts",
);

check(
  "Tool activity tracker hides git snapshots on Windows",
  toolActivityTracker.includes("CAPTURE_GIT_SNAPSHOT") &&
    toolActivityTracker.includes("windowsHide: true") &&
    (toolActivityTracker.match(/windowsHide:\s*true/g)?.length ?? 0) >= 2,
  "hooks/ToolActivityTracker.hook.ts",
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
  "Framework switch adapts provider system prompt",
  paiCli.includes('const systemPromptPath = join(root, "PAI", "PAI_SYSTEM_PROMPT.md")') &&
    paiCli.includes('writeFileSync(systemPromptPath, frameworkInstructionContent(readFileSync(systemPromptPath, "utf-8"), id))') &&
    installActions.includes('const systemPromptPath = join(paiDir, "PAI", "PAI_SYSTEM_PROMPT.md")') &&
    installActions.includes('frameworkInstructionContent(readFileSync(systemPromptPath, "utf-8"), target)'),
  "PAI/TOOLS/pai.ts and PAI/PAI-Install/engine/actions.ts",
);

check(
  "Installer avoids shell-string exec on Windows-sensitive paths",
  !installActions.includes("execSync") &&
    !installDetect.includes("execSync") &&
    installActions.includes("function trySpawn") &&
    installActions.includes("windowsHide: true") &&
    installActions.includes('tryGit(["clone", "https://github.com/danielmiessler/PAI.git", paiDir]') &&
    installDetect.includes("execFileSync") &&
    installDetect.includes("windowsHide: true"),
  "PAI/PAI-Install/engine/actions.ts and detect.ts",
);

check(
  "Framework hook adapter derives PAI env fallback",
  hookAdapter.includes("const frameworkDir = resolve(join(hooksDir, \"..\"))") &&
    hookAdapter.includes('import { homeDir } from "./lib/paths"') &&
    !hookAdapter.includes('from "os"') &&
    !hookAdapter.includes("process.env.HOME || process.env.USERPROFILE || homedir()") &&
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
  "Forge and Anvil progress tools resolve Windows homes",
  forgeProgress.includes('import { homeDir, memoryPath } from "./lib/paths"') &&
    anvilProgress.includes('import { getEnvPath, homeDir, memoryPath } from "./lib/paths"') &&
    !forgeProgress.includes('throw new Error("HOME is not set")') &&
    !anvilProgress.includes('throw new Error("HOME is not set")'),
  "PAI/TOOLS/ForgeProgress.ts and AnvilProgress.ts",
);

check(
  "Image tools use shared home helper and hidden child processes",
  removeBg.includes('import { homeDir } from "./lib/paths"') &&
    removeBg.includes("resolve(homeDir(), \".local/bin/rembg\")") &&
    removeBg.includes("windowsHide: true") &&
    !removeBg.includes("const home = process.env.HOME"),
  "PAI/TOOLS/RemoveBg.ts",
);

check(
  "Forge progress resolves Codex without hardcoded bun path",
  forgeProgress.includes("process.env.PAI_CODEX_BIN") &&
    forgeProgress.includes('Bun.which("codex")') &&
    forgeProgress.includes("function windowsSpawnArgs") &&
    forgeProgress.includes("windowsHide: true") &&
    !forgeProgress.includes('const codexPath = join(home, ".bun", "bin", "codex")'),
  "PAI/TOOLS/ForgeProgress.ts",
);

const nonNullHomePattern = "process.env." + "HOME!";
const homeBangFiles = walkTextFiles(join(paiRoot, "TOOLS"))
  .filter((path) => read(path).includes(nonNullHomePattern));
check(
  "PAI tools avoid non-null HOME assumptions",
  homeBangFiles.length === 0,
  homeBangFiles.length ? homeBangFiles.slice(0, 8).join("\n") : "PAI/TOOLS scanned",
);

const manualToolShellFiles = [
  "CostTracker.ts",
  "DocCheck.ts",
  "GetTranscript.ts",
  "KnowledgeHarvester.ts",
  "ReferenceCheck.ts",
  "RelationshipReflect.ts",
].map((file) => join(paiRoot, "TOOLS", file))
  .filter((path) => {
    const source = read(path);
    return source.includes("execSync(") || source.includes("require(\"child_process\")");
  });
check(
  "Manual PAI tools avoid shell-string exec",
  manualToolShellFiles.length === 0,
  manualToolShellFiles.length ? manualToolShellFiles.slice(0, 8).join("\n") : "manual tools scanned",
);

check(
  "Manual PAI tools use shared home helpers",
  !docCheck.includes("const HOME = process.env.HOME ||") &&
    !referenceCheck.includes("const HOME = process.env.HOME ||") &&
    gmailTool.includes('import { expandHome, userPath } from "./lib/paths"') &&
    gmailTool.includes("expandHome(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE)") &&
    !gmailTool.includes('from "node:os"') &&
    crossVendorAudit.includes('import { expandHome, homeDir, memoryPath } from "./lib/paths"') &&
    crossVendorAudit.includes("const HOME = homeDir()") &&
    crossVendorAudit.includes("function resolveCodexBin()") &&
    crossVendorAudit.includes('Bun.which("codex")') &&
    crossVendorAudit.includes("function windowsSpawnArgs") &&
    crossVendorAudit.includes("windowsHide: true") &&
    !crossVendorAudit.includes('from "node:os"') &&
    !crossVendorAudit.includes('const CODEX_BIN = join(HOME, ".bun", "bin", "codex")'),
  "PAI/TOOLS/CrossVendorAudit.ts, DocCheck.ts, gmail.ts, ReferenceCheck.ts",
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
    rtkHook.includes("function homeDir()") &&
    rtkHook.includes("return process.env.PAI_DATA_DIR || join(homeDir(), \".pai\")") &&
    !rtkHook.includes("fast_bypass"),
  "hooks/RtkPreToolUse.hook.js",
);

check(
  "Security pattern inspector uses shared home helper",
  patternInspector.includes("homeDir, paiPath, userPath") &&
    patternInspector.includes("const home = homeDir()") &&
    !patternInspector.includes("homedir()"),
  "hooks/security/inspectors/PatternInspector.ts",
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
  "RestoreContext locates recent ISA without shell exec",
  restoreContext.includes("function findRecentArtifact") &&
    restoreContext.includes("readdirSync(dir, { withFileTypes: true })") &&
    restoreContext.includes("findRecentArtifact(workDir, 'ISA.md'") &&
    !restoreContext.includes("execSync") &&
    !restoreContext.includes("fd -t f") &&
    !restoreContext.includes("head -1"),
  "hooks/RestoreContext.hook.ts",
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
  "UpdateCounts avoids shell credential lookup",
  updateCounts.includes("spawnSync('security', [") &&
    updateCounts.includes("windowsHide: true") &&
    updateCounts.includes("join(getClaudeDir(), '.credentials.json')") &&
    !updateCounts.includes("execSync") &&
    !updateCounts.includes("process.env.HOME || ''"),
  "hooks/handlers/UpdateCounts.ts",
);

check(
  "Branch validation avoids visible Windows cmd shims",
  branchValidation.includes('command === "bun" ? process.execPath') &&
    branchValidation.includes("windowsHide: true") &&
    !branchValidation.includes("const resolvedCommand = Bun.which(command) || command;"),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "Safe validation smokes hide Windows child processes",
  frameworkCommandResolutionSmoke.includes("windowsHide: true") &&
    hotfixUpdateRollbackSmoke.match(/windowsHide:\s*true/g)?.length >= 2 &&
    junctionSafeUpdateSmoke.includes("windowsHide: true") &&
    memoryDeleteSmoke.match(/windowsHide:\s*true/g)?.length >= 2 &&
    paiSecurityAuditSmoke.includes("windowsHide: true"),
  "FrameworkCommandResolution, HotfixUpdateRollback, JunctionSafeUpdate, MemoryDelete, PaiSecurityAudit",
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
  "Framework smoke keeps OpenCode CLI parsing opt-in",
  frameworkSmoke.includes('const dynamic = process.argv.includes("--dynamic")') &&
    frameworkSmoke.includes("PAI_FRAMEWORK_SMOKE_DYNAMIC") &&
    frameworkSmoke.includes("skipped in AV-safe static mode") &&
    frameworkSmoke.includes("checkOpenCodeConfigParses(root, dynamic)") &&
    (frameworkSmoke.match(/windowsHide:\s*true/g)?.length ?? 0) >= 15,
  "PAI/TOOLS/FrameworkSmokeTest.ts",
);

check(
  "OpenCode plugin bounds hook adapter dispatch",
  opencodePlugin.includes("DEFAULT_HOOK_TIMEOUT_MS") &&
    opencodePlugin.includes('import { expandPath, homeDir } from "../hooks/lib/paths"') &&
    opencodePlugin.includes("const HOME = homeDir()") &&
    !opencodePlugin.includes('from "os"') &&
    !opencodePlugin.includes("process.env.HOME || process.env.USERPROFILE || homedir()") &&
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

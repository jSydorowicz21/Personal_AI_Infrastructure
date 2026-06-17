#!/usr/bin/env bun
/**
 * FrameworkSmokeTest - verify PAI framework switching without touching real homes.
 *
 * This creates isolated temporary CLAUDE_HOME / CODEX_HOME / OPENCODE_CONFIG_DIR /
 * PAI_DATA_DIR roots, runs `pai framework switch`, and verifies that each
 * framework gets native config while sharing the same PAI data shape.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Framework = "claude" | "codex" | "opencode";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const keep = process.argv.includes("--keep");
const paiTool = join(import.meta.dir, "pai.ts");

function uniqueRoot(): string {
  return join(tmpdir(), `pai-framework-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function checkPath(name: string, path: string): Check {
  return {
    name,
    passed: existsSync(path),
    detail: path,
  };
}

function findJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime());
}

function readFilesUnder(dir: string, predicate: (path: string) => boolean): string {
  if (!existsSync(dir)) return "";
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      text += readFilesUnder(fullPath, predicate);
    } else if (entry.isFile() && predicate(fullPath)) {
      text += "\n" + readFileSync(fullPath, "utf-8");
    }
  }
  return text;
}

function checkGeneratedAgents(root: string, framework: Framework): Check[] {
  const agentsDir = join(root, "agents");
  const generatedText = readFilesUnder(agentsDir, (path) =>
    framework === "codex" ? path.endsWith(".toml") : path.endsWith(".md"));
  return [
    {
      name: `${framework} generated agents`,
      passed: generatedText.length > 0,
      detail: agentsDir,
    },
    {
      name: `${framework} agents avoid Claude home`,
      passed: generatedText.length > 0 && !generatedText.includes("~/.claude"),
      detail: generatedText.includes("~/.claude") ? "contains ~/.claude" : "no ~/.claude",
    },
    {
      name: `${framework} agents carry framework-relative context`,
      passed: generatedText.includes("$PAI_FRAMEWORK_DIR") || generatedText.includes("$PAI_DIR"),
      detail: "agent startup paths",
    },
  ];
}

function checkOpenCodeTranscript(root: string, data: string): Check[] {
  const pluginPath = join(root, "plugins", "pai-opencode.ts");
  const repeatMarkerPath = join(data, "opencode-repeat-detection.txt");
  const contextMarkerPath = join(data, "opencode-context-injection.txt");
  const kittyEnvPath = join(data, "MEMORY", "STATE", "kitty-env.json");
  const kittySessionPath = join(data, "MEMORY", "STATE", "kitty-sessions", "smoke-opencode.json");
  const testEnv = {
    ...process.env,
    PAI_DATA_DIR: data,
    PAI_FRAMEWORK: "opencode",
    PAI_FRAMEWORK_DIR: root,
    KITTY_LISTEN_ON: "unix:/tmp/pai-opencode-smoke-kitty",
    KITTY_WINDOW_ID: "smoke-window",
  };
  const script = `
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const userDir = ${JSON.stringify(join(data, "USER"))};
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      ${JSON.stringify(join(data, "USER", "OPINIONS.md"))},
      "### OpenCode context parity\\n\\n**Confidence:** 0.95\\n\\nOpenCode dynamic context should be injected into the first prompt.\\n",
      "utf-8"
    );
    const mod = await import(${JSON.stringify(pluginPath)});
    const hooks = await mod.PAIOpenCodePlugin();
    const session = { sessionId: "smoke-opencode", cwd: ${JSON.stringify(root)} };
    await hooks.event({ event: { ...session, type: "session.created" } });
    const repeatedPrompt = "Please use OpenCode shared memory for this exact repeated smoke prompt.";
    const firstPromptOutput = { prompt: repeatedPrompt };
    await hooks["tui.prompt.append"](session, firstPromptOutput);
    if (!String(firstPromptOutput.prompt || "").includes("OpenCode context parity")) {
      throw new Error("LoadContext did not inject dynamic context into OpenCode prompt");
    }
    writeFileSync(${JSON.stringify(contextMarkerPath)}, "injected", "utf-8");
    let repeatBlocked = false;
    try {
      await hooks["tui.prompt.append"](session, { prompt: repeatedPrompt });
    } catch {
      repeatBlocked = true;
    }
    if (!repeatBlocked) throw new Error("RepeatDetection did not block repeated OpenCode prompt");
    writeFileSync(${JSON.stringify(repeatMarkerPath)}, "blocked", "utf-8");
    await hooks.event({ event: { ...session, type: "message.updated", message: { role: "user", content: [{ type: "text", text: "Actually, shared memory should follow OpenCode too." }] } } });
    await hooks.event({ event: { ...session, type: "message.updated", message: { role: "assistant", content: [{ type: "text", text: "Important: OpenCode wrote a PAI transcript." }] } } });
    await hooks["tool.execute.after"]({ ...session, tool: "edit" }, { args: { filePath: "PAI/TOOLS/Smoke.ts" }, output: "ok" });
  `;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    timeout: 20_000,
  });

  const transcriptFiles = findJsonlFiles(join(data, "TRANSCRIPTS", "opencode"));
  const transcriptText = transcriptFiles.map((file) => readFileSync(file, "utf-8")).join("\n");
  const harvest = spawnSync(process.execPath, [join(import.meta.dir, "SessionHarvester.ts"), "--recent", "1", "--dry-run"], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    timeout: 20_000,
  });
  const activity = spawnSync(process.execPath, [join(import.meta.dir, "ActivityParser.ts"), "--today"], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    timeout: 20_000,
  });
  return [
    {
      name: "opencode plugin transcript exits 0",
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"} ${result.stderr.trim().slice(0, 120)}`,
    },
    {
      name: "opencode session start persists Kitty env",
      passed: existsSync(kittyEnvPath) && existsSync(kittySessionPath),
      detail: existsSync(kittySessionPath) ? kittySessionPath : kittyEnvPath,
    },
    {
      name: "opencode prompt repeat detection blocks",
      passed: existsSync(repeatMarkerPath),
      detail: repeatMarkerPath,
    },
    {
      name: "opencode dynamic context injected",
      passed: existsSync(contextMarkerPath),
      detail: contextMarkerPath,
    },
    {
      name: "opencode plugin transcript file",
      passed: transcriptFiles.length > 0,
      detail: transcriptFiles[0] || join(data, "TRANSCRIPTS", "opencode"),
    },
    {
      name: "opencode plugin transcript messages",
      passed: transcriptText.includes("shared memory should follow OpenCode") && transcriptText.includes("OpenCode wrote a PAI transcript"),
      detail: `${transcriptFiles.length} transcript file(s)`,
    },
    {
      name: "opencode plugin transcript tool call",
      passed: transcriptText.includes('"type":"tool_call"') && transcriptText.includes("PAI/TOOLS/Smoke.ts"),
      detail: "tool_call edit PAI/TOOLS/Smoke.ts",
    },
    {
      name: "opencode transcript harvestable",
      passed: harvest.status === 0 && harvest.stdout.includes("2 learning(s)"),
      detail: `status=${harvest.status ?? "null"}`,
    },
    {
      name: "opencode transcript activity parse",
      passed: activity.status === 0 && activity.stdout.includes("PAI/TOOLS/Smoke.ts"),
      detail: `status=${activity.status ?? "null"}`,
    },
  ];
}

function checkFrameworkStatePathFallback(root: string, data: string): Check[] {
  const toolsPath = join(import.meta.dir, "lib", "paths.ts");
  const hooksPath = join(import.meta.dir, "..", "..", "hooks", "lib", "paths.ts");
  const env = { ...process.env, PAI_DATA_DIR: data } as Record<string, string>;
  for (const key of ["PAI_DIR", "PAI_FRAMEWORK_DIR", "PAI_MEMORY_DIR", "PAI_USER_DIR", "PAI_SETTINGS_PATH"]) {
    delete env[key];
  }

  const script = `
    const tools = await import(${JSON.stringify(toolsPath)});
    const hooks = await import(${JSON.stringify(hooksPath)});
    console.log(JSON.stringify({
      toolsPaiDir: tools.getPaiDir(),
      toolsFrameworkDir: tools.getFrameworkDir(),
      hooksPaiDir: hooks.getPaiDir(),
      hooksFrameworkDir: hooks.getFrameworkDir()
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env,
    encoding: "utf-8",
    timeout: 20_000,
  });

  let resolved: Record<string, string> = {};
  try {
    resolved = JSON.parse(result.stdout.trim());
  } catch {}

  return [
    {
      name: "path fallback exits 0",
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"} ${result.stderr.trim().slice(0, 120)}`,
    },
    {
      name: "tools path fallback uses framework.json",
      passed: resolved.toolsPaiDir === join(root, "PAI") && resolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: resolved.toolsPaiDir, root: resolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path fallback uses framework.json",
      passed: resolved.hooksPaiDir === join(root, "PAI") && resolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: resolved.hooksPaiDir, root: resolved.hooksFrameworkDir }),
    },
  ];
}

function runSwitch(framework: Framework, base: string): { root: string; data: string; config: string; checks: Check[]; stdout: string; stderr: string } {
  const root = join(base, framework);
  const data = join(base, "pai-data");
  const config = join(base, "pai-config");
  mkdirSync(base, { recursive: true });
  if (framework === "codex") {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "high"',
      "",
      "[model_providers.custom_local]",
      'name = "Custom Local Provider"',
      'base_url = "http://127.0.0.1:8000/v1"',
      'wire_api = "responses"',
      "",
      "[profiles.custom-local]",
      'model = "custom-model"',
      'model_provider = "custom_local"',
      "",
      "[plugins.\"browser@openai-bundled\"]",
      "enabled = true",
      "",
    ].join("\n"));
  }

  const env: Record<string, string> = {
    ...process.env,
    PAI_DATA_DIR: data,
    PAI_CONFIG_DIR: config,
    PAI_FRAMEWORK: framework,
    PAI_FRAMEWORK_DIR: root,
  } as Record<string, string>;
  if (framework === "claude") env.CLAUDE_HOME = root;
  if (framework === "codex") env.CODEX_HOME = root;
  if (framework === "opencode") env.OPENCODE_CONFIG_DIR = root;

  const result = spawnSync(process.execPath, [paiTool, "framework", "switch", framework], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });

  const checks: Check[] = [
    {
      name: `${framework} switch exits 0`,
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"}`,
    },
    checkPath(`${framework} root`, root),
    checkPath(`${framework} instructions`, join(root, framework === "claude" ? "CLAUDE.md" : "AGENTS.md")),
    checkPath(`${framework} settings.json`, join(root, "settings.json")),
    checkPath(`${framework} shared MEMORY`, join(data, "MEMORY")),
    checkPath(`${framework} shared USER`, join(data, "USER")),
    checkPath(`${framework} framework PAI/MEMORY`, join(root, "PAI", "MEMORY")),
    checkPath(`${framework} framework PAI/USER`, join(root, "PAI", "USER")),
    checkPath(`${framework} framework state`, join(data, "framework.json")),
  ];

  const instructionPath = join(root, framework === "claude" ? "CLAUDE.md" : "AGENTS.md");
  if (existsSync(instructionPath)) {
    const instructionText = readFileSync(instructionPath, "utf-8");
    checks.push({
      name: `${framework} instructions avoid fixed Claude PAI root`,
      passed: framework === "claude" || !instructionText.includes("~/.claude/PAI"),
      detail: framework === "claude" ? "Claude native root allowed" : "AGENTS.md path rewrite",
    });
  }

  if (framework === "claude") {
    checks.push(checkPath("claude CLAUDE.md", join(root, "CLAUDE.md")));
    checks.push(checkPath("claude hooks directory", join(root, "hooks")));
    checks.push(...checkGeneratedAgents(root, framework));
    if (existsSync(join(root, "settings.json"))) {
      const settings = readJson(join(root, "settings.json"));
      checks.push({
        name: "claude settings carry PAI_DATA_DIR",
        passed: settings.env?.PAI_DATA_DIR === data,
        detail: `PAI_DATA_DIR=${settings.env?.PAI_DATA_DIR || ""}`,
      });
    }
  }

  if (framework === "codex") {
    checks.push(checkPath("codex config.toml", join(root, "config.toml")));
    checks.push(checkPath("codex hooks.json", join(root, "hooks.json")));
    checks.push(...checkGeneratedAgents(root, framework));
    if (existsSync(join(root, "hooks.json"))) {
      const hooksText = readFileSync(join(root, "hooks.json"), "utf-8");
      checks.push({
        name: "codex hooks carry PAI_DATA_DIR",
        passed: hooksText.includes("PAI_DATA_DIR"),
        detail: "hooks.json command env",
      });
    }
    if (existsSync(join(root, "config.toml"))) {
      const configText = readFileSync(join(root, "config.toml"), "utf-8");
      checks.push({
        name: "codex config preserves existing model",
        passed: configText.includes('model = "gpt-5.5"') && configText.includes('model_reasoning_effort = "high"'),
        detail: "model settings",
      });
      checks.push({
        name: "codex config preserves custom providers profiles plugins",
        passed: configText.includes("[model_providers.custom_local]")
          && configText.includes("[profiles.custom-local]")
          && configText.includes("[plugins.\"browser@openai-bundled\"]"),
        detail: "custom TOML sections",
      });
      checks.push({
        name: "codex config adds managed PAI block",
        passed: configText.includes("# BEGIN PAI MANAGED ROOT CONFIG") && configText.includes("# END PAI MANAGED ROOT CONFIG"),
        detail: "managed root block",
      });
    }
  }

  if (framework === "opencode") {
    checks.push(checkPath("opencode opencode.json", join(root, "opencode.json")));
    checks.push(checkPath("opencode plugin", join(root, "plugins", "pai-opencode.ts")));
    checks.push(...checkGeneratedAgents(root, framework));
    if (existsSync(join(root, "opencode.json"))) {
      const configJson = readJson(join(root, "opencode.json"));
      checks.push({
        name: "opencode config carries PAI_DATA_DIR",
        passed: configJson.env?.PAI_DATA_DIR === data,
        detail: `PAI_DATA_DIR=${configJson.env?.PAI_DATA_DIR || ""}`,
      });
    }
    checks.push(...checkOpenCodeTranscript(root, data));
  }

  if (existsSync(join(data, "framework.json"))) {
    const state = readJson(join(data, "framework.json"));
    checks.push({
      name: `${framework} state active`,
      passed: state.active === framework && state.root === root && state.dataDir === data,
      detail: JSON.stringify({ active: state.active, root: state.root, dataDir: state.dataDir }),
    });
    checks.push(...checkFrameworkStatePathFallback(root, data));
  }

  return {
    root,
    data,
    config,
    checks,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function printResult(label: string, checks: Check[]) {
  console.log(`\n${label}`);
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name} - ${check.detail}`);
  }
}

const base = uniqueRoot();
const frameworks: Framework[] = ["claude", "codex", "opencode"];
const isolatedResults = frameworks.map((framework) => runSwitch(framework, join(base, `${framework}-case`)));
const sequenceBase = join(base, "switch-sequence");
const sequenceResults = frameworks.map((framework) => runSwitch(framework, sequenceBase));
let failed = 0;

for (const [index, framework] of frameworks.entries()) {
  const result = isolatedResults[index];
  printResult(`${framework} isolated`, result.checks);
  failed += result.checks.filter((check) => !check.passed).length;
  if (result.stderr.trim()) {
    console.log(`${framework} stderr:\n${result.stderr.trim()}`);
  }
}

for (const [index, framework] of frameworks.entries()) {
  const result = sequenceResults[index];
  printResult(`${framework} shared switch`, result.checks);
  failed += result.checks.filter((check) => !check.passed).length;
  if (result.stderr.trim()) {
    console.log(`${framework} shared-switch stderr:\n${result.stderr.trim()}`);
  }
}

const sequenceDataDirs = new Set(sequenceResults.map((result) => result.data));
const finalStatePath = join(sequenceBase, "pai-data", "framework.json");
const finalState = existsSync(finalStatePath) ? readJson(finalStatePath) : {};
const sequenceChecks: Check[] = [
  {
    name: "shared switch sequence reuses one PAI_DATA_DIR",
    passed: sequenceDataDirs.size === 1,
    detail: Array.from(sequenceDataDirs).join(", "),
  },
  {
    name: "shared switch sequence final active framework",
    passed: finalState.active === "opencode" && finalState.dataDir === join(sequenceBase, "pai-data"),
    detail: JSON.stringify({ active: finalState.active, dataDir: finalState.dataDir }),
  },
];
printResult("shared switch sequence", sequenceChecks);
failed += sequenceChecks.filter((check) => !check.passed).length;

if (keep) {
  console.log(`\nKept smoke test root: ${base}`);
} else {
  rmSync(base, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} framework smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll framework smoke checks passed.");

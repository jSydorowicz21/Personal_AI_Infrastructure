#!/usr/bin/env bun
/**
 * OpenCodeFrameworkAgentExecutionSmokeTest
 *
 * Runtime (not source-string) proof that the exported OpenCode launcher path
 * actually invokes `opencode run -` with the contracted args, cwd, and stdin.
 * We build a fully isolated temp HOME/USERPROFILE/OPENCODE_CONFIG_DIR/
 * PAI_DATA_DIR/PAI_CONFIG_DIR and a temp PATH containing a fake `opencode` shim
 * (plus `opencode.cmd` on Windows). The shim records the argv + cwd + stdin +
 * a few env markers it receives and exits 0, so no live OpenCode auth or
 * provider is touched.
 *
 * Because `Bun.which("opencode")` (the no-options form the launcher uses)
 * resolves against the *startup* environment, the temp PATH must be in place
 * before the process starts. So the parent stages the temp env + shims and
 * re-execs itself; the child inherits the patched PATH at startup and drives
 * the real launcher:
 * - runFrameworkAgent() -> `opencode run -`, prompt on stdin, cwd = opts.cwd.
 * - PAI_OPENCODE_BIN overrides Bun.which (parity with PAI_CODEX_BIN).
 * - opts.model is intentionally NOT propagated: OpenCode's `run` model-flag
 *   contract is undocumented in this repo, so no `--model`/`-m` flag is invented.
 *
 * Inference coverage: Inference.ts intentionally routes only Claude/Codex — its
 * provider switch is `useCodex = framework === "codex" || ...` with a Claude
 * fallback, and it carries no OpenCode-native branch. So OpenCode inference is
 * NOT a supported direct provider path; OpenCode native execution proof is the
 * framework-agent path exercised here. The child asserts that contract instead
 * of spawning a real `claude`/provider.
 *
 * Complements the source/config coverage in FrameworkSmokeTest.ts (config gen +
 * plugin transcript) by executing the real launcher end-to-end against a
 * controllable binary, mirroring CodexFrameworkAgentExecutionSmokeTest.ts.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const checks: Check[] = [];
function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

interface Recording {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

function readRecording(path: string): Recording {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return {
    argv: Array.isArray(parsed.argv) ? parsed.argv : [],
    stdin: typeof parsed.stdin === "string" ? parsed.stdin : "",
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    env: parsed.env && typeof parsed.env === "object" ? parsed.env : {},
  };
}

const RECORDER_SOURCE = `
const recordFile = process.env.FAKE_OPENCODE_RECORD_FILE;
const argv = process.argv.slice(2);
let stdin = "";
try {
  stdin = await Bun.stdin.text();
} catch {}
if (recordFile) {
  await Bun.write(recordFile, JSON.stringify({
    argv,
    stdin,
    cwd: process.cwd(),
    env: {
      PAI_FRAMEWORK: process.env.PAI_FRAMEWORK,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDECODE: process.env.CLAUDECODE,
    },
  }));
}
process.stdout.write("FAKE_OPENCODE_OK\\n");
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Parent: stage isolated env + fake opencode shim, then re-exec self as child.
// `Bun.which("opencode")` reads the startup environment, so the shim must be on
// PATH before the test process begins — hence the re-exec.
// ---------------------------------------------------------------------------
function runParent(): number {
  const tempRoot = mkdtempSync(join(tmpdir(), "pai-opencode-exec-smoke-"));
  try {
    const home = join(tempRoot, "home");
    const opencodeConfig = join(tempRoot, "opencode-config");
    const paiData = join(tempRoot, "pai-data");
    const configDir = join(tempRoot, "config");
    const binDir = join(tempRoot, "bin");
    const workspace = join(tempRoot, "workspace");
    const recordDir = join(tempRoot, "record");
    for (const dir of [home, opencodeConfig, paiData, configDir, binDir, workspace, recordDir]) {
      mkdirSync(dir, { recursive: true });
    }

    // Fake opencode shim: records argv + cwd + stdin via a tiny Bun recorder, then exits 0.
    const recorderPath = join(binDir, "opencode-recorder.ts");
    writeFileSync(recorderPath, RECORDER_SOURCE);
    if (process.platform === "win32") {
      // .cmd is what `Bun.which("opencode")` resolves to on Windows (PATHEXT) and
      // what a packaged opencode install ships, so exercising it proves the
      // launcher spawns .cmd shims correctly.
      writeFileSync(join(binDir, "opencode.cmd"), `@echo off\r\nbun "${recorderPath}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const shim = join(binDir, "opencode");
      writeFileSync(shim, `#!/usr/bin/env bash\nexec bun "${recorderPath}" "$@"\n`);
      chmodSync(shim, 0o755);
    }

    // Build the child's startup environment. Windows stores the search path
    // under `Path`, not `PATH`; prepend to the existing key so the child resolves
    // our shim ahead of any real opencode install.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === "path") || "PATH";
    childEnv[pathKey] = binDir + delimiter + (childEnv[pathKey] || "");
    childEnv.PAI_FAKE_OPENCODE_CHILD = "1";
    childEnv.PAI_FRAMEWORK = "opencode";
    childEnv.HOME = home;
    childEnv.USERPROFILE = home;
    childEnv.OPENCODE_CONFIG_DIR = opencodeConfig;
    childEnv.PAI_DATA_DIR = paiData;
    childEnv.PAI_CONFIG_DIR = configDir;
    childEnv.FAKE_OPENCODE_BIN_DIR = binDir;
    childEnv.FAKE_OPENCODE_WORKSPACE = workspace;
    childEnv.FAKE_OPENCODE_RECORD_DIR = recordDir;
    // Inject API credentials so the child can prove frameworkAgentEnv() scrubs them.
    childEnv.ANTHROPIC_API_KEY = "sk-ant-FAKE-should-be-scrubbed";
    childEnv.ANTHROPIC_AUTH_TOKEN = "FAKE-auth-should-be-scrubbed";
    childEnv.CLAUDECODE = "1";
    delete childEnv.PAI_DIR;
    delete childEnv.PAI_FRAMEWORK_DIR;

    const child = Bun.spawnSync([process.execPath, import.meta.path], {
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exitCode ?? 1;
  } finally {
    const resolved = resolve(tempRoot);
    if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-opencode-exec-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Child: PATH already patched at startup; drive the real exported launcher.
// ---------------------------------------------------------------------------
async function runChild(): Promise<void> {
  const { runFrameworkAgent, buildFrameworkAgentCommand } = await import("./lib/framework-agent");
  const { getActiveFramework } = await import("./lib/transcripts");

  const binDir = process.env.FAKE_OPENCODE_BIN_DIR!;
  const workspace = process.env.FAKE_OPENCODE_WORKSPACE!;
  const recordDir = process.env.FAKE_OPENCODE_RECORD_DIR!;

  const resolvedOpenCode = Bun.which("opencode");
  check(
    "fake opencode shim resolves ahead of any real opencode",
    Boolean(resolvedOpenCode && resolve(resolvedOpenCode).startsWith(resolve(binDir))),
    resolvedOpenCode || "Bun.which('opencode') returned null",
  );

  check(
    "active framework resolves to opencode",
    getActiveFramework() === "opencode",
    getActiveFramework(),
  );

  // --- 1. Framework agent path (runFrameworkAgent) ---------------------------
  const agentRecord = join(recordDir, "agent.json");
  const agentPrompt = "PAI-FAKE-OPENCODE::framework-agent prompt payload";
  process.env.FAKE_OPENCODE_RECORD_FILE = agentRecord;
  const agentResult = await runFrameworkAgent(agentPrompt, { cwd: workspace });

  check(
    "runFrameworkAgent invoked fake opencode (exit 0, FAKE_OPENCODE_OK)",
    agentResult.exitCode === 0 && agentResult.framework === "opencode" && agentResult.stdout.includes("FAKE_OPENCODE_OK"),
    `exit=${agentResult.exitCode} framework=${agentResult.framework} label=${agentResult.label} stderr=${agentResult.stderr.trim().slice(0, 200)}`,
  );

  const agent = readRecording(agentRecord);
  check(
    "framework agent runs `opencode run` with stdin sentinel",
    agent.argv.length === 2 && agent.argv[0] === "run" && agent.argv[1] === "-",
    agent.argv.join(" "),
  );
  check(
    "framework agent spawns opencode in the requested cwd",
    resolve(agent.cwd) === resolve(workspace),
    `cwd=${agent.cwd} expected=${workspace}`,
  );
  check(
    "framework agent delivers the prompt payload on stdin",
    agent.stdin === agentPrompt,
    JSON.stringify(agent.stdin.slice(0, 120)),
  );
  check(
    "framework agent env sets PAI_FRAMEWORK=opencode and scrubs Anthropic credentials",
    agent.env.PAI_FRAMEWORK === "opencode" &&
      agent.env.ANTHROPIC_API_KEY === undefined &&
      agent.env.ANTHROPIC_AUTH_TOKEN === undefined,
    `PAI_FRAMEWORK=${agent.env.PAI_FRAMEWORK} ANTHROPIC_API_KEY=${agent.env.ANTHROPIC_API_KEY ?? "<unset>"}`,
  );

  // --- 1b. PAI_OPENCODE_BIN override (parity with PAI_CODEX_BIN) --------------
  // The launcher must prefer an explicit PAI_OPENCODE_BIN over Bun.which. We use
  // buildFrameworkAgentCommand (pure, no spawn) so the pinned path need not exist.
  const sentinelBin = join(binDir, "pinned-opencode-sentinel");
  const prevBin = process.env.PAI_OPENCODE_BIN;
  process.env.PAI_OPENCODE_BIN = sentinelBin;
  const pinnedSpec = buildFrameworkAgentCommand("PAI-FAKE-OPENCODE::override probe", { cwd: workspace });
  if (prevBin === undefined) delete process.env.PAI_OPENCODE_BIN;
  else process.env.PAI_OPENCODE_BIN = prevBin;
  check(
    "PAI_OPENCODE_BIN overrides Bun.which for the opencode command",
    pinnedSpec.command === sentinelBin && pinnedSpec.framework === "opencode",
    `command=${pinnedSpec.command} expected=${sentinelBin}`,
  );

  // --- 1c. Model propagation: intentional non-support ------------------------
  // OpenCode's `run` model-flag contract is not documented in this repo, so the
  // launcher does NOT forward opts.model (no invented flag). Assert that passing
  // a model leaves the argv as the bare `run -` contract — no `--model`/`-m`.
  const modeledSpec = buildFrameworkAgentCommand("PAI-FAKE-OPENCODE::model probe", {
    cwd: workspace,
    model: "anthropic/claude-sonnet-4-6",
  });
  check(
    "opts.model is intentionally not propagated to opencode (no --model/-m flag)",
    modeledSpec.args.length === 2 &&
      modeledSpec.args[0] === "run" &&
      modeledSpec.args[1] === "-" &&
      !modeledSpec.args.includes("--model") &&
      !modeledSpec.args.includes("-m"),
    modeledSpec.args.join(" "),
  );

  // --- 2. Inference path: documented non-support ------------------------------
  // Inference.ts routes only Claude/Codex. Driving inference() under OpenCode
  // would fall through to the Claude branch and spawn a real `claude`, touching
  // live auth — which this smoke must not do. Instead we assert the documented
  // contract from source: there is no OpenCode-native provider branch, and the
  // provider switch is the codex-vs-claude form. OpenCode native execution proof
  // is the framework-agent path verified above.
  const inferenceSrc = readFileSync(join(import.meta.dir, "Inference.ts"), "utf-8");
  check(
    "inference intentionally has no OpenCode-native provider branch (covered by framework-agent)",
    inferenceSrc.includes('const useCodex = framework === "codex"') &&
      !/===\s*"opencode"/.test(inferenceSrc) &&
      !/framework\s*===\s*'opencode'/.test(inferenceSrc),
    "PAI/TOOLS/Inference.ts routes Claude/Codex only; OpenCode uses runFrameworkAgent",
  );
}

if (process.env.PAI_FAKE_OPENCODE_CHILD === "1") {
  try {
    await runChild();
  } catch (err) {
    check("smoke test executed without throwing", false, err instanceof Error ? err.message : String(err));
  }
  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    console.error(`\nOpenCode framework-agent execution smoke failed: ${failed.length} check(s).`);
    process.exit(1);
  }
  console.log("\nAll OpenCode framework-agent execution checks passed.");
  process.exit(0);
} else {
  process.exit(runParent());
}

#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pai-launch-cwd-smoke-"));
try {
  const projectDir = join(root, "project");
  const codexHome = join(root, "codex-home");
  const paiData = join(root, "pai-data");
  const paiConfig = join(root, "pai-config");
  const bin = join(root, "bin");
  const cwdFile = join(root, "codex-cwd.txt");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(bin, { recursive: true });

  if (process.platform === "win32") {
    writeFileSync(join(bin, "codex.cmd"), `@echo off\r\ncd > "${cwdFile}"\r\nexit /b 0\r\n`, "utf-8");
  } else {
    const shim = join(bin, "codex");
    writeFileSync(shim, `#!/usr/bin/env sh\npwd > ${JSON.stringify(cwdFile)}\n`, "utf-8");
    spawnSync("chmod", ["755", shim]);
  }

  const env = {
    ...process.env,
    PAI_FRAMEWORK: "codex",
    CODEX_HOME: codexHome,
    PAI_DATA_DIR: paiData,
    PAI_CONFIG_DIR: paiConfig,
    PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
  };

  const result = spawnSync(process.execPath, [join(import.meta.dir, "pai.ts")], {
    cwd: projectDir,
    env,
    encoding: "utf-8",
    timeout: 20_000,
  });

  assert("PAI launch exits 0 with fake Codex", result.status === 0, result.stderr.trim().slice(0, 160));
  assert("fake Codex recorded cwd", existsSync(cwdFile), cwdFile);
  assert("framework launch preserves caller cwd", resolve(readFileSync(cwdFile, "utf-8").trim()) === resolve(projectDir), readFileSync(cwdFile, "utf-8").trim());
} finally {
  const resolved = resolve(root);
  if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-launch-cwd-smoke-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}

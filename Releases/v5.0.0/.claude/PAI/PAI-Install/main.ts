#!/usr/bin/env bun
/**
 * PAI Installer v5.0 — Main Entry Point
 * Routes to CLI, Web server (for Electron), or GUI (Electron app).
 *
 * Modes:
 *   --mode cli   → Interactive terminal wizard
 *   --mode web   → Start HTTP/WebSocket server (used internally by Electron)
 *   --mode gui   → Launch Electron app (which spawns web mode internally)
 */

import { spawn, spawnSync, execSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

const args = process.argv.slice(2);
const modeIdx = args.indexOf("--mode");
const mode = modeIdx >= 0 ? args[modeIdx + 1] : "gui";

const ROOT = import.meta.dir;

async function runCLI() {
  const { runCLI } = await import("./cli/index");
  await runCLI();
}

function missingElectronLibraries(electronDir: string): string[] {
  if (process.platform !== "linux") return [];

  const electronBin = join(electronDir, "node_modules", "electron", "dist", "electron");
  if (!existsSync(electronBin)) return [];

  const check = spawnSync("ldd", [electronBin], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (check.status !== 0) return [];

  const output = `${check.stdout || ""}\n${check.stderr || ""}`;
  return Array.from(
    new Set(
      output
        .split("\n")
        .map((line) => line.match(/^\s*(\S+)\s+=>\s+not found\s*$/)?.[1])
        .filter((lib): lib is string => Boolean(lib)),
    ),
  );
}

async function main() {
  if (mode === "cli") {
    // Run CLI wizard
    await runCLI();
  } else if (mode === "web") {
    // Start the HTTP + WebSocket server (Electron loads this)
    await import("./web/server");
  } else {
    // Launch Electron GUI app
    const electronDir = join(ROOT, "electron");
    const electronBin = join(electronDir, "node_modules", "electron", "dist", "electron");

    // Install electron dependencies if needed.
    // bun is the bootstrap runtime install.sh guarantees; npm is NOT on a
    // bun-only host. Using bun install here keeps the GUI path reachable
    // for the typical PAI user.
    if (!existsSync(electronBin)) {
      console.log("Installing GUI dependencies (first run only)...\n");
      const install = spawnSync("bun", ["install"], {
        cwd: electronDir,
        stdio: "inherit",
      });
      if (install.status !== 0) {
        console.error("Failed to install GUI dependencies. Falling back to CLI...\n");
        await runCLI();
        return;
      }
    }

    const missingLibs = missingElectronLibraries(electronDir);
    if (missingLibs.length > 0) {
      console.warn("GUI unavailable: Electron is missing Linux system libraries:");
      console.warn(`  ${missingLibs.join(", ")}`);
      console.warn("Falling back to CLI installer...\n");
      await runCLI();
      return;
    }

    // Clear macOS quarantine flags (prevents "app is damaged" error on copied installs)
    if (process.platform === "darwin") {
      try {
        execSync(`xattr -cr "${electronDir}"`, { stdio: "pipe", timeout: 30000 });
        console.log("Cleared macOS quarantine flags.\n");
      } catch {
        // Non-fatal
      }
    }

    console.log("Starting PAI Installer GUI...\n");
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("bun", ["run", "start"], {
        cwd: electronDir,
        stdio: "inherit",
      });

      child.on("error", reject);
      child.on("exit", resolve);
    });

    if (code && code !== 0) {
      console.error(`GUI exited with code ${code}. Falling back to CLI installer...\n`);
      await runCLI();
      return;
    }

    process.exit(code || 0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

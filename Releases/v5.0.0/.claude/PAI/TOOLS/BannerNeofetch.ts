#!/usr/bin/env bun

/**
 * BannerNeofetch - Modern Neofetch-Style PAI Banner
 *
 * LEFT SIDE: High-resolution 3D isometric cube using Braille + block elements
 * RIGHT SIDE: Modern stats with emoji icons, progress bars, color-coded values
 * BOTTOM SECTION: Gradient header, quote, sparkline histogram, PAI block art
 *
 * Aesthetic: Modern tech startup (gh, npm, vercel) with gradient colors (blue->purple->cyan)
 */

import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { getFrameworkDir, memoryPath, userPath } from "./lib/paths";
import { activeRuntimeLabel } from "./lib/framework-display";

const CLAUDE_DIR = getFrameworkDir();

// ═══════════════════════════════════════════════════════════════════════
// Terminal Width Detection
// ═══════════════════════════════════════════════════════════════════════

function getTerminalWidth(): number {
  let width: number | null = null;

  if (process.stdout.columns && process.stdout.columns > 0) {
    width = process.stdout.columns;
  }

  const kittyWindowId = process.env.KITTY_WINDOW_ID;
  if (kittyWindowId) {
    try {
      const result = spawnSync("kitten", ["@", "ls"], { encoding: "utf-8", timeout: 1000, windowsHide: true });
      if (result.stdout) {
        const data = JSON.parse(result.stdout);
        for (const osWindow of data) {
          for (const tab of osWindow.tabs) {
            for (const win of tab.windows) {
              if (win.id === parseInt(kittyWindowId)) {
                width = win.columns;
                break;
              }
            }
          }
        }
      }
    } catch {}
  }

  if (process.platform !== "win32" && (!width || width <= 0)) {
    try {
      const result = spawnSync("sh", ["-c", "stty size </dev/tty 2>/dev/null"], { encoding: "utf-8", timeout: 1000, windowsHide: true });
      if (result.stdout) {
        const cols = parseInt(result.stdout.trim().split(/\s+/)[1]);
        if (cols > 0) width = cols;
      }
    } catch {}
  }

  if (process.platform !== "win32" && (!width || width <= 0)) {
    try {
      const result = spawnSync("tput", ["cols"], { encoding: "utf-8", timeout: 1000, windowsHide: true });
      if (result.stdout) {
        const cols = parseInt(result.stdout.trim());
        if (cols > 0) width = cols;
      }
    } catch {}
  }

  if (!width || width <= 0) {
    width = parseInt(process.env.COLUMNS || "100") || 100;
  }

  return width;
}

// ═══════════════════════════════════════════════════════════════════════
// ANSI Color System - Modern Gradient Palette
// ═══════════════════════════════════════════════════════════════════════

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bgRgb = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

// Modern gradient palette (blue -> purple -> cyan) - inspired by Vercel, Linear, etc.
const GRADIENT = {
  // Blue spectrum
  blue1: rgb(59, 130, 246),     // #3B82F6 - bright blue
  blue2: rgb(99, 102, 241),     // #6366F1 - indigo
  // Purple spectrum
  purple1: rgb(139, 92, 246),   // #8B5CF6 - violet
  purple2: rgb(168, 85, 247),   // #A855F7 - purple
  magenta: rgb(217, 70, 239),   // #D946EF - fuchsia
  // Cyan spectrum
  cyan1: rgb(34, 211, 238),     // #22D3EE - cyan
  cyan2: rgb(6, 182, 212),      // #06B6D4 - teal-cyan
  teal: rgb(20, 184, 166),      // #14B8A6 - teal
};

// UI Colors
const UI = {
  text: rgb(226, 232, 240),       // #E2E8F0 - slate-200
  subtext: rgb(148, 163, 184),    // #94A3B8 - slate-400
  muted: rgb(100, 116, 139),      // #64748B - slate-500
  dim: rgb(71, 85, 105),          // #475569 - slate-600
  dark: rgb(51, 65, 85),          // #334155 - slate-700
  border: rgb(30, 41, 59),        // #1E293B - slate-800

  success: rgb(34, 197, 94),      // #22C55E - green
  warning: rgb(245, 158, 11),     // #F59E0B - amber
  info: rgb(59, 130, 246),        // #3B82F6 - blue
};

// ═══════════════════════════════════════════════════════════════════════
// Unicode Characters Library
// ═══════════════════════════════════════════════════════════════════════

// Braille patterns (2x4 dots per char = high resolution)
// Reference: https://en.wikipedia.org/wiki/Braille_Patterns
const BRAILLE = {
  empty: "⠀", full: "⣿",
  dots: "⠁⠂⠃⠄⠅⠆⠇⡀⡁⡂⡃⡄⡅⡆⡇⢀⢁⢂⢃⢄⢅⢆⢇⣀⣁⣂⣃⣄⣅⣆⣇",
  gradients: ["⠀", "⢀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"],
};

// Block elements for shading
const BLOCKS = {
  full: "█", light: "░", medium: "▒", dark: "▓",
  upper: "▀", lower: "▄", left: "▌", right: "▐",
  eighths: ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"],
  vEighths: ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
};

// Geometric shapes
const SHAPES = {
  triangles: { tl: "◤", tr: "◥", bl: "◣", br: "◢" },
  diamonds: { filled: "◆", empty: "◇", small: "⬥" },
  circles: { filled: "●", empty: "○", half: ["◐", "◑", "◒", "◓"] },
};

// Box drawing - rounded corners for modern feel
const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  lt: "├", rt: "┤", tt: "┬", bt: "┴",
};

// Sparkline characters (8 levels)
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// ═══════════════════════════════════════════════════════════════════════
// 3D Isometric Cube Logo - High Resolution Braille Art
// ═══════════════════════════════════════════════════════════════════════

/**
 * Premium 3D isometric cube using Braille characters
 * Features gradient shading on three visible faces
 * Top face: lightest, Left face: medium, Right face: darkest
 */
const ISOMETRIC_CUBE_BRAILLE = [
  "              ⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀              ",
  "          ⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⡀          ",
  "        ⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀        ",
  "      ⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀      ",
  "    ⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀    ",
  "   ⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦   ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿  ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿  ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿ PAI ⣿⣿⣿⣿⣿⣿⣿⣿⣿  ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿  ",
  "  ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿  ",
  "   ⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟   ",
  "    ⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋    ",
  "      ⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋      ",
  "        ⠉⠛⠻⠿⠿⠿⠿⠿⠿⠿⠿⠟⠛⠉        ",
  "              ⠉⠉⠉⠉⠉⠉              ",
];
const CUBE_WIDTH = 46;

// Alternative: Block-based geometric cube with gradient shading
const ISOMETRIC_CUBE_BLOCKS = [
  "          ╱────────────────╲          ",
  "        ╱░░░░░░░░░░░░░░░░░░░░╲        ",
  "      ╱░░░░░░░░░░░░░░░░░░░░░░░░╲      ",
  "    ╱░░░░░░░░░░░░░░░░░░░░░░░░░░░░╲    ",
  "  ╱░░░░░░░░░░░░ PAI ░░░░░░░░░░░░░░╲  ",
  "  │▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓│  ",
  "  │▒▒▒▒░░░░░░░░░░░░░░░░░░░░░▓▓▓▓│  ",
  "  │▒▒▒▒▒░░░░░░░░░░░░░░░░░░▓▓▓▓▓│  ",
  "  │▒▒▒▒▒▒░░░░░░░░░░░░░░░▓▓▓▓▓▓│  ",
  "    ╲▒▒▒▒▒▒░░░░░░░░░░▓▓▓▓▓▓╱    ",
  "      ╲▒▒▒▒▒▒░░░░▓▓▓▓▓▓╱      ",
  "        ╲▒▒▒▒▓▓▓▓▓▓╱        ",
  "          ╲────────╱          ",
];

// Compact high-detail version for narrower terminals
const COMPACT_CUBE = [
  "      ⣀⣤⣶⣶⣶⣶⣤⣀      ",
  "    ⣴⣿⣿⣿⣿⣿⣿⣿⣿⣦    ",
  "  ⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷  ",
  " ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿ ",
  " ⣿⣿⣿⣿ PAI ⣿⣿⣿⣿ ",
  " ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿ ",
  "  ⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟  ",
  "    ⠙⠿⣿⣿⣿⣿⠿⠋    ",
  "      ⠉⠉⠉⠉      ",
];
const COMPACT_CUBE_WIDTH = 24;

// ═══════════════════════════════════════════════════════════════════════
// Block Letter Art for "PAI"
// ═══════════════════════════════════════════════════════════════════════

const PAI_BLOCK_ART = [
  "██████╗  █████╗ ██╗",
  "██╔══██╗██╔══██╗██║",
  "██████╔╝███████║██║",
  "██╔═══╝ ██╔══██║██║",
  "██║     ██║  ██║██║",
  "╚═╝     ╚═╝  ╚═╝╚═╝",
];
const PAI_WIDTH = 19;

// ═══════════════════════════════════════════════════════════════════════
// Dynamic Stats Collection
// ═══════════════════════════════════════════════════════════════════════

interface SystemStats {
  name: string;
  skills: number;
  hooks: number;
  workItems: number;
  learnings: number;
  userFiles: number;
  model: string;
}

function readDAIdentity(): string {
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return settings.daidentity?.displayName || settings.daidentity?.name || settings.env?.DA || "PAI";
  } catch {
    return "PAI";
  }
}

function countSkills(): number {
  const skillsDir = join(CLAUDE_DIR, "skills");
  if (!existsSync(skillsDir)) return 66;
  let count = 0;
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md"))) count++;
    }
  } catch {}
  return count || 66;
}

function countHooks(): number {
  const hooksDir = join(CLAUDE_DIR, "hooks");
  if (!existsSync(hooksDir)) return 31;
  let count = 0;
  try {
    for (const entry of readdirSync(hooksDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) count++;
    }
  } catch {}
  return count || 31;
}

function countWorkItems(): number {
  const workDir = memoryPath("WORK");
  if (!existsSync(workDir)) return 100;
  let count = 0;
  try {
    for (const entry of readdirSync(workDir, { withFileTypes: true })) {
      if (entry.isDirectory()) count++;
    }
  } catch {}
  return count || 100;
}

function countLearnings(): number {
  const learningDir = memoryPath("LEARNING");
  if (!existsSync(learningDir)) return 1425;
  let count = 0;
  const countFiles = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) countFiles(join(dir, entry.name));
        else if (entry.isFile() && entry.name.endsWith(".md")) count++;
      }
    } catch {}
  };
  countFiles(learningDir);
  return count || 1425;
}

function countUserFiles(): number {
  const userDir = userPath();
  if (!existsSync(userDir)) return 47;
  let count = 0;
  const countRecursive = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) countRecursive(join(dir, entry.name));
        else if (entry.isFile()) count++;
      }
    } catch {}
  };
  countRecursive(userDir);
  return count || 47;
}

function getStats(): SystemStats {
  return {
    name: readDAIdentity(),
    skills: countSkills(),
    hooks: countHooks(),
    workItems: countWorkItems(),
    learnings: countLearnings(),
    userFiles: countUserFiles(),
    model: activeRuntimeLabel(CLAUDE_DIR),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padEnd(str: string, width: number): string {
  const visible = visibleLength(str);
  return str + " ".repeat(Math.max(0, width - visible));
}

function center(str: string, width: number): string {
  const visible = visibleLength(str);
  const total = width - visible;
  const left = Math.floor(total / 2);
  const right = total - left;
  return " ".repeat(Math.max(0, left)) + str + " ".repeat(Math.max(0, right));
}

// Generate progress bar with gradient colors
function progressBar(value: number, max: number, width: number = 12): string {
  const ratio = Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  // Gradient colors for filled portion
  let bar = "";
  for (let i = 0; i < filled; i++) {
    const pos = i / width;
    let color: string;
    if (pos < 0.33) color = GRADIENT.blue1;
    else if (pos < 0.66) color = GRADIENT.purple1;
    else color = GRADIENT.cyan1;
    bar += `${color}${BLOCKS.full}${RESET}`;
  }

  // Empty portion
  bar += `${UI.dark}${BLOCKS.light.repeat(empty)}${RESET}`;

  return `${UI.dim}[${RESET}${bar}${UI.dim}]${RESET}`;
}

// Generate animated sparkline histogram
function sparklineHistogram(length: number = 16): string {
  const colors = [
    GRADIENT.blue1, GRADIENT.blue2, GRADIENT.purple1, GRADIENT.purple2,
    GRADIENT.magenta, GRADIENT.cyan1, GRADIENT.cyan2, GRADIENT.teal,
  ];

  return Array.from({ length }, (_, i) => {
    const level = Math.floor(Math.random() * 8);
    const color = colors[i % colors.length];
    return `${color}${SPARK[level]}${RESET}`;
  }).join("");
}

// Color logo with gradient (top = blue, middle = purple, bottom = cyan)
function colorLogo(lines: string[]): string[] {
  return lines.map((line, i) => {
    const pos = i / (lines.length - 1);
    let color: string;

    if (pos < 0.33) color = GRADIENT.blue1;
    else if (pos < 0.66) color = GRADIENT.purple1;
    else color = GRADIENT.cyan1;

    // Special handling for PAI text
    if (line.includes("PAI") || line.includes("P A I")) {
      return line.replace(/P\s*A\s*I/,
        `${BOLD}${GRADIENT.blue1}P${RESET}${BOLD}${GRADIENT.purple1}A${RESET}${BOLD}${GRADIENT.cyan1}I${RESET}`
      );
    }

    return `${color}${line}${RESET}`;
  });
}

// Color PAI block art with gradient (P=blue, A=purple, I=cyan)
function colorPaiArt(): string[] {
  return PAI_BLOCK_ART.map(line => {
    // P section: chars 0-8, A section: chars 9-17, I section: chars 18+
    const p = `${BOLD}${GRADIENT.blue1}${line.substring(0, 9)}${RESET}`;
    const a = `${BOLD}${GRADIENT.purple1}${line.substring(9, 18)}${RESET}`;
    const i = `${BOLD}${GRADIENT.cyan1}${line.substring(18)}${RESET}`;
    return p + a + i;
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Main Banner Generation
// ═══════════════════════════════════════════════════════════════════════

function createNeofetchBanner(): string {
  const width = Math.max(getTerminalWidth(), 90);
  const stats = getStats();

  // Choose logo based on terminal width
  const useCompact = width < 100;
  const logo = useCompact ? COMPACT_CUBE : ISOMETRIC_CUBE_BRAILLE;
  const logoWidth = useCompact ? COMPACT_CUBE_WIDTH : CUBE_WIDTH;
  const coloredLogo = colorLogo(logo);

  const lines: string[] = [];
  const gap = 4;

  // ─────────────────────────────────────────────────────────────────
  // TOP SECTION: Logo (left) + Stats (right)
  // ─────────────────────────────────────────────────────────────────

  // Build stats lines with modern formatting
  const statsLines: string[] = [];

  // Header with gradient name
  const gradientName = stats.name.split("").map((c, i) => {
    const colors = [GRADIENT.blue1, GRADIENT.purple1, GRADIENT.cyan1];
    return `${BOLD}${colors[i % colors.length]}${c}${RESET}`;
  }).join("");
  statsLines.push(`${gradientName} ${UI.muted}@${RESET} ${UI.subtext}Personal AI Infrastructure${RESET}`);
  statsLines.push(`${UI.dim}${"─".repeat(40)}${RESET}`);
  statsLines.push("");

  // Stats with emoji icons and progress bars
  const maxSkills = 100;
  const maxHooks = 50;

  statsLines.push(`${GRADIENT.cyan1}⚡${RESET} ${UI.muted}DA Name${RESET}      ${UI.text}${stats.name}${RESET}`);
  statsLines.push(`${GRADIENT.blue1}🔧${RESET} ${UI.muted}Skills${RESET}       ${GRADIENT.blue1}${stats.skills}${RESET} ${progressBar(stats.skills, maxSkills, 10)}`);
  statsLines.push(`${GRADIENT.purple1}⚙${RESET}  ${UI.muted}Hooks${RESET}        ${GRADIENT.purple1}${stats.hooks}${RESET} ${progressBar(stats.hooks, maxHooks, 10)}`);
  statsLines.push(`${UI.warning}📋${RESET} ${UI.muted}Work Items${RESET}   ${UI.warning}${stats.workItems}+${RESET}`);
  statsLines.push(`${UI.success}💡${RESET} ${UI.muted}Learnings${RESET}    ${UI.success}${stats.learnings}${RESET}`);
  statsLines.push(`${GRADIENT.blue2}📁${RESET} ${UI.muted}User Files${RESET}   ${GRADIENT.blue2}${stats.userFiles}${RESET}`);
  statsLines.push(`${GRADIENT.magenta}🎯${RESET} ${UI.muted}Model${RESET}        ${GRADIENT.magenta}${stats.model}${RESET}`);
  statsLines.push("");
  statsLines.push(`${UI.dim}Activity${RESET} ${sparklineHistogram(24)}`);

  // Combine logo and stats side-by-side
  lines.push(""); // Top padding
  const maxRows = Math.max(coloredLogo.length, statsLines.length);

  for (let i = 0; i < maxRows; i++) {
    const logoLine = i < coloredLogo.length
      ? padEnd(coloredLogo[i], logoWidth)
      : " ".repeat(logoWidth);
    const statLine = i < statsLines.length ? statsLines[i] : "";
    lines.push(`  ${logoLine}${" ".repeat(gap)}${statLine}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // BOTTOM SECTION: Full-width footer area
  // ─────────────────────────────────────────────────────────────────

  lines.push("");

  // Calculate content width for bottom section
  const bottomWidth = Math.min(width - 4, 80);

  // Top border with rounded corners
  lines.push(`  ${UI.dim}${BOX.tl}${"─".repeat(bottomWidth - 2)}${BOX.tr}${RESET}`);

  // Gradient header: PAI | Personal AI Infrastructure
  const paiGradient = `${BOLD}${GRADIENT.blue1}P${RESET}${BOLD}${GRADIENT.purple1}A${RESET}${BOLD}${GRADIENT.cyan1}I${RESET}`;
  const headerContent = `${paiGradient} ${UI.dim}│${RESET} ${UI.text}Personal AI Infrastructure${RESET}`;
  lines.push(`  ${UI.dim}│${RESET}${center(headerContent, bottomWidth - 2)}${UI.dim}│${RESET}`);

  // Quote
  const quote = `${ITALIC}${UI.subtext}"Magnifying human capabilities through structured intelligence..."${RESET}`;
  lines.push(`  ${UI.dim}│${RESET}${center(quote, bottomWidth - 2)}${UI.dim}│${RESET}`);

  // Empty line for spacing
  lines.push(`  ${UI.dim}│${RESET}${" ".repeat(bottomWidth - 2)}${UI.dim}│${RESET}`);

  // Animated sparkline histogram (full gradient wave)
  const waveUp = SPARK.map((s, i) => {
    const colors = [GRADIENT.blue1, GRADIENT.blue2, GRADIENT.purple1, GRADIENT.purple2, GRADIENT.magenta, GRADIENT.cyan1, GRADIENT.cyan2, GRADIENT.teal];
    return `${colors[i]}${s}${RESET}`;
  }).join("");
  const waveDown = SPARK.slice().reverse().map((s, i) => {
    const colors = [GRADIENT.teal, GRADIENT.cyan2, GRADIENT.cyan1, GRADIENT.magenta, GRADIENT.purple2, GRADIENT.purple1, GRADIENT.blue2, GRADIENT.blue1];
    return `${colors[i]}${s}${RESET}`;
  }).join("");
  const fullWave = waveUp + waveDown + waveUp + waveDown;
  lines.push(`  ${UI.dim}│${RESET}${center(fullWave, bottomWidth - 2)}${UI.dim}│${RESET}`);

  // Empty line for spacing
  lines.push(`  ${UI.dim}│${RESET}${" ".repeat(bottomWidth - 2)}${UI.dim}│${RESET}`);

  // PAI block art (centered)
  const paiArt = colorPaiArt();
  for (const paiLine of paiArt) {
    lines.push(`  ${UI.dim}│${RESET}${center(paiLine, bottomWidth - 2)}${UI.dim}│${RESET}`);
  }

  // Empty line for spacing
  lines.push(`  ${UI.dim}│${RESET}${" ".repeat(bottomWidth - 2)}${UI.dim}│${RESET}`);

  // GitHub URL with modern link styling
  const linkIcon = `${GRADIENT.cyan2}◆${RESET}`;
  const githubUrl = `${linkIcon} ${UI.subtext}github.com/${RESET}${GRADIENT.blue1}danielmiessler${RESET}${UI.subtext}/${RESET}${GRADIENT.purple1}PAI${RESET}`;
  lines.push(`  ${UI.dim}│${RESET}${center(githubUrl, bottomWidth - 2)}${UI.dim}│${RESET}`);

  // Bottom border
  lines.push(`  ${UI.dim}${BOX.bl}${"─".repeat(bottomWidth - 2)}${BOX.br}${RESET}`);

  lines.push(""); // Bottom padding

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Compact Mode Banner (for narrow terminals)
// ═══════════════════════════════════════════════════════════════════════

function createCompactBanner(): string {
  const stats = getStats();
  const lines: string[] = [];

  // Compact gradient header
  const paiGradient = `${BOLD}${GRADIENT.blue1}P${RESET}${BOLD}${GRADIENT.purple1}A${RESET}${BOLD}${GRADIENT.cyan1}I${RESET}`;
  const kaiGradient = stats.name.split("").map((c, i) => {
    const colors = [GRADIENT.blue1, GRADIENT.purple1, GRADIENT.cyan1];
    return `${BOLD}${colors[i % colors.length]}${c}${RESET}`;
  }).join("");

  lines.push("");
  lines.push(`  ${UI.dim}╭──${RESET} ${paiGradient} ${UI.dim}│${RESET} ${UI.subtext}Personal AI Infrastructure${RESET} ${UI.dim}──────╮${RESET}`);
  lines.push(`  ${UI.dim}│${RESET}                                                 ${UI.dim}│${RESET}`);
  lines.push(`  ${UI.dim}│${RESET}   ${kaiGradient}  ${GRADIENT.cyan1}⚡${RESET}${UI.text}${stats.skills}${RESET} ${GRADIENT.purple1}⚙${RESET}${UI.text}${stats.hooks}${RESET} ${UI.success}💡${RESET}${UI.text}${stats.learnings}${RESET} ${GRADIENT.magenta}🎯${RESET}${UI.text}${stats.model}${RESET}   ${UI.dim}│${RESET}`);
  lines.push(`  ${UI.dim}│${RESET}                                                 ${UI.dim}│${RESET}`);
  lines.push(`  ${UI.dim}│${RESET}   ${sparklineHistogram(28)} ${UI.success}●${RESET} ${UI.subtext}ready${RESET}   ${UI.dim}│${RESET}`);
  lines.push(`  ${UI.dim}╰──────────────────────────────────────────────────╯${RESET}`);
  lines.push("");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════════════════════

function main(): void {
  const args = process.argv.slice(2);
  const compact = args.includes("--compact") || args.includes("-c");
  const test = args.includes("--test");

  try {
    if (test) {
      console.log("\n" + "═".repeat(80));
      console.log("  NEOFETCH BANNER - FULL MODE");
      console.log("═".repeat(80));
      console.log(createNeofetchBanner());

      console.log("\n" + "═".repeat(80));
      console.log("  NEOFETCH BANNER - COMPACT MODE");
      console.log("═".repeat(80));
      console.log(createCompactBanner());
    } else if (compact) {
      console.log(createCompactBanner());
    } else {
      console.log(createNeofetchBanner());
    }
  } catch (e) {
    console.error("Banner error:", e);
  }
}

main();

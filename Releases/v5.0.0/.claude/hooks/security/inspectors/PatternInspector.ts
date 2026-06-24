import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { Inspector, InspectionContext, InspectionResult } from '../types';
import { ALLOW, deny, requireApproval, alert } from '../types';
import { paiPath, userPath } from '../../lib/paths';

// ── Types ──

interface PatternEntry {
  pattern: string;
  reason: string;
}

interface PatternsConfig {
  version: string;
  philosophy: { mode: string; principle: string };
  bash: {
    trusted: PatternEntry[];
    blocked: PatternEntry[];
    confirm: PatternEntry[];
    alert: PatternEntry[];
  };
  paths: {
    zeroAccess: string[];
    alertAccess: string[];
    confirmAccess: string[];
    readOnly: string[];
    confirmWrite: string[];
    noDelete: string[];
  };
  projects: Record<string, unknown>;
}

type FileAction = 'read' | 'write' | 'delete';

// ── Pattern Loading ──

const USER_PATTERNS_PATH = userPath('SECURITY', 'PATTERNS.yaml');
const SYSTEM_PATTERNS_PATH = paiPath('DOCUMENTATION', 'Security', 'Patterns.example.yaml');

let patternsCache: PatternsConfig | null = null;

function emptyPatternsConfig(): PatternsConfig {
  return {
    version: 'unknown',
    philosophy: { mode: 'targeted', principle: '' },
    bash: { trusted: [], blocked: [], confirm: [], alert: [] },
    paths: { zeroAccess: [], alertAccess: [], confirmAccess: [], readOnly: [], confirmWrite: [], noDelete: [] },
    projects: {},
  };
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePatternsConfig(content: string): PatternsConfig {
  const config = emptyPatternsConfig();
  let section: 'bash' | 'paths' | 'philosophy' | null = null;
  let subsection = '';
  let currentPattern: PatternEntry | null = null;

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) continue;

    const versionMatch = line.match(/^version:\s*(.+)$/);
    if (versionMatch) {
      config.version = parseScalar(versionMatch[1]);
      continue;
    }

    const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (topMatch) {
      section = topMatch[1] === 'bash' || topMatch[1] === 'paths' || topMatch[1] === 'philosophy'
        ? topMatch[1] as typeof section
        : null;
      subsection = '';
      currentPattern = null;
      continue;
    }

    if (section === 'philosophy') {
      const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match && (match[1] === 'mode' || match[1] === 'principle')) {
        config.philosophy[match[1]] = parseScalar(match[2]);
      }
      continue;
    }

    if (section === 'bash') {
      const subMatch = line.match(/^\s{2}(trusted|blocked|confirm|alert):\s*$/);
      if (subMatch) {
        subsection = subMatch[1];
        currentPattern = null;
        continue;
      }
      const patternMatch = line.match(/^\s{4}-\s*pattern:\s*(.*)$/);
      if (patternMatch && subsection in config.bash) {
        currentPattern = { pattern: parseScalar(patternMatch[1]), reason: '' };
        config.bash[subsection as keyof PatternsConfig['bash']].push(currentPattern);
        continue;
      }
      const reasonMatch = line.match(/^\s{6}reason:\s*(.*)$/);
      if (reasonMatch && currentPattern) {
        currentPattern.reason = parseScalar(reasonMatch[1]);
      }
      continue;
    }

    if (section === 'paths') {
      const subMatch = line.match(/^\s{2}(zeroAccess|alertAccess|confirmAccess|readOnly|confirmWrite|noDelete):\s*$/);
      if (subMatch) {
        subsection = subMatch[1];
        continue;
      }
      const itemMatch = line.match(/^\s{4}-\s*(.*)$/);
      if (itemMatch && subsection in config.paths) {
        config.paths[subsection as keyof PatternsConfig['paths']].push(parseScalar(itemMatch[1]));
      }
    }
  }

  return config;
}

function loadPatterns(): PatternsConfig | null {
  if (patternsCache) return patternsCache;

  let patternsPath: string | null = null;
  if (existsSync(USER_PATTERNS_PATH)) {
    patternsPath = USER_PATTERNS_PATH;
  } else if (existsSync(SYSTEM_PATTERNS_PATH)) {
    patternsPath = SYSTEM_PATTERNS_PATH;
  }

  if (!patternsPath) return null;

  try {
    const content = readFileSync(patternsPath, 'utf-8');
    patternsCache = parsePatternsConfig(content);
    return patternsCache;
  } catch {
    return null;
  }
}

// ── Command Normalization ──

function stripEnvVarPrefix(command: string): string {
  return command.replace(
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+)*/,
    ''
  );
}

// ── Pattern Matching ──

function matchesBashPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(command);
  } catch {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
}

function maskQuotedSegments(command: string): string {
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let masked = '';

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      masked += quote ? ' ' : char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      masked += quote ? ' ' : char;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        masked += char;
      } else {
        masked += ' ';
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      masked += char;
      continue;
    }

    masked += char;
  }

  return masked;
}

function isPipeToShellPattern(entry: PatternEntry): boolean {
  const pattern = entry.pattern.toLowerCase();
  const reason = entry.reason.toLowerCase();
  return pattern.includes("\\|") &&
    (pattern.includes("sh") || pattern.includes("bash") || pattern.includes("zsh")) &&
    reason.includes("shell");
}

function matchesShellPattern(command: string, entry: PatternEntry): boolean {
  const target = isPipeToShellPattern(entry) ? maskQuotedSegments(command) : command;
  return matchesBashPattern(target, entry.pattern);
}

function expandTilde(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  const expandedPattern = expandTilde(pattern);
  const normalizedPath = resolve(expandTilde(filePath));

  if (pattern.includes('*')) {
    let regexStr = expandedPattern
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '<<<SINGLESTAR>>>')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/<<<DOUBLESTAR>>>/g, '.*')
      .replace(/<<<SINGLESTAR>>>/g, '[^/]*');
    try {
      return new RegExp(`^${regexStr}$`).test(normalizedPath);
    } catch {
      return false;
    }
  }

  return normalizedPath === expandedPattern ||
    normalizedPath.startsWith(expandedPattern.endsWith('/') ? expandedPattern : expandedPattern + '/');
}

// ── Action Detection ──

function getFileAction(toolName: string): FileAction | null {
  switch (toolName) {
    case 'Read': return 'read';
    case 'Write': return 'write';
    case 'Edit': return 'write';
    case 'MultiEdit': return 'write';
    default: return null;
  }
}

function extractFilePath(input: Record<string, unknown> | string): string {
  if (typeof input === 'string') return input;
  return (input?.file_path as string) || '';
}

function extractCommand(input: Record<string, unknown> | string): string {
  if (typeof input === 'string') return input;
  return (input?.command as string) || '';
}

function isShellTool(toolName: string): boolean {
  return ['Bash', 'Shell', 'exec'].includes(toolName);
}

// ── Inspection Logic ──

function inspectBash(command: string, config: PatternsConfig): InspectionResult {
  const normalized = stripEnvVarPrefix(command);
  if (!normalized) return ALLOW;

  for (const p of (config.bash.trusted || [])) {
    if (matchesShellPattern(normalized, p)) return ALLOW;
  }

  for (const p of (config.bash.blocked || [])) {
    if (matchesShellPattern(normalized, p)) return deny(p.reason);
  }

  for (const p of (config.bash.confirm || [])) {
    if (matchesShellPattern(normalized, p)) return requireApproval(p.reason);
  }

  for (const p of (config.bash.alert || [])) {
    if (matchesShellPattern(normalized, p)) return alert(p.reason);
  }

  return ALLOW;
}

function inspectPath(filePath: string, action: FileAction, config: PatternsConfig): InspectionResult {
  const normalized = resolve(expandTilde(filePath));

  for (const p of (config.paths.zeroAccess || [])) {
    if (matchesPathPattern(normalized, p)) return deny(`Zero access path: ${p}`);
  }

  for (const p of (config.paths.alertAccess || [])) {
    if (matchesPathPattern(normalized, p)) return alert(`Env file access logged: ${p}`);
  }

  for (const p of (config.paths.confirmAccess || [])) {
    if (matchesPathPattern(normalized, p)) return requireApproval(`Sensitive file access requires confirmation: ${p}`);
  }

  if (action === 'write') {
    for (const p of (config.paths.readOnly || [])) {
      if (matchesPathPattern(normalized, p)) return deny(`Read-only path: ${p}`);
    }

    for (const p of (config.paths.confirmWrite || [])) {
      if (matchesPathPattern(normalized, p)) return requireApproval(`Writing to protected file requires confirmation: ${p}`);
    }
  }

  if (action === 'delete') {
    for (const p of (config.paths.noDelete || [])) {
      if (matchesPathPattern(normalized, p)) return deny(`Cannot delete protected path: ${p}`);
    }
  }

  return ALLOW;
}

// ── Inspector Implementation ──

class PatternInspector implements Inspector {
  name = 'PatternInspector';
  priority = 100;

  inspect(ctx: InspectionContext): InspectionResult {
    const config = loadPatterns();
    if (!config) return deny('CRITICAL: Security patterns file missing — fail-closed');

    if (isShellTool(ctx.toolName)) {
      const command = extractCommand(ctx.toolInput);
      return inspectBash(command, config);
    }

    const fileAction = getFileAction(ctx.toolName);
    if (fileAction) {
      const filePath = extractFilePath(ctx.toolInput);
      if (!filePath) return ALLOW;
      return inspectPath(filePath, fileAction, config);
    }

    return ALLOW;
  }
}

export function createPatternInspector(): Inspector {
  return new PatternInspector();
}

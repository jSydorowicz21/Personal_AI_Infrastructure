/**
 * change-detection.ts - Utilities for detecting PAI system changes
 *
 * Parses transcripts for file modification tool_use blocks and categorizes
 * changes to determine if background integrity maintenance is needed.
 */

import { readFileSync, existsSync } from 'fs';
import { isAbsolute, join, relative, basename } from 'path';
import { getFrameworkDir, getMemoryDir, getPaiDir, getUserDir, memoryPath } from './paths';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  tool: 'Write' | 'Edit' | 'MultiEdit';
  path: string;
  category: ChangeCategory | null;
  isPhilosophical: boolean;
  isStructural: boolean;
}

export type ChangeCategory =
  | 'skill'
  | 'hook'
  | 'tool'
  | 'workflow'
  | 'config'
  | 'core-system'
  | 'memory-system'
  | 'documentation';

export type SignificanceLabel = 'trivial' | 'minor' | 'moderate' | 'major' | 'critical';

export type ChangeType =
  | 'skill_update'
  | 'structure_change'
  | 'doc_update'
  | 'hook_update'
  | 'workflow_update'
  | 'config_update'
  | 'tool_update'
  | 'multi_area';

export interface IntegrityState {
  last_run: string;
  last_changes_hash: string;
  cooldown_until: string | null;
}

// ============================================================================
// Path Constants
// ============================================================================

const PAI_DIR = getPaiDir();
const FRAMEWORK_DIR = getFrameworkDir();
const MEMORY_DIR = getMemoryDir();
const USER_DIR = getUserDir();
const STATE_FILE = memoryPath('STATE', 'integrity-state.json');

// Paths that are excluded from integrity checks
const EXCLUDED_PATHS = [
  'MEMORY/WORK/',
  'MEMORY/LEARNING/',
  'MEMORY/STATE/',
  'Plans/',
  'projects/',
  '.git/',
  'node_modules/',
  'ShellSnapshots/',
];

// High-priority paths that always warrant documentation
const HIGH_PRIORITY_PATHS = [
  'PAI/',
  'PAISYSTEMARCHITECTURE.md',
  'SKILLSYSTEM.md',
  'MEMORYSYSTEM.md',
  'THEHOOKSYSTEM.md',
  'DOCUMENTATION/Hooks/HookSystem.md',
  'THEDELEGATIONSYSTEM.md',
  'THENOTIFICATIONSYSTEM.md',
  'hooks.json',
  'settings.json',
  'config.toml',
];

// Philosophical/architectural patterns in paths
const PHILOSOPHICAL_PATTERNS = [
  /PAI\//i,
  /ARCHITECTURE/i,
  /PRINCIPLES/i,
  /FOUNDING/i,
  /IDENTITY/i,
];

// Structural change patterns
const STRUCTURAL_PATTERNS = [
  /\/SKILL\.md$/i,           // Skill definitions
  /\/Workflows\//i,          // Workflow routing
  /(^|\/)hooks\.json$/i,     // Native hook registry
  /settings\.json$/i,        // Configuration
  /(^|\/)config\.toml$/i,    // Codex/OpenCode configuration
  /frontmatter/i,            // Metadata changes
];

// ============================================================================
// Transcript Parsing
// ============================================================================

interface DetectedFileOperation {
  tool: FileChange['tool'];
  path: string;
}

function normalizePathText(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizePathTextLower(value: string): string {
  return normalizePathText(value).replace(/\/+$/g, '').toLowerCase();
}

function isNativeHookRegistryPath(path: string): boolean {
  return /(^|\/)hooks\.json$/i.test(normalizePathText(path));
}

function isNativeFrameworkConfigPath(path: string): boolean {
  return /(^|\/)(settings\.json|config\.toml)$/i.test(normalizePathText(path));
}

function parseJsonMaybe(value: any): any {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizedToolName(name: unknown): string {
  return String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function toolKindFromName(name: unknown): FileChange['tool'] | null {
  const normalized = normalizedToolName(name);
  if (normalized.includes('multiedit')) return 'MultiEdit';
  if (normalized.includes('write') || normalized.includes('create')) return 'Write';
  if (normalized.includes('edit') || normalized.includes('update')) return 'Edit';
  return null;
}

function isApplyPatchTool(name: unknown): boolean {
  return normalizedToolName(name).includes('applypatch');
}

function pushOperation(
  operations: DetectedFileOperation[],
  seen: Set<string>,
  tool: FileChange['tool'],
  path: unknown,
): void {
  if (typeof path !== 'string' || !path.trim()) return;
  const normalized = normalizePathText(path.trim());
  const key = `${tool}:${normalized.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  operations.push({ tool, path: normalized });
}

function patchOperationsFromText(patch: string, operations: DetectedFileOperation[], seen: Set<string>): void {
  if (!patch.includes('*** Begin Patch')) return;

  const regex = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(patch)) !== null) {
    const action = match[1];
    const rawPath = (match[2] || match[3] || '').trim();
    if (!rawPath) continue;
    pushOperation(operations, seen, action === 'Add' ? 'Write' : 'Edit', rawPath);
  }
}

function addOperationsFromToolCall(
  toolName: unknown,
  rawArgs: any,
  operations: DetectedFileOperation[],
  seen: Set<string>,
): void {
  const args = parseJsonMaybe(rawArgs);
  const tool = toolKindFromName(toolName);
  const directPath = args.file_path || args.filePath || args.path;

  if (tool && directPath) {
    pushOperation(operations, seen, tool, directPath);
  }

  if (tool === 'MultiEdit' && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      pushOperation(operations, seen, 'MultiEdit', edit?.file_path || edit?.filePath || edit?.path || directPath);
    }
  }

  const patchText = args.patch || args.patchText || args.input || (isApplyPatchTool(toolName) ? rawArgs : '');
  if (typeof patchText === 'string') {
    patchOperationsFromText(patchText, operations, seen);
  }
}

function detectFileOperationsFromTranscript(transcriptPath: string): DetectedFileOperation[] {
  if (!existsSync(transcriptPath)) {
    console.error('[ChangeDetection] Transcript not found:', transcriptPath);
    return [];
  }

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n');
  const operations: DetectedFileOperation[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      if (entry.type === 'tool_use') {
        addOperationsFromToolCall(entry.name, entry.input || entry.arguments || entry.args || {}, operations, seen);
        continue;
      }

      if (entry.type === 'assistant' && entry.message?.content) {
        const contentArray = Array.isArray(entry.message.content)
          ? entry.message.content
          : [];

        for (const block of contentArray) {
          if (block.type !== 'tool_use') continue;
          addOperationsFromToolCall(block.name, block.input || {}, operations, seen);
        }
        continue;
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
        addOperationsFromToolCall(entry.payload.name, entry.payload.arguments, operations, seen);
        continue;
      }

      if (entry.type === 'function_call') {
        addOperationsFromToolCall(entry.name, entry.arguments || entry.args || entry.input, operations, seen);
        continue;
      }

      if (entry.type === 'tool_call') {
        addOperationsFromToolCall(entry.name || entry.tool, entry.arguments || entry.args || entry.tool_input, operations, seen);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  return operations;
}

/**
 * Parse modified file paths from Claude, Codex, or OpenCode transcripts.
 */
export function parseModifiedFilePaths(transcriptPath: string): Set<string> {
  return new Set(detectFileOperationsFromTranscript(transcriptPath).map((operation) => normalizePathText(operation.path)));
}

/**
 * Parse tool/function call blocks from a transcript that modify files.
 * Extracts Write, Edit, and MultiEdit operations.
 */
export function parseToolUseBlocks(transcriptPath: string): FileChange[] {
  try {
    const changes: FileChange[] = [];
    const seenPaths = new Set<string>();

    for (const operation of detectFileOperationsFromTranscript(transcriptPath)) {
      const path = normalizeToRelativePath(operation.path);
      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        changes.push(createFileChange(operation.tool, path));
      }
    }

    return changes;
  } catch (error) {
    console.error('[ChangeDetection] Error parsing transcript:', error);
    return [];
  }
}

/**
 * Normalize an absolute path to relative (to PAI_DIR).
 */
function normalizeToRelativePath(absolutePath: string): string {
  const normalizedInput = normalizePathText(absolutePath);
  const inputLower = normalizePathTextLower(normalizedInput);

  if (inputLower.startsWith(normalizePathTextLower(PAI_DIR) + '/')) {
    return normalizePathText(relative(PAI_DIR, absolutePath));
  }
  if (inputLower.startsWith(normalizePathTextLower(FRAMEWORK_DIR) + '/')) {
    return normalizePathText(relative(FRAMEWORK_DIR, absolutePath));
  }
  if (inputLower.startsWith(normalizePathTextLower(MEMORY_DIR) + '/')) {
    return normalizePathText(join('MEMORY', relative(MEMORY_DIR, absolutePath)));
  }
  if (inputLower.startsWith(normalizePathTextLower(USER_DIR) + '/')) {
    return normalizePathText(join('USER', relative(USER_DIR, absolutePath)));
  }
  return normalizedInput;
}

/**
 * Create a FileChange object with categorization.
 */
function createFileChange(tool: FileChange['tool'], path: string): FileChange {
  return {
    tool,
    path,
    category: categorizeChange(path),
    isPhilosophical: isPhilosophicalPath(path),
    isStructural: isStructuralPath(path),
  };
}

// ============================================================================
// Change Categorization
// ============================================================================

/**
 * Categorize a file path by its location in the PAI system.
 */
export function categorizeChange(path: string): ChangeCategory | null {
  const normalizedPath = normalizePathText(path);

  // Check exclusions first
  for (const excluded of EXCLUDED_PATHS) {
    if (normalizedPath.includes(excluded)) {
      return null;
    }
  }

  const absolutePath = isAbsolute(normalizedPath) || /^[A-Za-z]:\//.test(normalizedPath)
    ? normalizedPath
    : normalizePathText(join(PAI_DIR, normalizedPath));
  const absoluteLower = normalizePathTextLower(absolutePath);
  const paiLower = normalizePathTextLower(PAI_DIR);
  const frameworkLower = normalizePathTextLower(FRAMEWORK_DIR);
  const relativeFrameworkRoots = /^(hooks|skills|commands|agents|custom-agents)\//i.test(normalizedPath) ||
    /^(CLAUDE|AGENTS|RTK)\.md$/i.test(normalizedPath) ||
    isNativeHookRegistryPath(normalizedPath) ||
    isNativeFrameworkConfigPath(normalizedPath);
  const relativePaiRoots = /^(TOOLS|ALGORITHM|DOCUMENTATION|PULSE|USER|MEMORY)\//i.test(normalizedPath) ||
    /^PAI_SYSTEM_PROMPT\.md$/i.test(normalizedPath);

  if (!absoluteLower.startsWith(paiLower + '/') &&
      !absoluteLower.startsWith(frameworkLower + '/') &&
      !relativeFrameworkRoots &&
      !relativePaiRoots) {
    return null;
  }

  // Categorize by path pattern
  if (normalizedPath.includes('skills/')) {
    // Exclude personal/private skills (prefixed with _ by convention)
    const skillMatch = normalizedPath.match(/skills\/(_[^/]+)/);
    if (skillMatch) return null;
    if (normalizedPath.includes('/Workflows/')) return 'workflow';
    if (normalizedPath.match(/PAI\/(?:DOCUMENTATION\/)?(?:PAISYSTEM|THEHOOKSYSTEM|THEDELEGATION|MEMORYSYSTEM)/)) return 'core-system';
    return 'skill';
  }

  if (normalizedPath.includes('hooks/') || isNativeHookRegistryPath(normalizedPath)) return 'hook';
  if (normalizedPath.startsWith('TOOLS/') || normalizedPath.includes('/TOOLS/') || normalizedPath.includes('/Tools/')) return 'tool';
  if (normalizedPath.includes('MEMORY/PAISYSTEMUPDATES/')) return 'documentation';
  if (normalizedPath.includes('MEMORY/')) return 'memory-system';
  if (isNativeFrameworkConfigPath(normalizedPath) || /^(CLAUDE|AGENTS|RTK)\.md$/i.test(normalizedPath)) return 'config';
  if (normalizedPath.endsWith('.md') && !normalizedPath.includes('WORK/')) return 'documentation';

  return null;
}

/**
 * Check if a path represents philosophical/architectural content.
 */
function isPhilosophicalPath(path: string): boolean {
  for (const pattern of PHILOSOPHICAL_PATTERNS) {
    if (pattern.test(path)) return true;
  }
  for (const highPriority of HIGH_PRIORITY_PATHS) {
    if (path.includes(highPriority)) return true;
  }
  return false;
}

/**
 * Check if a path represents structural content (SKILL.md, workflows, config).
 */
function isStructuralPath(path: string): boolean {
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(path)) return true;
  }
  return false;
}

// ============================================================================
// Significance Detection
// ============================================================================

/**
 * Determine if changes are significant enough to warrant background integrity check.
 */
export function isSignificantChange(changes: FileChange[]): boolean {
  // Filter to only PAI system changes
  const systemChanges = changes.filter(c => c.category !== null);

  if (systemChanges.length === 0) return false;

  // Always significant if philosophical or structural changes
  if (systemChanges.some(c => c.isPhilosophical || c.isStructural)) {
    return true;
  }

  // Significant if multiple files in same domain
  const categories = new Set(systemChanges.map(c => c.category));
  if (categories.size >= 1 && systemChanges.length >= 2) {
    return true;
  }

  // Significant if any skill, hook, or core-system change
  const importantCategories: ChangeCategory[] = ['skill', 'hook', 'tool', 'core-system', 'workflow'];
  if (systemChanges.some(c => importantCategories.includes(c.category!))) {
    return true;
  }

  return false;
}

/**
 * Check if changes warrant documentation.
 * UPDATED: Lower thresholds for more granular, frequent documentation.
 * Philosophy: File system is cheap, more signal is valuable.
 */
export function shouldDocumentChanges(changes: FileChange[]): boolean {
  const systemChanges = changes.filter(c => c.category !== null);

  // No changes to document
  if (systemChanges.length === 0) return false;

  // Always document philosophical or structural changes
  if (systemChanges.some(c => c.isPhilosophical || c.isStructural)) {
    return true;
  }

  // Document ANY skill, hook, workflow, core-system, or config change
  const importantCategories: ChangeCategory[] = ['skill', 'hook', 'tool', 'workflow', 'core-system', 'config'];
  if (systemChanges.some(c => c.category && importantCategories.includes(c.category))) {
    return true;
  }

  // Document if 2+ files changed (lowered from 3+)
  if (systemChanges.length >= 2) {
    return true;
  }

  // Document new file creation in system areas
  const newFiles = systemChanges.filter(c => c.tool === 'Write');
  if (newFiles.length > 0) return true;

  // Document any tool file changes (.ts in Tools/)
  if (systemChanges.some(c => c.path.includes('/Tools/') && c.path.endsWith('.ts'))) {
    return true;
  }

  return false;
}

// ============================================================================
// Throttling
// ============================================================================

// Reduced from 5 to 2 minutes for more frequent documentation updates
const COOLDOWN_MINUTES = 2;

/**
 * Read the current integrity state.
 */
export function readIntegrityState(): IntegrityState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const content = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Check if we're within the cooldown period.
 */
export function isInCooldown(): boolean {
  const state = readIntegrityState();
  if (!state?.cooldown_until) return false;

  const cooldownUntil = new Date(state.cooldown_until);
  return new Date() < cooldownUntil;
}

/**
 * Generate a hash of changes for deduplication.
 */
export function hashChanges(changes: FileChange[]): string {
  const sorted = changes
    .map(c => `${c.tool}:${c.path}`)
    .sort()
    .join('|');

  // Simple hash
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const char = sorted.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Check if changes are duplicates of the last run.
 */
export function isDuplicateRun(changes: FileChange[]): boolean {
  const state = readIntegrityState();
  if (!state?.last_changes_hash) return false;

  const currentHash = hashChanges(changes);
  return currentHash === state.last_changes_hash;
}

/**
 * Get the cooldown end time.
 */
export function getCooldownEndTime(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + COOLDOWN_MINUTES);
  return now.toISOString();
}

// ============================================================================
// Significance and Change Type Determination
// ============================================================================

/**
 * Determine the significance label based on change characteristics.
 */
export function determineSignificance(changes: FileChange[]): SignificanceLabel {
  const count = changes.length;
  const hasStructural = changes.some(c => c.isStructural);
  const hasPhilosophical = changes.some(c => c.isPhilosophical);
  const hasNewFiles = changes.some(c => c.tool === 'Write');

  const categories = new Set(changes.map(c => c.category).filter(Boolean));
  const hasCoreSystem = changes.some(c => c.category === 'core-system');
  const hasHooks = changes.some(c => c.category === 'hook');
  const hasSkills = changes.some(c => c.category === 'skill');

  // Critical: breaking changes, major restructuring
  if (hasStructural && hasPhilosophical && count >= 5) {
    return 'critical';
  }

  // Major: new skills/workflows, architectural decisions
  if (hasNewFiles && (hasStructural || hasPhilosophical)) {
    return 'major';
  }
  if (hasCoreSystem || (categories.size >= 3)) {
    return 'major';
  }
  if (hasHooks && count >= 3) {
    return 'major';
  }

  // Moderate: multi-file updates, small features
  if (count >= 3 || categories.size >= 2) {
    return 'moderate';
  }
  if (hasSkills && count >= 2) {
    return 'moderate';
  }

  // Minor: single file doc updates
  if (count === 1 && !hasStructural && !hasPhilosophical) {
    return 'minor';
  }

  // Trivial: only if very small doc changes
  if (count === 1 && changes[0].category === 'documentation') {
    return 'trivial';
  }

  return 'minor';
}

/**
 * Determine the change type based on affected files.
 */
export function inferChangeType(changes: FileChange[]): ChangeType {
  const categories = changes.map(c => c.category).filter(Boolean);
  const uniqueCategories = new Set(categories);

  // Multi-area if touching 3+ categories
  if (uniqueCategories.size >= 3) {
    return 'multi_area';
  }

  // Single category cases
  if (uniqueCategories.size === 1) {
    const cat = [...uniqueCategories][0];
    switch (cat) {
      case 'skill': return changes.some(c => c.isStructural) ? 'structure_change' : 'skill_update';
      case 'hook': return 'hook_update';
      case 'tool': return 'tool_update';
      case 'workflow': return 'workflow_update';
      case 'config': return 'config_update';
      case 'core-system': return 'structure_change';
      case 'documentation': return 'doc_update';
      default: return 'skill_update';
    }
  }

  // Two categories - pick the more significant one
  if (uniqueCategories.has('hook')) return 'hook_update';
  if (uniqueCategories.has('tool')) return 'tool_update';
  if (uniqueCategories.has('skill')) return 'skill_update';
  if (uniqueCategories.has('workflow')) return 'workflow_update';
  if (uniqueCategories.has('config')) return 'config_update';

  return 'multi_area';
}

/**
 * Generate a descriptive 4-8 word title based on the changes.
 */
export function generateDescriptiveTitle(changes: FileChange[]): string {
  const paths = changes.map(c => c.path);

  // Extract skill names
  const skillNames = new Set<string>();
  for (const p of paths) {
    const match = p.match(/skills\/([^/]+)\//);
    if (match && match[1] !== 'PAI') skillNames.add(match[1]);
  }

  // Detect file types
  const hasSkillMd = paths.some(p => p.endsWith('SKILL.md'));
  const hasWorkflows = paths.some(p => p.includes('/Workflows/'));
  const hasTools = paths.some(p => p.includes('/Tools/') && p.endsWith('.ts'));
  const hasHookRegistry = paths.some(p => isNativeHookRegistryPath(p));
  const hasHooks = paths.some(p => p.includes('hooks/') || isNativeHookRegistryPath(p));
  const hasConfig = paths.some(p => isNativeFrameworkConfigPath(p));
  const hasCoreSystem = paths.some(p => p.match(/PAI\/(?:DOCUMENTATION\/)?(?:PAISYSTEM|THEHOOKSYSTEM|THEDELEGATION|MEMORYSYSTEM)/));
  const hasCoreUser = paths.some(p => p.includes('PAI/USER/'));

  let title = '';

  // Single skill update
  if (skillNames.size === 1) {
    const skill = [...skillNames][0];
    if (hasSkillMd) {
      title = `${skill} Skill Definition Update`;
    } else if (hasWorkflows) {
      const workflowNames = paths
        .filter(p => p.includes('/Workflows/'))
        .map(p => basename(p, '.md'));
      if (workflowNames.length === 1) {
        title = `${skill} ${workflowNames[0]} Workflow Update`;
      } else {
        title = `${skill} Workflows Updated`;
      }
    } else if (hasTools) {
      const toolNames = paths
        .filter(p => p.includes('/Tools/'))
        .map(p => basename(p, '.ts'));
      if (toolNames.length === 1) {
        title = `${skill} ${toolNames[0]} Tool Update`;
      } else {
        title = `${skill} Tools Updated`;
      }
    } else {
      title = `${skill} Skill Files Updated`;
    }
  }
  // Multiple skills
  else if (skillNames.size > 1 && skillNames.size <= 3) {
    const skills = [...skillNames].slice(0, 3).join(' and ');
    title = `${skills} Skills Updated`;
  }
  // Hook changes
  else if (hasHooks) {
    const hookNames = paths
      .filter(p => p.includes('hooks/'))
      .map(p => basename(p, '.ts').replace('.hook', ''));
    if (hasHookRegistry && hookNames.length === 0) {
      title = 'PAI Hook Registration Updated';
    } else if (hookNames.length === 1) {
      title = `${hookNames[0]} Hook Updated`;
    } else if (hookNames.length <= 3) {
      title = `${hookNames.slice(0, 3).join(', ')} Hooks Updated`;
    } else {
      title = `Hook System Updates`;
    }
  }
  // Config changes
  else if (hasConfig) {
    title = 'System Configuration Updated';
  }
  // Core system changes
  else if (hasCoreSystem) {
    const docNames = paths
      .filter(p => p.match(/PAI\/(?:DOCUMENTATION\/)?(?:PAISYSTEM|THEHOOKSYSTEM|THEDELEGATION|MEMORYSYSTEM)/))
      .map(p => basename(p, '.md'));
    if (docNames.length === 1) {
      title = `${docNames[0]} Documentation Updated`;
    } else {
      title = 'PAI System Documentation Updated';
    }
  }
  // Core user changes
  else if (hasCoreUser) {
    const docNames = paths
      .filter(p => p.includes('PAI/USER/'))
      .map(p => basename(p, '.md'));
    if (docNames.length === 1) {
      title = `${docNames[0]} User Config Updated`;
    } else {
      title = 'User Configuration Updated';
    }
  }
  // Fallback
  else {
    const categories = new Set(changes.map(c => c.category).filter(Boolean));
    if (categories.size === 1) {
      const cat = [...categories][0];
      title = `${capitalize(cat || 'System')} Updates Applied`;
    } else {
      title = 'Multi-Area System Updates Applied';
    }
  }

  // Ensure 4-8 words
  const words = title.split(/\s+/);
  if (words.length < 4) {
    title = `PAI ${title}`;
  } else if (words.length > 8) {
    title = words.slice(0, 8).join(' ');
  }

  return title;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

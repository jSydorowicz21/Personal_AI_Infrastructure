/**
 * Central Identity Loader
 * Single source of truth for DA (Digital Assistant) and Principal identity
 *
 * Reads from settings.json first, then shared USER markdown as the
 * provider-neutral fallback for Codex/OpenCode installs whose settings only
 * contain framework metadata.
 * All hooks and tools should import from here.
 */

import { readFileSync, existsSync } from 'fs';
import { getSettingsPath, userPath } from './paths';

const SETTINGS_PATH = getSettingsPath();

// Default identity (fallback if settings.json doesn't have identity section)
const DEFAULT_IDENTITY = {
  name: 'PAI',
  fullName: 'Personal AI',
  displayName: 'PAI',
  mainDAVoiceID: '',
  color: '#3B82F6',
};

const DEFAULT_PRINCIPAL = {
  name: 'User',
  pronunciation: '',
  timezone: 'UTC',
};

export interface VoiceProsody {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  useSpeakerBoost: boolean;
  volume?: number;
}

export interface VoicePersonality {
  baseVoice: string;
  enthusiasm: number;
  energy: number;
  expressiveness: number;
  resilience: number;
  composure: number;
  optimism: number;
  warmth: number;
  formality: number;
  directness: number;
  precision: number;
  curiosity: number;
  playfulness: number;
}

export interface Identity {
  name: string;
  fullName: string;
  displayName: string;
  mainDAVoiceID: string;
  color: string;
  voice?: VoiceProsody;
  personality?: VoicePersonality;
}

export interface Principal {
  name: string;
  pronunciation: string;
  timezone: string;
}

export interface ObservabilityTarget {
  name: string;
  type: 'http' | 'cloudflare-kv';
  url?: string;
  headers?: Record<string, string>;
}

export interface ObservabilityConfig {
  targets: ObservabilityTarget[];
  server?: { port: number; enabled: boolean };
}

export interface Settings {
  daidentity?: Partial<Identity>;
  principal?: Partial<Principal>;
  env?: Record<string, string>;
  observability?: ObservabilityConfig;
  [key: string]: unknown;
}

let cachedSettings: Settings | null = null;
let cachedUserIdentity: UserIdentityDocuments | null = null;

type AlgorithmVoice = {
  voiceId: string;
  voiceName: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  useSpeakerBoost: boolean;
  volume?: number;
};

type UserIdentityDocuments = {
  daidentity?: Partial<Identity>;
  principal?: Partial<Principal>;
  algorithmVoice?: AlgorithmVoice;
};

const DEFAULT_MARKDOWN_VOICE: Omit<AlgorithmVoice, 'voiceId' | 'voiceName'> = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1,
  useSpeakerBoost: true,
};

/**
 * Load settings.json (cached)
 */
function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  try {
    if (!existsSync(SETTINGS_PATH)) {
      cachedSettings = {};
      return cachedSettings;
    }

    const content = readFileSync(SETTINGS_PATH, 'utf-8');
    cachedSettings = JSON.parse(content);
    return cachedSettings!;
  } catch {
    cachedSettings = {};
    return cachedSettings;
  }
}

function loadUserIdentityDocuments(): UserIdentityDocuments {
  if (cachedUserIdentity) return cachedUserIdentity;

  cachedUserIdentity = {
    daidentity: parseDaIdentity(readOptional(userPath('DA_IDENTITY.md'))),
    principal: parsePrincipal(readOptional(userPath('PRINCIPAL_IDENTITY.md'))),
  };

  const algorithmVoice = parseAlgorithmVoice(readOptional(userPath('DA_IDENTITY.md')));
  if (algorithmVoice) cachedUserIdentity.algorithmVoice = algorithmVoice;

  return cachedUserIdentity;
}

function readOptional(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function parseDaIdentity(text: string | null): Partial<Identity> {
  if (!text) return {};

  const name = readMarkdownField(text, 'Name') || readHeaderName(text, 'DA Identity');
  const fullName = readMarkdownField(text, 'Full Name');
  const displayName = readMarkdownField(text, 'Display');
  const color = readMarkdownField(text, 'Color');
  const mainDAVoiceID = readMarkdownBacktickField(text, 'Voice (main)');

  return compact({
    name,
    fullName,
    displayName,
    color,
    mainDAVoiceID,
  });
}

function parsePrincipal(text: string | null): Partial<Principal> {
  if (!text) return {};

  const name = readMarkdownField(text, 'Name') || readHeaderName(text, 'Principal Identity');
  const pronunciation = readMarkdownField(text, 'Pronunciation');
  const timezone = readMarkdownField(text, 'Timezone');

  return compact({
    name,
    pronunciation,
    timezone,
  });
}

function parseAlgorithmVoice(text: string | null): AlgorithmVoice | undefined {
  if (!text) return undefined;
  const voiceId = readMarkdownBacktickField(text, 'Voice (algorithm)');
  if (!voiceId) return undefined;

  return {
    voiceId,
    voiceName: readMarkdownParentheticalField(text, 'Voice (algorithm)') || 'Algorithm',
    ...DEFAULT_MARKDOWN_VOICE,
  };
}

function readHeaderName(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^#\\s+${escapeRegExp(label)}\\s+[—-]\\s+(.+?)\\s*$`, 'im'));
  return cleanMarkdownScalar(match?.[1]);
}

function readMarkdownField(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\*\\s*([^|\\r\\n]+)`, 'i'));
  return cleanMarkdownScalar(match?.[1]);
}

function readMarkdownBacktickField(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(?:\`([^\`\\r\\n]+)\`|([^|\\r\\n]+))`, 'i'));
  return cleanMarkdownScalar(match?.[1] || match?.[2]);
}

function readMarkdownParentheticalField(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`\\*\\*${escapeRegExp(label)}:\\*\\*[^\\r\\n]*\\(([^\\r\\n)]+)\\)`, 'i'));
  return cleanMarkdownScalar(match?.[1]?.split(/[—-]/)[0]);
}

function cleanMarkdownScalar(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '')) as T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get DA (Digital Assistant) identity from settings.json
 */
export function getIdentity(): Identity {
  const settings = loadSettings();
  const userDocs = loadUserIdentityDocuments();

  // Prefer settings.daidentity, fall back to env.DA for backward compat
  const daidentity = settings.daidentity || {};
  const envDA = settings.env?.DA;

  // Support both old (daidentity.voice) and new (daidentity.voices.main) structures
  const voices = (daidentity as any).voices || {};
  const voiceConfig = voices.main || (daidentity as any).voice;

  return {
    name: daidentity.name || envDA || userDocs.daidentity?.name || DEFAULT_IDENTITY.name,
    fullName: daidentity.fullName || daidentity.name || envDA || userDocs.daidentity?.fullName || userDocs.daidentity?.name || DEFAULT_IDENTITY.fullName,
    displayName: daidentity.displayName || daidentity.name || envDA || userDocs.daidentity?.displayName || userDocs.daidentity?.name || DEFAULT_IDENTITY.displayName,
    mainDAVoiceID: voiceConfig?.voiceId || (daidentity as any).voiceId || daidentity.mainDAVoiceID || userDocs.daidentity?.mainDAVoiceID || DEFAULT_IDENTITY.mainDAVoiceID,
    color: daidentity.color || userDocs.daidentity?.color || DEFAULT_IDENTITY.color,
    voice: voiceConfig as VoiceProsody | undefined,
    personality: (daidentity as any).personality as VoicePersonality | undefined,
  };
}

/**
 * Get Principal (human owner) identity from settings.json
 */
export function getPrincipal(): Principal {
  const settings = loadSettings();
  const userDocs = loadUserIdentityDocuments();

  // Prefer settings.principal, fall back to env.PRINCIPAL for backward compat
  const principal = settings.principal || {};
  const envPrincipal = settings.env?.PRINCIPAL;

  return {
    name: principal.name || envPrincipal || userDocs.principal?.name || DEFAULT_PRINCIPAL.name,
    pronunciation: principal.pronunciation || userDocs.principal?.pronunciation || DEFAULT_PRINCIPAL.pronunciation,
    timezone: principal.timezone || userDocs.principal?.timezone || DEFAULT_PRINCIPAL.timezone,
  };
}

/**
 * Clear cache (useful for testing or when settings.json changes)
 */
export function clearCache(): void {
  cachedSettings = null;
  cachedUserIdentity = null;
}

/**
 * Get just the DA name (convenience function)
 */
export function getDAName(): string {
  return getIdentity().name;
}

/**
 * Get the user-customized startup catchphrase the install wizard collected,
 * with `{name}` placeholder substitution against the active DA name.
 *
 * Read order:
 *   1. settings.daidentity.startupCatchphrase (set by PAI-Install wizard)
 *   2. fallback default: `<name> here, ready to go.`
 *
 * Callers should prefer this over hand-rolling `${getDAName()} here, ready
 * to go.` so the install's collected catchphrase is actually honored.
 */
export function getStartupCatchphrase(): string {
  const settings = loadSettings();
  const stored = (settings.daidentity as any)?.startupCatchphrase as string | undefined;
  const name = getDAName();
  const template = (stored && stored.trim()) || "{name} here, ready to go.";
  return template.replace(/\{name\}/gi, name);
}

/**
 * Get just the Principal name (convenience function)
 */
export function getPrincipalName(): string {
  return getPrincipal().name;
}

/**
 * Get just the voice ID (convenience function)
 */
export function getVoiceId(): string {
  return getIdentity().mainDAVoiceID;
}

/**
 * Get the full settings object (for advanced use)
 */
export function getSettings(): Settings {
  return loadSettings();
}

/**
 * Get observability config from settings.json.
 * Defaults to local-only target if not configured.
 */
export function getObservabilityConfig(): ObservabilityConfig {
  const settings = loadSettings();
  return {
    targets: settings.observability?.targets ?? [{ type: 'http' as const, url: 'http://localhost:31337', name: 'local' }],
    server: settings.observability?.server ?? { port: 31337, enabled: true },
  };
}

/**
 * Get the default identity (for documentation/testing)
 */
export function getDefaultIdentity(): Identity {
  return { ...DEFAULT_IDENTITY };
}

/**
 * Get the default principal (for documentation/testing)
 */
export function getDefaultPrincipal(): Principal {
  return { ...DEFAULT_PRINCIPAL };
}

/**
 * Get algorithm voice settings from settings.json → daidentity.voices.algorithm
 * Returns { voiceId, voiceName, stability, similarity_boost, style, speed, use_speaker_boost, volume }
 * or null if not configured.
 */
export function getAlgorithmVoice(): { voiceId: string; voiceName: string; stability: number; similarityBoost: number; style: number; speed: number; useSpeakerBoost: boolean; volume?: number } | null {
  const settings = loadSettings();
  const voices = (settings.daidentity as any)?.voices;
  if (voices?.algorithm?.voiceId) return voices.algorithm;
  return loadUserIdentityDocuments().algorithmVoice ?? null;
}

/**
 * Get voice prosody settings (convenience function) - legacy ElevenLabs
 */
export function getVoiceProsody(): VoiceProsody | undefined {
  return getIdentity().voice;
}

/**
 * Get voice personality settings (convenience function) - Qwen3-TTS
 */
export function getVoicePersonality(): VoicePersonality | undefined {
  return getIdentity().personality;
}

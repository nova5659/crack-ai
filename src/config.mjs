import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const WEB_DIR = path.join(PROJECT_ROOT, 'web');

export const DATA_DIR = process.env.CRACK_DATA_DIR
  ? path.resolve(process.env.CRACK_DATA_DIR)
  : path.join(os.homedir(), '.crack-ai');

export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const GEMINI_FREE_MODELS = [
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    badge: '초고속 · 안정 추천',
    tier: 'free',
    family: 'gemini-3',
    description: '0.8초 첫 응답 · 가장 넉넉한 무료 할당량 · 503 혼잡 없이 웹소설 문체와 롤플레잉에 가장 안정적.',
    defaultThinkingLevel: null,
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    badge: '심화 서사 · 무료',
    tier: 'free',
    family: 'gemini-3',
    description: '깊은 감정선과 추론을 지원하는 Gemini 3 Flash 모델 (혼잡 시 3.5 Flash-Lite로 자동 전환).',
    defaultThinkingLevel: 'LOW',
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite',
    badge: '쾌속 백업 · 무료',
    tier: 'free',
    family: 'gemini-3',
    description: '1.5초 응답의 쾌속 무료 모델. 자동 백업 체인에 포함.',
    defaultThinkingLevel: null,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    badge: '밸런스 · 무료',
    tier: 'free',
    family: 'gemini-3',
    description: '풍부한 장문 서사용 Flash 모델 (응답 대기 5~8초).',
    defaultThinkingLevel: 'LOW',
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    badge: '최신 플래시 · 자동우회',
    tier: 'free',
    family: 'gemini-3',
    description: '최신 세대 Flash. 서버 혼잡(503)이나 지연 발생 시 8초 내에 안정 모델로 자동 우회합니다.',
    defaultThinkingLevel: 'LOW',
  },
];

export const GENERATION_MODES = {
  story: {
    id: 'story',
    label: '쾌속 스토리',
    subtitle: 'Gemini 3.5 Flash-Lite · 1초대 초고속 · 끊김 없는 웹소설 서사',
    model: 'gemini-3.5-flash-lite',
    thinkingLevel: null,
    maxOutputTokens: 1800,
  },
  deep: {
    id: 'deep',
    label: '심화 서사',
    subtitle: 'Gemini 3 Flash · 깊은 심리 묘사와 치밀한 복선 전개',
    model: 'gemini-3-flash-preview',
    thinkingLevel: 'LOW',
    maxOutputTokens: 2200,
  },
  pro: {
    id: 'pro',
    label: '프로 추론',
    subtitle: 'Gemini 3.8 / 3.5 Flash · 최고 퀄리티 장문 (혼잡 시 자동 우회)',
    model: 'gemini-3.8-flash',
    thinkingLevel: 'LOW',
    maxOutputTokens: 2600,
  },
  speed: {
    id: 'speed',
    label: '초고속',
    subtitle: 'Gemini 3.5 Flash-Lite · 짧은 템포 빠른 티키타카',
    model: 'gemini-3.5-flash-lite',
    thinkingLevel: null,
    maxOutputTokens: 1100,
  },
};

const DEFAULT_CONFIG = {
  configVersion: 2,
  geminiApiKey: '',
  defaultModel: process.env.GEMINI_DEFAULT_MODEL || 'gemini-3.5-flash-lite',
  defaultMode: 'story',
  theme: 'dark', // 'dark' (true OLED black) | 'light'
  viewMode: 'novel', // 'novel' | 'chat'
  fontFamily: 'sans', // 'sans' | 'serif'
  fontSize: 'md', // 'sm' | 'md' | 'lg'
  backdropMode: 'dim', // 'dim' | 'vivid'
  outputLength: 'medium', // 'short' | 'medium' | 'long'
  autoSummaryInterval: 10,
  showAffinityHud: true,
  activePersonaId: 'persona_default',
  lastVerifiedModel: '',
  lastVerifiedAt: null,
};

export function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function loadDotEnv() {
  const envPaths = [
    path.join(PROJECT_ROOT, '.env'),
    path.join(DATA_DIR, '.env'),
  ];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && !(key in process.env)) {
          process.env[key] = val;
        }
      }
    } catch {
      // Ignore unreadable .env
    }
  }
}

loadDotEnv();

export function readConfig() {
  ensureDataDirs();
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      stored = {};
    }
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...stored,
  };
  // One-time migration from v1 (gemini-3.8-flash default that often hits 503 high demand) to fast stable gemini-3.5-flash-lite
  if ((stored.configVersion || 1) < 2) {
    if (merged.defaultModel === 'gemini-3.8-flash' && (merged.defaultMode || 'story') === 'story') {
      merged.defaultModel = 'gemini-3.5-flash-lite';
    }
    merged.configVersion = 2;
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const tmpPath = `${CONFIG_PATH}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf8');
        fs.renameSync(tmpPath, CONFIG_PATH);
      } catch {
        // Ignore non-fatal migration write error
      }
    }
  }
  return merged;
}

export function writeConfig(partial) {
  ensureDataDirs();
  const current = readConfig();
  const cleaned = { ...partial };
  if (typeof cleaned.geminiApiKey === 'string') {
    let k = cleaned.geminiApiKey.trim();
    k = k.replace(/^(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*/i, '').trim();
    k = k.replace(/^["'`]+|["'`]+$/g, '').trim();
    k = k.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
    cleaned.geminiApiKey = k.includes('•') ? '' : k;
  }
  const next = {
    ...current,
    ...cleaned,
  };
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
  return next;
}

export function getEffectiveApiKey() {
  const cfg = readConfig();
  const storedKey = (cfg.geminiApiKey || '').trim();
  if (storedKey) return storedKey;
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

export function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

export function getPublicConfig() {
  const cfg = readConfig();
  const effectiveKey = getEffectiveApiKey();
  return {
    hasApiKey: Boolean(effectiveKey),
    maskedApiKey: maskApiKey(effectiveKey),
    keySource: cfg.geminiApiKey ? 'settings' : (effectiveKey ? 'env' : 'none'),
    defaultModel: cfg.defaultModel,
    defaultMode: cfg.defaultMode,
    theme: cfg.theme === 'light' ? 'light' : 'dark',
    viewMode: cfg.viewMode,
    fontFamily: cfg.fontFamily,
    fontSize: cfg.fontSize || 'md',
    backdropMode: cfg.backdropMode || 'dim',
    outputLength: cfg.outputLength,
    autoSummaryInterval: cfg.autoSummaryInterval,
    showAffinityHud: cfg.showAffinityHud,
    activePersonaId: cfg.activePersonaId,
    lastVerifiedModel: cfg.lastVerifiedModel,
    lastVerifiedAt: cfg.lastVerifiedAt,
    models: GEMINI_FREE_MODELS,
    modes: GENERATION_MODES,
  };
}

export function getPort() {
  const p = Number(process.env.CRACK_PORT || 8787);
  return Number.isFinite(p) && p > 0 ? p : 8787;
}

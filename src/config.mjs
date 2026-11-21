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
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    badge: '무료 최강 · 추천',
    tier: 'free',
    family: 'gemini-3',
    description: 'Google AI Studio 무료 티어 최고 성능 플래시 모델. 웹소설 문체, 감정선, 맥락 추론에 최적화.',
    defaultThinkingLevel: 'MEDIUM',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    badge: '안정 · 밸런스',
    tier: 'free',
    family: 'gemini-3',
    description: '안정적인 무료 Flash 모델. 3.8 Flash 할당량 초과 시 자동 백업으로 동작.',
    defaultThinkingLevel: 'MEDIUM',
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    badge: '초고속 · 대용량 무료',
    tier: 'free',
    family: 'gemini-3',
    description: '가장 빠른 응답과 넉넉한 무료 일일 할당량. 추천 답변·요약 메모리·빠른 대화에 최적.',
    defaultThinkingLevel: 'LOW',
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    badge: '프리뷰 호환',
    tier: 'free',
    family: 'gemini-3',
    description: 'Gemini 3 세대 프리뷰 호환 모델.',
    defaultThinkingLevel: 'LOW',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    badge: '레거시 호환',
    tier: 'free',
    family: 'gemini-2.5',
    description: '구버전 API 프로젝트 호환용 자동 폴백 모델.',
    defaultThinkingLevel: null,
  },
];

export const GENERATION_MODES = {
  story: {
    id: 'story',
    label: '스토리',
    subtitle: 'Gemini 3.8 Flash · 균형 잡힌 웹소설 서사',
    model: 'gemini-3.8-flash',
    thinkingLevel: 'MEDIUM',
    maxOutputTokens: 1600,
  },
  pro: {
    id: 'pro',
    label: '프로 서사',
    subtitle: 'Gemini 3.8 Flash · 깊은 심리 묘사와 장문 전개',
    model: 'gemini-3.8-flash',
    thinkingLevel: 'HIGH',
    maxOutputTokens: 2600,
  },
  speed: {
    id: 'speed',
    label: '스피드',
    subtitle: 'Gemini 3.5 Flash-Lite · 초고속 응답 · 무료 한도 절약',
    model: 'gemini-3.5-flash-lite',
    thinkingLevel: 'LOW',
    maxOutputTokens: 1100,
  },
};

const DEFAULT_CONFIG = {
  geminiApiKey: '',
  defaultModel: process.env.GEMINI_DEFAULT_MODEL || 'gemini-3.8-flash',
  defaultMode: 'story',
  viewMode: 'novel', // 'novel' | 'chat'
  fontFamily: 'sans', // 'sans' | 'serif'
  outputLength: 'medium', // 'short' | 'medium' | 'long'
  autoSummaryInterval: 12,
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
  return {
    ...DEFAULT_CONFIG,
    ...stored,
  };
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
    viewMode: cfg.viewMode,
    fontFamily: cfg.fontFamily,
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

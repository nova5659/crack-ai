import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, UPLOADS_DIR, ensureDataDirs } from './config.mjs';
import { GENRES, PRESET_CHARACTERS, renderTemplate } from './presets.mjs';

const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const DEFAULT_PERSONAS = [
  {
    id: 'persona_default',
    name: '나',
    gender: '미지정',
    description: '이야기의 주인공. 상황에 따라 능동적으로 선택하고 반응한다.',
    isDefault: true,
  },
  {
    id: 'persona_noble',
    name: '세린',
    gender: '여성',
    description: '겉으로는 차분하지만 결정적인 순간에 대담한 선택을 하는 인물.',
    isDefault: false,
  },
  {
    id: 'persona_wanderer',
    name: '이현',
    gender: '남성',
    description: '관찰력이 뛰어나고 쉽게 본심을 드러내지 않는 인물.',
    isDefault: false,
  },
];

function readJson(filePath, fallback) {
  ensureDataDirs();
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDataDirs();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

export function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

// --- Meta (favorites, local play counts, likes) ---
function readMeta() {
  return readJson(META_FILE, {
    favorites: [],
    liked: [],
    extraPlays: {},
    extraLikes: {},
  });
}

function writeMeta(meta) {
  writeJsonAtomic(META_FILE, meta);
}

// --- Personas ---
export function listPersonas() {
  const saved = readJson(PERSONAS_FILE, null);
  if (!saved || !Array.isArray(saved) || saved.length === 0) {
    writeJsonAtomic(PERSONAS_FILE, DEFAULT_PERSONAS);
    return structuredClone(DEFAULT_PERSONAS);
  }
  return saved;
}

export function getPersona(personaId) {
  const list = listPersonas();
  return list.find((p) => p.id === personaId) || list[0];
}

export function savePersona(input) {
  const list = listPersonas();
  const name = String(input.name || '').trim().slice(0, 40) || '나';
  const gender = String(input.gender || '미지정').trim().slice(0, 20);
  const description = String(input.description || '').trim().slice(0, 600);

  if (input.id) {
    const idx = list.findIndex((p) => p.id === input.id);
    if (idx !== -1) {
      list[idx] = { ...list[idx], name, gender, description };
      writeJsonAtomic(PERSONAS_FILE, list);
      return list[idx];
    }
  }
  const created = {
    id: makeId('persona'),
    name,
    gender,
    description,
    isDefault: false,
  };
  list.push(created);
  writeJsonAtomic(PERSONAS_FILE, list);
  return created;
}

export function deletePersona(personaId) {
  const list = listPersonas();
  if (list.length <= 1) return false;
  const next = list.filter((p) => p.id !== personaId);
  if (next.length === list.length) return false;
  writeJsonAtomic(PERSONAS_FILE, next);
  return true;
}

// --- Characters ---
function readCustomCharacters() {
  return readJson(CHARACTERS_FILE, []);
}

function writeCustomCharacters(list) {
  writeJsonAtomic(CHARACTERS_FILE, list);
}

function genreLabelFor(genreId) {
  return GENRES.find((g) => g.id === genreId)?.label || '기타';
}

export function listCharacters() {
  const custom = readCustomCharacters();
  const meta = readMeta();
  const customById = new Map(custom.map((c) => [c.id, c]));

  const mergedPresets = PRESET_CHARACTERS.map((p) => {
    const override = customById.get(p.id);
    const base = override
      ? { ...p, ...override, isOriginal: Boolean(p.isOriginal), isAnime: Boolean(p.isAnime), isBuiltin: true }
      : { ...p, isBuiltin: true };
    return enrichCharacter(base, meta);
  });

  const onlyCustom = custom
    .filter((c) => !PRESET_CHARACTERS.some((p) => p.id === c.id))
    .map((c) => enrichCharacter({ ...c, isOriginal: false, isBuiltin: false }, meta));

  return [...onlyCustom, ...mergedPresets];
}

function enrichCharacter(char, meta) {
  return {
    ...char,
    genreLabel: char.genreLabel || genreLabelFor(char.genre),
    plays: (char.plays || 0) + (meta.extraPlays?.[char.id] || 0),
    likes: (char.likes || 0) + (meta.extraLikes?.[char.id] || 0),
    isFavorite: Boolean(meta.favorites?.includes(char.id)),
    isLiked: Boolean(meta.liked?.includes(char.id)),
    lorebook: Array.isArray(char.lorebook) ? char.lorebook : [],
    tags: Array.isArray(char.tags) ? char.tags : [],
    suggestedReplies: Array.isArray(char.suggestedReplies) ? char.suggestedReplies : [],
  };
}

export function getCharacter(id) {
  return listCharacters().find((c) => c.id === id) || null;
}

export function saveCharacter(payload) {
  const custom = readCustomCharacters();
  const now = new Date().toISOString();

  const normalizeTags = (raw) => {
    if (Array.isArray(raw)) {
      return raw
        .map((t) => String(t).trim())
        .filter(Boolean)
        .map((t) => (t.startsWith('#') ? t : `#${t}`))
        .slice(0, 8);
    }
    return String(raw || '')
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .slice(0, 8);
  };

  const normalizeLorebook = (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => ({
        id: item.id || makeId('lore'),
        title: String(item.title || '세계관 설정').trim().slice(0, 80),
        keywords: String(item.keywords || '').trim().slice(0, 200),
        content: String(item.content || '').trim().slice(0, 1200),
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.keywords && item.content);
  };

  const genre = GENRES.some((g) => g.id === payload.genre && g.id !== 'all')
    ? payload.genre
    : 'romance';

  const isAnime = Boolean(payload.isAnime || genre === 'anime' || payload.animeTitle);
  const castMembers = Array.isArray(payload.castMembers)
    ? payload.castMembers.map((m) => String(m).trim()).filter(Boolean).slice(0, 12)
    : String(payload.castMembers || '')
        .split(/[,،]+/)
        .map((m) => m.trim())
        .filter(Boolean)
        .slice(0, 12);

  const record = {
    id: payload.id || makeId('char'),
    isOriginal: Boolean(payload.isOriginal),
    isAnime,
    animeTitle: String(payload.animeTitle || '').trim().slice(0, 60),
    animeCategory: String(payload.animeCategory || 'shonen').trim().slice(0, 30),
    playStyle: payload.playStyle === 'world' ? 'world' : 'character',
    powerSystem: String(payload.powerSystem || '').trim().slice(0, 120),
    castMembers,
    featured: Boolean(payload.featured),
    name: String(payload.name || '').trim().slice(0, 50) || '이름 없는 캐릭터',
    title: String(payload.title || '').trim().slice(0, 90) || '새로운 이야기',
    subtitle: String(payload.subtitle || '').trim().slice(0, 180),
    genre,
    genreLabel: genreLabelFor(genre),
    tags: normalizeTags(payload.tags),
    creator: String(payload.creator || '내 캐릭터').trim().slice(0, 40),
    avatar: String(payload.avatar || '/assets/characters/seodohyun.jpg').trim(),
    accentColor: String(payload.accentColor || '#7C5CFF').trim(),
    plays: Number(payload.plays || 1),
    likes: Number(payload.likes || 0),
    initialAffinity: Math.max(0, Math.min(100, Number(payload.initialAffinity ?? 35))),
    initialMood: String(payload.initialMood || '호기심 어린 시선').trim().slice(0, 40),
    relationshipStage: String(payload.relationshipStage || '첫 만남 · 1막').trim().slice(0, 50),
    worldSummary: String(payload.worldSummary || '').trim().slice(0, 500),
    personaPrompt: String(payload.personaPrompt || '').trim().slice(0, 5000),
    openingMessage: String(payload.openingMessage || '').trim().slice(0, 3000),
    suggestedReplies: Array.isArray(payload.suggestedReplies)
      ? payload.suggestedReplies.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : [],
    lorebook: normalizeLorebook(payload.lorebook),
    updatedAt: now,
    createdAt: payload.createdAt || now,
  };

  const idx = custom.findIndex((c) => c.id === record.id);
  if (idx !== -1) {
    custom[idx] = { ...custom[idx], ...record };
  } else {
    custom.unshift(record);
  }
  writeCustomCharacters(custom);
  return getCharacter(record.id);
}

export function deleteCharacter(id) {
  const isPreset = PRESET_CHARACTERS.some((p) => p.id === id);
  if (isPreset) {
    // Only reset overrides if any
    const custom = readCustomCharacters();
    const next = custom.filter((c) => c.id !== id);
    writeCustomCharacters(next);
    return { deleted: false, reset: true };
  }
  const custom = readCustomCharacters();
  const next = custom.filter((c) => c.id !== id);
  if (next.length === custom.length) return { deleted: false };
  writeCustomCharacters(next);
  return { deleted: true };
}

export function toggleFavorite(characterId) {
  const meta = readMeta();
  const set = new Set(meta.favorites || []);
  let active = false;
  if (set.has(characterId)) {
    set.delete(characterId);
  } else {
    set.add(characterId);
    active = true;
  }
  meta.favorites = [...set];
  writeMeta(meta);
  return { isFavorite: active };
}

export function toggleLike(characterId) {
  const meta = readMeta();
  const set = new Set(meta.liked || []);
  meta.extraLikes = meta.extraLikes || {};
  let active = false;
  if (set.has(characterId)) {
    set.delete(characterId);
    meta.extraLikes[characterId] = Math.max(0, (meta.extraLikes[characterId] || 1) - 1);
  } else {
    set.add(characterId);
    meta.extraLikes[characterId] = (meta.extraLikes[characterId] || 0) + 1;
    active = true;
  }
  meta.liked = [...set];
  writeMeta(meta);
  return { isLiked: active, likes: getCharacter(characterId)?.likes || 0 };
}

export function incrementPlay(characterId) {
  const meta = readMeta();
  meta.extraPlays = meta.extraPlays || {};
  meta.extraPlays[characterId] = (meta.extraPlays[characterId] || 0) + 1;
  writeMeta(meta);
}

// --- Sessions ---
function readSessions() {
  return readJson(SESSIONS_FILE, []);
}

function writeSessions(sessions) {
  writeJsonAtomic(SESSIONS_FILE, sessions);
}

export function listSessions(characterId = null) {
  const sessions = readSessions();
  const chars = new Map(listCharacters().map((c) => [c.id, c]));
  return sessions
    .filter((s) => (!characterId ? true : s.characterId === characterId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((s) => {
      const char = chars.get(s.characterId);
      const lastMsg = s.messages?.[s.messages.length - 1];
      const turnCount = Array.isArray(s.messages) ? s.messages.filter((m) => m.role === 'user').length : 0;
      return {
        id: s.id,
        characterId: s.characterId,
        characterName: char?.name || '삭제된 캐릭터',
        characterAvatar: char?.avatar || '/assets/characters/seodohyun.jpg',
        characterTitle: char?.title || '',
        genreLabel: char?.genreLabel || '',
        title: s.title,
        personaId: s.personaId,
        affinity: s.affinity,
        mood: s.mood,
        relationshipStage: s.relationshipStage,
        storyLength: s.storyLength || 'standard',
        targetTurns: typeof s.targetTurns === 'number' ? s.targetTurns : 14,
        difficulty: s.difficulty || 'real',
        turnCount,
        ending: s.ending || null,
        messageCount: s.messages?.length || 0,
        lastPreview: lastMsg ? String(lastMsg.content).replace(/\s+/g, ' ').slice(0, 90) : '',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    });
}

export function getSession(sessionId) {
  const sessions = readSessions();
  return sessions.find((s) => s.id === sessionId) || null;
}

export function createSession({ characterId, personaId, title }) {
  const char = getCharacter(characterId);
  if (!char) throw new Error('캐릭터를 찾을 수 없습니다.');
  const persona = getPersona(personaId);
  const sessions = readSessions();
  const now = new Date().toISOString();

  const opening = renderTemplate(
    char.openingMessage || `*${char.name}이(가) 천천히 고개를 들어 {{user}}를 바라보았다.*\n\n"안녕, {{user}}. 기다리고 있었어."`,
    { userName: persona.name, charName: char.name }
  );

  const session = {
    id: makeId('sess'),
    characterId: char.id,
    title: title || `${char.name} · ${new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} 이야기`,
    personaId: persona.id,
    storyRoute: 'if', // 'canon' | 'if'
    nationMode: 'realistic', // 'realistic' | 'crisis'
    storyLength: 'standard', // 'short' (8) | 'standard' (14) | 'long' (24) | 'endless' (0)
    targetTurns: 14,
    difficulty: 'real', // 'real' | 'hardcore' | 'story'
    ending: null,
    nationState: char.initialNationState ? structuredClone(char.initialNationState) : null,
    userNote: '',
    summaryMemory: '',
    affinity: char.initialAffinity ?? 35,
    mood: char.initialMood || '호기심 어린 시선',
    relationshipStage: char.relationshipStage || '첫 만남',
    lorebook: structuredClone(char.lorebook || []),
    suggestedReplies: (char.suggestedReplies || []).map((r) =>
      renderTemplate(r, { userName: persona.name, charName: char.name })
    ),
    messages: [
      {
        id: makeId('msg'),
        role: 'model',
        content: opening,
        versions: [opening],
        activeVersion: 0,
        isOpening: true,
        createdAt: now,
        meta: {
          model: 'opening',
          triggeredLorebooks: [],
        },
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  sessions.unshift(session);
  writeSessions(sessions);
  incrementPlay(char.id);
  return session;
}

export function updateSession(sessionId, updater) {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return null;
  const next = typeof updater === 'function' ? updater(sessions[idx]) : { ...sessions[idx], ...updater };
  next.updatedAt = new Date().toISOString();
  sessions[idx] = next;
  writeSessions(sessions);
  return next;
}

export function deleteSession(sessionId) {
  const sessions = readSessions();
  const next = sessions.filter((s) => s.id !== sessionId);
  if (next.length === sessions.length) return false;
  writeSessions(next);
  return true;
}

export function clearAllSessions() {
  writeSessions([]);
  return true;
}

export function resetSession(sessionId) {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx === -1) return null;
  const curr = sessions[idx];
  const char = getCharacter(curr.characterId);
  if (!char) return null;
  const persona = getPersona(curr.personaId);
  const now = new Date().toISOString();

  const opening = renderTemplate(
    char.openingMessage || `*${char.name}이(가) 천천히 고개를 들어 {{user}}를 바라보았다.*\n\n"안녕, {{user}}. 기다리고 있었어."`,
    { userName: persona.name, charName: char.name }
  );

  const reset = {
    ...curr,
    nationState: char.initialNationState ? structuredClone(char.initialNationState) : null,
    ending: null,
    summaryMemory: '',
    affinity: char.initialAffinity ?? 35,
    mood: char.initialMood || '호기심 어린 시선',
    relationshipStage: char.relationshipStage || '첫 만남',
    suggestedReplies: (char.suggestedReplies || []).map((r) =>
      renderTemplate(r, { userName: persona.name, charName: char.name })
    ),
    messages: [
      {
        id: makeId('msg'),
        role: 'model',
        content: opening,
        versions: [opening],
        activeVersion: 0,
        isOpening: true,
        createdAt: now,
        meta: {
          model: 'opening',
          triggeredLorebooks: [],
        },
      },
    ],
    updatedAt: now,
  };

  sessions[idx] = reset;
  writeSessions(sessions);
  return reset;
}

// --- Image Upload ---
export function saveUploadedImage(dataUrl) {
  ensureDataDirs();
  const match = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('지원하지 않는 이미지 형식입니다. (PNG, JPG, WEBP, GIF)');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) {
    throw new Error('이미지 파일 크기는 8MB 이하만 업로드할 수 있습니다.');
  }
  const filename = `${makeId('img')}.${ext}`;
  const fullPath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(fullPath, buffer);
  return `/uploads/${filename}`;
}

export function resolveUploadFile(filename) {
  const safeName = path.basename(filename);
  const fullPath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

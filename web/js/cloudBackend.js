// Complete 24/7 Always-On Cloud & Static Web Engine for CRACK AI
// Works on Netlify (with Netlify Functions + optional GEMINI_API_KEY env var) AND pure static hosting (Netlify Drop / GitHub Pages / Cloudflare Pages).

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const STORAGE_PREFIX = 'crack_cloud_v1_';
const STATE_TAG_REGEX = /<!--\s*CRACK_STATE\s*:\s*(\{[\s\S]*?\})\s*-->/i;

const FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
];

const DEFAULT_PERSONAS = [
  { id: 'persona_default', name: '나', gender: '미지정', description: '이야기의 주인공. 상황에 따라 능동적으로 선택하고 반응한다.', isDefault: true },
  { id: 'persona_noble', name: '세린', gender: '여성', description: '겉으로는 차분하지만 결정적인 순간에 대담한 선택을 하는 인물.', isDefault: false },
  { id: 'persona_wanderer', name: '이현', gender: '남성', description: '관찰력이 뛰어나고 쉽게 본심을 드러내지 않는 인물.', isDefault: false },
];

const DEFAULT_CONFIG = {
  geminiApiKey: '',
  defaultModel: 'gemini-3.8-flash',
  defaultMode: 'story',
  viewMode: 'novel',
  fontFamily: 'sans',
  outputLength: 'medium',
  showAffinityHud: true,
  activePersonaId: 'persona_default',
  lastVerifiedModel: '',
  lastVerifiedAt: null,
};

let catalogCache = null;
let cloudInfo = {
  hasNetlifyFunction: false,
  hasServerKey: false,
};

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return structuredClone(fallback);
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

function writeLS(key, val) {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val));
}

function renderTemplate(text, { userName = '나', charName = '캐릭터' } = {}) {
  if (!text) return '';
  return String(text)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, charName);
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 6)}••••••${key.slice(-4)}`;
}

function isGemini3Model(modelId = '') {
  return /^gemini-3/i.test(modelId) || /^gemini-4/i.test(modelId);
}

function buildFallbackChain(preferred) {
  const seen = new Set();
  const out = [];
  for (const m of [preferred, ...FALLBACK_MODELS]) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function parseJsonLoose(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function sanitizeApiKey(raw = '') {
  let k = String(raw || '').trim();
  k = k.replace(/^(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*/i, '').trim();
  k = k.replace(/^["'`]+|["'`]+$/g, '').trim();
  k = k.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
  if (!k || k.includes('•')) return '';
  return k;
}

function isInvalidKeyError(status, errMsg = '') {
  if (status === 401 || status === 403) return true;
  return /api[\s_-]*key[\s_-]*(not[\s_-]*valid|invalid|expired)|API_KEY_INVALID/i.test(String(errMsg || ''));
}

function parseStateTag(fullText = '') {
  const match = fullText.match(STATE_TAG_REGEX);
  let stateUpdate = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      const rawDelta = Number(parsed.affinityDelta);
      const delta = Number.isFinite(rawDelta) ? Math.max(-5, Math.min(6, Math.round(rawDelta))) : 0;
      const mood = typeof parsed.mood === 'string' && parsed.mood.trim() ? parsed.mood.trim().slice(0, 28) : null;
      let nation = null;
      if (parsed.nation && typeof parsed.nation === 'object') {
        const n = parsed.nation;
        const clamp = (v, fb) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : fb);
        nation = {
          name: String(n.name || '').trim().slice(0, 32) || undefined,
          date: String(n.date || '').trim().slice(0, 36) || undefined,
          power: n.power !== undefined ? clamp(n.power, 65) : undefined,
          treasury: n.treasury !== undefined ? String(n.treasury).trim().slice(0, 28) : undefined,
          approval: n.approval !== undefined ? clamp(n.approval, 55) : undefined,
          military: n.military !== undefined ? clamp(n.military, 65) : undefined,
          stability: n.stability !== undefined ? clamp(n.stability, 65) : undefined,
        };
      }
      stateUpdate = { affinityDelta: delta, mood, nation };
    } catch {
      stateUpdate = null;
    }
  }
  return { cleanText: fullText.replace(STATE_TAG_REGEX, '').trimEnd(), stateUpdate };
}

function createStreamingTagFilter(onCleanDelta) {
  let pending = '';
  let rawAll = '';
  let inside = false;
  const flush = () => {
    if (inside || !pending) return;
    const idx = pending.indexOf('<!--');
    if (idx !== -1) {
      if (idx > 0) onCleanDelta(pending.slice(0, idx));
      pending = pending.slice(idx);
      inside = true;
      return;
    }
    let hold = 0;
    for (let len = Math.min(3, pending.length); len >= 1; len--) {
      if ('<!--'.startsWith(pending.slice(-len))) {
        hold = len;
        break;
      }
    }
    const emit = hold > 0 ? pending.slice(0, -hold) : pending;
    pending = hold > 0 ? pending.slice(-hold) : '';
    if (emit) onCleanDelta(emit);
  };
  return {
    push(chunk) {
      if (!chunk) return;
      rawAll += chunk;
      if (inside) {
        pending += chunk;
        const end = pending.indexOf('-->');
        if (end !== -1) {
          pending = pending.slice(end + 3);
          inside = false;
          flush();
        }
        return;
      }
      pending += chunk;
      flush();
    },
    finish() {
      if (!inside && pending) onCleanDelta(pending);
      pending = '';
      return parseStateTag(rawAll);
    },
  };
}

function extractTextFromCandidate(obj) {
  const parts = obj?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const p of parts) {
    if (p.thought === true) continue;
    if (typeof p.text === 'string') out += p.text;
  }
  return out;
}

function relationshipStageForAffinity(affinity, fallbackStage = '첫 만남') {
  if (affinity >= 85) return '운명적 유대 · 절정';
  if (affinity >= 65) return '깊은 신뢰와 끌림';
  if (affinity >= 45) return '흔들리는 경계선';
  if (affinity >= 25) return fallbackStage || '탐색과 긴장';
  return '차가운 경계 · 거리감';
}

function findTriggeredLorebooks(lorebook = [], recentMessages = [], latestUserText = '') {
  if (!Array.isArray(lorebook) || !lorebook.length) return [];
  const text = [...recentMessages.slice(-6).map((m) => m.content || ''), latestUserText || ''].join('\n').toLowerCase();
  const matched = [];
  for (const entry of lorebook) {
    if (!entry || entry.enabled === false) continue;
    const kws = String(entry.keywords || '').split(/[,،]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
    const hit = kws.find((kw) => text.includes(kw));
    if (hit) matched.push({ id: entry.id, title: entry.title, keyword: hit, content: entry.content });
  }
  return matched.slice(0, 6);
}

function buildSystemInstruction({ character, session, persona, triggeredLorebooks, outputLength = 'medium', viewMode = 'novel', isContinue = false }) {
  const ctx = { userName: persona?.name || '나', charName: character.name };
  const lenMap = {
    short: '분량 가이드: 간결하고 템포 빠르게 2~3문단 (약 180~320자)으로 응답하세요.',
    medium: '분량 가이드: 몰입감 있는 한국 웹소설 한 장면 분량으로 3~5문단 (약 400~750자)으로 응답하세요.',
    long: '분량 가이드: 풍성한 웹소설 1화 분량처럼 세밀한 내면 묘사, 공간감, 대화를 담아 5~8문단 (약 800~1400자)으로 응답하세요.',
  };
  const styleMap = {
    novel: '문체 형식: 한국 인기 웹소설·스토리 채팅 형식. 상황·행동·표정·심리 묘사는 *별표*로 감싸고, 캐릭터의 대사는 큰따옴표("...")로 구분해 생생하게 작성하세요.',
    chat: '문체 형식: 자연스러운 몰입형 메신저 대화 스타일. 짧은 *행동 지문*과 자연스러운 구어체 대사를 조화롭게 섞어 답하세요.',
  };

  const parts = [];
  if (character.isAnime && character.playStyle === 'world') {
    parts.push(`당신은 인기 애니메이션 「${character.animeTitle || character.name}」 세계관의 총괄 게임마스터(GM)이자 모든 원작 등장인물을 연기하는 인터랙티브 스토리 엔진입니다. 절대 AI·언어모델·시스템임을 드러내지 마세요.`);
  } else if (character.isAnime) {
    parts.push(`당신은 애니메이션 「${character.animeTitle || ''}」의 캐릭터 "${character.name}" 역할을 원작 고증에 충실하게 연기합니다. 절대 AI·언어모델·시스템임을 드러내지 마세요.`);
  } else {
    parts.push(`당신은 인터랙티브 웹소설/캐릭터 챗 플랫폼 CRACK의 캐릭터 "${character.name}" 역할을 완벽하게 연기합니다. 절대 AI·언어모델·시스템임을 드러내지 마세요.`);
  }

  if (character.isAnime) {
    const routeGuide =
      session.storyRoute === 'canon'
        ? '원작 고증 모드(CANON): 원작 설정·파워 밸런스·말투·타임라인을 최대한 충실히 고증하세요.'
        : 'IF 자유 전개 모드(WHAT-IF): 원작의 캐릭터성과 규칙은 유지하되 {{user}}의 활약에 따라 원작 비극을 막거나 새로운 평행세계 전개로 자유롭게 분기하세요.';
    parts.push(
      `\n[애니메이션 원작 설정]\n- 작품: ${character.animeTitle || character.name}${character.powerSystem ? `\n- 고유 시스템: ${character.powerSystem}` : ''}${character.castMembers?.length ? `\n- 주요 등장인물: ${character.castMembers.join(', ')}` : ''}\n- 진행 스타일: ${character.playStyle === 'world' ? '멀티 캐릭터 세계관 RPG 시뮬레이션 (화자 구분 및 상태창 업데이트)' : '1:1 캐릭터 몰입 스토리'}\n- 전개 노선: ${renderTemplate(routeGuide, ctx)}`
    );
  }

  if (character.isNationSim) {
    const modeDesc =
      session.nationMode === 'surreal'
        ? '🌀 초현실·막장 변수 모드 활성화: 정통 국가 경영의 틀은 유지하되, 매 1~2턴마다 예측 불가능하고 웃기거나 황당한 초현실 돌발 사건을 적극 발생시키세요!'
        : '🏛️ 정통 리얼리티 모드 활성화: 실제 역사·정치·경제·군사 인과관계를 냉정하고 치밀하게 반영하세요.';
    const ns = session.nationState;
    parts.push(
      `\n[국가의 시대 · 실시간 통치 시스템]\n- 진행 모드: ${modeDesc}${ns ? `\n- 직전 국가 상태: 국가=${ns.name}, 시점=${ns.date}, 국력=${ns.power}/100, 재정=${ns.treasury}, 지지율=${ns.approval}%, 군사=${ns.military}/100, 안정도=${ns.stability}/100` : ''}`
    );
  }

  parts.push(`\n[캐릭터 설정]\n${renderTemplate(character.personaPrompt || '', ctx)}`);
  if (character.worldSummary) parts.push(`\n[세계관 배경]\n${renderTemplate(character.worldSummary, ctx)}`);
  parts.push(`\n[상대방({{user}}) 프로필]\n이름: ${ctx.userName}${persona?.gender && persona.gender !== '미지정' ? ` (${persona.gender})` : ''}\n설명: ${persona?.description || '이야기의 주인공'}`);
  if (session.userNote?.trim()) parts.push(`\n[유저노트 · 최우선 절대 반영 규칙]\n${renderTemplate(session.userNote.trim(), ctx)}`);
  if (session.summaryMemory?.trim()) parts.push(`\n[요약 메모리]\n${renderTemplate(session.summaryMemory.trim(), ctx)}`);
  if (triggeredLorebooks.length) {
    parts.push(`\n[발동된 로어북]\n${triggeredLorebooks.map((l) => `- ${l.title}: ${renderTemplate(l.content, ctx)}`).join('\n')}`);
  }
  parts.push(`\n[현재 감정 상태]\n- 호감도: ${session.affinity ?? 35}/100 · 감정: ${session.mood || '호기심'} · 관계: ${session.relationshipStage || '첫 만남'}`);
  parts.push(`\n[서술 규칙]
1. ${styleMap[viewMode] || styleMap.novel}
2. ${lenMap[outputLength] || lenMap.medium}
3. ${ctx.userName}의 대사/행동을 대신 쓰지 말고 ${character.name} 측 반응과 묘사에 집중하세요.
4. ${isContinue ? '방금 끊긴 장면을 자연스럽게 이어서 서술하세요.' : `${ctx.userName}의 최신 입력에 입체적으로 반응하세요.`}
5. 맨 마지막 줄에만(줄바꿈 1회 후) 숨김 상태 태그 1줄을 덧붙이세요:
${character.isNationSim
  ? '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재정국2~12자","nation":{"name":"국가명","date":"YYYY년 M월 (N턴)","power":0~100정수,"treasury":"재정요약","approval":0~100정수,"military":0~100정수,"stability":0~100정수}}-->'
  : '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재감정2~12자"}-->'}`);

  return parts.join('\n');
}

function buildGeminiContents(messages = [], { maxHistory = 28, continueCue = false } = {}) {
  const merged = [];
  for (const m of messages.slice(-maxHistory)) {
    const role = m.role === 'user' ? 'user' : 'model';
    const text = String(m.content || '').trim();
    if (!text) continue;
    if (merged.length && merged[merged.length - 1].role === role) {
      merged[merged.length - 1].text += `\n\n${text}`;
    } else {
      merged.push({ role, text });
    }
  }
  if (merged.length && merged[0].role === 'model') merged.unshift({ role: 'user', text: '(이야기 시작)' });
  if (!merged.length || merged[merged.length - 1].role === 'model') {
    merged.push({
      role: 'user',
      text: continueCue ? '(침묵이 흐른다. 방금 장면을 자연스럽게 이어서 서술해 주세요.)' : '(이야기를 이어가 주세요.)',
    });
  }
  return merged.map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
}

function normalizeAssetUrl(p = '') {
  if (typeof p !== 'string') return './assets/characters/seodohyun.jpg';
  if (p.startsWith('/assets/')) return `.${p}`;
  return p || './assets/characters/seodohyun.jpg';
}

function pickAnimePoster(text = '', category = 'shonen') {
  const hay = `${text} ${category}`.toLowerCase();
  if (/검|칼|사무라이|귀멸|은혼|무협|약사|에도/.test(hay)) return './assets/anime/anime_katana.jpg';
  if (/해적|바다|항해|원피스|포켓몬|모험/.test(hay)) return './assets/anime/anime_pirate.jpg';
  if (/닌자|나루토|헌터|암살|마을/.test(hay)) return './assets/anime/anime_shinobi.jpg';
  if (/사신|영혼|블리치|요괴|달/.test(hay)) return './assets/anime/anime_soul.svg';
  if (/거인|성벽|연금술|강철|전쟁|진격/.test(hay)) return './assets/anime/anime_titan.svg';
  if (/아이돌|밴드|노래|봇치|최애|러브|카구야|학교|청춘/.test(hay)) return './assets/anime/anime_idol.jpg';
  if (/축구|농구|배구|스포츠|블루록|하이큐|슬램덩크/.test(hay)) return './assets/anime/anime_sports.svg';
  if (/스파이|탐정|코난|사카모토|추리/.test(hay)) return './assets/anime/anime_spy.svg';
  if (/가상|게임|소아온|이세계|vr|아인크라드/.test(hay)) return './assets/anime/anime_vrmmo.svg';
  if (/로봇|메카|에바|기아스|건담|슈타인즈|타임/.test(hay)) return './assets/anime/anime_mecha.svg';
  if (/사이버|네온|엣지|미래|해커/.test(hay)) return './assets/anime/anime_edgerunner.svg';
  if (/데스노트|구울|체인소|누아르|호러|공포|살인/.test(hay)) return './assets/anime/anime_noir.svg';
  if (/던전|레벨업|마왕|오버로드|헌터물|게이트/.test(hay)) return './assets/anime/anime_dungeon.svg';
  if (/프리렌|마법|엘프|리제로|바이올렛|판타지/.test(hay)) return './assets/anime/anime_frieren.svg';
  if (/드래곤볼|히어로|원펀맨|초능력|배틀/.test(hay)) return './assets/anime/anime_aura.jpg';
  return './assets/anime/anime_sorcery.jpg';
}

async function ensureCatalog() {
  if (catalogCache) return catalogCache;
  const res = await fetch('./data/catalog.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('카탈로그 데이터를 불러올 수 없습니다.');
  catalogCache = await res.json();
  return catalogCache;
}

async function discoverModelsDirect(key) {
  const res = await fetch(`${API_BASE}/models?pageSize=100`, {
    headers: { 'x-goog-api-key': key },
  });
  if (!res.ok) return { ok: false, models: [], recommendedModel: null };
  const data = await res.json();
  const models = (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((id) => /gemini/i.test(id));
  const recommendedModel =
    FALLBACK_MODELS.find((id) => models.includes(id)) ||
    models.find((id) => /flash/i.test(id) && !/image|tts|audio/i.test(id)) ||
    models[0] ||
    null;
  return { ok: true, models, recommendedModel };
}

function readConfigRaw() {
  return { ...DEFAULT_CONFIG, ...readLS('config', {}) };
}

function getEffectiveClientKey() {
  return sanitizeApiKey(readConfigRaw().geminiApiKey || '');
}

function hasAnyApiKey() {
  return Boolean(getEffectiveClientKey() || cloudInfo.hasServerKey);
}

// --- Direct / Proxy Gemini Calling ---
async function callGeminiGenerate({ model = 'gemini-3.5-flash-lite', systemInstruction, prompt, maxOutputTokens = 1400, jsonMode = false }) {
  const userKey = getEffectiveClientKey();

  if (cloudInfo.hasNetlifyFunction && (userKey || cloudInfo.hasServerKey)) {
    const headers = { 'Content-Type': 'application/json' };
    if (userKey) headers['x-user-gemini-key'] = userKey;
    const res = await fetch('/api/cloud/gemini/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, systemInstruction, prompt, maxOutputTokens, jsonMode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `AI 생성 실패 (HTTP ${res.status})`);
    return data;
  }

  if (!userKey) throw new Error('Google Gemini API 키가 설정되지 않았습니다.');

  // Direct CORS call to Google Gemini API (works on GitHub Pages / static hosting without backend!)
  let chain = buildFallbackChain(model);
  let discovered = false;
  let lastErr = 'Gemini API 호출 실패';
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const generationConfig = { maxOutputTokens };
    if (jsonMode) generationConfig.responseMimeType = 'application/json';
    if (isGemini3Model(candidate)) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    else generationConfig.temperature = 0.85;

    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(candidate)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': userKey },
      body: JSON.stringify({
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      try { lastErr = JSON.parse(errText)?.error?.message || `HTTP ${res.status}`; } catch { lastErr = `HTTP ${res.status}`; }
      if (isInvalidKeyError(res.status, lastErr)) {
        const e = new Error('Google Gemini API 키가 유효하지 않습니다. 상단 [🔑 API]에서 Google AI Studio(aistudio.google.com/apikey)의 AIza... 키를 다시 입력해 주세요.');
        e.code = 'INVALID_API_KEY';
        throw e;
      }
      if (res.status === 404 && i === chain.length - 1 && !discovered) {
        discovered = true;
        const avail = await discoverModelsDirect(userKey).catch(() => ({ ok: false }));
        if (avail.ok && avail.recommendedModel && !chain.includes(avail.recommendedModel)) {
          chain = [...chain, avail.recommendedModel];
          continue;
        }
      }
      if ([400, 404, 429, 500, 503].includes(res.status) && i < chain.length - 1) continue;
      throw new Error(lastErr);
    }
    const data = await res.json();
    return { text: extractTextFromCandidate(data).trim(), modelUsed: candidate };
  }
  throw new Error(lastErr);
}

async function consumeGeminiSseResponse(res, onCleanDelta) {
  const filter = createStreamingTagFilter(onCleanDelta);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const chunk = extractTextFromCandidate(parsed);
        if (chunk) filter.push(chunk);
      } catch {
        // ignore
      }
    }
  }
  return filter.finish();
}

async function streamGeminiLive({ model, thinkingLevel, maxOutputTokens, systemInstruction, contents, onDelta, signal }) {
  const userKey = getEffectiveClientKey();

  if (cloudInfo.hasNetlifyFunction && (userKey || cloudInfo.hasServerKey)) {
    const headers = { 'Content-Type': 'application/json' };
    if (userKey) headers['x-user-gemini-key'] = userKey;
    const res = await fetch('/api/cloud/gemini/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, thinkingLevel, maxOutputTokens, systemInstruction, contents }),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.error || `스트리밍 오류 (HTTP ${res.status})`);
      if (err.code) e.code = err.code;
      throw e;
    }
    const modelUsed = res.headers.get('X-Crack-Model-Used') || model;
    const fallbackFrom = res.headers.get('X-Crack-Fallback-From') || null;
    const { cleanText, stateUpdate } = await consumeGeminiSseResponse(res, onDelta);
    return { text: cleanText, stateUpdate, modelUsed, fallbackFrom, isDemo: false };
  }

  // Direct CORS SSE stream to Google Gemini API (GitHub Pages / Static Hosting — zero backend cost!)
  let chain = buildFallbackChain(model);
  let discovered = false;
  let lastErr = 'Gemini 스트리밍 실패';
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const generationConfig = { maxOutputTokens };
    if (isGemini3Model(candidate)) {
      generationConfig.thinkingConfig = { thinkingLevel: ['LOW', 'MEDIUM', 'HIGH'].includes(thinkingLevel) ? thinkingLevel : 'MEDIUM' };
    } else {
      generationConfig.temperature = 0.85;
    }

    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(candidate)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': userKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig,
        safetySettings: [
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      try { lastErr = JSON.parse(errText)?.error?.message || `HTTP ${res.status}`; } catch { lastErr = `HTTP ${res.status}`; }
      if (isInvalidKeyError(res.status, lastErr)) {
        const e = new Error('Google Gemini API 키가 유효하지 않습니다. 상단 [🔑 API]에서 Google AI Studio(aistudio.google.com/apikey)의 AIza... 키를 다시 입력해 주세요.');
        e.code = 'INVALID_API_KEY';
        throw e;
      }
      if (res.status === 404 && i === chain.length - 1 && !discovered) {
        discovered = true;
        const avail = await discoverModelsDirect(userKey).catch(() => ({ ok: false }));
        if (avail.ok && avail.recommendedModel && !chain.includes(avail.recommendedModel)) {
          chain = [...chain, avail.recommendedModel];
          continue;
        }
      }
      if ([400, 404, 429, 500, 503].includes(res.status) && i < chain.length - 1) continue;
      throw new Error(lastErr);
    }

    const { cleanText, stateUpdate } = await consumeGeminiSseResponse(res, onDelta);
    return {
      text: cleanText,
      stateUpdate,
      modelUsed: candidate,
      fallbackFrom: candidate !== model ? model : null,
      isDemo: false,
    };
  }
  throw new Error(lastErr);
}

async function streamDemoCloud({ character, persona, userMessage, triggeredLorebooks, onDelta, signal }) {
  const userName = persona?.name || '나';
  const charName = character.name;
  const quoted = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const loreHint = triggeredLorebooks.length ? `\n\n*그 순간 '${triggeredLorebooks[0].title}'에 얽힌 기억이 스치며 공기가 달라졌다.*` : '';
  const fullText = character.isNationSim
    ? `*비서실장이 긴급 보고서를 전략 탁자 위에 펼쳐 놓으며 숨을 골랐다. 집무실의 각 부처 장관들이 일제히 시선을 집중했다.*\n\n"각하, 방금 하달하신 지시(${quoted || '국정 개혁 명령'})가 전국과 각국 대사관에 즉시 전파되었습니다!"${loreHint}\n\n**[ 긴급 속보 · 국제 뉴스 ]**\n- [속보] ${userName} 지도자, 전격 국정 드라이브 선언… 증시·여론 즉각 반응\n- [국제] 주변 열강 외무부 "향후 행보 예의주시" 긴급 논평 발표\n\n**[ 국가 상태창 · 대한민국 ]**\n- 시점: 2026년 2월 (1턴) · 지도자: ${userName}\n- 국력: 74/100 · 재정: 645조 원 · 지지율: 61% (+3%) · 군사력: 82/100 · 안정도: 71/100\n- 긴급 현안: 야당의 긴급 대정부 질문 대응 및 주변국 무역 협상`
    : character.isAnime && character.playStyle === 'world'
    ? `*「${character.animeTitle || charName}」 세계의 공기가 요동쳤다! ${character.castMembers?.[0] || charName}이(가) ${userName}을(를) 보며 눈을 번뜩였다.*\n\n${character.castMembers?.[0] || charName}: "${quoted ? `${quoted}... 좋아, ${userName}! 네 각오는 확실히 전해졌어!` : `자 ${userName}, 지금부터 진짜 시작이야!`}"${loreHint}\n\n**[ ${character.animeTitle || '애니 월드'} 진행 상태창 ]**\n- 고유 시스템(${character.powerSystem || '능력'}) 활성화 · 호감도 +2`
    : `*${charName}의 시선이 ${userName}에게 고정되었다. 정적 속에 묘한 긴장감과 설렘이 번졌다.*\n\n"${quoted ? `방금 한 말... 진심인가, ${userName}?` : `갑자기 말없이 쳐다보면 곤란한데, ${userName}.`}"\n\n*${charName}이(가) 천천히 한 걸음 가까이 다가섰다.*${loreHint}\n\n"좋아. 네가 선택한 그 결말, 내가 끝까지 지켜봐 주지."`;

  const chars = [...fullText];
  for (let i = 0; i < chars.length; i += 4) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onDelta(chars.slice(i, i + 4).join(''));
    await new Promise((r) => setTimeout(r, 16));
  }
  return {
    text: fullText,
    stateUpdate: character.isNationSim
      ? {
          affinityDelta: 3,
          mood: '국정 개혁 드라이브',
          nation: { name: '대한민국', date: '2026년 2월 (1턴)', power: 74, treasury: '645조 원', approval: 61, military: 82, stability: 71 },
        }
      : { affinityDelta: 2, mood: '흥미와 떨림' },
    modelUsed: 'demo-preview',
    fallbackFrom: null,
    isDemo: true,
  };
}

// --- Client Store Helpers ---
function listPersonasLocal() {
  const list = readLS('personas', null);
  if (!Array.isArray(list) || !list.length) {
    writeLS('personas', DEFAULT_PERSONAS);
    return structuredClone(DEFAULT_PERSONAS);
  }
  return list;
}

async function listCharactersCloud() {
  const cat = await ensureCatalog();
  const custom = readLS('characters', []);
  const meta = readLS('meta', { favorites: [], liked: [], extraPlays: {}, extraLikes: {} });
  const customMap = new Map(custom.map((c) => [c.id, c]));

  const mergedBuiltins = cat.characters.map((p) => {
    const over = customMap.get(p.id);
    const base = over ? { ...p, ...over, isBuiltin: true, isOriginal: Boolean(p.isOriginal), isAnime: Boolean(p.isAnime) } : { ...p, isBuiltin: true };
    return {
      ...base,
      avatar: normalizeAssetUrl(base.avatar),
      plays: (base.plays || 0) + (meta.extraPlays?.[base.id] || 0),
      likes: (base.likes || 0) + (meta.extraLikes?.[base.id] || 0),
      isFavorite: Boolean(meta.favorites?.includes(base.id)),
      isLiked: Boolean(meta.liked?.includes(base.id)),
    };
  });

  const onlyCustom = custom
    .filter((c) => !cat.characters.some((p) => p.id === c.id))
    .map((c) => ({
      ...c,
      avatar: normalizeAssetUrl(c.avatar),
      isBuiltin: false,
      isOriginal: false,
      plays: (c.plays || 1) + (meta.extraPlays?.[c.id] || 0),
      likes: (c.likes || 0) + (meta.extraLikes?.[c.id] || 0),
      isFavorite: Boolean(meta.favorites?.includes(c.id)),
      isLiked: Boolean(meta.liked?.includes(c.id)),
    }));

  return [...onlyCustom, ...mergedBuiltins];
}

function getSessionsRaw() {
  return readLS('sessions', []);
}

function saveSessionsRaw(list) {
  writeLS('sessions', list);
}

function resizeImageDataUrl(dataUrl, maxW = 480, maxH = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    img.src = dataUrl;
  });
}

export function setCloudRuntimeInfo(info) {
  cloudInfo = { ...cloudInfo, ...info };
}

export const cloudBackend = {
  isCloud: true,

  async getConfig() {
    const cat = await ensureCatalog();
    const cfg = readConfigRaw();
    const userKey = getEffectiveClientKey();
    const hasKey = Boolean(userKey || cloudInfo.hasServerKey);
    return {
      hasApiKey: hasKey,
      maskedApiKey: userKey ? maskKey(userKey) : (cloudInfo.hasServerKey ? '클라우드 서버 키 연결됨' : ''),
      keySource: userKey ? 'settings' : (cloudInfo.hasServerKey ? 'server-env' : 'none'),
      runtimeMode: cloudInfo.hasNetlifyFunction ? 'netlify-cloud' : 'static-cloud',
      defaultModel: cfg.defaultModel,
      defaultMode: cfg.defaultMode,
      viewMode: cfg.viewMode,
      fontFamily: cfg.fontFamily,
      outputLength: cfg.outputLength,
      showAffinityHud: cfg.showAffinityHud,
      activePersonaId: cfg.activePersonaId,
      lastVerifiedModel: cfg.lastVerifiedModel,
      lastVerifiedAt: cfg.lastVerifiedAt,
      models: cat.models,
      modes: cat.modes,
    };
  },

  async updateConfig(patch) {
    const curr = readConfigRaw();
    const cleaned = { ...patch };
    if (typeof cleaned.geminiApiKey === 'string') {
      cleaned.geminiApiKey = sanitizeApiKey(cleaned.geminiApiKey);
    }
    const next = { ...curr, ...cleaned };
    writeLS('config', next);
    return this.getConfig();
  },

  async verifyGemini({ apiKey, save = true, autoSelectRecommended = true }) {
    const keyToTest = (apiKey || '').trim() || getEffectiveClientKey();
    let result;

    if (cloudInfo.hasNetlifyFunction && (keyToTest || cloudInfo.hasServerKey)) {
      const res = await fetch('/api/cloud/gemini/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(keyToTest ? { 'x-user-gemini-key': keyToTest } : {}),
        },
        body: JSON.stringify({ apiKey: keyToTest }),
      });
      result = await res.json().catch(() => ({ ok: false, error: '인증 응답 오류' }));
      if (!res.ok) throw new Error(result.error || 'API 키 인증 실패');
    } else {
      if (!keyToTest) throw new Error('Google Gemini API 키를 입력해 주세요.');
      const res = await fetch(`${API_BASE}/models?pageSize=100`, {
        headers: { 'x-goog-api-key': keyToTest },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `API 키 인증 실패 (HTTP ${res.status})`);
      }
      const data = await res.json();
      const models = (data.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((id) => /gemini/i.test(id));
      const recommendedModel = FALLBACK_MODELS.find((id) => models.includes(id)) || models[0] || 'gemini-3.8-flash';
      result = { ok: true, models, recommendedModel };
    }

    const patch = {
      lastVerifiedModel: result.recommendedModel,
      lastVerifiedAt: new Date().toISOString(),
    };
    if (save && (apiKey || '').trim()) patch.geminiApiKey = apiKey.trim();
    if (autoSelectRecommended && result.recommendedModel) patch.defaultModel = result.recommendedModel;
    const config = await this.updateConfig(patch);
    return { ...result, config };
  },

  async getNetwork() {
    const publicUrl = window.location.href.split(/[?#]/)[0];
    return {
      isCloud: true,
      localUrl: publicUrl,
      lanUrl: publicUrl,
      bonjourUrl: publicUrl,
      qrSvg: '',
    };
  },

  async getCharacters() {
    const cat = await ensureCatalog();
    return {
      genres: cat.genres,
      animeCategories: cat.animeCategories,
      characters: await listCharactersCloud(),
    };
  },

  async saveCharacter(payload) {
    const cat = await ensureCatalog();
    const custom = readLS('characters', []);
    const now = new Date().toISOString();
    const genre = cat.genres.some((g) => g.id === payload.genre && g.id !== 'all') ? payload.genre : 'romance';
    const genreLabel = cat.genres.find((g) => g.id === genre)?.label || '기타';
    const tags = Array.isArray(payload.tags)
      ? payload.tags
      : String(payload.tags || '').split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)).slice(0, 8);
    const castMembers = Array.isArray(payload.castMembers)
      ? payload.castMembers
      : String(payload.castMembers || '').split(/[,،]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);

    const record = {
      id: payload.id || makeId('char'),
      isOriginal: false,
      isBuiltin: false,
      isAnime: Boolean(payload.isAnime || genre === 'anime' || payload.animeTitle),
      animeTitle: String(payload.animeTitle || '').trim().slice(0, 60),
      animeCategory: String(payload.animeCategory || 'shonen'),
      playStyle: payload.playStyle === 'world' ? 'world' : 'character',
      powerSystem: String(payload.powerSystem || '').trim().slice(0, 120),
      castMembers,
      name: String(payload.name || '').trim().slice(0, 50) || '이름 없는 캐릭터',
      title: String(payload.title || '').trim().slice(0, 90) || '새로운 이야기',
      subtitle: String(payload.subtitle || '').trim().slice(0, 180),
      genre,
      genreLabel,
      tags,
      creator: payload.creator || '내 캐릭터',
      avatar: normalizeAssetUrl(payload.avatar || './assets/characters/seodohyun.jpg'),
      plays: 1,
      likes: 0,
      initialAffinity: Number(payload.initialAffinity ?? 35),
      initialMood: payload.initialMood || '호기심 어린 시선',
      relationshipStage: payload.relationshipStage || '첫 만남 · 1막',
      worldSummary: payload.worldSummary || '',
      personaPrompt: payload.personaPrompt || '',
      openingMessage: payload.openingMessage || '',
      suggestedReplies: Array.isArray(payload.suggestedReplies) ? payload.suggestedReplies.slice(0, 3) : [],
      lorebook: Array.isArray(payload.lorebook) ? payload.lorebook : [],
      createdAt: payload.createdAt || now,
      updatedAt: now,
    };

    const idx = custom.findIndex((c) => c.id === record.id);
    if (idx !== -1) custom[idx] = { ...custom[idx], ...record };
    else custom.unshift(record);
    writeLS('characters', custom);
    return { character: (await listCharactersCloud()).find((c) => c.id === record.id) };
  },

  async deleteCharacter(id) {
    const custom = readLS('characters', []);
    writeLS('characters', custom.filter((c) => c.id !== id));
    return { deleted: true };
  },

  async toggleFavorite(id) {
    const meta = readLS('meta', { favorites: [], liked: [], extraPlays: {}, extraLikes: {} });
    const set = new Set(meta.favorites || []);
    const active = !set.has(id);
    if (active) set.add(id); else set.delete(id);
    meta.favorites = [...set];
    writeLS('meta', meta);
    return { isFavorite: active };
  },

  async toggleLike(id) {
    const meta = readLS('meta', { favorites: [], liked: [], extraPlays: {}, extraLikes: {} });
    const set = new Set(meta.liked || []);
    meta.extraLikes = meta.extraLikes || {};
    const active = !set.has(id);
    if (active) { set.add(id); meta.extraLikes[id] = (meta.extraLikes[id] || 0) + 1; }
    else { set.delete(id); meta.extraLikes[id] = Math.max(0, (meta.extraLikes[id] || 1) - 1); }
    meta.liked = [...set];
    writeLS('meta', meta);
    const char = (await listCharactersCloud()).find((c) => c.id === id);
    return { isLiked: active, likes: char?.likes || 0 };
  },

  async uploadImage(dataUrl) {
    const resized = await resizeImageDataUrl(dataUrl);
    return { url: resized };
  },

  async getPersonas() {
    return { personas: listPersonasLocal() };
  },

  async savePersona(input) {
    const list = listPersonasLocal();
    const record = {
      id: input.id || makeId('persona'),
      name: String(input.name || '').trim().slice(0, 40) || '나',
      gender: String(input.gender || '미지정').trim().slice(0, 20),
      description: String(input.description || '').trim().slice(0, 600),
      isDefault: false,
    };
    const idx = list.findIndex((p) => p.id === record.id);
    if (idx !== -1) list[idx] = { ...list[idx], ...record };
    else list.push(record);
    writeLS('personas', list);
    return { persona: record, personas: list };
  },

  async deletePersona(id) {
    const list = listPersonasLocal();
    if (list.length <= 1) return { ok: false, personas: list };
    const next = list.filter((p) => p.id !== id);
    writeLS('personas', next);
    return { ok: true, personas: next };
  },

  async getSessions(characterId = null) {
    const chars = new Map((await listCharactersCloud()).map((c) => [c.id, c]));
    const list = getSessionsRaw()
      .filter((s) => (!characterId ? true : s.characterId === characterId))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map((s) => {
        const c = chars.get(s.characterId);
        const last = s.messages?.[s.messages.length - 1];
        return {
          id: s.id,
          characterId: s.characterId,
          characterName: c?.name || '삭제된 캐릭터',
          characterAvatar: normalizeAssetUrl(c?.avatar || './assets/characters/seodohyun.jpg'),
          characterTitle: c?.title || '',
          title: s.title,
          affinity: s.affinity,
          mood: s.mood,
          relationshipStage: s.relationshipStage,
          messageCount: s.messages?.length || 0,
          lastPreview: last ? String(last.content).replace(/\s+/g, ' ').slice(0, 90) : '',
          updatedAt: s.updatedAt,
        };
      });
    return { sessions: list };
  },

  async createSession({ characterId, personaId, title }) {
    const chars = await listCharactersCloud();
    const char = chars.find((c) => c.id === characterId);
    if (!char) throw new Error('캐릭터를 찾을 수 없습니다.');
    const personas = listPersonasLocal();
    const persona = personas.find((p) => p.id === personaId) || personas[0];
    const now = new Date().toISOString();
    const opening = renderTemplate(char.openingMessage || `*${char.name}이(가) {{user}}를 바라보았다.*`, { userName: persona.name, charName: char.name });

    const session = {
      id: makeId('sess'),
      characterId: char.id,
      title: title || `${char.name} · ${new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} 이야기`,
      personaId: persona.id,
      storyRoute: 'if',
      nationMode: 'realistic',
      nationState: char.initialNationState ? structuredClone(char.initialNationState) : null,
      userNote: '',
      summaryMemory: '',
      affinity: char.initialAffinity ?? 35,
      mood: char.initialMood || '호기심 어린 시선',
      relationshipStage: char.relationshipStage || '첫 만남',
      lorebook: structuredClone(char.lorebook || []),
      suggestedReplies: (char.suggestedReplies || []).map((r) => renderTemplate(r, { userName: persona.name, charName: char.name })),
      messages: [
        { id: makeId('msg'), role: 'model', content: opening, versions: [opening], activeVersion: 0, isOpening: true, createdAt: now, meta: { model: 'opening', triggeredLorebooks: [] } },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const sessions = getSessionsRaw();
    sessions.unshift(session);
    saveSessionsRaw(sessions);

    const meta = readLS('meta', { favorites: [], liked: [], extraPlays: {}, extraLikes: {} });
    meta.extraPlays = meta.extraPlays || {};
    meta.extraPlays[char.id] = (meta.extraPlays[char.id] || 0) + 1;
    writeLS('meta', meta);

    return { session, character: char };
  },

  async getSession(id) {
    const session = getSessionsRaw().find((s) => s.id === id);
    if (!session) throw new Error('세션을 찾을 수 없습니다.');
    const char = (await listCharactersCloud()).find((c) => c.id === session.characterId);
    const personas = listPersonasLocal();
    const persona = personas.find((p) => p.id === session.personaId) || personas[0];
    return { session, character: char, persona };
  },

  async updateSession(id, patch) {
    const sessions = getSessionsRaw();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('세션을 찾을 수 없습니다.');
    const curr = sessions[idx];
    const next = { ...curr, ...patch, updatedAt: new Date().toISOString() };
    if (typeof patch.affinity === 'number') {
      const char = (await listCharactersCloud()).find((c) => c.id === curr.characterId);
      next.affinity = Math.max(0, Math.min(100, Math.round(patch.affinity)));
      next.relationshipStage = relationshipStageForAffinity(next.affinity, char?.relationshipStage);
    }
    sessions[idx] = next;
    saveSessionsRaw(sessions);
    return { session: next };
  },

  async deleteSession(id) {
    saveSessionsRaw(getSessionsRaw().filter((s) => s.id !== id));
    return { deleted: true };
  },

  async updateMessage(sessionId, msgId, patch) {
    const { session } = await this.getSession(sessionId);
    const msgs = session.messages.map((m) => {
      if (m.id !== msgId) return m;
      const copy = { ...m };
      if (typeof patch.activeVersion === 'number' && Array.isArray(copy.versions)) {
        const clamped = Math.max(0, Math.min(copy.versions.length - 1, patch.activeVersion));
        copy.activeVersion = clamped;
        copy.content = copy.versions[clamped];
      }
      if (typeof patch.content === 'string') {
        copy.content = patch.content;
        if (Array.isArray(copy.versions)) {
          copy.versions = [...copy.versions];
          copy.versions[copy.activeVersion || 0] = patch.content;
        }
      }
      return copy;
    });
    return this.updateSession(sessionId, { messages: msgs });
  },

  async rewindSession(sessionId, messageId) {
    const { session } = await this.getSession(sessionId);
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return { session };
    return this.updateSession(sessionId, { messages: session.messages.slice(0, idx + 1) });
  },

  async exportStoryMarkdown(sessionId) {
    const { session, character, persona } = await this.getSession(sessionId);
    const lines = [
      `# ${character?.title || session.title}`,
      `> 캐릭터: **${character?.name}** · 주인공: **${persona.name}** · 호감도: ${session.affinity}/100 (${session.mood})`,
      '',
      ...(session.summaryMemory ? ['## 요약 메모리', session.summaryMemory, ''] : []),
      '---',
      '',
      ...session.messages.flatMap((m) => [`### ${m.role === 'user' ? persona.name : character.name}`, '', m.content, '']),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown; charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(character?.name || 'crack_story').replace(/[^\w가-힣-]+/g, '_')}_story.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  async streamChat(sessionId, payload, { onStart, onDelta, onDone, onError, signal }) {
    const { session: loadedSession, character, persona } = await this.getSession(sessionId);
    const cfg = readConfigRaw();
    const action = payload.action || 'send';
    const mode = payload.mode || cfg.defaultMode || 'story';
    const model = payload.model || (mode === 'speed' ? 'gemini-3.5-flash-lite' : cfg.defaultModel);
    const thinkingLevel = mode === 'pro' ? 'HIGH' : mode === 'speed' ? 'LOW' : 'MEDIUM';
    const maxOutputTokens = mode === 'pro' ? 2600 : mode === 'speed' ? 1100 : 1600;

    let session = loadedSession;
    let userText = '';
    if (action === 'send') {
      userText = String(payload.text || '').trim();
      const userMsg = { id: makeId('msg'), role: 'user', content: userText, createdAt: new Date().toISOString() };
      const res = await this.updateSession(sessionId, { messages: [...session.messages, userMsg] });
      session = res.session;
    } else if (action === 'regenerate') {
      userText = [...session.messages].reverse().find((m) => m.role === 'user')?.content || '';
    }

    const historyForPrompt = action === 'regenerate' ? session.messages.slice(0, -1) : session.messages;
    const triggered = findTriggeredLorebooks(session.lorebook || character.lorebook || [], historyForPrompt, userText);
    const systemInstruction = buildSystemInstruction({
      character,
      session,
      persona,
      triggeredLorebooks: triggered,
      outputLength: payload.outputLength || cfg.outputLength || 'medium',
      viewMode: payload.viewMode || cfg.viewMode || 'novel',
      isContinue: action === 'continue',
    });
    const contents = buildGeminiContents(historyForPrompt, { continueCue: action === 'continue' });

    const useLive = hasAnyApiKey();
    if (onStart) onStart({ action, triggeredLorebooks: triggered, isDemo: !useLive });

    try {
      const result = useLive
        ? await streamGeminiLive({
            model,
            thinkingLevel,
            maxOutputTokens,
            systemInstruction,
            contents,
            onDelta: (t) => onDelta && onDelta({ text: t }),
            signal,
          })
        : await streamDemoCloud({
            character,
            persona,
            userMessage: userText,
            triggeredLorebooks: triggered,
            onDelta: (t) => onDelta && onDelta({ text: t }),
            signal,
          });

      const finalText = result.text || '*(잠시 말이 끊어졌다.)*';
      const nextAff = Math.max(0, Math.min(100, (session.affinity ?? 35) + (result.stateUpdate?.affinityDelta || 0)));
      const nextMood = result.stateUpdate?.mood || session.mood;
      const meta = {
        model: result.modelUsed,
        fallbackFrom: result.fallbackFrom,
        isDemo: Boolean(result.isDemo),
        triggeredLorebooks: triggered.map((l) => l.title),
        affinityDelta: result.stateUpdate?.affinityDelta || 0,
        mood: nextMood,
      };

      const msgs = [...session.messages];
      let savedMessage;
      if (action === 'regenerate' && msgs.length && msgs[msgs.length - 1].role === 'model') {
        const target = { ...msgs[msgs.length - 1] };
        const vers = Array.isArray(target.versions) && target.versions.length ? [...target.versions] : [target.content];
        vers.push(finalText);
        target.versions = vers;
        target.activeVersion = vers.length - 1;
        target.content = finalText;
        target.meta = meta;
        msgs[msgs.length - 1] = target;
        savedMessage = target;
      } else {
        savedMessage = { id: makeId('msg'), role: 'model', content: finalText, versions: [finalText], activeVersion: 0, createdAt: new Date().toISOString(), meta };
        msgs.push(savedMessage);
      }

      const nextNationState = result.stateUpdate?.nation
        ? {
            ...(session.nationState || {}),
            ...Object.fromEntries(Object.entries(result.stateUpdate.nation).filter(([, v]) => v !== undefined)),
          }
        : session.nationState;

      const { session: updated } = await this.updateSession(sessionId, {
        affinity: nextAff,
        mood: nextMood,
        nationState: nextNationState,
        messages: msgs,
      });

      if (onDone) {
        onDone({
          message: savedMessage,
          sessionState: {
            affinity: updated.affinity,
            mood: updated.mood,
            relationshipStage: updated.relationshipStage,
            nationState: updated.nationState,
            messageCount: updated.messages.length,
          },
          modelUsed: result.modelUsed,
          fallbackFrom: result.fallbackFrom,
          isDemo: result.isDemo,
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (onError) onError({ message: err.message, code: err.code || '' });
    }
  },

  async generateSuggestions(sessionId) {
    const { session, character, persona } = await this.getSession(sessionId);
    if (!hasAnyApiKey()) {
      const suggestions = [
        `"잠깐, 지금 한 말 진심이야?" *${character.name}의 눈을 바라본다.*`,
        `*한 걸음 다가서며 묻는다.* "숨기는 게 뭔지 전부 말해줘."`,
        `*미소 지으며* "좋아, 이번엔 내 방식대로 움직여 볼게."`,
      ];
      await this.updateSession(sessionId, { suggestedReplies: suggestions });
      return { suggestions, modelUsed: 'demo-preview' };
    }
    const transcript = session.messages.slice(-8).map((m) => `${m.role === 'user' ? persona.name : character.name}: ${m.content}`).join('\n\n');
    const out = await callGeminiGenerate({
      model: 'gemini-3.5-flash-lite',
      systemInstruction: '당신은 한국 웹소설 인터랙티브 채팅(CRACK) 추천 선택지 작가입니다. JSON 문자열 배열(["...", "...", "..."])만 반환하세요.',
      prompt: `캐릭터 "${character.name}"와 유저 "${persona.name}"의 최근 대화:\n\n${transcript}\n\n서로 다른 분위기의 추천 답변 3개를 *행동 지문*과 "대사"를 섞어 작성해 JSON 배열로 반환하세요.`,
      maxOutputTokens: 500,
      jsonMode: true,
    });
    const suggestions = parseJsonLoose(out.text).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
    await this.updateSession(sessionId, { suggestedReplies: suggestions });
    return { suggestions, modelUsed: out.modelUsed };
  },

  async summarizeSession(sessionId) {
    const { session, character, persona } = await this.getSession(sessionId);
    if (!hasAnyApiKey()) {
      const summaryMemory = `[미리보기 자동 요약] ${persona.name}와(과) ${character.name}은(는) '${session.relationshipStage}' 단계이며 감정은 '${session.mood}'(호감도 ${session.affinity})입니다.`;
      await this.updateSession(sessionId, { summaryMemory });
      return { summaryMemory, modelUsed: 'demo-preview' };
    }
    const transcript = session.messages.slice(-26).map((m) => `${m.role === 'user' ? persona.name : character.name}: ${m.content}`).join('\n\n');
    const out = await callGeminiGenerate({
      model: 'gemini-3.5-flash-lite',
      systemInstruction: '당신은 AI 스토리 채팅의 요약 메모리 편집자입니다. 간결한 한국어 불릿 4~6줄로 핵심 사실만 정리하세요.',
      prompt: `기존 메모리:\n${session.summaryMemory || '(없음)'}\n\n최근 대화:\n${transcript}\n\n핵심 사건, 약속, 감정 변화를 400자 이내로 정리하세요.`,
      maxOutputTokens: 600,
    });
    await this.updateSession(sessionId, { summaryMemory: out.text });
    return { summaryMemory: out.text, modelUsed: out.modelUsed };
  },

  async autofillCharacter({ concept, genre = 'romance', name = '' }) {
    if (!hasAnyApiKey()) {
      const n = name || '한서윤';
      return {
        isDemo: true,
        character: {
          name: n,
          title: `${concept.slice(0, 26)} — 운명의 시작`,
          subtitle: '“네가 나타나기 전까지, 이 밤은 늘 똑같았는데.”',
          genre,
          tags: ['#오리지널', '#스토리챗', '#비밀'],
          worldSummary: `${concept}을(를) 배경으로 {{user}}와 ${n}이(가) 얽히는 스토리.`,
          personaPrompt: `이름: ${n}\n컨셉: ${concept}\n성격: 차분하지만 {{user}} 앞에서 진심이 흔들린다.`,
          openingMessage: `*고요한 밤, ${n}이(가) 천천히 고개를 들어 {{user}}를 바라보았다.*\n\n"기다리고 있었어, {{user}}."`,
          initialMood: '묘한 기대감',
          relationshipStage: '운명적 첫 만남',
          suggestedReplies: ['"무슨 뜻이야?"', '*한 걸음 다가선다.*', '"좋아, 같이 가보자."'],
          lorebook: [{ id: makeId('lore'), title: '핵심 비밀', keywords: '비밀, 과거', content: `${concept}의 숨겨진 진실.`, enabled: true }],
        },
      };
    }
    const out = await callGeminiGenerate({
      model: readConfigRaw().defaultModel || 'gemini-3.8-flash',
      systemInstruction: '한국 웹소설 AI 캐릭터 챗 크리에이터입니다. 유효한 JSON 객체만 출력하세요.',
      prompt: `아이디어 "${concept}", 장르 "${genre}", 이름 힌트 "${name || '자유'}"로 CRACK 캐릭터 JSON을 생성하세요. 필드: name, title, subtitle, tags(배열), worldSummary, personaPrompt, openingMessage, initialMood, relationshipStage, initialAffinity, suggestedReplies(3개), lorebook([{title,keywords,content}]).`,
      maxOutputTokens: 2000,
      jsonMode: true,
    });
    const character = parseJsonLoose(out.text);
    character.genre = genre;
    return { character, modelUsed: out.modelUsed, isDemo: false };
  },

  async summonAnime({ animeTitle, targetCharacter = '', playStyle = 'world', extraPrompt = '' }) {
    const avatar = pickAnimePoster(`${animeTitle} ${targetCharacter} ${extraPrompt}`);
    let charPayload;
    let isDemo = !hasAnyApiKey();

    if (isDemo) {
      const name = playStyle === 'world' ? `${animeTitle} · 세계관 시뮬` : (targetCharacter || `${animeTitle} 대표 캐릭터`);
      charPayload = {
        isAnime: true,
        animeTitle,
        playStyle,
        genre: 'anime',
        powerSystem: `${animeTitle} 고유 능력 시스템`,
        castMembers: targetCharacter ? [targetCharacter] : [animeTitle],
        name,
        title: `[${animeTitle}] ${targetCharacter ? `${targetCharacter}와(과) 시작하는 이야기` : '원작 세계관 시뮬레이션'}`,
        subtitle: `“${animeTitle}의 세계에서 새로운 이야기가 시작된다.”`,
        tags: [`#${animeTitle.replace(/\s+/g, '')}`, playStyle === 'world' ? '#세계관시뮬' : '#1대1캐릭터챗', '#애니소환'],
        creator: 'ANIME SUMMON',
        avatar,
        worldSummary: `애니메이션 「${animeTitle}」 세계로 들어온 {{user}}의 이야기.${extraPrompt ? ` (${extraPrompt})` : ''}`,
        personaPrompt: `원작: ${animeTitle}\n역할: ${name}\n설정: 원작 고증 말투와 세계관 규칙 준수. ${extraPrompt}`,
        openingMessage: `*애니메이션 「${animeTitle}」의 상징적인 무대. 운명의 막이 올랐다.*\n\n${playStyle === 'world' ? `${targetCharacter || '주인공'}: "어이 {{user}}! 지금 당장 움직여야 해!"` : `"기다리고 있었어, {{user}}. 여기서부터 네 선택을 보여줘."`}\n\n**[ ${animeTitle} 상태창 · {{user}} ]**\n- 모드: ${playStyle === 'world' ? '멀티 캐릭터 세계관 RPG' : '1:1 캐릭터 챗'}`,
        suggestedReplies: [`"좋아, ${animeTitle} 세계의 규칙대로 정면 돌파하자!"`, '"지금 원작 타임라인 어디쯤인지 확인해 보자."', '*상대의 눈을 마주 보며 동행을 제안한다.*'],
        lorebook: [{ id: makeId('lore'), title: `${animeTitle} 핵심 설정`, keywords: `${animeTitle}, 능력, 비밀`, content: `「${animeTitle}」의 원작 능력 체계와 주요 세력.`, enabled: true }],
      };
    } else {
      const out = await callGeminiGenerate({
        model: readConfigRaw().defaultModel || 'gemini-3.8-flash',
        systemInstruction: '모든 애니메이션의 원작 설정, 말투, 능력치, 명장면을 꿰뚫고 있는 한국어 AI 스토리 크리에이터입니다. 유효한 JSON 객체만 출력하세요.',
        prompt: `애니메이션 「${animeTitle}」 기반 CRACK 캐릭터/세계관 JSON을 생성하세요. 대상: ${targetCharacter || '대표 인기 캐릭터/주연진'}, 모드: ${playStyle === 'world' ? '멀티캐릭터 세계관 RPG(상태창 포함)' : '1:1 캐릭터 챗'}, 추가 요청: ${extraPrompt || '가장 인기 있는 명장면 시점'}. 필드: name, title, subtitle, animeCategory(shonen|fantasy_isekai|thriller_sf|slice_sports), powerSystem, castMembers(배열), tags(배열), worldSummary, personaPrompt(500자 이상), openingMessage(3~5문단), initialMood, relationshipStage, initialAffinity, suggestedReplies(3개), lorebook(3개: {title,keywords,content}).`,
        maxOutputTokens: 2400,
        jsonMode: true,
      });
      charPayload = { ...parseJsonLoose(out.text), isAnime: true, animeTitle, playStyle, genre: 'anime', creator: 'ANIME SUMMON', avatar };
    }

    const { character } = await this.saveCharacter(charPayload);
    const { session } = await this.createSession({ characterId: character.id, personaId: readConfigRaw().activePersonaId });
    const persona = listPersonasLocal().find((p) => p.id === session.personaId) || listPersonasLocal()[0];
    return { character, session, persona, isDemo };
  },

  exportFullBackup() {
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      config: { ...readConfigRaw(), geminiApiKey: '' }, // Never export raw API key in backup file
      characters: readLS('characters', []),
      sessions: readLS('sessions', []),
      personas: listPersonasLocal(),
      meta: readLS('meta', {}),
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `crack_ai_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  importFullBackup(parsed) {
    if (!parsed || typeof parsed !== 'object') throw new Error('올바른 백업 파일이 아닙니다.');
    if (Array.isArray(parsed.characters)) writeLS('characters', parsed.characters);
    if (Array.isArray(parsed.sessions)) writeLS('sessions', parsed.sessions);
    if (Array.isArray(parsed.personas) && parsed.personas.length) writeLS('personas', parsed.personas);
    if (parsed.meta && typeof parsed.meta === 'object') writeLS('meta', parsed.meta);
  },
};

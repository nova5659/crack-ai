// Complete 24/7 Always-On Cloud & Static Web Engine for CRACK AI
// Works on Netlify (with Netlify Functions + optional GEMINI_API_KEY env var) AND pure static hosting (Netlify Drop / GitHub Pages / Cloudflare Pages).

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const STORAGE_PREFIX = 'crack_cloud_v1_';
const STATE_TAG_REGEX = /<!--\s*CRACK_STATE\s*:\s*(\{[\s\S]*?\})\s*-->/i;

const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];

const DEFAULT_PERSONAS = [
  { id: 'persona_default', name: '나', gender: '미지정', description: '이야기의 주인공. 상황에 따라 능동적으로 선택하고 반응한다.', isDefault: true },
  { id: 'persona_noble', name: '세린', gender: '여성', description: '겉으로는 차분하지만 결정적인 순간에 대담한 선택을 하는 인물.', isDefault: false },
  { id: 'persona_wanderer', name: '이현', gender: '남성', description: '관찰력이 뛰어나고 쉽게 본심을 드러내지 않는 인물.', isDefault: false },
];

const DEFAULT_CONFIG = {
  configVersion: 2,
  geminiApiKey: '',
  defaultModel: 'gemini-3.5-flash-lite',
  defaultMode: 'story',
  theme: 'dark',
  viewMode: 'novel',
  fontFamily: 'sans',
  fontSize: 'md',
  backdropMode: 'dim',
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

const STORY_LENGTH_TURNS = {
  short: 8,
  standard: 14,
  long: 24,
  endless: 0,
};

function computeStoryArc(session = {}) {
  const storyLength = session.storyLength || 'standard';
  const targetTurns = typeof session.targetTurns === 'number' ? session.targetTurns : (STORY_LENGTH_TURNS[storyLength] ?? 14);
  const isEndless = storyLength === 'endless' || targetTurns <= 0;
  const turn = Math.max(0, Array.isArray(session.messages) ? session.messages.filter((m) => m.role === 'user').length : Number(session.turnCount || 0));
  if (isEndless) {
    return { storyLength: 'endless', turn, targetTurns: 0, remainingTurns: null, progressPct: 0, actIndex: 0, actLabel: '자유 연재 모드', isEndless: true, isClimax: false, isFinalTurn: false };
  }
  const ratio = targetTurns > 0 ? turn / targetTurns : 0;
  let actIndex = 1;
  let actLabel = '제1막 · 발단';
  if (ratio > 0.82 || turn >= targetTurns) { actIndex = 4; actLabel = '제4막 · 최종 결말'; }
  else if (ratio > 0.55) { actIndex = 3; actLabel = '제3막 · 위기와 절정'; }
  else if (ratio > 0.25) { actIndex = 2; actLabel = '제2막 · 전개와 갈등'; }
  const remainingTurns = Math.max(0, targetTurns - turn);
  return {
    storyLength,
    turn,
    targetTurns,
    remainingTurns,
    progressPct: Math.min(100, Math.round((turn / targetTurns) * 100)),
    actIndex,
    actLabel,
    isEndless: false,
    isClimax: remainingTurns > 0 && remainingTurns <= 2,
    isFinalTurn: turn >= targetTurns,
  };
}

function rollFateJudgment({ session = {}, character = {}, difficulty = null, storyArc = null } = {}) {
  const diff = difficulty || session.difficulty || 'real';
  const arc = storyArc || computeStoryArc(session);
  if (character?.isNationSim && arc.turn <= 1) {
    return { roll: 55, outcome: 'mixed', label: '위기 개시', directive: '취임/개국 첫 브리핑 턴입니다. 순탄한 출발이 아니라 당장 해결해야 할 날카로운 복합 위기와 압박 요소를 분명히 제시하세요.' };
  }
  let roll = Math.floor(Math.random() * 100) + 1;
  if (character?.isNationSim && session.nationState) {
    const app = Number(session.nationState.approval ?? 58);
    const stab = Number(session.nationState.stability ?? 68);
    if (app <= 30 || stab <= 30) roll = Math.max(1, roll - 12);
    if (session.nationMode === 'crisis' || session.nationMode === 'surreal') roll = Math.max(1, roll - 8);
  } else if (Number(session.affinity ?? 35) <= 20) {
    roll = Math.max(1, roll - 10);
  }
  const th = diff === 'hardcore' ? { fail: 32, setback: 62, mixed: 86 } : diff === 'story' ? { fail: 10, setback: 28, mixed: 65 } : { fail: 24, setback: 50, mixed: 80 };
  if (roll <= th.fail) {
    return { roll, outcome: 'fail', label: '실패 · 역풍', directive: '[이번 턴 운명 판정: 명백한 실패 / 치명적 역풍] 절대 유저의 계획을 성공시켜 주지 마세요! 상대의 반격, 함정, 힘·자원의 한계, 내부 반발 또는 거절로 인해 이번 시도가 뚜렷하게 실패하고 뼈아픈 손실(부상, 신뢰·호감도 하락, 지지율·국고 급락, 주도권 상실)을 입게 하세요.' };
  }
  if (roll <= th.setback) {
    return { roll, outcome: 'setback', label: '난항 · 값비싼 대가', directive: '[이번 턴 운명 판정: 난항 / 값비싼 대가] 의도한 대로 풀리지 않습니다. 목표 달성에 실패해 물러서거나, 간신히 버텨내더라도 치명적인 대가(큰 피해, 동맹 이탈, 감정적 균열)를 치르게 하세요.' };
  }
  if (roll <= th.mixed) {
    return { roll, outcome: 'mixed', label: '조건부 돌파', directive: '[이번 턴 운명 판정: 부분 성공 / 조건부 돌파] 계획이 합리적이라면 절반의 성과는 얻되, 적의 반격·부작용·새로운 대가가 즉각 따라붙게 전개하세요. 계획이 무모하다면 가차 없이 실패시키세요.' };
  }
  return { roll, outcome: 'success', label: '결정적 돌파', directive: '[이번 턴 운명 판정: 돌파구 확보] 유저의 선택이 상황상 타당하고 설득력 있을 때만 값진 성과를 허락하세요. 무모한 행동이나 준비 없는 기적은 여전히 실패로 판정하세요.' };
}

function normalizeEnding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const typeRaw = String(raw.type || '').toLowerCase();
  const type = ['true', 'good', 'bittersweet', 'bad'].includes(typeRaw) ? typeRaw : 'good';
  const labels = { true: 'TRUE ENDING · 진엔딩', good: 'GOOD ENDING · 굿엔딩', bittersweet: 'BITTERSWEET ENDING · 여운 엔딩', bad: 'BAD ENDING · 배드엔딩' };
  const title = String(raw.title || '').trim().slice(0, 60);
  if (!title) return null;
  return { type, code: String(raw.code || labels[type]).trim().slice(0, 42), title, summary: String(raw.summary || '').trim().slice(0, 260), reachedAt: new Date().toISOString() };
}

function resolveSessionEnding({ character = {}, nextAffinity = 35, nextNationState = null, storyArc = null, aiEnding = null, prevEnding = null } = {}) {
  if (prevEnding) return prevEnding;
  if (aiEnding && aiEnding.title) return aiEnding;
  const turn = storyArc?.turn || 0;
  if (character.isNationSim && nextNationState && turn >= 2) {
    const app = Number(nextNationState.approval ?? 55);
    const stab = Number(nextNationState.stability ?? 65);
    const pow = Number(nextNationState.power ?? 65);
    const mil = Number(nextNationState.military ?? 65);
    if (app <= 10 || stab <= 10) return { type: 'bad', code: 'BAD ENDING · 정권 붕괴', title: '무너진 집무실과 탄핵의 밤', summary: `민심(${app}%)과 국내 안정도(${stab}%)가 임계점 이하로 추락하며 통치 기반이 완전히 붕괴했습니다.`, reachedAt: new Date().toISOString() };
    if (pow <= 10 || mil <= 10) return { type: 'bad', code: 'BAD ENDING · 국가 패망', title: '꺼져버린 국운', summary: `국력(${pow})과 군사력(${mil})이 고갈되어 국가의 자주권과 존립을 지켜내지 못했습니다.`, reachedAt: new Date().toISOString() };
  }
  if (!character.isNationSim && nextAffinity <= 5 && turn >= 3) {
    return { type: 'bad', code: 'BAD ENDING · 파국', title: '돌이킬 수 없는 결별과 파멸', summary: `${character.name || '인물'}과의 신뢰가 완전히 무너지고, 치명적인 오판 끝에 이야기가 비극적으로 막을 내렸습니다.`, reachedAt: new Date().toISOString() };
  }
  if (storyArc && !storyArc.isEndless && storyArc.isFinalTurn) {
    if (character.isNationSim && nextNationState) {
      const avg = Math.round((Number(nextNationState.power ?? 60) + Number(nextNationState.approval ?? 55) + Number(nextNationState.stability ?? 60) + Number(nextNationState.military ?? 60)) / 4);
      if (avg >= 76) return { type: 'true', code: 'TRUE ENDING · 시대의 성군', title: `${nextNationState.name || '국가'}의 황금시대`, summary: '수많은 위기와 외교전을 뚫고 국력·민심·안보를 모두 정점에 올려놓으며 역사에 길이 남을 업적을 세웠습니다.', reachedAt: new Date().toISOString() };
      if (avg >= 58) return { type: 'good', code: 'GOOD ENDING · 버텨낸 시대', title: '격랑 끝에 지켜낸 나라', summary: '치열한 갈등과 대가 속에서도 국가의 기틀을 지켜내며 다음 세대로 바통을 넘겼습니다.', reachedAt: new Date().toISOString() };
      if (avg >= 40) return { type: 'bittersweet', code: 'BITTERSWEET ENDING · 상처뿐인 생존', title: '미완의 개혁과 남은 숙제', summary: '최악의 파국은 면했으나 깊은 상처와 분열을 남긴 채 임기의 끝을 맞았습니다.', reachedAt: new Date().toISOString() };
      return { type: 'bad', code: 'BAD ENDING · 쇠락의 기록', title: '역사의 심판대 앞에서', summary: '연이은 실정과 위기 대응 실패로 국력이 크게 쇠퇴하며 비극적인 평가를 남겼습니다.', reachedAt: new Date().toISOString() };
    }
    if (nextAffinity >= 75) return { type: 'true', code: 'TRUE ENDING · 진엔딩', title: '끝내 지켜낸 운명의 결말', summary: `수많은 시련과 갈등을 정면으로 돌파해 ${character.name || '인물'}과 함께 최고의 결말에 도달했습니다.`, reachedAt: new Date().toISOString() };
    if (nextAffinity >= 52) return { type: 'good', code: 'GOOD ENDING · 굿엔딩', title: '새로운 내일의 문턱에서', summary: '완벽하진 않았지만 치열한 선택 끝에 각자의 길을 지켜내며 이야기를 매듭지었습니다.', reachedAt: new Date().toISOString() };
    if (nextAffinity >= 30) return { type: 'bittersweet', code: 'BITTERSWEET ENDING · 여운 엔딩', title: '지키지 못한 약속의 잔향', summary: '모든 것을 지키지는 못한 채, 깊은 여운과 상처를 안고 이 장의 막을 내렸습니다.', reachedAt: new Date().toISOString() };
    return { type: 'bad', code: 'BAD ENDING · 배드엔딩', title: '어긋난 선택의 끝', summary: '반복된 실패와 균열을 끝내 되돌리지 못한 채 비극적인 결말을 맞이했습니다.', reachedAt: new Date().toISOString() };
  }
  return null;
}

function normalizeChoiceText(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/(^|\s)'([^'\n]{2,90})'(?=\s|$|[.,!?])/g, '$1"$2"');
  return s.slice(0, 120);
}

function parseStateTag(fullText = '') {
  const match = fullText.match(STATE_TAG_REGEX);
  let stateUpdate = null;
  if (match) {
    const rawJson = match[1];
    try {
      const parsed = JSON.parse(rawJson);
      const rawDelta = Number(parsed.affinityDelta);
      const delta = Number.isFinite(rawDelta) ? Math.max(-8, Math.min(6, Math.round(rawDelta))) : 0;
      const mood = typeof parsed.mood === 'string' && parsed.mood.trim() ? parsed.mood.trim().slice(0, 28) : null;
      const outcomeRaw = String(parsed.outcome || '').toLowerCase();
      const outcome = ['fail', 'setback', 'mixed', 'success'].includes(outcomeRaw) ? outcomeRaw : null;
      const ending = normalizeEnding(parsed.ending);
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
      const choices = Array.isArray(parsed.choices)
        ? parsed.choices.map(normalizeChoiceText).filter(Boolean).slice(0, 3)
        : [];
      stateUpdate = { affinityDelta: delta, mood, outcome, ending, nation, choices };
    } catch {
      const dMatch = rawJson.match(/"affinityDelta"\s*:\s*(-?\d+)/);
      const mMatch = rawJson.match(/"mood"\s*:\s*"([^"]{1,28})"/);
      const oMatch = rawJson.match(/"outcome"\s*:\s*"(fail|setback|mixed|success)"/i);
      const cMatch = rawJson.match(/"choices"\s*:\s*\[([\s\S]*?)\]/);
      const eTitle = rawJson.match(/"ending"\s*:\s*\{[\s\S]*?"title"\s*:\s*"([^"]+)"/);
      const eType = rawJson.match(/"ending"\s*:\s*\{[\s\S]*?"type"\s*:\s*"(true|good|bittersweet|bad)"/i);
      const eSum = rawJson.match(/"ending"\s*:\s*\{[\s\S]*?"summary"\s*:\s*"([^"]+)"/);
      const choices = [];
      if (cMatch) {
        const itemRe = /"((?:\\.|[^"\\])+)"/g;
        let it;
        while ((it = itemRe.exec(cMatch[1])) && choices.length < 3) {
          const txt = normalizeChoiceText(it[1].replace(/\\"/g, '"'));
          if (txt) choices.push(txt);
        }
      }
      const ending = eTitle ? normalizeEnding({ type: eType?.[1] || 'good', title: eTitle[1], summary: eSum?.[1] || '' }) : null;
      if (dMatch || mMatch || oMatch || ending || choices.length) {
        const rawDelta = dMatch ? Number(dMatch[1]) : 0;
        stateUpdate = {
          affinityDelta: Number.isFinite(rawDelta) ? Math.max(-8, Math.min(6, Math.round(rawDelta))) : 0,
          mood: mMatch ? mMatch[1].trim() : null,
          outcome: oMatch ? oMatch[1].toLowerCase() : null,
          ending,
          nation: null,
          choices,
        };
      }
    }
  }
  return {
    cleanText: fullText.replace(STATE_TAG_REGEX, '').replace(/<!--\s*CRACK_STATE[\s\S]*$/i, '').trimEnd(),
    stateUpdate,
  };
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

function buildSystemInstruction({ character, session, persona, triggeredLorebooks, outputLength = 'medium', viewMode = 'novel', isContinue = false, storyArc = null, fateRoll = null }) {
  const ctx = { userName: persona?.name || '나', charName: character.name };
  const lenMap = {
    short: '분량 가이드: 간결하고 호흡 빠르게 2~3문단(약 200~340자)으로 한 장면을 깔끔하게 끊어 쓰세요.',
    medium: '분량 가이드: 실제 한국 상업 웹소설의 밀도 있는 한 장면 분량으로 4~6문단(약 450~820자)으로 작성하세요.',
    long: '분량 가이드: 웹소설 1화 클라이맥스처럼 풍성한 공간감·감정선·대사를 담아 6~9문단(약 850~1450자)으로 작성하세요.',
  };
  const styleMap = {
    novel: `문체 형식 (한국 상업 웹소설 베스트셀러 집필 기준):
- 실제 카카오페이지·문피아 출간 웹소설처럼 작성하세요. 서술 문장에 별표(*)나 마크다운 기울임을 절대 쓰지 마세요.
- 대사는 큰따옴표("...")로, 인물의 속마음은 작은따옴표(‘...’)로만 구분하세요.
- [서술 2줄 → 대사 → 서술 2줄 → 대사] 같은 기계적인 교대 패턴을 깨세요! 짧은 한 문장으로 호흡을 끊기도 하고, 서술 두 문단 뒤에 짧은 대사 한 마디를 던지거나, 대사 사이에 짧은 시선·호흡만 끼워 넣는 등 실제 소설가처럼 완급과 호흡을 자유롭게 조절하세요.
- "기특하다는 듯", "오롯이", "~한 것일까", "고스란히", "묘한 ~이 스쳤다" 같은 AI 번역투·과잉 수식어를 금지하고, 건조하면서도 선명한 감각 묘사(소리·온도·빛·거리·손끝의 움직임)로 장면을 생생하게 그려내세요.`,
    chat: '문체 형식: 몰입감 있는 실시간 대화 스타일. 간결한 행동 묘사(*짧은 동작*)와 살아 있는 구어체 대사를 자연스럽게 섞어 빠른 템포로 이어가세요.',
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
        ? '원작 고증 모드(CANON): 원작 애니메이션의 세계관 법칙·파워 밸런스·말투·비극성과 서사의 무게감을 실제 본편처럼 진지하게 고증하세요.'
        : 'IF 자유 전개 모드(WHAT-IF): 원작의 캐릭터성·규칙·생사의 무게감은 100% 진지하게 유지하되 {{user}}의 치열한 선택과 대가에 따라 정통 평행세계 서사로 깊이 있게 분기하세요.';
    parts.push(
      `\n[애니메이션 원작 설정]\n- 작품: ${character.animeTitle || character.name}${character.powerSystem ? `\n- 고유 시스템: ${character.powerSystem}` : ''}${character.castMembers?.length ? `\n- 주요 등장인물: ${character.castMembers.join(', ')}` : ''}\n- 진행 스타일: ${character.playStyle === 'world' ? '멀티 캐릭터 세계관 RPG 시뮬레이션 (각 인물이 살아 움직이며 화자 구분 및 상태창 업데이트)' : '1:1 캐릭터 몰입 대서사'}\n- 전개 노선: ${renderTemplate(routeGuide, ctx)}`
    );
  }

  if (character.isNationSim) {
    const isCrisis = session.nationMode === 'crisis' || session.nationMode === 'surreal';
    const modeDesc = isCrisis
      ? '⚔️ 전시·격변 하드코어 모드 활성화: 실제 지정학·경제·군사 원리에 기반한 초대형 복합 위기(금융 경색, 국경 무력 도발, 동맹 균열, 내각 갈등, 공급망 봉쇄)가 연쇄적으로 밀려오는 초고난도 정통 정치·전쟁 스릴러로 진행하세요. 절대 개그·밈·초현실 장난 금지!'
      : '🏛️ 정통 국정 시뮬레이션 모드 활성화: 실제 역사·정치·거시경제·외교·군사 인과관계를 냉정하고 치밀하게 반영해 묵직한 정통 국가 경영 대서사를 진행하세요. 절대 개그·밈·초현실 장난 금지!';
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
  const arc = storyArc || computeStoryArc(session);
  const fate = fateRoll || rollFateJudgment({ session, character, storyArc: arc });
  const arcRule = arc.isEndless
    ? `- 현재 진행: 자유 연재 모드 (${arc.turn}턴째). 단, 회복 불가능한 파국(사망·임무 완전 실패·국가 붕괴/탄핵·관계 영구 파탄)에 도달하면 즉시 배드엔딩으로 완결하세요.`
    : arc.isFinalTurn
      ? `- 🚨 [최종화 도달 · ${arc.turn}/${arc.targetTurns}턴 · 반드시 완결 엔딩 집필!] 이번 턴이 이 작품의 마지막 화입니다! 지금까지의 선택·성공과 실패를 총결산해 완결된 클라이맥스와 여운 깊은 에필로그를 집필하고, 반드시 마지막 줄 CRACK_STATE의 "ending" 필드에 결말을 기록하세요! (실패가 많았거나 치명적 오판을 했다면 가차 없이 bad/bittersweet 엔딩!)`
      : arc.isClimax
        ? `- ⚡ [최종 결말 직전 · ${arc.actLabel} · ${arc.turn}/${arc.targetTurns}턴 · 완결까지 ${arc.remainingTurns}턴] 모든 복선과 갈등을 최후의 결전·선택으로 수렴시키세요. 치명적 파국 시 즉시 조기 배드엔딩 가능.`
        : `- 현재 진행: ${arc.actLabel} (${arc.turn}/${arc.targetTurns}턴 · 완결까지 ${arc.remainingTurns}턴 남음). 기승전결 호흡으로 이야기를 실질적으로 전진시키되, 회복 불가능한 치명적 실패 발생 시 즉시 조기 배드엔딩으로 완결하세요.`;

  const userRefGuide =
    ctx.userName === '나'
      ? '유저 주권 및 시점 절대 규칙: 유저의 기본 이름이 "나"로 되어 있더라도 AI가 절대 1인칭("내 목소리", "내 귓가", "나를 바라보는 가운데")으로 시점을 가로채지 마세요! 또한 절대 유저의 대사·연설·명령·행동을 AI가 대신 지어내 쓰지 마세요. 철저히 3인칭 관찰자/캐릭터 시점에서 유저의 실제 입력에 대한 세계와 인물의 반응만 서술하세요.'
      : `유저 주권 및 시점 절대 규칙: 지문에서는 "${ctx.userName}"을(를) 자연스러운 3인칭으로 호칭하고, 대사에서는 캐릭터 성격에 맞는 호칭으로 부르세요. 절대 "${ctx.userName}"의 대사·연설·행동·결정을 AI가 대신 지어내 쓰지 마세요.`;

  parts.push(`\n[공정한 판정 · 실제 실패 허용 규칙 (무조건 성공/아첨 절대 금지!)]
- 당신은 유저 비위를 맞추는 아첨꾼이 아니라 냉정하고 공정한 스토리 심판관입니다.
- 준비 부족·무모한 시도·강적·현실적 반발 앞에서는 가차 없이 실패·좌절·거절·부상·배신·역풍을 겪게 만드세요.
- ${fate.directive}

[스토리 완결 구조 · 기승전결 & 멀티 엔딩]
${arcRule}

[전 작품 공통 최상위 서사 헌장 · 절대 엄수]
1. [진지한 서사 몰입 & 개연성 절대 수호]
   - 이 작품의 세계관·인물·갈등·생사와 운명을 실제 대작 드라마·베스트셀러 연재 웹소설·극장판 본편 수준의 진지함으로 집필합니다.
   - 황당한 병맛 전개, 억지 개그, 인터넷 밈(SNS 밈, 배달앱, 음식/동물/외계인 드립, 유치한 패러디), 메타 발언을 절대 금지합니다.
   - 사용자가 가볍거나 도발적인 입력을 하더라도 장난에 동조해 망가지지 말고, 세계관 내부의 현실적이고 묵직한 반응(당혹, 냉정한 제지, 신뢰 하락, 현실적 파장)으로 작품의 품격을 지키세요.
2. [진심으로 이어지는 연재 스토리 아크 & 인과관계]
   - 매 턴은 긴 서사가 이어지는 다음 화(Episode)입니다. 이전 턴의 사건·약속·상처·비밀·세력 구도·위치와 자세·시간의 흐름을 단 하나도 놓치지 말고 치밀하게 이어받으세요.
   - 주변 인물·적대 세력·정세도 각자의 목적대로 움직이며 매 턴 이야기가 실제로 한 걸음 전진하고 실질적인 대가와 연쇄 결과(Consequences)가 따르게 하세요.
3. ${styleMap[viewMode] || styleMap.novel}
4. ${lenMap[outputLength] || lenMap.medium}
5. ${userRefGuide}
6. [AI 번역투·클리셰 금지] "~한 것일까", "고스란히 담겨 있었다", "묘한 ~이 스쳤다", "기묘한 침묵이 흘렀다", "어때, 감이 좀 와?", "이제 진짜 시작이야!" 같은 상투적 AI 표현을 절대 쓰지 마세요.
7. ${isContinue ? '방금 끊긴 문장과 장면의 숨결을 그대로 이어받아 다음 사건과 대사로 매끄럽게 전개하세요.' : arc.isFinalTurn ? '모든 갈등과 감정의 매듭을 짓고 깊은 여운을 남기는 완결 에필로그로 마무리하세요.' : '상대방의 직전 대사·행동에 냉정하고 입체적으로 반응하며, 마지막 문장은 다음 화의 선택으로 자연스럽게 이어지는 긴장감 있는 장면으로 열어두세요.'}
8. 맨 마지막 줄에만(줄바꿈 1회 후) 숨김 상태 태그 1줄을 덧붙이세요. 본문 안에 JSON·**[다음 선택지]** 번호 목록을 중복으로 쓰지 마세요. "outcome"은 이번 턴 결과("fail"|"setback"|"mixed"|"success"), 엔딩 미도달 시 "ending":null (${arc.isFinalTurn ? '최종화이므로 반드시 "ending":{"type":"true|good|bittersweet|bad","code":"...","title":"...","summary":"..."} 채우기!' : '조기 배드엔딩 도달 시에만 채우기'}), choices에는 진지한 선택지 3개(엔딩 시 []):
${character.isNationSim
  ? '<!--CRACK_STATE:{"affinityDelta":정수(-6~+5),"mood":"현재정국2~12자","outcome":"fail|setback|mixed|success","ending":null,"nation":{"name":"국가명","date":"YYYY년 M월 (N턴)","power":0~100정수,"treasury":"재정요약","approval":0~100정수,"military":0~100정수,"stability":0~100정수},"choices":["결단력 있는 정책·지시 1문장","외교·정치적 승부수 1문장","신중한 정보·실무 파악 1문장"]}-->'
  : '<!--CRACK_STATE:{"affinityDelta":정수(-6~+5),"mood":"현재감정2~12자","outcome":"fail|setback|mixed|success","ending":null,"choices":["정면 돌파 행동·대사 1문장","진지한 심리·감정 대사 1문장","신중한 탐색·전략 행동 1문장"]}-->'}`);

  return parts.join('\n');
}

function buildGeminiContents(messages = [], { maxHistory = 28, continueCue = false, viewMode = 'novel' } = {}) {
  const merged = [];
  for (const m of messages.slice(-maxHistory)) {
    const role = m.role === 'user' ? 'user' : 'model';
    let text = String(m.content || '').trim();
    if (!text) continue;
    if (viewMode === 'novel' && role === 'model') {
      text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
    }
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
  for (const url of ['./data/catalog.json', `./data/catalog.json?v=${Date.now()}`]) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok) {
        catalogCache = await res.json();
        return catalogCache;
      }
    } catch {
      // retry next
    }
  }
  throw new Error('카탈로그 데이터를 불러올 수 없습니다. 페이지를 새로고침해 주세요.');
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
  const stored = readLS('config', {});
  const merged = { ...DEFAULT_CONFIG, ...stored };
  if ((stored.configVersion || 1) < 2) {
    if (merged.defaultModel === 'gemini-3.8-flash' && (merged.defaultMode || 'story') === 'story') {
      merged.defaultModel = 'gemini-3.5-flash-lite';
    }
    merged.configVersion = 2;
    if (Object.keys(stored).length > 0) {
      try { writeLS('config', merged); } catch { /* ignore */ }
    }
  }
  return merged;
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

  // Only route via Netlify Function if user has NO personal key and server env key exists.
  // When user provides their own key, connect directly to Google Gemini API (0.8s faster, 0 serverless cost, zero proxy timeout!).
  if (!userKey && cloudInfo.hasNetlifyFunction && cloudInfo.hasServerKey) {
    const res = await fetch('/api/cloud/gemini/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, systemInstruction, prompt, maxOutputTokens, jsonMode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `AI 생성 실패 (HTTP ${res.status})`);
    return data;
  }

  if (!userKey) throw new Error('Google Gemini API 키가 설정되지 않았습니다.');

  // Direct CORS call to Google Gemini API (works on GitHub Pages / Netlify / static hosting with 8.5s fast failover!)
  let chain = buildFallbackChain(model);
  let discovered = false;
  let lastErr = 'Gemini API 호출 실패';
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const generationConfig = { maxOutputTokens };
    if (jsonMode) generationConfig.responseMimeType = 'application/json';
    const isLite = /lite/i.test(candidate);
    if (isGemini3Model(candidate)) {
      if (!isLite) generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
    } else {
      generationConfig.temperature = 0.85;
    }

    const attemptCtrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptCtrl.abort();
    }, i < chain.length - 1 ? 8500 : 22000);

    let res;
    try {
      res = await fetch(`${API_BASE}/models/${encodeURIComponent(candidate)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': userKey },
        body: JSON.stringify({
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
        }),
        signal: attemptCtrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = timedOut ? `[${candidate}] 응답 지연` : `네트워크 오류 (${candidate}): ${err.message}`;
      if (i < chain.length - 1) continue;
      throw new Error(lastErr);
    }
    clearTimeout(timer);

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
    const outText = extractTextFromCandidate(data).trim();
    if (!outText && i < chain.length - 1) {
      lastErr = `[${candidate}] 빈 응답`;
      continue;
    }
    return { text: outText, modelUsed: candidate };
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

  // Only route via Netlify Function if user has NO personal key and server env key exists.
  // When user has their own API key, stream directly from Google Gemini API via CORS (faster, zero Netlify quota/timeouts!).
  if (!userKey && cloudInfo.hasNetlifyFunction && cloudInfo.hasServerKey) {
    const res = await fetch('/api/cloud/gemini/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  // Direct CORS SSE stream to Google Gemini API (GitHub Pages / Static Hosting — zero backend cost + 8.5s fast failover!)
  let chain = buildFallbackChain(model);
  let discovered = false;
  let lastErr = 'Gemini 스트리밍 실패';
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const generationConfig = { maxOutputTokens };
    const isLite = /lite/i.test(candidate);
    if (isGemini3Model(candidate)) {
      if (!isLite && thinkingLevel && ['LOW', 'MEDIUM', 'HIGH'].includes(thinkingLevel)) {
        generationConfig.thinkingConfig = { thinkingLevel };
      }
    } else {
      generationConfig.temperature = 0.85;
    }

    const attemptCtrl = new AbortController();
    let timedOut = false;
    const onUserAbort = () => attemptCtrl.abort();
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onUserAbort, { once: true });
    }
    const headerTimer = setTimeout(() => {
      timedOut = true;
      attemptCtrl.abort();
    }, i < chain.length - 1 ? 8500 : 25000);

    let res;
    try {
      res = await fetch(`${API_BASE}/models/${encodeURIComponent(candidate)}:streamGenerateContent?alt=sse`, {
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
        signal: attemptCtrl.signal,
      });
    } catch (err) {
      clearTimeout(headerTimer);
      if (signal) signal.removeEventListener('abort', onUserAbort);
      if (signal?.aborted) throw err;
      lastErr = timedOut
        ? `[${candidate}] 응답 지연으로 자동 우회 중`
        : `네트워크 연결 실패 (${candidate}): ${err.message}`;
      if (i < chain.length - 1) continue;
      throw new Error(lastErr);
    }
    clearTimeout(headerTimer);

    if (!res.ok) {
      if (signal) signal.removeEventListener('abort', onUserAbort);
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

    let cleanText = '';
    let stateUpdate = null;
    try {
      const parsed = await consumeGeminiSseResponse(res, onDelta);
      cleanText = parsed.cleanText;
      stateUpdate = parsed.stateUpdate;
    } finally {
      if (signal) signal.removeEventListener('abort', onUserAbort);
    }
    if (!cleanText && i < chain.length - 1) {
      lastErr = `[${candidate}] 빈 응답 수신`;
      continue;
    }
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
  const loreHint = triggeredLorebooks.length ? `\n\n그 순간 '${triggeredLorebooks[0].title}'에 얽힌 기억이 스치며 공기가 달라졌다.` : '';
  const fullText = character.isNationSim
    ? `비서실장이 긴급 보고서를 전략 탁자 위에 펼쳐 놓으며 숨을 골랐다. 집무실의 각 부처 장관들이 일제히 시선을 집중했다.\n\n"각하, 방금 하달하신 지시(${quoted || '국정 개혁 명령'})가 전국과 각국 대사관에 즉시 전파되었습니다."${loreHint}\n\n**[ 긴급 속보 · 국제 뉴스 ]**\n- [속보] ${userName} 지도자, 전격 국정 드라이브 선언… 증시·여론 즉각 반응\n- [국제] 주변 열강 외무부 "향후 행보 예의주시" 긴급 논평 발표\n\n**[ 국가 상태창 · 대한민국 ]**\n- 시점: 2026년 2월 (1턴) · 지도자: ${userName}\n- 국력: 74/100 · 재정: 645조 원 · 지지율: 61% (+3%) · 군사력: 82/100 · 안정도: 71/100\n- 긴급 현안: 야당의 긴급 대정부 질문 대응 및 주변국 무역 협상`
    : character.isAnime && character.playStyle === 'world'
    ? `「${character.animeTitle || charName}」 세계의 공기가 팽팽하게 당겨졌다. ${character.castMembers?.[0] || charName}이(가) 고개를 돌려 시선을 맞췄다.\n\n${character.castMembers?.[0] || charName}: "${quoted ? `${quoted}… 좋아, 각오는 확실히 전해졌어.` : `자, 여기서부터 움직여 볼까.`}"${loreHint}\n\n**[ ${character.animeTitle || '애니 월드'} 진행 상태창 ]**\n- 고유 시스템(${character.powerSystem || '능력'}) 활성화 · 호감도 +2`
    : `${charName}의 시선이 천천히 멈췄다. 정적 속에 팽팽한 긴장감이 감돌았다.\n\n"${quoted ? `방금 한 말… 진심인가.` : `그렇게 말없이 쳐다보면 곤란한데.`}"\n\n${charName}이(가) 반 걸음 가까이 다가섰다.${loreHint}\n\n"좋아. 네가 선택한 그 결말, 끝까지 지켜봐 주지."`;

  const chars = [...fullText];
  for (let i = 0; i < chars.length; i += 4) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onDelta(chars.slice(i, i + 4).join(''));
    await new Promise((r) => setTimeout(r, 16));
  }
  const demoChoices = character.isNationSim
    ? [
        '긴급 국무회의를 소집해 경제 부양책을 즉시 발표한다.',
        '주변국 대사들을 불러 직접 외교 담판을 짓는다.',
        '비서실장에게 야당과 여론의 핵심 불만부터 보고받는다.',
      ]
    : [
        '"좋아, 지금 바로 정면으로 돌파해 보자."',
        `${charName}의 눈을 똑바로 마주 보며 한 걸음 다가선다.`,
        '"잠깐, 숨기고 있는 조건이 하나 더 있지 않아?"',
      ];
  return {
    text: fullText,
    stateUpdate: character.isNationSim
      ? {
          affinityDelta: 3,
          mood: '국정 개혁 드라이브',
          nation: { name: '대한민국', date: '2026년 2월 (1턴)', power: 74, treasury: '645조 원', approval: 61, military: 82, stability: 71 },
          choices: demoChoices,
        }
      : { affinityDelta: 2, mood: '흥미와 떨림', choices: demoChoices },
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
      theme: cfg.theme === 'light' ? 'light' : 'dark',
      viewMode: cfg.viewMode,
      fontFamily: cfg.fontFamily,
      fontSize: cfg.fontSize || 'md',
      backdropMode: cfg.backdropMode || 'dim',
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
    const cleanedInput = sanitizeApiKey(apiKey || '');
    const keyToTest = cleanedInput || getEffectiveClientKey();
    let result;

    if (!keyToTest && cloudInfo.hasNetlifyFunction && cloudInfo.hasServerKey) {
      const res = await fetch('/api/cloud/gemini/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '' }),
      });
      result = await res.json().catch(() => ({ ok: false, error: '인증 응답 오류' }));
      if (!res.ok) throw new Error(result.error || 'API 키 인증 실패');
    } else {
      if (!keyToTest) throw new Error('Google Gemini API 키를 입력해 주세요. (Google AI Studio의 AIza... 키)');
      const res = await fetch(`${API_BASE}/models?pageSize=100`, {
        headers: { 'x-goog-api-key': keyToTest },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.error?.message || `API 키 인증 실패 (HTTP ${res.status})`;
        if (isInvalidKeyError(res.status, msg)) {
          throw new Error('유효하지 않은 API 키입니다. aistudio.google.com/apikey 에서 발급한 AIza... 키를 정확히 복사해 주세요.');
        }
        throw new Error(msg);
      }
      const data = await res.json();
      const models = (data.models || [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((id) => /gemini/i.test(id));
      const recommendedModel = FALLBACK_MODELS.find((id) => models.includes(id)) || models[0] || 'gemini-3.5-flash-lite';
      result = { ok: true, models, recommendedModel };
    }

    const patch = {
      lastVerifiedModel: result.recommendedModel,
      lastVerifiedAt: new Date().toISOString(),
    };
    if (save && cleanedInput) patch.geminiApiKey = cleanedInput;
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
        const turnCount = Array.isArray(s.messages) ? s.messages.filter((m) => m.role === 'user').length : 0;
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
          storyLength: s.storyLength || 'standard',
          targetTurns: typeof s.targetTurns === 'number' ? s.targetTurns : 14,
          difficulty: s.difficulty || 'real',
          turnCount,
          ending: s.ending || null,
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
      storyLength: 'standard',
      targetTurns: 14,
      difficulty: 'real',
      ending: null,
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
    if (patch.storyLength && STORY_LENGTH_TURNS[patch.storyLength] !== undefined) {
      next.targetTurns = STORY_LENGTH_TURNS[patch.storyLength];
    }
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

  async clearAllSessions() {
    saveSessionsRaw([]);
    return { cleared: true, sessions: [] };
  },

  async resetSession(id) {
    const sessions = getSessionsRaw();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('세션을 찾을 수 없습니다.');
    const curr = sessions[idx];
    const chars = await listCharactersCloud();
    const char = chars.find((c) => c.id === curr.characterId);
    if (!char) throw new Error('캐릭터를 찾을 수 없습니다.');
    const personas = listPersonasLocal();
    const persona = personas.find((p) => p.id === curr.personaId) || personas[0];
    const now = new Date().toISOString();
    const opening = renderTemplate(
      char.openingMessage || `*${char.name}이(가) {{user}}를 바라보았다.*`,
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
        { id: makeId('msg'), role: 'model', content: opening, versions: [opening], activeVersion: 0, isOpening: true, createdAt: now, meta: { model: 'opening', triggeredLorebooks: [] } },
      ],
      updatedAt: now,
    };
    sessions[idx] = reset;
    saveSessionsRaw(sessions);
    return { session: reset, character: char, persona };
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
    return this.updateSession(sessionId, { ending: null, messages: session.messages.slice(0, idx + 1) });
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
    const modeDefaultModel =
      mode === 'deep'
        ? 'gemini-3-flash-preview'
        : mode === 'pro'
          ? 'gemini-3.8-flash'
          : 'gemini-3.5-flash-lite';
    const model = payload.model || modeDefaultModel || cfg.defaultModel;
    const thinkingLevel = mode === 'deep' || mode === 'pro' ? 'LOW' : null;
    const maxOutputTokens = mode === 'pro' ? 2600 : mode === 'deep' ? 2200 : mode === 'speed' ? 1100 : 1800;

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
    const storyArc = computeStoryArc({ ...session, messages: historyForPrompt });
    const fateRoll = rollFateJudgment({ session, character, difficulty: session.difficulty || 'real', storyArc });
    const systemInstruction = buildSystemInstruction({
      character,
      session,
      persona,
      triggeredLorebooks: triggered,
      outputLength: payload.outputLength || cfg.outputLength || 'medium',
      viewMode: payload.viewMode || cfg.viewMode || 'novel',
      isContinue: action === 'continue',
      storyArc,
      fateRoll,
    });
    const contents = buildGeminiContents(historyForPrompt, {
      continueCue: action === 'continue',
      viewMode: payload.viewMode || cfg.viewMode || 'novel',
    });

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
      const resolvedOutcome = result.stateUpdate?.outcome || fateRoll.outcome;
      const nextNationState = result.stateUpdate?.nation
        ? {
            ...(session.nationState || {}),
            ...Object.fromEntries(Object.entries(result.stateUpdate.nation).filter(([, v]) => v !== undefined)),
          }
        : session.nationState;
      const resolvedEnding = resolveSessionEnding({
        character,
        nextAffinity: nextAff,
        nextNationState,
        storyArc,
        aiEnding: result.stateUpdate?.ending || null,
        prevEnding: action === 'regenerate' ? null : session.ending,
      });

      const meta = {
        model: result.modelUsed,
        fallbackFrom: result.fallbackFrom,
        isDemo: Boolean(result.isDemo),
        triggeredLorebooks: triggered.map((l) => l.title),
        affinityDelta: result.stateUpdate?.affinityDelta || 0,
        mood: nextMood,
        outcome: resolvedOutcome,
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

      const nextSuggestions = resolvedEnding
        ? []
        : Array.isArray(result.stateUpdate?.choices) && result.stateUpdate.choices.length > 0
          ? result.stateUpdate.choices
          : session.suggestedReplies;

      const { session: updated } = await this.updateSession(sessionId, {
        affinity: nextAff,
        mood: nextMood,
        nationState: nextNationState,
        ending: resolvedEnding,
        suggestedReplies: nextSuggestions,
        messages: msgs,
      });

      if (onDone) {
        onDone({
          message: savedMessage,
          outcome: resolvedOutcome,
          ending: updated.ending || null,
          storyArc: computeStoryArc(updated),
          suggestedReplies: updated.ending
            ? []
            : Array.isArray(result.stateUpdate?.choices) && result.stateUpdate.choices.length > 0
              ? result.stateUpdate.choices
              : [],
          sessionState: {
            affinity: updated.affinity,
            mood: updated.mood,
            relationshipStage: updated.relationshipStage,
            nationState: updated.nationState,
            ending: updated.ending || null,
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
      systemInstruction: '당신은 한국 정통 웹소설 인터랙티브 스토리(CRACK)의 추천 선택지 작가입니다. 진지하고 몰입감 있는 선택지 JSON 문자열 배열(["...", "...", "..."])만 반환하세요.',
      prompt: `작품 "${character.name}"(${character.genreLabel})의 최근 전개:\n\n${transcript}\n\n방금 끝난 장면의 진지한 분위기와 인과관계를 그대로 이어받아, 주인공(${persona.name})이 다음 화에서 선택할 만한 묵직하고 설득력 있는 선택지 3개(1: 정면 돌파·결단 / 2: 심리·외교·감정 압박 / 3: 신중·정보 탐색)를 작성하세요. 장난·개그·밈 드립은 절대 금지합니다. 자연스러운 한국어 1문장(15~55자) JSON 배열만 반환하세요.`,
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

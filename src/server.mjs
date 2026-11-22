import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WEB_DIR,
  getEffectiveApiKey,
  getPort,
  getPublicConfig,
  readConfig,
  writeConfig,
} from './config.mjs';
import { ANIME_CATEGORIES, GENRES, renderTemplate } from './presets.mjs';
import {
  clearAllSessions,
  createSession,
  deleteCharacter,
  deletePersona,
  deleteSession,
  getCharacter,
  getPersona,
  getSession,
  listCharacters,
  listPersonas,
  listSessions,
  makeId,
  resetSession,
  resolveUploadFile,
  saveCharacter,
  savePersona,
  saveUploadedImage,
  toggleFavorite,
  toggleLike,
  updateSession,
} from './store.mjs';
import {
  STORY_LENGTH_TURNS,
  buildGeminiContents,
  buildSystemInstruction,
  computeStoryArc,
  findTriggeredLorebooks,
  relationshipStageForAffinity,
  resolveSessionEnding,
  rollFateJudgment,
} from './promptBuilder.mjs';
import {
  generateStructuredText,
  listAvailableModels,
  streamChatCompletion,
  streamDemoResponse,
} from './gemini.mjs';
import { generateQrSvg } from './qr.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message || '요청 처리 중 오류가 발생했습니다.' });
}

function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('요청 크기가 허용 한도를 초과했습니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('올바른 JSON 형식이 아닙니다.'));
      }
    });
    req.on('error', reject);
  });
}

function getNetworkInfo(port) {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        ips.push(entry.address);
      }
    }
  }
  const primaryIp = ips[0] || '127.0.0.1';
  const hostname = os.hostname();
  const localUrl = `http://127.0.0.1:${port}`;
  const lanUrl = `http://${primaryIp}:${port}`;
  const bonjourUrl = hostname ? `http://${hostname.endsWith('.local') ? hostname : `${hostname}.local`}:${port}` : lanUrl;
  return {
    port,
    localUrl,
    lanUrl,
    bonjourUrl,
    ips,
    qrSvg: generateQrSvg(lanUrl),
  };
}

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isImage = contentType.startsWith('image/');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': isImage ? 'public, max-age=86400' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseJsonLoose(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

async function handleChatStream(req, res, sessionId) {
  const body = await readJsonBody(req);
  const session = getSession(sessionId);
  if (!session) return sendError(res, 404, '채팅 세션을 찾을 수 없습니다.');

  const character = getCharacter(session.characterId);
  if (!character) return sendError(res, 404, '캐릭터를 찾을 수 없습니다.');

  const cfg = readConfig();
  const persona = getPersona(session.personaId || cfg.activePersonaId);
  const action = body.action || 'send'; // 'send' | 'regenerate' | 'continue'
  const mode = body.mode || cfg.defaultMode || 'story';
  const modeDefaultModel =
    mode === 'deep'
      ? 'gemini-3-flash-preview'
      : mode === 'pro'
        ? 'gemini-3.8-flash'
        : 'gemini-3.5-flash-lite';
  const requestedModel = body.model || modeDefaultModel || cfg.defaultModel;
  const outputLength = body.outputLength || cfg.outputLength || 'medium';
  const viewMode = body.viewMode || cfg.viewMode || 'novel';

  let workingSession = session;
  let userTextForContext = '';

  if (action === 'send') {
    const text = String(body.text || '').trim();
    if (!text) return sendError(res, 400, '메시지를 입력해 주세요.');
    userTextForContext = text;
    const userMsg = {
      id: makeId('msg'),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    workingSession = updateSession(sessionId, (curr) => ({
      ...curr,
      messages: [...curr.messages, userMsg],
    }));
  } else if (action === 'regenerate') {
    const lastMsg = workingSession.messages[workingSession.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'model') {
      return sendError(res, 400, '재생성할 캐릭터 메시지가 없습니다.');
    }
    const prevUser = [...workingSession.messages].reverse().find((m) => m.role === 'user');
    userTextForContext = prevUser?.content || '';
  } else if (action === 'continue') {
    userTextForContext = '';
  }

  // Messages used for prompt context (exclude last model msg if regenerating)
  const historyForPrompt =
    action === 'regenerate'
      ? workingSession.messages.slice(0, -1)
      : workingSession.messages;

  // Combine character lorebook + session lorebook
  const combinedLorebook = Array.isArray(workingSession.lorebook)
    ? workingSession.lorebook
    : (character.lorebook || []);

  const triggeredLorebooks = findTriggeredLorebooks(
    combinedLorebook,
    historyForPrompt,
    userTextForContext
  );

  const storyArc = computeStoryArc({ ...workingSession, messages: historyForPrompt });
  const fateRoll = rollFateJudgment({
    session: workingSession,
    character,
    difficulty: workingSession.difficulty || 'real',
    storyArc,
  });

  const systemInstruction = buildSystemInstruction({
    character,
    session: workingSession,
    persona,
    triggeredLorebooks,
    outputLength,
    viewMode,
    isContinue: action === 'continue',
    storyArc,
    fateRoll,
  });

  const contents = buildGeminiContents(historyForPrompt, {
    continueCue: action === 'continue',
    viewMode,
  });

  // Start SSE stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const abortController = new AbortController();
  // IMPORTANT: In Node 18+/22+/26, listen to `res.on('close')`, NOT `req.on('close')` (which fires as soon as POST body ends!).
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  const apiKey = getEffectiveApiKey();
  writeSse(res, 'start', {
    action,
    triggeredLorebooks: triggeredLorebooks.map((l) => ({ id: l.id, title: l.title, keyword: l.matchedKeyword })),
    isDemo: !apiKey,
  });

  try {
    const result = apiKey
      ? await streamChatCompletion({
          apiKey,
          model: requestedModel,
          mode,
          systemInstruction,
          contents,
          onDelta: (delta) => writeSse(res, 'delta', { text: delta }),
          signal: abortController.signal,
        })
      : await streamDemoResponse({
          character,
          persona,
          userMessage: userTextForContext,
          triggeredLorebooks,
          onDelta: (delta) => writeSse(res, 'delta', { text: delta }),
          signal: abortController.signal,
        });

    const finalText = result.text || '*(잠시 말이 끊어졌다.)*';
    const nextAffinity = Math.max(
      0,
      Math.min(100, (workingSession.affinity ?? 35) + (result.stateUpdate?.affinityDelta || 0))
    );
    const nextMood = result.stateUpdate?.mood || workingSession.mood;
    const nextStage = relationshipStageForAffinity(nextAffinity, character.relationshipStage);
    const resolvedOutcome = result.stateUpdate?.outcome || fateRoll.outcome;

    let savedMessage = null;
    const updatedSession = updateSession(sessionId, (curr) => {
      const nextMessages = [...curr.messages];
      const nextNationState = result.stateUpdate?.nation
        ? {
            ...(curr.nationState || {}),
            ...Object.fromEntries(Object.entries(result.stateUpdate.nation).filter(([, v]) => v !== undefined)),
          }
        : curr.nationState;

      const resolvedEnding = resolveSessionEnding({
        character,
        nextAffinity,
        nextNationState,
        storyArc,
        aiEnding: result.stateUpdate?.ending || null,
        prevEnding: action === 'regenerate' ? null : curr.ending,
      });

      const meta = {
        model: result.modelUsed,
        fallbackFrom: result.fallbackFrom || null,
        isDemo: Boolean(result.isDemo),
        triggeredLorebooks: triggeredLorebooks.map((l) => l.title),
        affinityDelta: result.stateUpdate?.affinityDelta || 0,
        mood: nextMood,
        outcome: resolvedOutcome,
      };

      if (action === 'regenerate' && nextMessages.length > 0 && nextMessages[nextMessages.length - 1].role === 'model') {
        const target = { ...nextMessages[nextMessages.length - 1] };
        const versions = Array.isArray(target.versions) && target.versions.length > 0
          ? [...target.versions]
          : [target.content];
        versions.push(finalText);
        target.versions = versions;
        target.activeVersion = versions.length - 1;
        target.content = finalText;
        target.meta = meta;
        nextMessages[nextMessages.length - 1] = target;
        savedMessage = target;
      } else {
        savedMessage = {
          id: makeId('msg'),
          role: 'model',
          content: finalText,
          versions: [finalText],
          activeVersion: 0,
          createdAt: new Date().toISOString(),
          meta,
        };
        nextMessages.push(savedMessage);
      }

      const nextSuggestions = resolvedEnding
        ? []
        : Array.isArray(result.stateUpdate?.choices) && result.stateUpdate.choices.length > 0
          ? result.stateUpdate.choices
          : curr.suggestedReplies;

      return {
        ...curr,
        affinity: nextAffinity,
        mood: nextMood,
        relationshipStage: nextStage,
        nationState: nextNationState,
        ending: resolvedEnding,
        suggestedReplies: nextSuggestions,
        messages: nextMessages,
      };
    });

    const finalArc = computeStoryArc(updatedSession);
    writeSse(res, 'done', {
      message: savedMessage,
      outcome: resolvedOutcome,
      ending: updatedSession.ending || null,
      storyArc: finalArc,
      suggestedReplies: updatedSession.ending
        ? []
        : Array.isArray(result.stateUpdate?.choices) && result.stateUpdate.choices.length > 0
          ? result.stateUpdate.choices
          : [],
      sessionState: {
        affinity: updatedSession.affinity,
        mood: updatedSession.mood,
        relationshipStage: updatedSession.relationshipStage,
        nationState: updatedSession.nationState,
        ending: updatedSession.ending || null,
        messageCount: updatedSession.messages.length,
      },
      modelUsed: result.modelUsed,
      fallbackFrom: result.fallbackFrom,
      isDemo: result.isDemo,
    });
    res.end();
  } catch (err) {
    if (err?.name !== 'AbortError') {
      writeSse(res, 'error', {
        message: err?.message || 'AI 응답 생성 중 오류가 발생했습니다.',
        code: err?.code || '',
      });
    }
    res.end();
  }
}

async function handleGenerateSuggestions(res, sessionId) {
  const session = getSession(sessionId);
  if (!session) return sendError(res, 404, '세션을 찾을 수 없습니다.');
  const character = getCharacter(session.characterId);
  const persona = getPersona(session.personaId);
  const apiKey = getEffectiveApiKey();

  if (!apiKey) {
    const fallback = [
      `"잠깐, 지금 한 말 진심이야?" *${character?.name || '상대'}의 눈을 똑바로 바라본다.*`,
      `*잠시 침묵하다가 한 걸음 가까이 다가선다.* "네가 숨기는 게 뭔지 전부 말해줘."`,
      `*살짝 미소 지으며 분위기를 바꾼다.* "좋아, 그럼 이번엔 내 방식대로 해볼게."`,
    ];
    updateSession(sessionId, { suggestedReplies: fallback });
    return sendJson(res, 200, { suggestions: fallback, modelUsed: 'demo-preview' });
  }

  const recentTranscript = session.messages
    .slice(-8)
    .map((m) => `${m.role === 'user' ? persona.name : character.name}: ${m.content}`)
    .join('\n\n');

  const prompt = `다음은 작품 "${character.name}"(${character.genreLabel})의 최근 전개입니다.\n\n${recentTranscript}\n\n방금 끝난 장면의 진지한 분위기와 인과관계를 그대로 이어받아, 주인공(${persona.name})이 다음 화에서 선택할 만한 묵직하고 설득력 있는 추천 선택지 3개를 작성하세요.\n- 1번: 정면 돌파·결단형\n- 2번: 심리·감정·외교 압박형\n- 3번: 신중·정보 탐색·전략 우회형\n장난·개그·밈·황당한 드립은 절대 금지합니다. 각 선택지는 자연스러운 한국어 1문장(15~55자)으로 작성하고, 반드시 JSON 배열(["...", "...", "..."])만 출력하세요.`;

  try {
    const out = await generateStructuredText({
      apiKey,
      preferredModel: 'gemini-3.5-flash-lite',
      systemInstruction: '당신은 한국 웹소설 인터랙티브 채팅(CRACK)의 추천 선택지 작가입니다. JSON 문자열 배열만 반환하세요.',
      prompt,
      maxOutputTokens: 500,
      jsonMode: true,
    });
    const arr = parseJsonLoose(out.text);
    const suggestions = Array.isArray(arr)
      ? arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
      : [];
    if (suggestions.length > 0) {
      updateSession(sessionId, { suggestedReplies: suggestions });
    }
    return sendJson(res, 200, { suggestions, modelUsed: out.modelUsed });
  } catch (err) {
    return sendError(res, 502, `추천 답변 생성 실패: ${err.message}`);
  }
}

async function handleSummarizeSession(res, sessionId) {
  const session = getSession(sessionId);
  if (!session) return sendError(res, 404, '세션을 찾을 수 없습니다.');
  const character = getCharacter(session.characterId);
  const persona = getPersona(session.personaId);
  const apiKey = getEffectiveApiKey();

  if (!apiKey) {
    const summary = `[미리보기 자동 요약] ${persona.name}와(과) ${character?.name || '캐릭터'}은(는) 현재 '${session.relationshipStage}' 단계이며, 감정 상태는 '${session.mood}'(호감도 ${session.affinity})입니다. (Google Gemini API 키를 연결하면 전체 대화 맥락을 AI가 정밀하게 요약합니다.)`;
    updateSession(sessionId, { summaryMemory: summary });
    return sendJson(res, 200, { summaryMemory: summary, modelUsed: 'demo-preview' });
  }

  const transcript = session.messages
    .slice(-30)
    .map((m) => `${m.role === 'user' ? persona.name : character.name}: ${m.content}`)
    .join('\n\n');

  const prompt = `기존 요약 메모리:\n${session.summaryMemory || '(없음)'}\n\n최근 대화 내용:\n${transcript}\n\n위 내용을 바탕으로 앞으로의 스토리 전개에서 AI가 절대 잊지 말아야 할 핵심 사실(사건, 약속, 비밀, 감정 변화, 현재 장소/시간)을 한국어 불릿 포인트 4~6줄(400자 이내)로 간결하게 정리하세요.`;

  try {
    const out = await generateStructuredText({
      apiKey,
      preferredModel: 'gemini-3.5-flash-lite',
      systemInstruction: '당신은 AI 스토리 채팅의 장기 기억(요약 메모리) 편집자입니다. 간결하고 사실적으로 핵심만 요약하세요.',
      prompt,
      maxOutputTokens: 600,
    });
    const summaryMemory = out.text.trim();
    updateSession(sessionId, { summaryMemory });
    return sendJson(res, 200, { summaryMemory, modelUsed: out.modelUsed });
  } catch (err) {
    return sendError(res, 502, `요약 메모리 생성 실패: ${err.message}`);
  }
}

function pickAnimePoster(text = '', category = 'shonen') {
  const hay = `${text} ${category}`.toLowerCase();
  if (/검|칼|사무라이|귀멸|은혼|무협|약사|에도/.test(hay)) return '/assets/anime/anime_katana.jpg';
  if (/해적|바다|항해|원피스|포켓몬|모험/.test(hay)) return '/assets/anime/anime_pirate.jpg';
  if (/닌자|나루토|헌터|암살|마을/.test(hay)) return '/assets/anime/anime_shinobi.jpg';
  if (/사신|영혼|블리치|요괴|달/.test(hay)) return '/assets/anime/anime_soul.svg';
  if (/거인|성벽|연금술|강철|전쟁|진격/.test(hay)) return '/assets/anime/anime_titan.svg';
  if (/아이돌|밴드|노래|봇치|최애|러브|카구야|학교|청춘/.test(hay)) return '/assets/anime/anime_idol.jpg';
  if (/축구|농구|배구|스포츠|블루록|하이큐|슬램덩크/.test(hay)) return '/assets/anime/anime_sports.svg';
  if (/스파이|탐정|코난|사카모토|추리/.test(hay)) return '/assets/anime/anime_spy.svg';
  if (/가상|게임|소아온|이세계|vr|아인크라드/.test(hay)) return '/assets/anime/anime_vrmmo.svg';
  if (/로봇|메카|에바|기아스|건담|슈타인즈|타임/.test(hay)) return '/assets/anime/anime_mecha.svg';
  if (/사이버|네온|엣지|미래|해커/.test(hay)) return '/assets/anime/anime_edgerunner.svg';
  if (/데스노트|구울|체인소|누아르|호러|공포|살인/.test(hay)) return '/assets/anime/anime_noir.svg';
  if (/던전|레벨업|마왕|오버로드|헌터물|게이트/.test(hay)) return '/assets/anime/anime_dungeon.svg';
  if (/프리렌|마법|엘프|리제로|바이올렛|판타지/.test(hay)) return '/assets/anime/anime_frieren.svg';
  if (/드래곤볼|히어로|원펀맨|초능력|배틀/.test(hay)) return '/assets/anime/anime_aura.jpg';
  if (category === 'fantasy_isekai') return '/assets/anime/anime_frieren.svg';
  if (category === 'thriller_sf') return '/assets/anime/anime_noir.svg';
  if (category === 'slice_sports') return '/assets/anime/anime_idol.jpg';
  return '/assets/anime/anime_sorcery.jpg';
}

async function handleSummonAnime(req, res) {
  const body = await readJsonBody(req);
  const animeTitle = String(body.animeTitle || '').trim();
  const targetCharacter = String(body.targetCharacter || '').trim();
  const playStyle = body.playStyle === 'world' ? 'world' : 'character';
  const animeCategory = String(body.animeCategory || 'shonen');
  const extraPrompt = String(body.extraPrompt || '').trim();

  if (!animeTitle) {
    return sendError(res, 400, '소환할 애니메이션 작품명을 입력해 주세요. (예: 주술회전, 베르세르크, 강철의 연금술사)');
  }

  const avatar = pickAnimePoster(`${animeTitle} ${targetCharacter} ${extraPrompt}`, animeCategory);
  const apiKey = getEffectiveApiKey();
  const cfg = readConfig();
  const persona = getPersona(cfg.activePersonaId);

  let charPayload;
  let isDemo = !apiKey;
  let modelUsed = 'demo-preview';

  if (!apiKey) {
    const charName =
      playStyle === 'world'
        ? `${animeTitle} · 세계관 시뮬`
        : (targetCharacter || `${animeTitle} 대표 캐릭터`);
    charPayload = {
      isAnime: true,
      animeTitle,
      animeCategory,
      playStyle,
      powerSystem: `${animeTitle} 원작 고유 능력·세계관 시스템`,
      castMembers: targetCharacter ? [targetCharacter] : [animeTitle],
      name: charName,
      title: `[${animeTitle}] ${targetCharacter ? `${targetCharacter}와(과) 시작하는 이야기` : '원작 세계관 인터랙티브 시뮬레이션'}`,
      subtitle: `“${animeTitle}의 세계에 발을 들인 순간, 새로운 이야기가 시작된다.”`,
      genre: 'anime',
      tags: [`#${animeTitle.replace(/\s+/g, '')}`, playStyle === 'world' ? '#세계관시뮬' : '#1대1캐릭터챗', '#애니소환', '#IF전개'],
      creator: 'ANIME SUMMON',
      avatar,
      initialAffinity: 45,
      initialMood: '운명적인 조우',
      relationshipStage: `${animeTitle} · 제1화 시작`,
      worldSummary: `애니메이션 「${animeTitle}」의 세계관으로 들어온 {{user}}. ${targetCharacter ? `${targetCharacter}을(를) 비롯한 원작 인물들과` : '원작 등장인물들과'} 함께 원작 고증 또는 IF 자유 전개로 이야기를 써 내려간다.${extraPrompt ? ` (${extraPrompt})` : ''}`,
      personaPrompt: `원작 애니메이션: ${animeTitle}\n역할: ${playStyle === 'world' ? '세계관 전체 멀티 캐릭터 GM' : charName}\n추가 설정: ${extraPrompt || '원작의 성격·말투·세계관 법칙을 충실히 고증하며 몰입감 넘치는 전개 구현.'}`,
      openingMessage: `*애니메이션 「${animeTitle}」의 상징적인 무대. 낯설지만 선명한 공기가 {{user}}를 감싸며, 원작 속 가장 강렬한 장면의 막이 올랐다.*\n\n${playStyle === 'world' ? `${targetCharacter || '원작의 주인공'}: "어이, 거기 너 {{user}}! 이 세계에 온 지 얼마 안 된 것 같은데... 지금 당장 움직여야 해!"` : `*${charName}이(가) 천천히 고개를 들어 {{user}}를 바라보았다.*\n\n"드디어 만났네, {{user}}. 여기서부터 어떤 선택을 할지, 네가 직접 보여줘."`}\n\n**[ ${animeTitle} 상태창 · {{user}} ]**\n- 모드: ${playStyle === 'world' ? '멀티 캐릭터 세계관 RPG' : '1:1 캐릭터 챗'} · 노선: IF 자유 전개 / 원작 고증 전환 가능`,
      suggestedReplies: [
        `"좋아, ${animeTitle} 세계의 규칙대로 정면 돌파해 보자!"`,
        `"잠깐, 지금 이 시점이 원작에서 어떤 에피소드 직전인지 확인부터 해야겠어."`,
        `*${targetCharacter || '상대'}의 눈을 똑바로 마주 보며 동행을 제안한다.*`,
      ],
      lorebook: [
        {
          id: makeId('lore'),
          title: `${animeTitle} 핵심 세계관 설정`,
          keywords: `${animeTitle}, 능력, 비밀, 원작, 전투`,
          content: `「${animeTitle}」 원작의 고유 능력 체계, 주요 세력, 대표 에피소드를 충실히 반영한다.${extraPrompt ? ` 유저 요청: ${extraPrompt}` : ''}`,
          enabled: true,
        },
      ],
    };
  } else {
    const prompt = `인기 애니메이션 「${animeTitle}」을(를) 기반으로 한국 AI 캐릭터 챗 플랫폼 CRACK용 최고 퀄리티 캐릭터/세계관 카드를 생성하세요.
- 작품명: ${animeTitle}
- 대상 캐릭터(비어있으면 대표 인기 캐릭터 또는 전체 주연진): ${targetCharacter || '작품 대표 인기 캐릭터/주연진'}
- 플레이 스타일: ${playStyle === 'world' ? '멀티 캐릭터 세계관 RPG 시뮬레이션 (여러 원작 캐릭터가 동시에 등장하고 상태창 포함)' : '1:1 인기 캐릭터 몰입 챗'}
- 추가 희망 설정/에피소드: ${extraPrompt || '가장 인기 있고 몰입감 높은 명장면 시점에서 시작'}

반드시 아래 JSON 스키마만 정확히 반환하세요 ({{user}} 변수 활용, 원작 고증 말투와 명대사 필수):
{
  "name": "캐릭터 이름 또는 세계관 시뮬 제목",
  "title": "[${animeTitle}] 매력적인 한 줄 타이틀 (34자 이내)",
  "subtitle": "원작 느낌 살린 대표 대사 1줄 (큰따옴표 포함)",
  "animeCategory": "shonen | fantasy_isekai | thriller_sf | slice_sports 중 가장 어울리는 1개",
  "powerSystem": "이 애니메이션 고유의 능력/시스템 요약 (예: 주력·영역전개, 악마의 열매·패기 등)",
  "castMembers": ["주요등장인물1", "주요등장인물2", "주요등장인물3", "주요등장인물4"],
  "tags": ["#${animeTitle.replace(/\s+/g, '')}", "#태그2", "#태그3", "#태그4"],
  "worldSummary": "세계관과 시작 상황 2문장 요약",
  "personaPrompt": "원작 고증 외모, 성격, 말투(특유의 말버릇/명대사), 주요 관계, 서사 규칙을 아주 상세하게 작성 (500자 이상)",
  "openingMessage": "*생생한 원작 장면 묘사*와 \\"원작 말투 대사\\"가 어우러진 강렬한 첫 인사말 (3~5문단${playStyle === 'world' ? ', 마지막에 **[상태창]** 포함' : ''})",
  "initialMood": "초기 감정 상태",
  "relationshipStage": "초기 관계/장소 단계",
  "initialAffinity": 42,
  "suggestedReplies": ["추천답변1", "추천답변2", "추천답변3"],
  "lorebook": [
    {"title": "핵심 능력/규칙", "keywords": "키워드1, 키워드2, 키워드3", "content": "원작 고증 상세 설정"},
    {"title": "주요 세력/사건", "keywords": "키워드1, 키워드2, 키워드3", "content": "원작 핵심 사건 및 IF 분기 가능 포인트"},
    {"title": "핵심 인물 관계", "keywords": "키워드1, 키워드2, 키워드3", "content": "원작 주변 인물들의 관계와 특징"}
  ]
}`;

    try {
      const out = await generateStructuredText({
        apiKey,
        preferredModel: cfg.defaultModel || 'gemini-3.8-flash',
        systemInstruction: '당신은 모든 애니메이션의 원작 설정, 말투, 능력치, 명장면을 꿰뚫고 있는 최고의 한국어 AI 스토리 챗 크리에이터입니다. 유효한 JSON 객체만 출력하세요.',
        prompt,
        maxOutputTokens: 2400,
        jsonMode: true,
      });
      const parsed = parseJsonLoose(out.text);
      modelUsed = out.modelUsed;
      charPayload = {
        ...parsed,
        isAnime: true,
        animeTitle,
        animeCategory: parsed.animeCategory || animeCategory,
        playStyle,
        genre: 'anime',
        creator: 'ANIME SUMMON',
        avatar,
      };
    } catch (err) {
      return sendError(res, 502, `애니 소환 실패: ${err.message}`);
    }
  }

  const savedChar = saveCharacter(charPayload);
  const session = createSession({
    characterId: savedChar.id,
    personaId: persona.id,
  });

  return sendJson(res, 201, {
    character: savedChar,
    session,
    persona,
    isDemo,
    modelUsed,
  });
}

async function handleAutofillCharacter(req, res) {
  const body = await readJsonBody(req);
  const concept = String(body.concept || '').trim();
  const genre = String(body.genre || 'romance');
  const nameHint = String(body.name || '').trim();
  if (!concept) return sendError(res, 400, '캐릭터 아이디어나 키워드를 먼저 입력해 주세요.');

  const apiKey = getEffectiveApiKey();
  const genreLabel = GENRES.find((g) => g.id === genre)?.label || '로맨스';

  if (!apiKey) {
    const charName = nameHint || '한서윤';
    return sendJson(res, 200, {
      isDemo: true,
      character: {
        name: charName,
        title: `${concept.slice(0, 26)} — 운명의 시작`,
        subtitle: `“네가 나타나기 전까지, 이 밤은 늘 똑같았는데.”`,
        genre,
        tags: [`#${genreLabel}`, '#오리지널', '#비밀', '#스토리챗'],
        worldSummary: `${concept}을(를) 배경으로 {{user}}와 ${charName}이(가) 얽히며 펼쳐지는 인터랙티브 스토리.`,
        personaPrompt: `이름: ${charName}\n장르: ${genreLabel}\n핵심 컨셉: ${concept}\n성격: 겉으로는 차분하고 속내를 숨기지만, {{user}} 앞에서는 조금씩 본심과 감정이 흔들린다.\n말투: 상황에 맞는 몰입감 있는 한국 웹소설 대사체.`,
        openingMessage: `*깊은 밤, 공기가 유독 서늘하게 내려앉은 순간 ${charName}이(가) 천천히 고개를 들어 {{user}}를 바라보았다.*\n\n"기다리고 있었어, {{user}}. 이제부터 우리가 어떤 이야기를 쓰게 될지... 네 선택에 달렸어."`,
        initialMood: '묘한 기대감',
        relationshipStage: '운명적 첫 만남',
        initialAffinity: 35,
        suggestedReplies: [
          '"무슨 뜻이야? 방금 한 말 자세히 설명해 줘."',
          '*조용히 시선을 마주하며 한 걸음 다가선다.*',
          '"좋아, 네가 제안하는 이야기에 올라타 볼게."',
        ],
        lorebook: [
          {
            id: makeId('lore'),
            title: '핵심 비밀 설정',
            keywords: '비밀, 과거, 약속',
            content: `${concept}과 관련된 숨겨진 과거가 두 사람 사이에 존재한다.`,
            enabled: true,
          },
        ],
      },
    });
  }

  const prompt = `한국 AI 캐릭터 챗 플랫폼 CRACK 스타일의 매력적인 캐릭터를 기획하세요.
- 장르: ${genreLabel} (${genre})
- 이름 힌트: ${nameHint || '어울리는 매력적인 한국식/판타지 이름 자동 창작'}
- 유저 아이디어: ${concept}

반드시 아래 JSON 스키마만 정확히 반환하세요 ({{user}} 변수를 자연스럽게 활용):
{
  "name": "캐릭터 이름",
  "title": "웹소설 제목 느낌의 매력적인 타이틀 (28자 이내)",
  "subtitle": "캐릭터의 대표 대사 1줄 (큰따옴표 포함)",
  "tags": ["#태그1", "#태그2", "#태그3", "#태그4"],
  "worldSummary": "세계관과 시작 상황 요약 (2문장)",
  "personaPrompt": "외모, 성격, 말투, 서사 규칙을 포함한 상세 캐릭터 프롬프트 (400자 내외)",
  "openingMessage": "*지문*과 \\"대사\\"가 어우러진 몰입감 높은 첫 인사말 (3~4문단)",
  "initialMood": "초기 감정 상태 (예: 차가운 경계심)",
  "relationshipStage": "초기 관계 단계 (예: 비밀 거래 · 1막)",
  "initialAffinity": 35,
  "suggestedReplies": ["추천답변1", "추천답변2", "추천답변3"],
  "lorebook": [
    {"title": "로어북 제목", "keywords": "키워드1, 키워드2, 키워드3", "content": "해당 키워드가 나올 때 AI가 참고할 세계관 비밀 설정"}
  ]
}`;

  try {
    const out = await generateStructuredText({
      apiKey,
      preferredModel: readConfig().defaultModel || 'gemini-3.8-flash',
      systemInstruction: '당신은 인기 한국 웹소설·AI 캐릭터 챗 크리에이터입니다. 유효한 JSON 객체만 출력하세요.',
      prompt,
      maxOutputTokens: 2000,
      jsonMode: true,
    });
    const parsed = parseJsonLoose(out.text);
    parsed.genre = genre;
    return sendJson(res, 200, { character: parsed, modelUsed: out.modelUsed, isDemo: false });
  } catch (err) {
    return sendError(res, 502, `AI 캐릭터 자동 생성 실패: ${err.message}`);
  }
}

export function createAppServer({ port = getPort() } = {}) {
  const server = http.createServer(async (req, res) => {
    const activePort = (server.address && typeof server.address() === 'object' && server.address()?.port) || port;
    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${activePort}`);
    const pathname = decodeURIComponent(urlObj.pathname);
    const method = req.method || 'GET';

    try {
      // --- API Routes ---
      if (pathname === '/api/health' && method === 'GET') {
        const cfg = getPublicConfig();
        return sendJson(res, 200, {
          ok: true,
          app: 'CRACK AI',
          port: activePort,
          hasApiKey: cfg.hasApiKey,
          defaultModel: cfg.defaultModel,
          characterCount: listCharacters().length,
          sessionCount: listSessions().length,
        });
      }

      if (pathname === '/api/network' && method === 'GET') {
        return sendJson(res, 200, getNetworkInfo(activePort));
      }

      if (pathname === '/api/config' && method === 'GET') {
        return sendJson(res, 200, getPublicConfig());
      }

      if (pathname === '/api/config' && method === 'PATCH') {
        const body = await readJsonBody(req);
        const allowed = {};
        if (typeof body.geminiApiKey === 'string') allowed.geminiApiKey = body.geminiApiKey.trim();
        if (typeof body.defaultModel === 'string') allowed.defaultModel = body.defaultModel.trim();
        if (typeof body.defaultMode === 'string') allowed.defaultMode = body.defaultMode.trim();
        if (body.theme === 'dark' || body.theme === 'light') allowed.theme = body.theme;
        if (typeof body.viewMode === 'string') allowed.viewMode = body.viewMode;
        if (typeof body.fontFamily === 'string') allowed.fontFamily = body.fontFamily;
        if (typeof body.fontSize === 'string') allowed.fontSize = body.fontSize;
        if (typeof body.backdropMode === 'string') allowed.backdropMode = body.backdropMode;
        if (typeof body.outputLength === 'string') allowed.outputLength = body.outputLength;
        if (typeof body.showAffinityHud === 'boolean') allowed.showAffinityHud = body.showAffinityHud;
        if (typeof body.activePersonaId === 'string') allowed.activePersonaId = body.activePersonaId;
        writeConfig(allowed);
        return sendJson(res, 200, getPublicConfig());
      }

      if (pathname === '/api/gemini/verify' && method === 'POST') {
        const body = await readJsonBody(req);
        const keyToTest = typeof body.apiKey === 'string' && body.apiKey.trim()
          ? body.apiKey.trim()
          : getEffectiveApiKey();
        const result = await listAvailableModels(keyToTest);
        if (result.ok) {
          const patch = {
            lastVerifiedModel: result.recommendedModel,
            lastVerifiedAt: new Date().toISOString(),
          };
          if (body.save && typeof body.apiKey === 'string' && body.apiKey.trim()) {
            patch.geminiApiKey = body.apiKey.trim();
          }
          if (body.autoSelectRecommended && result.recommendedModel) {
            patch.defaultModel = result.recommendedModel;
          }
          writeConfig(patch);
        }
        return sendJson(res, result.ok ? 200 : 400, {
          ...result,
          config: getPublicConfig(),
        });
      }

      // Characters
      if (pathname === '/api/characters' && method === 'GET') {
        return sendJson(res, 200, {
          genres: GENRES,
          animeCategories: ANIME_CATEGORIES,
          characters: listCharacters(),
        });
      }

      if (pathname === '/api/anime/summon' && method === 'POST') {
        return await handleSummonAnime(req, res);
      }

      if (pathname === '/api/characters' && method === 'POST') {
        const body = await readJsonBody(req);
        const saved = saveCharacter(body);
        return sendJson(res, 201, { character: saved });
      }

      if (pathname === '/api/characters/autofill' && method === 'POST') {
        return await handleAutofillCharacter(req, res);
      }

      const charMatch = pathname.match(/^\/api\/characters\/([^/]+)(?:\/(favorite|like))?$/);
      if (charMatch) {
        const charId = charMatch[1];
        const sub = charMatch[2];
        if (!sub && method === 'GET') {
          const char = getCharacter(charId);
          return char ? sendJson(res, 200, { character: char }) : sendError(res, 404, '캐릭터를 찾을 수 없습니다.');
        }
        if (!sub && method === 'DELETE') {
          return sendJson(res, 200, deleteCharacter(charId));
        }
        if (sub === 'favorite' && method === 'POST') {
          return sendJson(res, 200, toggleFavorite(charId));
        }
        if (sub === 'like' && method === 'POST') {
          return sendJson(res, 200, toggleLike(charId));
        }
      }

      // Image Upload
      if (pathname === '/api/upload/image' && method === 'POST') {
        const body = await readJsonBody(req, 12 * 1024 * 1024);
        const url = saveUploadedImage(body.dataUrl);
        return sendJson(res, 201, { url });
      }

      // Personas
      if (pathname === '/api/personas' && method === 'GET') {
        return sendJson(res, 200, { personas: listPersonas() });
      }
      if (pathname === '/api/personas' && method === 'POST') {
        const body = await readJsonBody(req);
        const persona = savePersona(body);
        return sendJson(res, 201, { persona, personas: listPersonas() });
      }
      const personaDel = pathname.match(/^\/api\/personas\/([^/]+)$/);
      if (personaDel && method === 'DELETE') {
        const ok = deletePersona(personaDel[1]);
        return sendJson(res, ok ? 200 : 400, { ok, personas: listPersonas() });
      }

      // Sessions
      if (pathname === '/api/sessions' && method === 'GET') {
        const charId = urlObj.searchParams.get('characterId');
        return sendJson(res, 200, { sessions: listSessions(charId) });
      }
      if (pathname === '/api/sessions' && method === 'DELETE') {
        clearAllSessions();
        return sendJson(res, 200, { cleared: true, sessions: [] });
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await readJsonBody(req);
        const cfg = readConfig();
        const session = createSession({
          characterId: body.characterId,
          personaId: body.personaId || cfg.activePersonaId,
          title: body.title,
        });
        const character = getCharacter(session.characterId);
        return sendJson(res, 201, { session, character });
      }

      const sessReset = pathname.match(/^\/api\/sessions\/([^/]+)\/reset$/);
      if (sessReset && method === 'POST') {
        const reset = resetSession(sessReset[1]);
        if (!reset) return sendError(res, 404, '세션을 찾을 수 없습니다.');
        const character = getCharacter(reset.characterId);
        const persona = getPersona(reset.personaId);
        return sendJson(res, 200, { session: reset, character, persona });
      }

      const sessStream = pathname.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/);
      if (sessStream && method === 'POST') {
        return await handleChatStream(req, res, sessStream[1]);
      }

      const sessSug = pathname.match(/^\/api\/sessions\/([^/]+)\/suggestions$/);
      if (sessSug && method === 'POST') {
        return await handleGenerateSuggestions(res, sessSug[1]);
      }

      const sessSum = pathname.match(/^\/api\/sessions\/([^/]+)\/summarize$/);
      if (sessSum && method === 'POST') {
        return await handleSummarizeSession(res, sessSum[1]);
      }

      const sessRewind = pathname.match(/^\/api\/sessions\/([^/]+)\/rewind$/);
      if (sessRewind && method === 'POST') {
        const body = await readJsonBody(req);
        const updated = updateSession(sessRewind[1], (curr) => {
          const idx = curr.messages.findIndex((m) => m.id === body.messageId);
          if (idx === -1) return curr;
          return { ...curr, ending: null, messages: curr.messages.slice(0, idx + 1) };
        });
        return updated ? sendJson(res, 200, { session: updated }) : sendError(res, 404, '세션을 찾을 수 없습니다.');
      }

      const sessExport = pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
      if (sessExport && method === 'GET') {
        const session = getSession(sessExport[1]);
        if (!session) return sendError(res, 404, '세션을 찾을 수 없습니다.');
        const char = getCharacter(session.characterId);
        const persona = getPersona(session.personaId);
        const mdLines = [
          `# ${char?.title || session.title}`,
          `> 캐릭터: **${char?.name || '알 수 없음'}** · 주인공: **${persona.name}** · 호감도: ${session.affinity}/100 (${session.mood})`,
          '',
        ];
        if (session.summaryMemory) {
          mdLines.push('## 요약 메모리', session.summaryMemory, '');
        }
        mdLines.push('---', '');
        for (const msg of session.messages) {
          const speaker = msg.role === 'user' ? persona.name : (char?.name || '캐릭터');
          mdLines.push(`### ${speaker}`, '', msg.content, '');
        }
        const md = mdLines.join('\n');
        const safeTitle = (char?.name || 'crack_story').replace(/[^\w가-힣-]+/g, '_');
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeTitle}_story.md`)}`,
        });
        return res.end(md);
      }

      const msgPatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)$/);
      if (msgPatch && method === 'PATCH') {
        const body = await readJsonBody(req);
        const updated = updateSession(msgPatch[1], (curr) => {
          const msgs = curr.messages.map((m) => {
            if (m.id !== msgPatch[2]) return m;
            const copy = { ...m };
            if (typeof body.activeVersion === 'number' && Array.isArray(copy.versions)) {
              const clamped = Math.max(0, Math.min(copy.versions.length - 1, body.activeVersion));
              copy.activeVersion = clamped;
              copy.content = copy.versions[clamped];
            }
            if (typeof body.content === 'string') {
              copy.content = body.content;
              if (Array.isArray(copy.versions)) {
                const vIdx = copy.activeVersion || 0;
                copy.versions = [...copy.versions];
                copy.versions[vIdx] = body.content;
              }
            }
            return copy;
          });
          return { ...curr, messages: msgs };
        });
        return updated ? sendJson(res, 200, { session: updated }) : sendError(res, 404, '세션을 찾을 수 없습니다.');
      }

      const sessMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessMatch) {
        const sessionId = sessMatch[1];
        if (method === 'GET') {
          const session = getSession(sessionId);
          if (!session) return sendError(res, 404, '세션을 찾을 수 없습니다.');
          return sendJson(res, 200, {
            session,
            character: getCharacter(session.characterId),
            persona: getPersona(session.personaId),
          });
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const updated = updateSession(sessionId, (curr) => {
            const next = { ...curr };
            if (typeof body.title === 'string') next.title = body.title.trim().slice(0, 80) || curr.title;
            if (typeof body.userNote === 'string') next.userNote = body.userNote.slice(0, 2000);
            if (typeof body.summaryMemory === 'string') next.summaryMemory = body.summaryMemory.slice(0, 2000);
            if (typeof body.personaId === 'string') next.personaId = body.personaId;
            if (body.storyRoute === 'canon' || body.storyRoute === 'if') next.storyRoute = body.storyRoute;
            if (['realistic', 'crisis', 'surreal'].includes(body.nationMode)) {
              next.nationMode = body.nationMode === 'surreal' ? 'crisis' : body.nationMode;
            }
            if (['short', 'standard', 'long', 'endless'].includes(body.storyLength)) {
              next.storyLength = body.storyLength;
              next.targetTurns = STORY_LENGTH_TURNS[body.storyLength] ?? 14;
            }
            if (typeof body.targetTurns === 'number' && Number.isFinite(body.targetTurns)) {
              next.targetTurns = Math.max(0, Math.min(60, Math.round(body.targetTurns)));
            }
            if (['real', 'hardcore', 'story'].includes(body.difficulty)) {
              next.difficulty = body.difficulty;
            }
            if (body.ending === null) {
              next.ending = null;
            }
            if (typeof body.affinity === 'number') {
              next.affinity = Math.max(0, Math.min(100, Math.round(body.affinity)));
              const ch = getCharacter(curr.characterId);
              next.relationshipStage = relationshipStageForAffinity(next.affinity, ch?.relationshipStage);
            }
            if (typeof body.mood === 'string') next.mood = body.mood.trim().slice(0, 40);
            if (Array.isArray(body.lorebook)) next.lorebook = body.lorebook;
            return next;
          });
          return updated ? sendJson(res, 200, { session: updated }) : sendError(res, 404, '세션을 찾을 수 없습니다.');
        }
        if (method === 'DELETE') {
          return sendJson(res, 200, { deleted: deleteSession(sessionId) });
        }
      }

      // Uploaded user images
      if (pathname.startsWith('/uploads/') && method === 'GET') {
        const uploadPath = resolveUploadFile(pathname.slice('/uploads/'.length));
        if (uploadPath && serveStaticFile(res, uploadPath)) return;
        return sendError(res, 404, '파일을 찾을 수 없습니다.');
      }

      // Static frontend files (cross-platform Windows & POSIX safe)
      const relPath = pathname.replace(/^[/\\]+/, '');
      const normalized = relPath ? path.normalize(relPath).replace(/^(\.\.[/\\])+/, '') : 'index.html';
      const candidatePath = path.resolve(WEB_DIR, normalized === '.' ? 'index.html' : normalized);
      const resolvedWebDir = path.resolve(WEB_DIR);
      if (
        (candidatePath === resolvedWebDir || candidatePath.startsWith(resolvedWebDir + path.sep)) &&
        serveStaticFile(res, candidatePath)
      ) {
        return;
      }

      // SPA fallback
      if (serveStaticFile(res, path.join(WEB_DIR, 'index.html'))) {
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, 500, err?.message || '서버 내부 오류');
      }
    }
  });
  return server;
}

export function startServer({ port = getPort(), host = '0.0.0.0' } = {}) {
  const server = createAppServer({ port });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address()?.port || port;
      resolve({ server, port: actualPort, network: getNetworkInfo(actualPort) });
    });
  });
}

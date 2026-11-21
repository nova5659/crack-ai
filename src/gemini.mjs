import { GENERATION_MODES, GEMINI_FREE_MODELS } from './config.mjs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const STATE_TAG_REGEX = /<!--\s*CRACK_STATE\s*:\s*(\{[\s\S]*?\})\s*-->/i;

export function sanitizeApiKey(raw = '') {
  let k = String(raw || '').trim();
  k = k.replace(/^(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*/i, '').trim();
  k = k.replace(/^["'`]+|["'`]+$/g, '').trim();
  k = k.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
  if (!k || k.includes('•')) return '';
  return k;
}

export function isInvalidKeyError(status, errMsg = '') {
  if (status === 401 || status === 403) return true;
  return /api[\s_-]*key[\s_-]*(not[\s_-]*valid|invalid|expired)|API_KEY_INVALID/i.test(String(errMsg || ''));
}

export function isGemini3Model(modelId = '') {
  return /^gemini-3/i.test(modelId) || /^gemini-4/i.test(modelId);
}

export function buildFallbackChain(preferredModel) {
  const baseOrder = [
    preferredModel,
    'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
  ];
  const seen = new Set();
  const out = [];
  for (const m of baseOrder) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function buildSafetySettings() {
  return [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
  ];
}

export function buildGenerationPayload({
  modelId,
  systemInstruction,
  contents,
  thinkingLevel = 'MEDIUM',
  maxOutputTokens = 1600,
  responseMimeType = null,
}) {
  const generationConfig = {
    maxOutputTokens,
  };

  if (responseMimeType) {
    generationConfig.responseMimeType = responseMimeType;
  }

  // Gemini 3.x models deprecate temperature/topP/topK (can return 400).
  // Use thinkingConfig.thinkingLevel only on non-Lite models when explicitly requested (LOW/MEDIUM/HIGH);
  // omitting thinkingConfig on Flash-Lite gives blazing <1s responses!
  const isLite = /lite/i.test(modelId || '');
  if (isGemini3Model(modelId)) {
    if (!isLite && thinkingLevel && ['LOW', 'MEDIUM', 'HIGH'].includes(String(thinkingLevel).toUpperCase())) {
      generationConfig.thinkingConfig = {
        thinkingLevel: String(thinkingLevel).toUpperCase(),
      };
    }
  } else {
    generationConfig.temperature = 0.85;
  }

  const body = {
    contents,
    generationConfig,
    safetySettings: buildSafetySettings(),
  };

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  return body;
}

function normalizeChoiceText(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Convert outer single-quoted speech '대사' into clean Korean dialogue "..." for user convenience
  s = s.replace(/(^|\s)'([^'\n]{2,90})'(?=\s|$|[.,!?])/g, '$1"$2"');
  return s.slice(0, 120);
}

export function parseStateTag(fullText = '') {
  const match = fullText.match(STATE_TAG_REGEX);
  let stateUpdate = null;
  if (match) {
    const rawJson = match[1];
    try {
      const parsed = JSON.parse(rawJson);
      const rawDelta = Number(parsed.affinityDelta);
      const delta = Number.isFinite(rawDelta)
        ? Math.max(-5, Math.min(6, Math.round(rawDelta)))
        : 0;
      const mood = typeof parsed.mood === 'string' && parsed.mood.trim()
        ? parsed.mood.trim().slice(0, 28)
        : null;
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
      stateUpdate = { affinityDelta: delta, mood, nation, choices };
    } catch {
      // Defensive fallback if an unescaped quote broke JSON.parse
      const dMatch = rawJson.match(/"affinityDelta"\s*:\s*(-?\d+)/);
      const mMatch = rawJson.match(/"mood"\s*:\s*"([^"]{1,28})"/);
      const cMatch = rawJson.match(/"choices"\s*:\s*\[([\s\S]*?)\]/);
      const choices = [];
      if (cMatch) {
        const itemRe = /"((?:\\.|[^"\\])+)"/g;
        let it;
        while ((it = itemRe.exec(cMatch[1])) && choices.length < 3) {
          const txt = normalizeChoiceText(it[1].replace(/\\"/g, '"'));
          if (txt) choices.push(txt);
        }
      }
      if (dMatch || mMatch || choices.length) {
        const rawDelta = dMatch ? Number(dMatch[1]) : 0;
        stateUpdate = {
          affinityDelta: Number.isFinite(rawDelta) ? Math.max(-5, Math.min(6, Math.round(rawDelta))) : 0,
          mood: mMatch ? mMatch[1].trim() : null,
          nation: null,
          choices,
        };
      }
    }
  }
  const cleanText = fullText
    .replace(STATE_TAG_REGEX, '')
    .replace(/<!--\s*CRACK_STATE[\s\S]*$/i, '')
    .trimEnd();
  return { cleanText, stateUpdate };
}

/**
 * Strips trailing partial `<!--CRACK_STATE:...` tokens during streaming so users never see raw metadata tags.
 */
export function createStreamingTagFilter(onCleanDelta) {
  let pending = '';
  let rawAll = '';
  let insideHiddenTag = false;

  const flushSafe = () => {
    if (insideHiddenTag || !pending) return;
    const markerIdx = pending.indexOf('<!--');
    if (markerIdx !== -1) {
      if (markerIdx > 0) {
        onCleanDelta(pending.slice(0, markerIdx));
      }
      pending = pending.slice(markerIdx);
      insideHiddenTag = true;
      return;
    }
    // Keep up to 3 trailing chars if they could start "<!--"
    let holdLen = 0;
    for (let len = Math.min(3, pending.length); len >= 1; len--) {
      if ('<!--'.startsWith(pending.slice(-len))) {
        holdLen = len;
        break;
      }
    }
    const emit = holdLen > 0 ? pending.slice(0, -holdLen) : pending;
    pending = holdLen > 0 ? pending.slice(-holdLen) : '';
    if (emit) onCleanDelta(emit);
  };

  return {
    push(chunk) {
      if (!chunk) return;
      rawAll += chunk;
      if (insideHiddenTag) {
        pending += chunk;
        const endIdx = pending.indexOf('-->');
        if (endIdx !== -1) {
          pending = pending.slice(endIdx + 3);
          insideHiddenTag = false;
          flushSafe();
        }
        return;
      }
      pending += chunk;
      flushSafe();
    },
    finish() {
      if (!insideHiddenTag && pending) {
        onCleanDelta(pending);
      }
      pending = '';
      return parseStateTag(rawAll);
    },
  };
}

export async function listAvailableModels(apiKey) {
  if (!apiKey) {
    return { ok: false, error: 'API 키가 비어 있습니다.', models: [] };
  }
  const url = `${API_BASE}/models?pageSize=100`;
  const res = await fetch(url, {
    headers: {
      'x-goog-api-key': apiKey,
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let message = `API 키 인증 실패 (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, error: message, models: [] };
  }

  const data = await res.json();
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const generateModels = rawModels
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((id) => /gemini/i.test(id));

  // Recommend fastest rock-solid free Flash model detected on this key
  const preferredOrder = [
    'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
  ];
  const recommended =
    preferredOrder.find((id) => generateModels.includes(id)) ||
    generateModels.find((id) => /flash/i.test(id) && !/image|tts|audio/i.test(id)) ||
    generateModels[0] ||
    GEMINI_FREE_MODELS[0].id;

  return {
    ok: true,
    models: generateModels,
    recommendedModel: recommended,
  };
}

function extractTextFromCandidate(jsonObj) {
  const parts = jsonObj?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    // Skip internal reasoning thought parts if returned
    if (p.thought === true) continue;
    if (typeof p.text === 'string') text += p.text;
  }
  return text;
}

export async function streamChatCompletion({
  apiKey,
  model,
  mode = 'story',
  systemInstruction,
  contents,
  maxOutputTokens,
  onDelta,
  signal,
}) {
  const modeCfg = GENERATION_MODES[mode] || GENERATION_MODES.story;
  const preferredModel = model || modeCfg.model || 'gemini-3.8-flash';
  const cleanKey = sanitizeApiKey(apiKey);
  if (!cleanKey) {
    throw new Error('Google Gemini API 키가 올바르지 않습니다. 상단 [🔑 무료 Gemini API]에서 AIza... 키를 다시 입력해 주세요.');
  }

  let chain = buildFallbackChain(preferredModel);
  const targetMaxTokens = maxOutputTokens || modeCfg.maxOutputTokens || 1600;
  let discoveredFallback = false;

  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const url = `${API_BASE}/models/${encodeURIComponent(candidateModel)}:streamGenerateContent?alt=sse`;
    const isLite = /lite/i.test(candidateModel);
    const body = buildGenerationPayload({
      modelId: candidateModel,
      systemInstruction,
      contents,
      thinkingLevel: isLite ? null : (modeCfg.thinkingLevel || 'LOW'),
      maxOutputTokens: targetMaxTokens,
    });

    // Per-model fast-failover header timeout (8.5s) so a congested model NEVER hangs the user!
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
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey,
        },
        body: JSON.stringify(body),
        signal: attemptCtrl.signal,
      });
    } catch (err) {
      clearTimeout(headerTimer);
      if (signal) signal.removeEventListener('abort', onUserAbort);
      if (signal?.aborted) throw err;
      lastError = new Error(
        timedOut
          ? `[${candidateModel}] 응답 지연으로 자동 우회 중`
          : `네트워크 오류 (${candidateModel}): ${err.message}`
      );
      if (i < chain.length - 1) continue;
      throw lastError;
    }
    clearTimeout(headerTimer);

    if (!res.ok) {
      if (signal) signal.removeEventListener('abort', onUserAbort);
      const errBody = await res.text().catch(() => '');
      let errMsg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(errBody);
        errMsg = parsed?.error?.message || errMsg;
      } catch {
        // ignore
      }
      lastError = new Error(`[${candidateModel}] ${errMsg}`);
      if (isInvalidKeyError(res.status, errMsg)) {
        throw new Error('Google Gemini API 키가 유효하지 않습니다. 상단 [🔑 무료 Gemini API]에서 Google AI Studio(aistudio.google.com/apikey) 키를 다시 확인 후 [연결 테스트 & 저장]을 눌러주세요.');
      }
      if (res.status === 404 && i === chain.length - 1 && !discoveredFallback) {
        discoveredFallback = true;
        const avail = await listAvailableModels(cleanKey).catch(() => ({ ok: false }));
        if (avail.ok && avail.recommendedModel && !chain.includes(avail.recommendedModel)) {
          chain = [...chain, avail.recommendedModel];
          continue;
        }
      }
      if ([400, 404, 429, 500, 503].includes(res.status) && i < chain.length - 1) {
        continue;
      }
      throw lastError;
    }

    // Stream SSE chunks!
    const filter = createStreamingTagFilter((cleanDelta) => {
      if (onDelta) onDelta(cleanDelta);
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let usage = null;

    try {
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
            const chunkText = extractTextFromCandidate(parsed);
            if (chunkText) filter.push(chunkText);
            if (parsed.usageMetadata) usage = parsed.usageMetadata;
          } catch {
            // Ignore malformed keepalive chunk
          }
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onUserAbort);
    }

    const { cleanText, stateUpdate } = filter.finish();
    if (!cleanText && i < chain.length - 1) {
      lastError = new Error(`[${candidateModel}] 빈 응답 수신`);
      continue;
    }
    return {
      text: cleanText,
      stateUpdate,
      modelUsed: candidateModel,
      fallbackFrom: candidateModel !== preferredModel ? preferredModel : null,
      usage,
      isDemo: false,
    };
  }

  throw lastError || new Error('Gemini API 호출에 실패했습니다.');
}

export async function generateStructuredText({
  apiKey,
  preferredModel = 'gemini-3.5-flash-lite',
  systemInstruction,
  prompt,
  maxOutputTokens = 900,
  jsonMode = false,
}) {
  const chain = buildFallbackChain(preferredModel);
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    const url = `${API_BASE}/models/${encodeURIComponent(candidateModel)}:generateContent`;
    const body = buildGenerationPayload({
      modelId: candidateModel,
      systemInstruction,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      thinkingLevel: 'LOW',
      maxOutputTokens,
      responseMimeType: jsonMode ? 'application/json' : null,
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let errMsg = `HTTP ${res.status}`;
        try {
          errMsg = JSON.parse(errBody)?.error?.message || errMsg;
        } catch {
          // ignore
        }
        lastError = new Error(`[${candidateModel}] ${errMsg}`);
        if (res.status === 401 || res.status === 403) throw lastError;
        if ([400, 404, 429, 500, 503].includes(res.status) && i < chain.length - 1) continue;
        throw lastError;
      }

      const data = await res.json();
      const text = extractTextFromCandidate(data);
      return { text: text.trim(), modelUsed: candidateModel };
    } catch (err) {
      lastError = err;
      if (i === chain.length - 1) throw lastError;
    }
  }
  throw lastError || new Error('보조 AI 생성에 실패했습니다.');
}

/**
 * Rich built-in Korean interactive preview engine when API key is not configured yet.
 */
export async function streamDemoResponse({
  character,
  persona,
  userMessage,
  triggeredLorebooks = [],
  onDelta,
  signal,
}) {
  const userName = persona?.name || '당신';
  const charName = character.name;
  const quoted = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const loreHint = triggeredLorebooks.length > 0
    ? `\n\n*그 순간, '${triggeredLorebooks[0].title}'에 얽힌 기억이 스치며 ${charName}의 눈빛이 미세하게 흔들렸다.*`
    : '';

  const genreTemplates = {
    simulation: character.isNationSim
      ? `비서실장이 긴급 보고서를 집무실 전략 탁자 위에 펼쳐 놓으며 숨을 골랐다. 외교부와 기획재정부 장관들이 동시에 시선을 집중했다.\n\n"각하, 방금 하달하신 지시(${quoted || '국정 개혁 명령'})가 전국과 각국 대사관에 즉시 전파되었습니다. 국회와 언론이 즉각 반응하고 있습니다."${loreHint}\n\n**[ 긴급 속보 · 국제 뉴스 ]**\n- [속보] ${userName} 지도자, 전격 국정 드라이브 선언… 증시·여론 즉각 반응\n- [국제] 주변 열강 외무부 "향후 행보 예의주시" 긴급 논평 발표\n\n**[ 국가 상태창 · 대한민국 ]**\n- 시점: 2026년 2월 (1턴) · 지도자: ${userName}\n- 국력: 74/100 · 재정: 645조 원 · 지지율: 61% (+3%) · 군사력: 82/100 · 안정도: 71/100\n- 긴급 현안: 야당의 긴급 대정부 질문 대응 및 주변국 무역 협상`
      : `루미나의 손 위 수정구가 경쾌한 소리와 함께 보라빛으로 반짝였다.\n\n"오오! ${userName} 모험가님, 엄청 센스 있는 선택이세요!"\n\n양피지 두루마리가 공중에 펼쳐지며 새로운 선택지가 떠올랐다.${loreHint}\n\n**[ 퀘스트 진행 알림 ]**\n- 호감도 +2 상승 · 새로운 분기가 열렸습니다!\n- "자, 다음엔 어느 쪽으로 움직여 볼까요?"`,
    anime: character.playStyle === 'world'
      ? `「${character.animeTitle || character.name}」 세계의 공기가 팽팽하게 당겨졌다. ${character.castMembers?.[0] || charName}이(가) 고개를 돌려 시선을 맞췄다.\n\n${character.castMembers?.[0] || charName}: "${quoted ? `${quoted.slice(0, 32)}… 좋아, 각오는 확실히 전해졌어.` : `자, 여기서부터 움직여 볼까.`}"\n\n주변의 동료들도 일제히 자세를 낮추며 다음 국면을 대비했다.${loreHint}\n\n**[ ${character.animeTitle || '애니 월드'} 진행 상태창 ]**\n- 고유 시스템(${character.powerSystem || '능력'}) 활성화 · 호감도 +2`
      : `${charName}의 시선이 천천히 멈췄다. 입꼬리가 미세하게 올라갔다.\n\n"${quoted ? `호오, 그렇게 나온단 말이지? 생각보다 훨씬 재밌는데.` : `멍하니 있지 말고 따라와.`}"\n\n발끝이 한 걸음 가까워졌다.${loreHint}\n\n"좋아. 네가 선택한 그 길, 끝까지 지켜봐 주지."`,
    romance: `${charName}의 시선이 잠시 머물렀다. 방 안의 공기가 낮게 가라앉았다.\n\n"${quoted ? `방금 한 말… 진심인가.` : `그렇게 말없이 쳐다보면 곤란한데.`}"\n\n천천히 한 걸음 다가선 ${charName}이(가) 낮게 숨을 내쉬었다.${loreHint}\n\n"쉽게 선을 긋지 마. 아직 끝내지 못한 이야기가 남아 있으니까."`,
    fantasy: `어둠 속에 떠 있던 마력의 입자들이 일제히 흩어지며 ${charName}의 손끝으로 모여들었다.\n\n"네 선택은 언제나 예상을 벗어나네."\n\n망토 자락을 여민 ${charName}이(가) 고개를 들었다.${loreHint}\n\n"좋아. 네가 그렇게 나온다면 나도 숨겨둔 패를 꺼낼 수밖에."`,
    murim: `바람이 대나무 잎을 스치며 서늘한 검기가 한 차례 일렁였다. ${charName}의 입꼬리가 천천히 올라갔다.\n\n"호오… 방금 그 말, 꽤 대담하군."\n\n검자루를 가볍게 두드린 ${charName}이(가) 반 걸음 앞섰다.${loreHint}\n\n"그 기세를 끝까지 유지할 수 있을지, 직접 확인해 보지."`,
  };

  const fullText =
    genreTemplates[character.genre] ||
    `${charName}이(가) 조용히 말을 곱씹듯 눈을 가늘게 떴다. 밤의 정적 속에 팽팽한 긴장감이 감돌았다.\n\n"흥미로운 반응이네."\n\n시선을 고정한 채 반 걸음 다가섰다.${loreHint}\n\n"다음 수는 어떻게 둘 생각이지? 직접 보여줘."`;

  // Stream token-by-token smoothly
  const chars = [...fullText];
  let idx = 0;
  while (idx < chars.length) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const step = 3 + (idx % 4);
    const piece = chars.slice(idx, idx + step).join('');
    if (onDelta) onDelta(piece);
    idx += step;
    await new Promise((r) => setTimeout(r, 18));
  }

  const demoChoices = character.isNationSim
    ? [
        '긴급 국무회의를 소집해 경제 부양책을 즉시 발표한다.',
        '주변국 대사들을 불러 직접 외교 담판을 짓는다.',
        '비서실장에게 야당과 여론의 핵심 불만부터 보고받는다.',
      ]
    : [
        `"좋아, 지금 바로 정면으로 돌파해 보자."`,
        `${charName}의 눈을 똑바로 마주 보며 한 걸음 다가선다.`,
        `"잠깐, 숨기고 있는 조건이 하나 더 있지 않아?"`,
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
      : { affinityDelta: 2, mood: '흥미와 미묘한 떨림', choices: demoChoices },
    modelUsed: 'demo-preview',
    fallbackFrom: null,
    isDemo: true,
  };
}

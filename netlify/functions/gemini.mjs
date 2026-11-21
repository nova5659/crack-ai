const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const FALLBACK_BASE = [
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];

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

function isGemini3Model(modelId = '') {
  return /^gemini-3/i.test(modelId) || /^gemini-4/i.test(modelId);
}

function buildFallbackChain(preferred) {
  const seen = new Set();
  const out = [];
  for (const m of [preferred, ...FALLBACK_BASE]) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function getServerEnvKey() {
  try {
    if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
      return sanitizeApiKey(Netlify.env.get('GEMINI_API_KEY') || Netlify.env.get('GOOGLE_API_KEY') || '');
    }
  } catch {
    // fallback
  }
  return sanitizeApiKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
}

function resolveApiKey(req, bodyKey = '') {
  const headerKey = sanitizeApiKey(req.headers.get('x-user-gemini-key') || '');
  if (headerKey) return { key: headerKey, source: 'browser' };
  const fromBody = sanitizeApiKey(bodyKey);
  if (fromBody) return { key: fromBody, source: 'browser' };
  const envKey = getServerEnvKey();
  if (envKey) return { key: envKey, source: 'server-env' };
  return { key: '', source: 'none' };
}

function buildPayload({ modelId, systemInstruction, contents, thinkingLevel = null, maxOutputTokens = 1800, responseMimeType = null }) {
  const generationConfig = { maxOutputTokens };
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;

  if (isGemini3Model(modelId)) {
    const isLite = /lite/i.test(modelId);
    if (!isLite && thinkingLevel && ['LOW', 'MEDIUM', 'HIGH'].includes(String(thinkingLevel).toUpperCase())) {
      generationConfig.thinkingConfig = { thinkingLevel: String(thinkingLevel).toUpperCase() };
    }
  } else {
    generationConfig.temperature = 0.85;
  }

  const body = {
    contents,
    generationConfig,
    safetySettings: [
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  return body;
}

function extractText(jsonObj) {
  const parts = jsonObj?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const p of parts) {
    if (p.thought === true) continue;
    if (typeof p.text === 'string') text += p.text;
  }
  return text;
}

async function discoverModels(key) {
  const res = await fetch(`${API_BASE}/models?pageSize=100`, {
    headers: { 'x-goog-api-key': key },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = `API 키 인증 실패 (HTTP ${res.status})`;
    try {
      msg = JSON.parse(errText)?.error?.message || msg;
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, error: msg, models: [] };
  }
  const data = await res.json();
  const generateModels = (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((id) => /gemini/i.test(id));
  const recommendedModel =
    FALLBACK_BASE.find((id) => generateModels.includes(id)) ||
    generateModels.find((id) => /flash/i.test(id) && !/image|tts|audio/i.test(id)) ||
    generateModels[0] ||
    'gemini-3.5-flash-lite';
  return { ok: true, models: generateModels, recommendedModel };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/api/cloud/health' && req.method === 'GET') {
    const serverKey = getServerEnvKey();
    return Response.json(
      {
        ok: true,
        runtime: 'netlify-cloud',
        hasServerKey: Boolean(serverKey),
        defaultModel: 'gemini-3.5-flash-lite',
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (path === '/api/cloud/gemini/verify' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { key } = resolveApiKey(req, body.apiKey);
    if (!key) {
      return Response.json(
        { ok: false, code: 'INVALID_API_KEY', error: 'Google Gemini API 키가 비어 있거나 올바른 형식이 아닙니다.' },
        { status: 400 }
      );
    }
    const result = await discoverModels(key);
    if (!result.ok) {
      return Response.json(
        {
          ok: false,
          code: isInvalidKeyError(result.status, result.error) ? 'INVALID_API_KEY' : 'API_ERROR',
          error: isInvalidKeyError(result.status, result.error)
            ? '유효하지 않은 Google Gemini API 키입니다. aistudio.google.com/apikey 에서 발급한 AIza... 키를 정확히 복사해 주세요.'
            : result.error,
        },
        { status: 400 }
      );
    }
    return Response.json(result);
  }

  if (path === '/api/cloud/gemini/stream' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { key, source } = resolveApiKey(req);
    if (!key) {
      return Response.json(
        { code: 'INVALID_API_KEY', error: 'Google Gemini API 키가 설정되지 않았습니다. 상단 [🔑 API]에서 무료 키를 입력해 주세요.' },
        { status: 401 }
      );
    }

    const preferredModel = body.model || 'gemini-3.5-flash-lite';
    let chain = buildFallbackChain(preferredModel);
    let discovered = false;
    let lastErr = 'Gemini API 스트리밍 요청에 실패했습니다.';

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), i < chain.length - 1 ? 8500 : 25000);
      let upstream;
      try {
        upstream = await fetch(
          `${API_BASE}/models/${encodeURIComponent(candidate)}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key,
            },
            body: JSON.stringify(
              buildPayload({
                modelId: candidate,
                systemInstruction: body.systemInstruction,
                contents: body.contents,
                thinkingLevel: body.thinkingLevel || (/lite/i.test(candidate) ? null : 'LOW'),
                maxOutputTokens: body.maxOutputTokens || 1800,
              })
            ),
            signal: ctrl.signal,
          }
        );
      } catch (err) {
        clearTimeout(timer);
        lastErr = `[${candidate}] 응답 시간 초과 (${err.message})`;
        if (i < chain.length - 1) continue;
        return Response.json({ error: lastErr }, { status: 504 });
      }
      clearTimeout(timer);

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        try {
          lastErr = JSON.parse(errText)?.error?.message || `HTTP ${upstream.status}`;
        } catch {
          lastErr = `HTTP ${upstream.status}`;
        }
        if (isInvalidKeyError(upstream.status, lastErr)) {
          const where = source === 'server-env' ? 'Netlify 환경변수(GEMINI_API_KEY)' : '브라우저 설정에 저장된 키';
          return Response.json(
            {
              code: 'INVALID_API_KEY',
              error: `${where}가 유효하지 않습니다. Google AI Studio(aistudio.google.com/apikey)의 'AIza...' 키를 다시 확인해 [연결 테스트 & 저장]을 눌러주세요.`,
            },
            { status: 401 }
          );
        }
        if (upstream.status === 404 && i === chain.length - 1 && !discovered) {
          discovered = true;
          const avail = await discoverModels(key).catch(() => ({ ok: false }));
          if (avail.ok && avail.recommendedModel && !chain.includes(avail.recommendedModel)) {
            chain = [...chain, avail.recommendedModel];
            continue;
          }
        }
        if ([400, 404, 429, 500, 503].includes(upstream.status) && i < chain.length - 1) {
          continue;
        }
        return Response.json({ error: `[${candidate}] ${lastErr}` }, { status: 502 });
      }

      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Crack-Model-Used': candidate,
          'X-Crack-Fallback-From': candidate !== preferredModel ? preferredModel : '',
        },
      });
    }

    return Response.json({ error: lastErr }, { status: 502 });
  }

  if (path === '/api/cloud/gemini/generate' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { key } = resolveApiKey(req);
    if (!key) {
      return Response.json({ code: 'INVALID_API_KEY', error: 'Google Gemini API 키가 설정되지 않았습니다.' }, { status: 401 });
    }

    const preferredModel = body.model || 'gemini-3.5-flash-lite';
    let chain = buildFallbackChain(preferredModel);
    let discovered = false;
    let lastErr = '보조 AI 생성 실패';

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i];
      const upstream = await fetch(`${API_BASE}/models/${encodeURIComponent(candidate)}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(
          buildPayload({
            modelId: candidate,
            systemInstruction: body.systemInstruction,
            contents: [{ role: 'user', parts: [{ text: String(body.prompt || '') }] }],
            thinkingLevel: body.thinkingLevel || 'LOW',
            maxOutputTokens: body.maxOutputTokens || 1400,
            responseMimeType: body.jsonMode ? 'application/json' : null,
          })
        ),
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        try {
          lastErr = JSON.parse(errText)?.error?.message || `HTTP ${upstream.status}`;
        } catch {
          lastErr = `HTTP ${upstream.status}`;
        }
        if (isInvalidKeyError(upstream.status, lastErr)) {
          return Response.json(
            { code: 'INVALID_API_KEY', error: '유효하지 않은 Google Gemini API 키입니다. 설정에서 키를 다시 입력해 주세요.' },
            { status: 401 }
          );
        }
        if (upstream.status === 404 && i === chain.length - 1 && !discovered) {
          discovered = true;
          const avail = await discoverModels(key).catch(() => ({ ok: false }));
          if (avail.ok && avail.recommendedModel && !chain.includes(avail.recommendedModel)) {
            chain = [...chain, avail.recommendedModel];
            continue;
          }
        }
        if ([400, 404, 429, 500, 503].includes(upstream.status) && i < chain.length - 1) {
          continue;
        }
        return Response.json({ error: `[${candidate}] ${lastErr}` }, { status: 502 });
      }

      const data = await upstream.json();
      return Response.json({
        text: extractText(data).trim(),
        modelUsed: candidate,
      });
    }

    return Response.json({ error: lastErr }, { status: 502 });
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
};

export const config = {
  path: ['/api/cloud/health', '/api/cloud/gemini/*'],
};

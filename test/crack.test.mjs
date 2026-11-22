import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate test storage directory before importing app modules
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crack-ai-test-'));
process.env.CRACK_DATA_DIR = tmpDataDir;

const {
  buildGeminiContents,
  buildSystemInstruction,
  computeStoryArc,
  findTriggeredLorebooks,
  resolveSessionEnding,
  rollFateJudgment,
} = await import('../src/promptBuilder.mjs');
const {
  buildFallbackChain,
  buildGenerationPayload,
  createStreamingTagFilter,
  isInvalidKeyError,
  parseStateTag,
  sanitizeApiKey,
} = await import('../src/gemini.mjs');
const { generateQrSvg } = await import('../src/qr.mjs');
const { createAppServer, startServer } = await import('../src/server.mjs');

test('Lorebook keyword scanner activates only matching enabled entries', () => {
  const lorebook = [
    { id: '1', title: '계약서 7조', keywords: '계약서, 7조, 이혼', content: '감정 배제 조항', enabled: true },
    { id: '2', title: '숨겨진 금고', keywords: '금고, 열쇠', content: '비공개 내용', enabled: true },
    { id: '3', title: '꺼진 설정', keywords: '계약서', content: '비활성화됨', enabled: false },
  ];
  const matched = findTriggeredLorebooks(lorebook, [{ content: '계약서 이야기를 꺼냈다.' }], '7조가 뭔가요?');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].title, '계약서 7조');
});

test('Gemini 3.8 Flash uses thinkingLevel, Flash-Lite omits thinkingConfig, and all Gemini 3.x omit deprecated sampling params', () => {
  const payload38 = buildGenerationPayload({
    modelId: 'gemini-3.8-flash',
    systemInstruction: '시스템 프롬프트',
    contents: [{ role: 'user', parts: [{ text: '안녕' }] }],
    thinkingLevel: 'HIGH',
    maxOutputTokens: 2000,
  });

  assert.equal(payload38.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.equal('temperature' in payload38.generationConfig, false);
  assert.equal('topP' in payload38.generationConfig, false);
  assert.equal('topK' in payload38.generationConfig, false);

  // Flash-Lite omits thinkingConfig for instant ~0.8s first-token latency
  const payloadLite = buildGenerationPayload({
    modelId: 'gemini-3.5-flash-lite',
    systemInstruction: '시스템',
    contents: [{ role: 'user', parts: [{ text: '안녕' }] }],
    thinkingLevel: 'LOW',
  });
  assert.equal('thinkingConfig' in payloadLite.generationConfig, false);
  assert.equal('temperature' in payloadLite.generationConfig, false);

  // Legacy Gemini 2.5 fallback uses temperature instead of thinkingLevel
  const payload25 = buildGenerationPayload({
    modelId: 'gemini-2.5-flash',
    systemInstruction: '시스템',
    contents: [{ role: 'user', parts: [{ text: '안녕' }] }],
  });
  assert.equal('thinkingConfig' in payload25.generationConfig, false);
  assert.equal(typeof payload25.generationConfig.temperature, 'number');
});

test('buildGeminiContents guarantees alternating turns and ALWAYS ends with a user turn', () => {
  const contents = buildGeminiContents([
    { role: 'model', content: '오프닝 장면' },
    { role: 'user', content: '첫 대답' },
    { role: 'user', content: '추가 행동' },
    { role: 'model', content: '캐릭터 대답' },
  ], { continueCue: true });

  assert.equal(contents[0].role, 'user');
  assert.equal(contents[contents.length - 1].role, 'user');
  for (let i = 1; i < contents.length; i++) {
    assert.notEqual(contents[i].role, contents[i - 1].role);
  }
});

test('Streaming tag filter strips <!--CRACK_STATE:...--> across arbitrary chunk boundaries', () => {
  let emitted = '';
  const filter = createStreamingTagFilter((chunk) => {
    emitted += chunk;
  });

  const chunks = [
    '*그가 조용히 웃었다.*\n\n"기다리고 있었어."\n<!',
    '--CRACK_STATE:{"affinityDelta":3,"mood":"설레는 시선"}--',
    '>',
  ];
  for (const c of chunks) filter.push(c);
  const { cleanText, stateUpdate } = filter.finish();

  assert.equal(emitted.includes('CRACK_STATE'), false);
  assert.equal(cleanText.includes('CRACK_STATE'), false);
  assert.equal(stateUpdate.affinityDelta, 3);
  assert.equal(stateUpdate.mood, '설레는 시선');
});

test('Fallback chain starts with requested model, prioritizes fast verified models, excludes dead 2.5-flash, and deduplicates', () => {
  const chainDefault = buildFallbackChain();
  assert.equal(chainDefault[0], 'gemini-3.5-flash-lite');
  assert.equal(chainDefault.includes('gemini-2.5-flash'), false);
  const chain = buildFallbackChain('gemini-3.8-flash');
  assert.equal(chain[0], 'gemini-3.8-flash');
  assert.ok(chain.includes('gemini-3.5-flash-lite'));
  assert.equal(new Set(chain).size, chain.length);
});

test('parseStateTag clamps affinity delta to [-5, 6]', () => {
  const res = parseStateTag('본문 텍스트\n<!--CRACK_STATE:{"affinityDelta":99,"mood":"극대노"}-->');
  assert.equal(res.cleanText, '본문 텍스트');
  assert.equal(res.stateUpdate.affinityDelta, 6);
});

test('QR SVG generator produces valid crisp SVG markup', () => {
  const svg = generateQrSvg('http://192.168.0.10:8787');
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('<rect '));
  assert.ok(svg.endsWith('</svg>'));
});

test('HTTP server API & SSE streaming end-to-end flow', async (t) => {
  const server = createAppServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  // 1. Health & Characters (8 Originals + 36 Major Anime = 44 total)
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.ok(health.characterCount >= 40, `Expected >= 40 characters, got ${health.characterCount}`);

  const chars = await fetch(`${base}/api/characters`).then((r) => r.json());
  assert.equal(chars.characters.length, health.characterCount);
  assert.ok(Array.isArray(chars.animeCategories) && chars.animeCategories.length >= 5);

  // Verify every single built-in character/anime avatar asset returns HTTP 200
  const uniqueAvatars = [...new Set(chars.characters.map((c) => c.avatar))];
  for (const avatarUrl of uniqueAvatars) {
    const imgRes = await fetch(`${base}${avatarUrl}`);
    assert.equal(imgRes.status, 200, `Missing avatar asset: ${avatarUrl}`);
  }

  // 1.5. Test Instant Anime Summoner (POST /api/anime/summon)
  const summonRes = await fetch(`${base}/api/anime/summon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      animeTitle: '베르세르크',
      targetCharacter: '가츠',
      playStyle: 'character',
      extraPrompt: '황금시대 편 전야',
    }),
  }).then((r) => r.json());
  assert.equal(summonRes.character.isAnime, true);
  assert.equal(summonRes.character.animeTitle, '베르세르크');
  assert.ok(summonRes.session.id);

  // Verify anime prompt includes Canon vs IF route & world GM instructions
  const animeSysPrompt = buildSystemInstruction({
    character: chars.characters.find((c) => c.id === 'anime_demonslayer_world'),
    session: { ...summonRes.session, storyRoute: 'canon' },
    persona: { name: '현준', description: '귀살대 신입' },
    triggeredLorebooks: [],
  });
  assert.ok(animeSysPrompt.includes('귀멸의 칼날'));
  assert.ok(animeSysPrompt.includes('원작 고증 모드'));

  // 2. Create custom character
  const createdCharRes = await fetch(`${base}/api/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '테스트 캐릭터',
      title: '테스트 스토리',
      genre: 'fantasy',
      personaPrompt: '테스트 성격',
      openingMessage: '*테스트 오프닝* "안녕, {{user}}!"',
      lorebook: [{ title: '테스트 로어', keywords: '마법석', content: '전설의 보석' }],
    }),
  }).then((r) => r.json());
  assert.equal(createdCharRes.character.name, '테스트 캐릭터');

  // 3. Create Session & stream reply (demo preview mode without API key)
  const sessRes = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId: createdCharRes.character.id }),
  }).then((r) => r.json());
  assert.ok(sessRes.session.id);

  const streamRes = await fetch(`${base}/api/sessions/${sessRes.session.id}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'send', text: '마법석에 대해 알려줘!' }),
  });
  assert.equal(streamRes.status, 200);
  const sseText = await streamRes.text();
  assert.ok(sseText.includes('event: start'));
  assert.ok(sseText.includes('테스트 로어'));
  assert.ok(sseText.includes('event: delta'));
  assert.ok(sseText.includes('event: done'));

  // 4. Verify session persisted user + AI turn & affinity updated
  const reloaded = await fetch(`${base}/api/sessions/${sessRes.session.id}`).then((r) => r.json());
  assert.equal(reloaded.session.messages.length, 3);
  assert.ok(reloaded.session.affinity > 35);

  // 5. Export markdown
  const mdRes = await fetch(`${base}/api/sessions/${sessRes.session.id}/export`);
  assert.equal(mdRes.status, 200);
  const mdText = await mdRes.text();
  assert.ok(mdText.includes('테스트 스토리'));

  // 6. System instruction integrates userNote
  const sysPrompt = buildSystemInstruction({
    character: createdCharRes.character,
    session: { ...reloaded.session, userNote: '절대 반말 사용' },
    persona: { name: '현준', description: '주인공' },
    triggeredLorebooks: [],
  });
  assert.ok(sysPrompt.includes('절대 반말 사용'));

  // 7. Reset session back to opening turn & Clear all sessions
  const resetRes = await fetch(`${base}/api/sessions/${sessRes.session.id}/reset`, {
    method: 'POST',
  }).then((r) => r.json());
  assert.equal(resetRes.session.messages.length, 1);
  assert.equal(resetRes.session.messages[0].isOpening, true);
  assert.equal(resetRes.session.affinity, 35);

  const clearRes = await fetch(`${base}/api/sessions`, { method: 'DELETE' }).then((r) => r.json());
  assert.equal(clearRes.cleared, true);
  const afterClear = await fetch(`${base}/api/sessions`).then((r) => r.json());
  assert.equal(afterClear.sessions.length, 0);
});

test('Netlify Cloud Function handler responds to health and enforces API key checks', async () => {
  const { default: handler, config } = await import('../netlify/functions/gemini.mjs');
  assert.ok(Array.isArray(config.path));
  assert.ok(config.path.includes('/api/cloud/health'));

  const healthRes = await handler(new Request('https://crack-ai.netlify.app/api/cloud/health', { method: 'GET' }));
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.runtime, 'netlify-cloud');
  assert.equal(healthJson.defaultModel, 'gemini-3.5-flash-lite');

  // Verify missing API key returns 400 cleanly
  const verifyRes = await handler(
    new Request('https://crack-ai.netlify.app/api/cloud/gemini/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),
    })
  );
  assert.equal(verifyRes.status, 400);

  // Stream without key returns 401 cleanly
  const streamRes = await handler(
    new Request('https://crack-ai.netlify.app/api/cloud/gemini/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [] }),
    })
  );
  assert.equal(streamRes.status, 401);
});

test('API key sanitizer strips quotes, prefixes, whitespace and detects HTTP 400 API_KEY_INVALID', () => {
  assert.equal(sanitizeApiKey('  GEMINI_API_KEY="AIzaSyTestKey12345" \n'), 'AIzaSyTestKey12345');
  assert.equal(sanitizeApiKey('AIzaSy••••••1234'), '');
  assert.equal(isInvalidKeyError(400, 'API key not valid. Please pass a valid API key.'), true);
  assert.equal(isInvalidKeyError(401, 'Unauthorized'), true);
  assert.equal(isInvalidKeyError(429, 'Quota exceeded'), false);
});

test('parseStateTag parses live nation governance stats AND inline suggested choices', () => {
  const res = parseStateTag(
    '집무실 브리핑 본문\n<!--CRACK_STATE:{"affinityDelta":2,"mood":"개혁 추진","nation":{"name":"대한민국","date":"2026년 3월 (2턴)","power":79,"treasury":"660조 원","approval":64,"military":85,"stability":73},"choices":["비서실장에게 세부 보고를 요구한다.","\'지금 바로 대국민 담화를 준비해.\'","야당 원내대표에게 직접 전화를 건다."]}-->'
  );
  assert.equal(res.cleanText, '집무실 브리핑 본문');
  assert.equal(res.stateUpdate.nation.name, '대한민국');
  assert.equal(res.stateUpdate.nation.approval, 64);
  assert.equal(res.stateUpdate.nation.power, 79);
  assert.equal(res.stateUpdate.choices.length, 3);
  assert.equal(res.stateUpdate.choices[1], '"지금 바로 대국민 담화를 준비해."');

  // Verify novel system instruction forbids AI clichés, prevents 1st-person hijacking when persona is "나", and requests inline choices
  const novelPrompt = buildSystemInstruction({
    character: { name: '고죠 사토루', personaPrompt: '최강 주술사', genreLabel: '애니' },
    session: { affinity: 50, mood: '흥미' },
    persona: { name: '나', description: '주술고전 1학년' },
    triggeredLorebooks: [],
    viewMode: 'novel',
  });
  assert.ok(novelPrompt.includes('별표(*)'));
  assert.ok(novelPrompt.includes('진지한 서사 몰입'));
  assert.ok(novelPrompt.includes('연재 스토리 아크'));
  assert.ok(novelPrompt.includes('실제 실패 허용 규칙'));
  assert.ok(novelPrompt.includes('choices'));
});

test('Story Arc, Fate Judgment (real failure rolls), and Multi-Ending engine work reliably', () => {
  // 1. Story Arc tracks Acts 1-4 and Final Turn accurately
  const arc1 = computeStoryArc({ storyLength: 'standard', targetTurns: 14, messages: [{ role: 'model' }, { role: 'user' }] });
  assert.equal(arc1.actIndex, 1);
  assert.equal(arc1.isFinalTurn, false);
  const arcFinal = computeStoryArc({
    storyLength: 'short',
    targetTurns: 8,
    messages: Array.from({ length: 8 }, () => ({ role: 'user', content: '행동' })),
  });
  assert.equal(arcFinal.actIndex, 4);
  assert.equal(arcFinal.isFinalTurn, true);

  // 2. Deterministic low fate roll produces explicit Failure directive (no plot armor!)
  const failRoll = rollFateJudgment({
    session: { difficulty: 'real', affinity: 40, messages: [{ role: 'user' }, { role: 'user' }] },
    character: { name: '서도현' },
    rng: () => 0.05,
  });
  assert.equal(failRoll.outcome, 'fail');
  assert.ok(failRoll.directive.includes('명백한 실패'));

  // 3. Parse outcome + ending object from CRACK_STATE tag
  const parsedEnd = parseStateTag(
    '에필로그 본문\n<!--CRACK_STATE:{"affinityDelta":-6,"mood":"탄핵 실각","outcome":"fail","ending":{"type":"bad","code":"BAD ENDING · 탄핵","title":"무너진 집무실","summary":"민심 이반으로 결국 정권이 붕괴했다."},"choices":[]}-->'
  );
  assert.equal(parsedEnd.cleanText, '에필로그 본문');
  assert.equal(parsedEnd.stateUpdate.outcome, 'fail');
  assert.equal(parsedEnd.stateUpdate.ending.type, 'bad');
  assert.equal(parsedEnd.stateUpdate.ending.title, '무너진 집무실');

  // 4. Fatal collapse auto-triggers Bad Ending even if LLM omits ending JSON
  const autoBad = resolveSessionEnding({
    character: { isNationSim: true, name: '국가의 시대' },
    nextNationState: { name: '대한민국', approval: 8, stability: 15, power: 40, military: 50 },
    storyArc: { turn: 4, targetTurns: 14, isEndless: false, isFinalTurn: false },
    aiEnding: null,
  });
  assert.equal(autoBad.type, 'bad');
  assert.ok(autoBad.title.includes('탄핵'));

  // 5. Final turn guarantees ending resolution
  const autoTrue = resolveSessionEnding({
    character: { isNationSim: false, name: '아델라이드' },
    nextAffinity: 88,
    storyArc: { turn: 14, targetTurns: 14, isEndless: false, isFinalTurn: true },
    aiEnding: null,
  });
  assert.equal(autoTrue.type, 'true');
});

test('Static web catalog bundle contains all 50 built-in worlds including 《국가의 시대》', () => {
  const catalogPath = new URL('../web/data/catalog.json', import.meta.url);
  assert.equal(fs.existsSync(catalogPath), true, 'web/data/catalog.json must exist (run npm run build:web)');
  const cat = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.equal(cat.characters.length, 50);
  assert.equal(cat.characters.filter((c) => c.isAnime).length, 41);
  assert.ok(cat.characters.some((c) => c.id === 'char_age_of_nations' && c.isNationSim));
  assert.ok(cat.models.some((m) => m.id === 'gemini-3.8-flash'));

  // GitHub Pages subpath safety: all bundled catalog avatars & index.html links must be relative (./)
  for (const c of cat.characters) {
    assert.ok(c.avatar.startsWith('./assets/'), `Avatar must be relative for GitHub Pages subpath: ${c.avatar}`);
  }
  const indexHtml = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal(/href="\/(css|assets|manifest)/.test(indexHtml), false, 'index.html should not use root-absolute asset hrefs');
  assert.equal(/src="\/(js|assets)/.test(indexHtml), false, 'index.html should not use root-absolute asset srcs');
  assert.equal(fs.existsSync(new URL('../web/.nojekyll', import.meta.url)), true);
});

test('Theme switching (True Black Dark Mode #000000 & Light Mode) persists via /api/config and CSS tokens', async () => {
  const server = createAppServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const cfg0 = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg0.theme, 'dark');

    const cfgLight = await (
      await fetch(`${base}/api/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'light' }),
      })
    ).json();
    assert.equal(cfgLight.theme, 'light');

    const cfgDark = await (
      await fetch(`${base}/api/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' }),
      })
    ).json();
    assert.equal(cfgDark.theme, 'dark');

    const css = fs.readFileSync(new URL('../web/css/styles.css', import.meta.url), 'utf8');
    assert.ok(css.includes('--bg-0: #000000;'), 'Dark mode must use true pure black #000000');
    assert.ok(css.includes(':root[data-theme="light"]'), 'Light mode CSS token overrides must exist');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('startServer resolves actual bound port for ephemeral port 0 (Windows fallback) and serves index', async () => {
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    assert.ok(started.port > 0, 'Ephemeral port must resolve to actual non-zero port');
    const health = await (await fetch(`http://127.0.0.1:${started.port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.port, started.port);
    const homeRes = await fetch(`http://127.0.0.1:${started.port}/`);
    assert.equal(homeRes.status, 200);
    const html = await homeRes.text();
    assert.ok(html.includes('CRACK'));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});


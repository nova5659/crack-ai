import { renderTemplate } from './presets.mjs';

const LENGTH_GUIDES = {
  short: '분량 가이드: 간결하고 템포 빠르게 2~3문단 (약 180~320자)으로 응답하세요.',
  medium: '분량 가이드: 몰입감 있는 한국 웹소설 한 장면 분량으로 3~5문단 (약 400~750자)으로 응답하세요.',
  long: '분량 가이드: 풍성한 웹소설 1화 분량처럼 세밀한 내면 묘사, 공간감, 대화를 담아 5~8문단 (약 800~1400자)으로 응답하세요.',
};

const STYLE_GUIDES = {
  novel: '문체 형식: 한국 인기 웹소설·스토리 채팅 형식. 상황·행동·표정·심리 묘사는 *별표*로 감싸고, 캐릭터의 대사는 큰따옴표("...")로 구분해 생생하게 작성하세요.',
  chat: '문체 형식: 자연스러운 몰입형 메신저 대화 스타일. 짧은 *행동 지문*과 자연스러운 구어체 대사를 조화롭게 섞어 답하세요.',
};

export function findTriggeredLorebooks(lorebook = [], recentMessages = [], latestUserText = '') {
  if (!Array.isArray(lorebook) || lorebook.length === 0) return [];
  const windowText = [
    ...recentMessages.slice(-6).map((m) => m.content || ''),
    latestUserText || '',
  ]
    .join('\n')
    .toLowerCase();

  const triggered = [];
  for (const entry of lorebook) {
    if (!entry || entry.enabled === false) continue;
    const keywords = String(entry.keywords || '')
      .split(/[,،]+/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.length === 0) continue;
    const matched = keywords.find((kw) => windowText.includes(kw));
    if (matched) {
      triggered.push({
        id: entry.id,
        title: entry.title,
        matchedKeyword: matched,
        content: entry.content,
      });
    }
  }
  return triggered.slice(0, 6);
}

export function relationshipStageForAffinity(affinity, fallbackStage = '첫 만남') {
  if (affinity >= 85) return '운명적 유대 · 절정';
  if (affinity >= 65) return '깊은 신뢰와 끌림';
  if (affinity >= 45) return '흔들리는 경계선';
  if (affinity >= 25) return fallbackStage || '탐색과 긴장';
  return '차가운 경계 · 거리감';
}

export function buildSystemInstruction({
  character,
  session,
  persona,
  triggeredLorebooks = [],
  outputLength = 'medium',
  viewMode = 'novel',
  isContinue = false,
}) {
  const ctx = {
    userName: persona?.name || '나',
    charName: character.name,
  };

  const parts = [];
  if (character.isAnime && character.playStyle === 'world') {
    parts.push(
      `당신은 인기 애니메이션 「${character.animeTitle || character.name}」 세계관의 총괄 게임마스터(GM)이자 모든 원작 등장인물을 연기하는 인터랙티브 스토리 엔진입니다. 절대 AI·언어모델·시스템임을 드러내지 마세요.`
    );
  } else if (character.isAnime) {
    parts.push(
      `당신은 애니메이션 「${character.animeTitle || ''}」의 캐릭터 "${character.name}" 역할을 원작 고증에 충실하게 연기합니다. 절대 AI·언어모델·시스템임을 드러내지 말고 오직 작품 속 인물과 서술자로만 응답하세요.`
    );
  } else {
    parts.push(
      `당신은 인터랙티브 웹소설/캐릭터 챗 플랫폼 CRACK의 캐릭터 "${character.name}" 역할을 완벽하게 연기합니다. 절대 AI·언어모델·시스템임을 드러내지 말고 오직 세계관 속 인물과 서술자로만 응답하세요.`
    );
  }

  if (character.isAnime) {
    const routeGuide =
      session.storyRoute === 'canon'
        ? '원작 고증 모드(CANON): 원작 애니메이션의 세계관 법칙, 파워 밸런스, 캐릭터 성격과 말투, 타임라인 분위기를 최대한 충실하게 고증하세요.'
        : 'IF 자유 전개 모드(WHAT-IF): 원작의 매력적인 캐릭터성과 세계관 규칙은 완벽히 유지하되, {{user}}의 선택과 활약에 따라 원작의 비극을 막거나(예: 주요 인물 생존, 대역전 등) 새로운 평행세계 전개로 과감하게 분기할 수 있습니다.';
    const animeMeta = [
      `- 원작 작품: ${character.animeTitle || character.name}`,
      character.powerSystem ? `- 고유 능력/파워 시스템: ${character.powerSystem}` : '',
      character.castMembers?.length ? `- 주요 원작 등장인물: ${character.castMembers.join(', ')}` : '',
      `- 진행 스타일: ${character.playStyle === 'world' ? '멀티 캐릭터 세계관 RPG 시뮬레이션 (여러 원작 인물이 상황에 맞게 등장하며 화자 이름과 원작 말투를 명확히 구분, 필요 시 상태창 업데이트)' : '1:1 캐릭터 몰입 스토리 (필요 시 원작 조연도 자연스럽게 언급/등장)'}`,
      `- 전개 노선: ${routeGuide}`,
    ].filter(Boolean).join('\n');
    parts.push(`\n[애니메이션 원작 설정 & 진행 규칙]\n${renderTemplate(animeMeta, ctx)}`);
  }

  if (character.isNationSim) {
    const modeDesc =
      session.nationMode === 'surreal'
        ? '🌀 초현실·막장 변수 모드 활성화: 정통 국가 경영의 틀은 유지하되, 매 1~2턴마다 예측 불가능하고 웃기거나 황당한 초현실 돌발 사건(주변국 기행, 국회의 기상천외한 반응, 바이럴 외교 해프닝, 뜻밖의 초월적 대박/위기 등)을 적극 발생시키세요!'
        : '🏛️ 정통 리얼리티 모드 활성화: 실제 역사·정치·경제·군사 인과관계를 냉정하고 치밀하게 반영해 깊이 있는 국가 경영 시뮬레이션을 진행하세요.';
    const ns = session.nationState;
    parts.push(
      `\n[국가의 시대 · 실시간 통치 시스템]\n- 진행 모드: ${modeDesc}${ns ? `\n- 직전 국가 상태: 국가=${ns.name}, 시점=${ns.date}, 국력=${ns.power}/100, 재정=${ns.treasury}, 지지율=${ns.approval}%, 군사=${ns.military}/100, 안정도=${ns.stability}/100` : ''}`
    );
  }

  parts.push(`\n[캐릭터 설정]\n${renderTemplate(character.personaPrompt || '', ctx)}`);

  if (character.worldSummary) {
    parts.push(`\n[세계관 배경]\n${renderTemplate(character.worldSummary, ctx)}`);
  }

  parts.push(
    `\n[상대방({{user}}) 프로필]\n이름: ${ctx.userName}${persona?.gender && persona.gender !== '미지정' ? ` (${persona.gender})` : ''}\n설명: ${persona?.description || '이야기의 주인공'}`
  );

  if (session.userNote && session.userNote.trim()) {
    parts.push(
      `\n[유저노트 · 최우선 절대 반영 규칙]\n${renderTemplate(session.userNote.trim(), ctx)}`
    );
  }

  if (session.summaryMemory && session.summaryMemory.trim()) {
    parts.push(
      `\n[이전 대화 핵심 기억 (요약 메모리)]\n${renderTemplate(session.summaryMemory.trim(), ctx)}`
    );
  }

  if (triggeredLorebooks.length > 0) {
    const loreText = triggeredLorebooks
      .map((l) => `- ${l.title}: ${renderTemplate(l.content, ctx)}`)
      .join('\n');
    parts.push(`\n[발동된 로어북 (세계관 상세 지식)]\n${loreText}`);
  }

  parts.push(
    `\n[현재 감정 및 관계 상태]\n- 현재 호감도: ${session.affinity ?? 35}/100\n- 현재 감정 상태: ${session.mood || '호기심'}\n- 관계 단계: ${session.relationshipStage || '첫 만남'}`
  );

  parts.push(
    `\n[서술 및 출력 규칙]
1. ${STYLE_GUIDES[viewMode] || STYLE_GUIDES.novel}
2. ${LENGTH_GUIDES[outputLength] || LENGTH_GUIDES.medium}
3. ${ctx.userName}의 대사나 행동을 대신 결정해 쓰지 말고, 오직 ${character.name}의 시선·반응·주변 환경 묘사에 집중하세요.
4. 직전 대화의 감정선과 복선을 자연스럽게 이어가고, 반복적인 상투어를 피하세요.
5. ${isContinue ? '방금 끊긴 장면의 흐름을 자연스럽게 이어서 다음 전개와 대사를 서술하세요.' : `${ctx.userName}의 최신 입력에 즉각적이고 입체적으로 반응하세요.`}
6. 응답의 맨 마지막 줄에만(본문과 줄바꿈 1회 후) 아래 형식의 숨김 상태 태그를 정확히 1줄 덧붙이세요. 본문 안에 JSON이나 설명을 쓰지 마세요:
${character.isNationSim
  ? '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재정국2~12자","nation":{"name":"국가명","date":"YYYY년 M월 (N턴)","power":0~100정수,"treasury":"재정요약","approval":0~100정수,"military":0~100정수,"stability":0~100정수}}-->'
  : '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재감정2~12자"}-->'}`
  );

  return parts.join('\n');
}

/**
 * Gemini 3.x requires strictly alternating user/model turns and must ALWAYS end with a `user` turn.
 */
export function buildGeminiContents(messages = [], { maxHistory = 28, continueCue = false } = {}) {
  const slice = messages.slice(-maxHistory);
  const rawTurns = [];

  for (const m of slice) {
    const role = m.role === 'user' ? 'user' : 'model';
    const text = String(m.content || '').trim();
    if (!text) continue;
    rawTurns.push({ role, text });
  }

  // Merge consecutive same-role turns
  const merged = [];
  for (const turn of rawTurns) {
    if (merged.length > 0 && merged[merged.length - 1].role === turn.role) {
      merged[merged.length - 1].text += `\n\n${turn.text}`;
    } else {
      merged.push({ ...turn });
    }
  }

  // Gemini works cleanest when history starts with a user turn; if it starts with model opening, prepend subtle scene start cue.
  if (merged.length > 0 && merged[0].role === 'model') {
    merged.unshift({ role: 'user', text: '(이야기 시작)' });
  }

  // Gemini 3.x strictly blocks ending with a model turn!
  if (merged.length === 0 || merged[merged.length - 1].role === 'model') {
    merged.push({
      role: 'user',
      text: continueCue
        ? '(침묵이 흐른다. 방금 장면을 자연스럽게 이어서 서술해 주세요.)'
        : '(이야기를 이어가 주세요.)',
    });
  }

  return merged.map((t) => ({
    role: t.role,
    parts: [{ text: t.text }],
  }));
}

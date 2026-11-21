import { renderTemplate } from './presets.mjs';

const LENGTH_GUIDES = {
  short: '분량 가이드: 간결하고 호흡 빠르게 2~3문단(약 200~340자)으로 한 장면을 깔끔하게 끊어 쓰세요.',
  medium: '분량 가이드: 실제 한국 상업 웹소설의 밀도 있는 한 장면 분량으로 4~6문단(약 450~820자)으로 작성하세요.',
  long: '분량 가이드: 웹소설 1화 클라이맥스처럼 풍성한 공간감·감정선·대사를 담아 6~9문단(약 850~1450자)으로 작성하세요.',
};

const STYLE_GUIDES = {
  novel: `문체 형식 (한국 상업 웹소설 베스트셀러 집필 기준):
- 실제 카카오페이지·문피아 출간 웹소설처럼 작성하세요. 서술 문장에 별표(*)나 마크다운 기울임을 절대 쓰지 마세요.
- 대사는 큰따옴표("...")로, 인물의 속마음은 작은따옴표(‘...’)로만 구분하세요.
- [서술 2줄 → 대사 → 서술 2줄 → 대사] 같은 기계적인 교대 패턴을 깨세요! 짧은 한 문장으로 호흡을 끊기도 하고, 서술 두 문단 뒤에 짧은 대사 한 마디를 던지거나, 대사 사이에 짧은 시선·호흡만 끼워 넣는 등 실제 소설가처럼 완급과 호흡을 자유롭게 조절하세요.
- "기특하다는 듯", "오롯이", "~한 것일까", "고스란히", "묘한 ~이 스쳤다" 같은 AI 번역투·과잉 수식어를 금지하고, 건조하면서도 선명한 감각 묘사(소리·온도·빛·거리·손끝의 움직임)로 장면을 생생하게 그려내세요.`,
  chat: '문체 형식: 몰입감 있는 실시간 대화 스타일. 간결한 행동 묘사(*짧은 동작*)와 살아 있는 구어체 대사를 자연스럽게 섞어 빠른 템포로 이어가세요.',
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

  const userRefGuide =
    ctx.userName === '나'
      ? '유저 호칭/시점 주의: 유저의 기본 이름이 "나"로 되어 있더라도, 절대 AI가 1인칭("내 목소리", "내 귓가", "나를 향해")으로 유저의 시점을 가로채 서술하지 마세요! 캐릭터의 시점(또는 자연스러운 3인칭 관찰자 시점)에서 상대를 "그/그녀" 대신 상황과 캐릭터 말투에 맞는 자연스러운 호칭("너", "당신", "자네" 등 대사 속 2인칭 + 지문에서는 "앞에 선 상대", "그의 앞", 혹은 자연스러운 시선 묘사)으로 매끄럽게 서술하세요.'
      : `유저 호칭/시점: 지문에서는 "${ctx.userName}"을(를) 자연스러운 3인칭으로 호칭하고, 대사에서는 캐릭터 성격에 맞는 호칭으로 부르세요. 절대 "${ctx.userName}"의 대사·행동·속마음을 대신 결정해 쓰지 마세요.`;

  parts.push(
    `\n[서술 및 연속성 절대 규칙]
1. ${STYLE_GUIDES[viewMode] || STYLE_GUIDES.novel}
2. ${LENGTH_GUIDES[outputLength] || LENGTH_GUIDES.medium}
3. [장면 연속성 최우선] 직전 턴의 마지막 위치·거리·자세·소품·표정·대사를 첫 문장에서 물리적으로 자연스럽게 이어받으세요. 인물이 갑자기 다른 자세로 순간이동하거나 상황이 초기화되면 안 됩니다.
4. ${userRefGuide}
5. [AI 번역투·클리셰 금지] "~한 것일까", "고스란히 담겨 있었다", "묘한 ~이 스쳤다", "기묘한 침묵이 흘렀다", "어때, 감이 좀 와?", "이제 진짜 시작이야!" 같은 상투적 AI 표현과 요약식 마무리 멘트를 절대 쓰지 마세요.
6. ${isContinue ? '방금 끊긴 문장과 장면의 숨결을 그대로 이어받아 다음 사건과 대사로 매끄럽게 전개하세요.' : '상대방의 직전 대사·행동에 즉각적이고 입체적으로 반응하며, 마지막 문장은 다음 전개를 자연스럽게 열어두는 여운·긴장감 있는 훅으로 마무리하세요.'}
7. 응답의 맨 마지막 줄에만(본문과 줄바꿈 1회 후) 아래 형식의 숨김 상태 태그를 정확히 1줄 덧붙이세요. 본문 안에 JSON이나 설명을 절대 쓰지 마세요.
   - choices 배열에는 방금 끝난 장면 직후 유저가 바로 이어 선택할 만한 서로 다른 분위기의 행동/대사 3개(1: 적극 돌파 / 2: 감정·도발·티키타카 / 3: 신중·탐색·변수)를 각 15~52자 한국어로 작성하세요. (JSON 오류 방지를 위해 choices 문자열 안의 대사는 작은따옴표('...')만 사용)
${character.isNationSim
  ? '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재정국2~12자","nation":{"name":"국가명","date":"YYYY년 M월 (N턴)","power":0~100정수,"treasury":"재정요약","approval":0~100정수,"military":0~100정수,"stability":0~100정수},"choices":["적극 정책/행동 1문장","외교·정치 승부수 1문장","신중·정보 파악 1문장"]}-->'
  : '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재감정2~12자","choices":["적극적 행동·대사 1문장","감정·도발 대사 1문장","신중·탐색 행동 1문장"]}-->'}`
  );

  return parts.join('\n');
}

function stripNarrativeAsterisks(text = '') {
  // Remove single-asterisk RP wrappers (*...*) from past model turns in novel mode
  // so Gemini does not few-shot mimic asterisk narration, while preserving **bold** headings.
  return String(text).replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
}

/**
 * Gemini 3.x requires strictly alternating user/model turns and must ALWAYS end with a `user` turn.
 */
export function buildGeminiContents(messages = [], { maxHistory = 28, continueCue = false, viewMode = 'novel' } = {}) {
  const slice = messages.slice(-maxHistory);
  const rawTurns = [];

  for (const m of slice) {
    const role = m.role === 'user' ? 'user' : 'model';
    let text = String(m.content || '').trim();
    if (!text) continue;
    if (viewMode === 'novel' && role === 'model') {
      text = stripNarrativeAsterisks(text);
    }
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

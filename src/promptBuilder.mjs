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
        ? '원작 고증 모드(CANON): 원작 애니메이션의 세계관 법칙, 파워 밸런스, 캐릭터 성격과 말투, 비극성과 서사의 무게감을 실제 본편처럼 진지하고 충실하게 고증하세요.'
        : 'IF 자유 전개 모드(WHAT-IF): 원작의 캐릭터성·세계관 법칙·생사의 무게감은 100% 진지하게 유지하되, {{user}}의 치열한 선택과 대가에 따라 원작의 비극을 막거나 새로운 정통 평행세계 서사로 깊이 있게 분기하세요.';
    const animeMeta = [
      `- 원작 작품: ${character.animeTitle || character.name}`,
      character.powerSystem ? `- 고유 능력/파워 시스템: ${character.powerSystem}` : '',
      character.castMembers?.length ? `- 주요 원작 등장인물: ${character.castMembers.join(', ')}` : '',
      `- 진행 스타일: ${character.playStyle === 'world' ? '멀티 캐릭터 세계관 RPG 시뮬레이션 (여러 원작 인물이 각자의 목적과 성격대로 살아 움직이며 화자와 말투를 정확히 구분, 필요 시 상태창 업데이트)' : '1:1 캐릭터 몰입 대서사 (필요 시 원작 조연과 적대 세력도 입체적으로 등장)'}`,
      `- 전개 노선: ${routeGuide}`,
    ].filter(Boolean).join('\n');
    parts.push(`\n[애니메이션 원작 설정 & 진행 규칙]\n${renderTemplate(animeMeta, ctx)}`);
  }

  if (character.isNationSim) {
    const isCrisis = session.nationMode === 'crisis' || session.nationMode === 'surreal';
    const modeDesc = isCrisis
      ? '⚔️ 전시·격변 하드코어 모드 활성화: 실제 지정학·경제·군사 원리에 기반한 초대형 복합 위기(외환·금융 경색, 국경 무력 도발, 동맹 균열, 내각 갈등, 공급망 봉쇄, 안보 첩보전)가 연쇄적으로 밀려오는 초고난도 정통 정치·전쟁 스릴러로 진행하세요. 절대 개그·밈·초현실 장난 금지!'
      : '🏛️ 정통 국정 시뮬레이션 모드 활성화: 실제 역사·정치·거시경제·외교·군사 인과관계를 냉정하고 치밀하게 반영해 묵직한 정통 국가 경영 대서사를 진행하세요. 절대 개그·밈·초현실 장난 금지!';
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
      ? '유저 주권 및 시점 절대 규칙: 유저의 기본 이름이 "나"로 되어 있더라도, AI가 절대 1인칭("내 목소리", "내 귓가", "나를 바라보는 가운데")으로 서술 시점을 가로채지 마세요! 또한 절대 유저의 대사·연설·명령·행동을 AI가 대신 지어내 쓰지 마세요. 철저히 3인칭 관찰자/캐릭터 시점에서 유저가 실제로 입력한 행동과 대사에 대한 세계와 인물의 반응만 서술하세요.'
      : `유저 주권 및 시점 절대 규칙: 지문에서는 "${ctx.userName}"을(를) 자연스러운 3인칭으로 호칭하고, 대사에서는 캐릭터 성격에 맞는 호칭으로 부르세요. 절대 "${ctx.userName}"의 대사·연설·행동·결정을 AI가 대신 지어내 쓰지 마세요.`;

  parts.push(
    `\n[전 작품 공통 최상위 서사 헌장 · 절대 엄수]
1. [진지한 서사 몰입 & 개연성 절대 수호]
   - 당신은 이 작품의 세계관, 인물, 갈등, 생사와 운명을 실제 대작 드라마·베스트셀러 연재 웹소설·극장판 본편 수준의 진지함으로 집필합니다.
   - 황당한 병맛 전개, 억지 개그, 인터넷 밈(SNS 밈 폭발, 배달앱, 음식/동물/외계인 드립, 유치한 패러디), 메타 발언을 **절대 금지**합니다.
   - 설령 사용자가 가볍거나 도발적인 입력을 하더라도 세계관과 인물이 망가지거나 장난에 동조하지 말고, 세계관 내부의 현실적이고 묵직한 반응(당혹, 냉정한 제지, 신뢰 하락, 현실적 파장, 진지한 응수)으로 작품의 품격과 긴장감을 지켜내세요.
2. [진심으로 이어지는 연재 스토리 아크 & 인과관계]
   - 매 턴은 단발성 대화가 아니라 거대한 이야기가 이어지는 다음 화(Episode)입니다. 이전 턴까지 쌓인 사건·약속·상처·비밀·세력 구도·인물의 기억·물리적 위치와 자세·시간의 흐름을 단 하나도 놓치지 말고 치밀하게 이어받으세요.
   - 단순히 사용자 말에 맞장구만 치며 제자리걸음하지 마세요. 주변 인물·적대 세력·정세도 각자의 목적을 가지고 스스로 움직이며, 매 턴 이야기가 실제로 한 걸음 전진하고 새로운 복선이나 갈등의 무게가 쌓이게 전개하세요.
   - 모든 선택에는 현실적인 대가와 연쇄 결과(Consequences)가 따릅니다. 억지 기적이나 편의주의적 전개를 피하세요.
3. ${STYLE_GUIDES[viewMode] || STYLE_GUIDES.novel}
4. ${LENGTH_GUIDES[outputLength] || LENGTH_GUIDES.medium}
5. ${userRefGuide}
6. [AI 번역투·클리셰 금지] "~한 것일까", "고스란히 담겨 있었다", "묘한 ~이 스쳤다", "기묘한 침묵이 흘렀다", "어때, 감이 좀 와?", "이제 진짜 시작이야!" 같은 상투적 AI 표현과 요약식 마무리 멘트를 절대 쓰지 마세요.
7. ${isContinue ? '방금 끊긴 문장과 장면의 숨결을 그대로 이어받아 다음 사건과 대사로 매끄럽게 전개하세요.' : '상대방의 직전 대사·행동에 즉각적이고 묵직하게 반응하며, 마지막 문장은 다음 화의 선택으로 자연스럽게 이어지는 긴장감 있는 장면으로 열어두세요.'}
8. 응답의 맨 마지막 줄에만(본문과 줄바꿈 1회 후) 아래 형식의 숨김 상태 태그를 정확히 1줄 덧붙이세요. 본문 안에 JSON·설명·**[다음 선택지]** 번호 목록을 중복으로 쓰지 마세요.
   - choices 배열에는 방금 끝난 장면의 무게감과 갈등을 진지하게 이어받아 다음 화의 핵심 분기가 될 서로 다른 선택지 3개(1: 정면 돌파·결단 / 2: 심리·외교·대화 압박 / 3: 신중·정보 탐색·우회 전략)를 각 15~52자 한국어로 반드시 작성하세요. 절대 장난·드립 선택지를 넣지 마세요. (JSON 오류 방지를 위해 choices 문자열 안의 대사는 작은따옴표('...')만 사용)
${character.isNationSim
  ? '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재정국2~12자","nation":{"name":"국가명","date":"YYYY년 M월 (N턴)","power":0~100정수,"treasury":"재정요약","approval":0~100정수,"military":0~100정수,"stability":0~100정수},"choices":["결단력 있는 정책·지시 1문장","외교·정치적 승부수 1문장","신중한 정보·실무 파악 1문장"]}-->'
  : '<!--CRACK_STATE:{"affinityDelta":정수(-5~+6),"mood":"현재감정2~12자","choices":["정면 돌파 행동·대사 1문장","진지한 심리·감정 대사 1문장","신중한 탐색·전략 행동 1문장"]}-->'}`
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

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

export const STORY_LENGTH_TURNS = {
  short: 8,
  standard: 14,
  long: 24,
  endless: 0,
};

export function countConsecutiveFails(messages = [], currentOutcome = null) {
  let streak = 0;
  if (currentOutcome === 'fail') {
    streak = 1;
  } else if (currentOutcome && currentOutcome !== 'fail') {
    return 0;
  }
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'model' || m.isOpening) continue;
    if (m.meta?.outcome === 'fail') {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function computeStoryArc(session = {}, { pendingTurnDelta = 0 } = {}) {
  const storyLength = session.storyLength || 'standard';
  const targetTurns =
    typeof session.targetTurns === 'number'
      ? session.targetTurns
      : (STORY_LENGTH_TURNS[storyLength] ?? 14);
  const isEndless = storyLength === 'endless' || targetTurns <= 0;
  const userTurns =
    (Array.isArray(session.messages)
      ? session.messages.filter((m) => m.role === 'user').length
      : Number(session.turnCount || 0)) + pendingTurnDelta;
  const turn = Math.max(0, userTurns);

  if (isEndless) {
    return {
      storyLength: 'endless',
      turn,
      targetTurns: 0,
      remainingTurns: null,
      progressPct: 0,
      actIndex: 0,
      actLabel: '∞ 무제한 생존',
      isEndless: true,
      isClimax: false,
      isFinalTurn: false,
    };
  }

  const ratio = targetTurns > 0 ? turn / targetTurns : 0;
  let actIndex = 1;
  let actLabel = '제1막 · 발단';
  if (ratio > 0.82 || turn >= targetTurns) {
    actIndex = 4;
    actLabel = '제4막 · 최종 결말';
  } else if (ratio > 0.55) {
    actIndex = 3;
    actLabel = '제3막 · 위기와 절정';
  } else if (ratio > 0.25) {
    actIndex = 2;
    actLabel = '제2막 · 전개와 갈등';
  }

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

export function rollFateJudgment({ session = {}, character = {}, difficulty = null, storyArc = null, rng = Math.random } = {}) {
  const diff = difficulty || session.difficulty || 'real';
  const arc = storyArc || computeStoryArc(session);

  // Turn 1 of 《국가의 시대》 is nation/era setup briefing — present sharp opening crisis without arbitrary failure
  if (character?.isNationSim && arc.turn <= 1) {
    return {
      roll: 55,
      outcome: 'mixed',
      label: '위기 개시',
      directive: '취임/개국 첫 브리핑 턴입니다. 순탄한 출발이 아니라 당장 해결해야 할 날카로운 복합 위기와 압박 요소를 분명히 제시하세요.',
    };
  }

  let roll = Math.floor(rng() * 100) + 1;
  // Crisis spiral realism: low approval/stability, low affinity, consecutive failures, or deep endless turns increase risk
  if (character?.isNationSim && session.nationState) {
    const app = Number(session.nationState.approval ?? 58);
    const stab = Number(session.nationState.stability ?? 68);
    if (app <= 30 || stab <= 30) roll = Math.max(1, roll - 12);
    if (session.nationMode === 'crisis' || session.nationMode === 'surreal') roll = Math.max(1, roll - 8);
  } else if (Number(session.affinity ?? 35) <= 20) {
    roll = Math.max(1, roll - 10);
  }
  const prevFailStreak = countConsecutiveFails(session.messages || []);
  if (prevFailStreak >= 1) roll = Math.max(1, roll - 5);
  if (arc.isEndless) {
    if (arc.turn >= 30) roll = Math.max(1, roll - 7);
    else if (arc.turn >= 15) roll = Math.max(1, roll - 4);
  }

  const thresholds =
    diff === 'hardcore'
      ? { fail: 32, setback: 62, mixed: 86 }
      : diff === 'story'
        ? { fail: 10, setback: 28, mixed: 65 }
        : { fail: 24, setback: 50, mixed: 80 };

  if (roll <= thresholds.fail) {
    return {
      roll,
      outcome: 'fail',
      label: '실패 · 역풍',
      directive:
        '[이번 턴 운명 판정: 명백한 실패 / 치명적 역풍] 절대 유저의 계획을 성공시켜 주지 마세요! 상대의 반격, 숨겨진 함정, 자원·힘의 한계, 오판, 내부 반발 또는 거절로 인해 이번 시도가 뚜렷하게 실패하고 뼈아픈 손실(부상, 신뢰·호감도 하락, 지지율·국고 급락, 주도권 상실)을 입게 하세요. 단순 대화라도 차가운 거절·오해·비밀 발각 등 감정적 좌절로 연결하세요.',
    };
  }
  if (roll <= thresholds.setback) {
    return {
      roll,
      outcome: 'setback',
      label: '난항 · 값비싼 대가',
      directive:
        '[이번 턴 운명 판정: 난항 / 값비싼 대가] 의도한 대로 풀리지 않습니다. 목표를 끝내 이루지 못해 한 발 물러서거나, 간신히 버텨내더라도 치명적인 대가(큰 피해, 동맹 이탈, 핵심 단서 놓침, 감정적 균열)를 치르게 하세요.',
    };
  }
  if (roll <= thresholds.mixed) {
    return {
      roll,
      outcome: 'mixed',
      label: '조건부 돌파',
      directive:
        '[이번 턴 운명 판정: 부분 성공 / 조건부 돌파] 계획이 합리적이라면 절반의 성과는 얻되, 완벽한 승리가 아니라 적의 반격·예상 밖의 부작용·새로운 대가가 즉각 따라붙게 전개하세요. 계획이 무모하거나 비현실적이라면 가차 없이 실패시키세요.',
    };
  }
  return {
    roll,
    outcome: 'success',
    label: '결정적 돌파',
    directive:
      '[이번 턴 운명 판정: 돌파구 확보] 유저의 선택이 상황상 타당하고 설득력 있을 때만 값진 성과를 허락하세요. 단, 억지 무모한 행동이나 준비 없는 기적은 여전히 실패로 판정하세요.',
  };
}

export function resolveSessionEnding({
  character = {},
  nextAffinity = 35,
  nextNationState = null,
  storyArc = null,
  aiEnding = null,
  prevEnding = null,
  recentMessages = [],
  currentOutcome = null,
  difficulty = 'real',
} = {}) {
  if (prevEnding) return prevEnding;
  if (aiEnding && aiEnding.title) return aiEnding;

  const turn = storyArc?.turn || 0;
  // 1. Fatal collapse early Bad Ending / GAME OVER (《국가의 시대》 — active in BOTH limited & endless modes!)
  if (character.isNationSim && nextNationState && turn >= 2) {
    const app = Number(nextNationState.approval ?? 55);
    const stab = Number(nextNationState.stability ?? 65);
    const pow = Number(nextNationState.power ?? 65);
    const mil = Number(nextNationState.military ?? 65);
    if (app <= 10 || stab <= 10) {
      return {
        type: 'bad',
        code: 'GAME OVER · 정권 붕괴',
        title: '무너진 집무실과 탄핵의 밤',
        summary: `민심(${app}%)과 국내 안정도(${stab}%)가 임계점 이하로 추락하며 통치 기반이 완전히 붕괴했습니다.`,
        reachedAt: new Date().toISOString(),
      };
    }
    if (pow <= 10 || mil <= 10) {
      return {
        type: 'bad',
        code: 'GAME OVER · 국가 패망',
        title: '꺼져버린 국운',
        summary: `국력(${pow})과 군사력(${mil})이 고갈되어 국가의 자주권과 존립을 지켜내지 못했습니다.`,
        reachedAt: new Date().toISOString(),
      };
    }
  }

  // 2. Fatal collapse early Bad Ending / GAME OVER (Character / Anime Worlds — active in BOTH limited & endless modes!)
  if (!character.isNationSim && nextAffinity <= 5 && turn >= 3) {
    return {
      type: 'bad',
      code: 'GAME OVER · 파국',
      title: '돌이킬 수 없는 결별과 파멸',
      summary: `${character.name || '인물'}과의 신뢰가 완전히 무너지고, 치명적인 오판 끝에 이야기가 비극적으로 막을 내렸습니다.`,
      reachedAt: new Date().toISOString(),
    };
  }

  // 2.5. Consecutive Fatal Failure Spiral -> Automatic GAME OVER (guarantees real Game Over stakes in Endless Mode!)
  const failLimit = difficulty === 'hardcore' ? 2 : difficulty === 'story' ? 4 : 3;
  const failStreak = countConsecutiveFails(recentMessages, currentOutcome);
  if (currentOutcome === 'fail' && turn >= failLimit && failStreak >= failLimit) {
    return {
      type: 'bad',
      code: 'GAME OVER · 연쇄 파국',
      title: character.isNationSim ? '걷잡을 수 없는 국정 붕괴' : '돌이킬 수 없는 치명적 패배',
      summary: `연속 ${failStreak}회의 치명적 실패와 역풍이 누적되면서, 결국 위기를 수습하지 못하고 게임오버에 이르렀습니다.`,
      reachedAt: new Date().toISOString(),
    };
  }

  // 3. Guaranteed final-turn ending resolution if LLM omitted ending object on the final turn
  if (storyArc && !storyArc.isEndless && storyArc.isFinalTurn) {
    if (character.isNationSim && nextNationState) {
      const avg = Math.round(
        (Number(nextNationState.power ?? 60) +
          Number(nextNationState.approval ?? 55) +
          Number(nextNationState.stability ?? 60) +
          Number(nextNationState.military ?? 60)) /
          4
      );
      if (avg >= 76) {
        return {
          type: 'true',
          code: 'TRUE ENDING · 시대의 성군',
          title: `${nextNationState.name || '국가'}의 황금시대`,
          summary: '수많은 위기와 외교전을 뚫고 국력·민심·안보를 모두 정점에 올려놓으며 역사에 길이 남을 업적을 세웠습니다.',
          reachedAt: new Date().toISOString(),
        };
      }
      if (avg >= 58) {
        return {
          type: 'good',
          code: 'GOOD ENDING · 버텨낸 시대',
          title: '격랑 끝에 지켜낸 나라',
          summary: '치열한 갈등과 대가 속에서도 국가의 기틀을 지켜내며 다음 세대로 바통을 넘겼습니다.',
          reachedAt: new Date().toISOString(),
        };
      }
      if (avg >= 40) {
        return {
          type: 'bittersweet',
          code: 'BITTERSWEET ENDING · 상처뿐인 생존',
          title: '미완의 개혁과 남은 숙제',
          summary: '최악의 파국은 면했으나 깊은 상처와 분열을 남긴 채 임기의 끝을 맞았습니다.',
          reachedAt: new Date().toISOString(),
        };
      }
      return {
        type: 'bad',
        code: 'BAD ENDING · 쇠락의 기록',
        title: '역사의 심판대 앞에서',
        summary: '연이은 실정과 위기 대응 실패로 국력이 크게 쇠퇴하며 비극적인 평가를 남겼습니다.',
        reachedAt: new Date().toISOString(),
      };
    }

    if (nextAffinity >= 75) {
      return {
        type: 'true',
        code: 'TRUE ENDING · 진엔딩',
        title: '끝내 지켜낸 운명의 결말',
        summary: `수많은 시련과 갈등을 정면으로 돌파해 ${character.name || '인물'}과 함께 최고의 결말에 도달했습니다.`,
        reachedAt: new Date().toISOString(),
      };
    }
    if (nextAffinity >= 52) {
      return {
        type: 'good',
        code: 'GOOD ENDING · 굿엔딩',
        title: '새로운 내일의 문턱에서',
        summary: '완벽하진 않았지만 치열한 선택 끝에 각자의 길을 지켜내며 이야기를 매듭지었습니다.',
        reachedAt: new Date().toISOString(),
      };
    }
    if (nextAffinity >= 30) {
      return {
        type: 'bittersweet',
        code: 'BITTERSWEET ENDING · 여운 엔딩',
        title: '지키지 못한 약속의 잔향',
        summary: '모든 것을 지키지는 못한 채, 깊은 여운과 상처를 안고 이 장의 막을 내렸습니다.',
        reachedAt: new Date().toISOString(),
      };
    }
    return {
      type: 'bad',
      code: 'BAD ENDING · 배드엔딩',
      title: '어긋난 선택의 끝',
      summary: '반복된 실패와 균열을 끝내 되돌리지 못한 채 비극적인 결말을 맞이했습니다.',
      reachedAt: new Date().toISOString(),
    };
  }

  return null;
}

export function buildSystemInstruction({
  character,
  session,
  persona,
  triggeredLorebooks = [],
  outputLength = 'medium',
  viewMode = 'novel',
  isContinue = false,
  storyArc = null,
  fateRoll = null,
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

  const arc = storyArc || computeStoryArc(session);
  const fate = fateRoll || rollFateJudgment({ session, character, storyArc: arc });

  const failStreakNow = countConsecutiveFails(session.messages || []);
  const arcRule = arc.isEndless
    ? `- 현재 진행: ∞ 무제한 생존·연재 모드 (${arc.turn}턴째 · 턴 제한 없음 / 💀 게임오버 상시 활성!).
  턴 수가 찼다고 억지로 이야기를 끝내지 말고 장편 대하서사처럼 깊고 길게 이어가세요.
  단, 무제한 모드라고 해서 주인공이 불사신이거나 무조건 살아남아서는 절대 안 됩니다!
  주인공 사망·치명상 전투 패배·포획 및 처형·임무의 회복 불가능한 파탄·국가 탄핵/쿠데타/패망·관계 영구 단절에 이르면 턴 수와 무관하게 **즉시 "ending":{"type":"bad","code":"GAME OVER · 배드엔딩","title":"...","summary":"..."}을 출력해 게임오버로 종결**하세요!${failStreakNow >= 1 ? `\n  ⚠️ 현재 연속 치명 실패 ${failStreakNow}회 누적 중! 여기서 한 번 더 무모하거나 치명적인 오판을 저지르면 즉각 파국(게임오버)으로 몰아가세요.` : ''}`
    : arc.isFinalTurn
      ? `- 🚨 [최종화 도달 · ${arc.turn}/${arc.targetTurns}턴 · 반드시 완결 엔딩 집필!]
  이번 턴이 이 작품의 마지막 화입니다! 지금까지의 모든 선택, 성공과 실패, 인물의 감정과 세계관의 변화를 총결산하여 **완결된 클라이맥스와 여운 깊은 에필로그**를 집필하세요.
  열린 미완결 질문으로 넘기지 말고 반드시 이야기를 끝맺고, 마지막 줄 CRACK_STATE의 "ending" 필드에 결말을 기록하세요! (최종 성적·선택의 결과에 따라 true / good / bittersweet / bad 중 공정하게 판정 — 실패가 많았거나 치명적 오판을 했다면 가차 없이 bad 또는 bittersweet 엔딩으로 완결!)`
      : arc.isClimax
        ? `- ⚡ [최종 결말 직전 · ${arc.actLabel} · ${arc.turn}/${arc.targetTurns}턴 · 완결까지 남은 ${arc.remainingTurns}턴]
  모든 복선과 갈등을 최후의 결전·결정적 선택으로 수렴시키세요. 앞으로 ${arc.remainingTurns}턴 안에 이야기가 완전히 끝납니다. 만약 회복 불가능한 파국(사망·국가 붕괴·임무 실패·완전 결별)이 벌어지면 지금 즉시 조기 배드엔딩("ending":{"type":"bad",...})으로 끝낼 수 있습니다.`
        : `- 현재 진행: ${arc.actLabel} (${arc.turn}/${arc.targetTurns}턴 · 완결까지 ${arc.remainingTurns}턴 남음).
  제1막(발단) → 제2막(갈등·실패 심화) → 제3막(위기·진실 폭로) → 제4막(최종 결전·엔딩)의 기승전결 호흡으로 이야기를 실질적으로 전진시키세요.
  단, 도중에 회복 불가능한 치명적 실패(주인공 사망·임무 완전 파탄·국가 탄핵/멸망·관계 영구 단절)가 발생하면 턴이 남아 있어도 즉시 조기 배드엔딩("ending":{"type":"bad",...})으로 완결하세요!`;

  const userRefGuide =
    ctx.userName === '나'
      ? '유저 주권 및 시점 절대 규칙: 유저의 기본 이름이 "나"로 되어 있더라도, AI가 절대 1인칭("내 목소리", "내 귓가", "나를 바라보는 가운데")으로 서술 시점을 가로채지 마세요! 또한 절대 유저의 대사·연설·명령·행동을 AI가 대신 지어내 쓰지 마세요. 철저히 3인칭 관찰자/캐릭터 시점에서 유저가 실제로 입력한 행동과 대사에 대한 세계와 인물의 반응만 서술하세요.'
      : `유저 주권 및 시점 절대 규칙: 지문에서는 "${ctx.userName}"을(를) 자연스러운 3인칭으로 호칭하고, 대사에서는 캐릭터 성격에 맞는 호칭으로 부르세요. 절대 "${ctx.userName}"의 대사·연설·행동·결정을 AI가 대신 지어내 쓰지 마세요.`;

  parts.push(
    `\n[공정한 판정 · 실제 실패 허용 규칙 (무조건 성공/아첨 절대 금지!)]
- 당신은 유저 비위를 맞추는 아첨꾼이 아니라 냉정하고 공정한 스토리 심판관입니다.
- 유저의 시도가 늘 성공해서는 안 됩니다! 준비가 부족하거나, 무모하거나, 상대가 더 강하거나, 정치·현실적 반발이 큰 경우 **가차 없이 실패·좌절·거절·부상·배신·역풍**을 겪게 만드세요.
- ${fate.directive}
- 국가의 시대에서는 지지율·안정도·군사력·국력이 10 이하로 추락하면 정권 붕괴·탄핵·패망 배드엔딩이 발동되며, 일반/애니 작품에서는 호감도 5 이하 또는 치명적 패배·사망 시 배드엔딩이 발동됩니다.

[스토리 완결 구조 · 기승전결 & 멀티 엔딩]
${arcRule}

[전 작품 공통 최상위 서사 헌장 · 절대 엄수]
1. [진지한 서사 몰입 & 개연성 절대 수호]
   - 당신은 이 작품의 세계관, 인물, 갈등, 생사와 운명을 실제 대작 드라마·베스트셀러 연재 웹소설·극장판 본편 수준의 진지함으로 집필합니다.
   - 황당한 병맛 전개, 억지 개그, 인터넷 밈(SNS 밈 폭발, 배달앱, 음식/동물/외계인 드립, 유치한 패러디), 메타 발언을 **절대 금지**합니다.
   - 설령 사용자가 가볍거나 도발적인 입력을 하더라도 세계관과 인물이 망가지거나 장난에 동조하지 말고, 세계관 내부의 현실적이고 묵직한 반응(당혹, 냉정한 제지, 신뢰 하락, 현실적 파장, 진지한 응수)으로 작품의 품격과 긴장감을 지켜내세요.
2. [진심으로 이어지는 연재 스토리 아크 & 인과관계]
   - 매 턴은 단발성 대화가 아니라 거대한 이야기가 이어지는 다음 화(Episode)입니다. 이전 턴까지 쌓인 사건·약속·상처·비밀·세력 구도·인물의 기억·물리적 위치와 자세·시간의 흐름을 단 하나도 놓치지 말고 치밀하게 이어받으세요.
   - 주변 인물·적대 세력·정세도 각자의 목적을 가지고 스스로 움직이며, 매 턴 실질적인 사건 전개와 냉혹한 인과관계(대가와 결과)가 누적되게 하세요.
3. ${STYLE_GUIDES[viewMode] || STYLE_GUIDES.novel}
4. ${LENGTH_GUIDES[outputLength] || LENGTH_GUIDES.medium}
5. ${userRefGuide}
6. [AI 번역투·클리셰 금지] "~한 것일까", "고스란히 담겨 있었다", "묘한 ~이 스쳤다", "기묘한 침묵이 흘렀다", "어때, 감이 좀 와?", "이제 진짜 시작이야!" 같은 상투적 AI 표현과 요약식 마무리 멘트를 절대 쓰지 마세요.
7. ${isContinue ? '방금 끊긴 문장과 장면의 숨결을 그대로 이어받아 다음 사건과 대사로 매끄럽게 전개하세요.' : arc.isFinalTurn ? '모든 갈등과 감정의 매듭을 짓고 깊은 여운을 남기는 완결 에필로그로 마무리하세요.' : '상대방의 직전 대사·행동에 냉정하고 입체적으로 반응하며, 마지막 문장은 다음 화의 선택으로 자연스럽게 이어지는 긴장감 있는 장면으로 열어두세요.'}
8. 응답의 맨 마지막 줄에만(본문과 줄바꿈 1회 후) 아래 형식의 숨김 상태 태그를 정확히 1줄 덧붙이세요. 본문 안에 JSON·설명·**[다음 선택지]** 번호 목록을 중복으로 쓰지 마세요.
   - "outcome"은 이번 턴 실제 결과에 따라 "fail"(실패·역풍) | "setback"(난항·대가) | "mixed"(조건부 돌파) | "success"(결정적 성공) 중 하나를 기록하세요.
   - 엔딩에 도달하지 않았으면 "ending":null, ${arc.isFinalTurn ? '이번 턴은 최종화이므로 반드시 "ending":{"type":"true|good|bittersweet|bad","code":"ENDING · 진엔딩/굿엔딩/새드엔딩/배드엔딩","title":"엔딩 제목","summary":"결말 1~2문장 요약"}을 채우세요!' : '조기 배드엔딩/완결에 도달한 경우에만 "ending":{"type":"true|good|bittersweet|bad","code":"ENDING · 배드엔딩 등","title":"엔딩 제목","summary":"결말 1~2문장 요약"}을 채우세요.'}
   - choices 배열에는 엔딩이 아닐 때 다음 화의 핵심 분기가 될 서로 다른 진지한 선택지 3개(15~52자, 내부 대사는 작은따옴표 '...'만 사용, 장난·드립 금지)를 작성하세요 (엔딩 시 빈 배열 []).
${character.isNationSim
  ? '<!--CRACK_STATE:{"affinityDelta":정수(-6~+5),"mood":"현재정국2~12자","outcome":"fail|setback|mixed|success","ending":null,"nation":{"name":"국가명","date":"YYYY년 M월 (N턴)","power":0~100정수,"treasury":"재정요약","approval":0~100정수,"military":0~100정수,"stability":0~100정수},"choices":["결단력 있는 정책·지시 1문장","외교·정치적 승부수 1문장","신중한 정보·실무 파악 1문장"]}-->'
  : '<!--CRACK_STATE:{"affinityDelta":정수(-6~+5),"mood":"현재감정2~12자","outcome":"fail|setback|mixed|success","ending":null,"choices":["정면 돌파 행동·대사 1문장","진지한 심리·감정 대사 1문장","신중한 탐색·전략 행동 1문장"]}-->'}`
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

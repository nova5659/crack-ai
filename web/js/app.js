import { api } from './api.js';
import { escapeHtml, formatKoreanCount, formatRelativeTime, formatStoryHtml } from './format.js';

const PRESET_AVATARS = [
  './assets/characters/age_of_nations.svg',
  './assets/characters/seodohyun.jpg',
  './assets/characters/adelaide.jpg',
  './assets/characters/baekmuyeong.jpg',
  './assets/characters/yunseoha.jpg',
  './assets/characters/vex.jpg',
  './assets/characters/kangsiwoo.jpg',
  './assets/characters/lumina.jpg',
  './assets/characters/chayujin.jpg',
  './assets/anime/anime_sorcery.jpg',
  './assets/anime/anime_katana.jpg',
  './assets/anime/anime_pirate.jpg',
  './assets/anime/anime_shinobi.jpg',
  './assets/anime/anime_aura.jpg',
  './assets/anime/anime_idol.jpg',
  './assets/anime/anime_titan.svg',
  './assets/anime/anime_frieren.svg',
  './assets/anime/anime_dungeon.svg',
  './assets/anime/anime_sports.svg',
  './assets/anime/anime_vrmmo.svg',
  './assets/anime/anime_edgerunner.svg',
];

const state = {
  view: 'home',
  config: null,
  genres: [],
  animeCategories: [],
  characters: [],
  sessions: [],
  personas: [],

  // Home filters
  activeGenre: 'all',
  sortBy: 'popular',
  searchQuery: '',
  heroIndex: 0,
  heroTimer: null,

  // Anime Hub filters
  activeAnimeCategory: 'all',
  activeAnimePlayStyle: 'all',
  activeAnimeSeries: 'all',

  // Active Chat
  activeSession: null,
  activeCharacter: null,
  activePersona: null,
  viewMode: 'novel',
  fontFamily: 'sans',
  aiMode: 'story',
  outputLength: 'medium',
  isStreaming: false,
  abortController: null,
  editingMsgId: null,

  // Creator
  creatorAvatar: PRESET_AVATARS[0],
  creatorLorebook: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(message, type = 'info') {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all 0.2s ease';
    setTimeout(() => el.remove(), 220);
  }, 3000);
}

// ================================
// BOOTSTRAP
// ================================
async function init() {
  bindStaticEvents();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  try {
    const mode = await api.getRuntimeMode();
    const [cfg, charData, sessData, persData] = await Promise.all([
      api.getConfig(),
      api.getCharacters(),
      api.getSessions(),
      api.getPersonas(),
    ]);
    state.runtimeMode = mode;
    state.config = cfg;
    state.genres = charData.genres || [];
    state.animeCategories = charData.animeCategories || [];
    state.characters = charData.characters || [];
    state.sessions = sessData.sessions || [];
    state.personas = persData.personas || [];

    state.viewMode = cfg.viewMode || 'novel';
    state.fontFamily = cfg.fontFamily || 'sans';
    state.aiMode = cfg.defaultMode || 'story';
    state.outputLength = cfg.outputLength || 'medium';

    renderApiStatus();
    renderGenreTabs();
    renderHeroSpotlight();
    renderHomeCatalog();
    renderAnimeHub();
    renderSidebarSessions();
    renderChatsView();
    renderLibraryView();
    initCreatorDefaults();
    startHeroRotation();
  } catch (err) {
    showToast(`초기화 오류: ${err.message}`, 'error');
  }
}

function bindStaticEvents() {
  // Navigation
  $$('.nav-item, .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      if (target) switchView(target);
    });
  });

  $('#brandHomeBtn').addEventListener('click', () => switchView('home'));
  $('#mobileBrandBtn').addEventListener('click', () => switchView('home'));
  $('#quickCreateBtn').addEventListener('click', () => {
    resetCreatorForm();
    switchView('creator');
  });
  $('#goToAnimeHubBtn').addEventListener('click', () => switchView('anime'));
  $('#chatsExploreBtn').addEventListener('click', () => switchView('home'));

  // Anime Hub Controls
  $('#summonAnimeBtn').addEventListener('click', handleSummonAnime);
  $('#summonAnimeTitle').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSummonAnime();
    }
  });
  $$('.quick-summon-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#summonAnimeTitle').value = chip.dataset.anime || '';
      $('#summonCharName').value = chip.dataset.char || '';
      $('#summonPlayStyle').value = chip.dataset.style || 'character';
      $('#summonAnimeTitle').focus();
    });
  });
  $$('#animePlayStylePills .sort-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#animePlayStylePills .sort-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeAnimePlayStyle = btn.dataset.pstyle;
      renderAnimeHub();
    });
  });

  // Story Route (Canon vs IF)
  $$('#storyRouteToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeSession) return;
      const route = btn.dataset.route;
      $$('#storyRouteToggle .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      try {
        const { session } = await api.updateSession(state.activeSession.id, { storyRoute: route });
        state.activeSession = session;
        showToast(route === 'canon' ? '📚 원작 고증 모드로 전환되었습니다.' : '✨ IF 자유 전개 모드로 전환되었습니다.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Nation Mode (《국가의 시대》 정통 리얼리티 vs 초현실 변수)
  $$('#nationModeToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeSession) return;
      const nmode = btn.dataset.nmode;
      $$('#nationModeToggle .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      try {
        const { session } = await api.updateSession(state.activeSession.id, { nationMode: nmode });
        state.activeSession = session;
        showToast(nmode === 'surreal' ? '🌀 초현실·막장 변수 모드가 활성화되었습니다!' : '🏛️ 정통 리얼리티 모드로 전환되었습니다.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Search & Sort
  $('#globalSearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim().toLowerCase();
    if (state.view === 'anime') {
      renderAnimeHub();
    } else {
      if (state.view !== 'home') switchView('home');
      renderHomeCatalog();
    }
  });

  $$('.sort-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.sort-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.sortBy = btn.dataset.sort;
      renderHomeCatalog();
    });
  });

  // Modals open/close
  $('#sidebarApiBtn').addEventListener('click', openSettingsModal);
  $('#topApiBtn').addEventListener('click', openSettingsModal);
  $('#openSettingsBtn').addEventListener('click', openSettingsModal);
  $('#bannerConnectApiBtn').addEventListener('click', openSettingsModal);
  $('#qrConnectBtn').addEventListener('click', openQrModal);

  $$('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  $$('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.hidden = true;
    });
  });

  // Settings Modal Actions
  $('#verifyApiKeyBtn').addEventListener('click', handleVerifyApiKey);
  $('#saveSettingsBtn').addEventListener('click', handleSaveSettings);
  $('#clearApiKeyBtn').addEventListener('click', handleClearApiKey);
  $('#exportCloudBackupBtn').addEventListener('click', () => {
    api.exportCloudBackup();
    showToast('전체 데이터 백업 파일이 저장되었습니다.');
  });
  $('#importCloudBackupInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        api.importCloudBackup(JSON.parse(reader.result));
        await reloadCharacters();
        await reloadSessions();
        const p = await api.getPersonas();
        state.personas = p.personas || [];
        renderLibraryView();
        showToast('백업 데이터가 복원되었습니다!');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Chat Header & Controls
  $('#chatBackBtn').addEventListener('click', () => {
    if (state.isStreaming && state.abortController) state.abortController.abort();
    switchView('home');
  });

  $$('#viewModeToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setViewMode(btn.dataset.mode);
    });
  });

  $('#chatAiModeSelect').addEventListener('change', (e) => {
    state.aiMode = e.target.value;
    api.updateConfig({ defaultMode: state.aiMode }).catch(() => {});
  });

  const setInspectorOpen = (open) => {
    $('#inspectorDrawer').classList.toggle('open', open);
    const backdrop = $('#inspectorBackdrop');
    if (backdrop) backdrop.hidden = !open || window.innerWidth > 860;
  };
  $('#toggleInspectorBtn').addEventListener('click', () => {
    setInspectorOpen(!$('#inspectorDrawer').classList.contains('open'));
  });
  $('#closeInspectorBtn').addEventListener('click', () => setInspectorOpen(false));
  $('#inspectorBackdrop').addEventListener('click', () => setInspectorOpen(false));

  $$('.insp-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.insp-tab').forEach((t) => t.classList.remove('active'));
      $$('.insp-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#insp-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Chat Composer
  const chatInput = $('#chatInput');
  chatInput.addEventListener('input', () => autoResizeTextarea(chatInput));
  chatInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // Korean IME guard
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendOrStop();
    }
  });
  $('#sendBtn').addEventListener('click', handleSendOrStop);

  $('#toggleSuggestionsBtn').addEventListener('click', toggleSuggestionsTray);
  $('#closeSuggestionsBtn').addEventListener('click', () => {
    $('#suggestionsTray').hidden = true;
    $('#toggleSuggestionsBtn').classList.remove('active');
  });
  $('#refreshSuggestionsBtn').addEventListener('click', () => refreshSuggestions(true));
  $('#continueBtn').addEventListener('click', () => triggerChatStream({ action: 'continue' }));
  $('#regenerateLastBtn').addEventListener('click', () => triggerChatStream({ action: 'regenerate' }));

  $$('#lengthPills .len-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.outputLength = btn.dataset.len;
      $$('#lengthPills .len-pill').forEach((b) => b.classList.toggle('active', b === btn));
      api.updateConfig({ outputLength: state.outputLength }).catch(() => {});
    });
  });

  // Inspector Controls
  $('#sessionPersonaSelect').addEventListener('change', async (e) => {
    if (!state.activeSession) return;
    const personaId = e.target.value;
    try {
      const { session } = await api.updateSession(state.activeSession.id, { personaId });
      state.activeSession = session;
      state.activePersona = state.personas.find((p) => p.id === personaId) || state.personas[0];
      renderMessages();
      showToast(`페르소나가 '${state.activePersona.name}'(으)로 변경되었어요.`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#sessionUserNote').addEventListener('input', (e) => {
    $('#userNoteCounter').textContent = `${e.target.value.length} / 2000`;
  });

  $('#saveUserNoteBtn').addEventListener('click', async () => {
    if (!state.activeSession) return;
    try {
      const { session } = await api.updateSession(state.activeSession.id, {
        userNote: $('#sessionUserNote').value,
      });
      state.activeSession = session;
      showToast('유저노트가 저장되었습니다. 다음 대화부터 즉시 반영됩니다.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#inspAffinityRange').addEventListener('input', (e) => {
    $('#inspAffinityValue').textContent = `${e.target.value} / 100`;
  });

  $('#saveStateBtn').addEventListener('click', async () => {
    if (!state.activeSession) return;
    try {
      const { session } = await api.updateSession(state.activeSession.id, {
        affinity: Number($('#inspAffinityRange').value),
        mood: $('#inspMoodInput').value,
      });
      state.activeSession = session;
      updateChatHeaderHud();
      showToast('감정과 호감도 상태가 반영되었어요.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#autoSummarizeBtn').addEventListener('click', handleAutoSummarize);
  $('#saveSummaryBtn').addEventListener('click', async () => {
    if (!state.activeSession) return;
    try {
      const { session } = await api.updateSession(state.activeSession.id, {
        summaryMemory: $('#sessionSummaryInput').value,
      });
      state.activeSession = session;
      showToast('요약 메모리가 저장되었습니다.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#sessionAddLoreBtn').addEventListener('click', () => {
    if (!state.activeSession) return;
    const nextLore = [
      ...(state.activeSession.lorebook || []),
      {
        id: `lore_${Date.now().toString(36)}`,
        title: '새 세계관 설정',
        keywords: '',
        content: '',
        enabled: true,
      },
    ];
    state.activeSession.lorebook = nextLore;
    renderSessionLorebook();
  });

  $$('#fontFamilyToggle .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFontFamily(btn.dataset.font);
    });
  });

  $('#newSessionSameCharBtn').addEventListener('click', () => {
    if (state.activeCharacter) startNewStory(state.activeCharacter.id);
  });

  $('#exportStoryBtn').addEventListener('click', () => {
    if (!state.activeSession) return;
    api.exportStory(state.activeSession.id);
  });

  $('#editCurrentCharBtn').addEventListener('click', () => {
    if (!state.activeCharacter) return;
    loadCharacterIntoCreator(state.activeCharacter);
    switchView('creator');
  });

  $('#deleteCurrentSessionBtn').addEventListener('click', async () => {
    if (!state.activeSession) return;
    if (!confirm('현재 채팅 기록을 삭제할까요?')) return;
    try {
      await api.deleteSession(state.activeSession.id);
      state.activeSession = null;
      await reloadSessions();
      switchView('chats');
      showToast('채팅방이 삭제되었습니다.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Creator Events
  $('#wizardAutofillBtn').addEventListener('click', handleWizardAutofill);
  $('#creatorAvatarFile').addEventListener('change', handleAvatarUpload);
  $('#creatorAddLoreBtn').addEventListener('click', () => {
    state.creatorLorebook.push({
      id: `lore_${Date.now().toString(36)}`,
      title: '',
      keywords: '',
      content: '',
      enabled: true,
    });
    renderCreatorLorebook();
  });
  $('#creatorForm').addEventListener('submit', handleCreatorSubmit);
  $('#resetCreatorBtn').addEventListener('click', resetCreatorForm);
  $('#exportCharJsonBtn').addEventListener('click', handleExportCharJson);
  $('#importCharJsonInput').addEventListener('change', handleImportCharJson);

  ['charNameInput', 'charTitleInput', 'charSubtitleInput', 'charGenreInput', 'charTagsInput'].forEach((id) => {
    $(`#${id}`).addEventListener('input', renderCreatorLiveCard);
  });

  // Persona Modal
  $('#addPersonaBtn').addEventListener('click', () => openPersonaModal(null));
  $('#personaForm').addEventListener('submit', handlePersonaSubmit);
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(150, el.scrollHeight)}px`;
}

function switchView(target) {
  state.view = target;
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${target}`).classList.add('active');

  $$('.nav-item, .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === target);
  });

  const isChat = target === 'chat';
  $('#globalTopbar').classList.toggle('hidden', isChat);
  $('#mobileTabbar').classList.toggle('hidden', isChat);

  if (target === 'anime') renderAnimeHub();
  if (target === 'chats') renderChatsView();
  if (target === 'library') renderLibraryView();
}

function closeModal(id) {
  $(`#${id}`).hidden = true;
}

// ================================
// API STATUS & SETTINGS
// ================================
function renderApiStatus() {
  const cfg = state.config;
  if (!cfg) return;
  const connected = cfg.hasApiKey;
  const modelLabel = cfg.defaultModel || 'gemini-3.8-flash';

  $('#apiStatusDot').classList.toggle('connected', connected);
  $('#apiStatusTitle').textContent = connected ? modelLabel : 'Gemini 무료 API 연결';
  $('#apiStatusSub').textContent = connected
    ? `연결됨 (${cfg.maskedApiKey})`
    : '미리보기 모드 · 클릭해 설정';

  $('#topApiBtn').classList.toggle('connected', connected);
  $('#topApiLabel').textContent = connected ? `✦ ${modelLabel}` : '🔑 무료 Gemini API';

  if (state.view === 'chat') {
    $('#chatDemoBanner').hidden = connected;
  }
}

function openSettingsModal() {
  const cfg = state.config;
  if (!cfg) return;

  $('#settingsApiKeyInput').value = '';
  $('#settingsApiKeyInput').placeholder = cfg.hasApiKey
    ? `현재 저장됨: ${cfg.maskedApiKey} (새 키 입력 시 덮어쓰기)`
    : 'AIzaSy... (Google AI Studio 무료 키 붙여넣기)';

  const modelSel = $('#settingsModelSelect');
  modelSel.innerHTML = cfg.models
    .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} — ${escapeHtml(m.badge)}</option>`)
    .join('');
  modelSel.value = cfg.defaultModel || 'gemini-3.8-flash';
  $('#settingsModeSelect').value = cfg.defaultMode || 'story';

  $('#modelCardsInfo').innerHTML = cfg.models
    .slice(0, 3)
    .map(
      (m) => `
      <div class="model-info-row">
        <div>
          <strong>${escapeHtml(m.name)}</strong>
          <p>${escapeHtml(m.description)}</p>
        </div>
        <span class="badge-free">${escapeHtml(m.badge)}</span>
      </div>`
    )
    .join('');

  const verifyEl = $('#verifyStatusMsg');
  verifyEl.className = 'verify-status';
  verifyEl.textContent = cfg.hasApiKey
    ? `현재 연결된 키: ${cfg.maskedApiKey}${cfg.lastVerifiedModel ? ` · 추천 확인 모델: ${cfg.lastVerifiedModel}` : ''}`
    : '키를 입력하지 않아도 미리보기 모드로 앱을 체험할 수 있습니다.';

  $('#cloudBackupBox').hidden = state.runtimeMode !== 'cloud';
  $('#settingsModal').hidden = false;
}

async function handleVerifyApiKey() {
  const keyInput = $('#settingsApiKeyInput').value.trim();
  const statusEl = $('#verifyStatusMsg');
  const btn = $('#verifyApiKeyBtn');
  btn.disabled = true;
  btn.textContent = '연결 확인 중...';
  statusEl.className = 'verify-status';
  statusEl.textContent = 'Google Gemini API와 통신 중입니다...';

  try {
    const res = await api.verifyGemini({
      apiKey: keyInput || undefined,
      save: Boolean(keyInput),
      autoSelectRecommended: true,
    });
    state.config = res.config;
    renderApiStatus();
    $('#settingsModelSelect').value = state.config.defaultModel;
    statusEl.className = 'verify-status ok';
    statusEl.textContent = `✅ 연결 성공! 사용 가능 모델 ${res.models.length}개 확인 · 최고 무료 모델(${res.recommendedModel}) 자동 선택됨`;
    showToast('Google Gemini 무료 API가 성공적으로 연결되었습니다!');
  } catch (err) {
    statusEl.className = 'verify-status err';
    statusEl.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '연결 테스트 & 저장';
  }
}

async function handleSaveSettings() {
  const keyInput = $('#settingsApiKeyInput').value.trim();
  const patch = {
    defaultModel: $('#settingsModelSelect').value,
    defaultMode: $('#settingsModeSelect').value,
  };

  const btn = $('#saveSettingsBtn');
  btn.disabled = true;
  btn.textContent = keyInput ? '키 검증 및 저장 중...' : '저장 중...';

  try {
    if (keyInput) {
      // Automatically verify newly entered API key so invalid/typo keys are never saved silently
      const verified = await api.verifyGemini({
        apiKey: keyInput,
        save: true,
        autoSelectRecommended: false,
      });
      state.config = verified.config;
    }
    state.config = await api.updateConfig(patch);
    state.aiMode = state.config.defaultMode;
    $('#chatAiModeSelect').value = state.aiMode;
    renderApiStatus();
    closeModal('settingsModal');
    showToast(keyInput ? '✅ Gemini API 키가 검증되어 안전하게 저장되었습니다!' : '설정이 저장되었습니다.');
  } catch (err) {
    const statusEl = $('#verifyStatusMsg');
    statusEl.className = 'verify-status err';
    statusEl.textContent = `❌ ${err.message}`;
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '설정 저장';
  }
}

async function handleClearApiKey() {
  if (!confirm('저장된 Gemini API 키를 삭제하고 미리보기 모드로 전환할까요?')) return;
  try {
    state.config = await api.updateConfig({ geminiApiKey: '' });
    renderApiStatus();
    closeModal('settingsModal');
    showToast('저장된 API 키가 삭제되었습니다.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openQrModal() {
  $('#qrModal').hidden = false;
  $('#qrSvgContainer').innerHTML = '<span style="color:#333;font-size:12px;">불러오는 중...</span>';
  try {
    const net = await api.getNetwork();
    if (net.isCloud) {
      $('#qrSvgContainer').style.display = 'none';
      $('#networkUrlList').innerHTML = `
        <div class="url-copy-row">
          <div style="min-width:0;text-align:left;">
            <div style="font-size:10.5px;color:#6ee7b7;font-weight:700;">☁️ 24시간 상시 클라우드 웹 주소 (컴퓨터 꺼져도 접속 가능)</div>
            <code>${escapeHtml(net.lanUrl)}</code>
          </div>
          <button class="tiny-ghost-btn" data-copy="${escapeHtml(net.lanUrl)}">복사</button>
        </div>`;
    } else {
      $('#qrSvgContainer').style.display = 'grid';
      $('#qrSvgContainer').innerHTML = net.qrSvg || '<span style="color:#333">QR 생성 불가</span>';
      const urls = [
        { label: 'Wi-Fi IP 주소 (모바일 추천)', url: net.lanUrl },
        { label: 'Mac Bonjour 주소', url: net.bonjourUrl },
        { label: '로컬 Mac 주소', url: net.localUrl },
      ];
      $('#networkUrlList').innerHTML = urls
        .map(
          (u) => `
        <div class="url-copy-row">
          <div style="min-width:0;text-align:left;">
            <div style="font-size:10.5px;color:var(--text-2)">${escapeHtml(u.label)}</div>
            <code>${escapeHtml(u.url)}</code>
          </div>
          <button class="tiny-ghost-btn" data-copy="${escapeHtml(u.url)}">복사</button>
        </div>`
        )
        .join('');
    }
    $$('#networkUrlList [data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.copy);
        showToast('접속 주소가 복사되었습니다.');
      });
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================================
// HOME / DISCOVER
// ================================
function renderGenreTabs() {
  const wrap = $('#genreTabs');
  const tabs = [...state.genres, { id: 'mine', label: '내 캐릭터' }];
  wrap.innerHTML = tabs
    .map(
      (g) => `<button class="genre-tab ${state.activeGenre === g.id ? 'active' : ''}" data-genre="${g.id}">${escapeHtml(g.label)}</button>`
    )
    .join('');

  $$('#genreTabs .genre-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeGenre = btn.dataset.genre;
      renderGenreTabs();
      renderHomeCatalog();
    });
  });
}

function getFeaturedCharacters() {
  const featured = state.characters.filter((c) => c.featured);
  return featured.length > 0 ? featured : state.characters.slice(0, 3);
}

function renderHeroSpotlight() {
  const featured = getFeaturedCharacters();
  if (featured.length === 0) return;
  const current = featured[state.heroIndex % featured.length];

  $('#heroSpotlight').innerHTML = `
    <div class="hero-bg" style="background-image:url('${escapeHtml(current.avatar)}')"></div>
    <div class="hero-overlay"></div>
    <div class="hero-inner">
      <div class="hero-copy">
        <div class="hero-badges">
          <span class="badge-original">${current.isAnime ? `🎬 ANIME · ${escapeHtml(current.animeTitle || '')}` : '✦ CRACK ORIGINAL'}</span>
          <span class="badge-genre">${current.isAnime ? (current.playStyle === 'world' ? '🌍 멀티캐릭 세계관 시뮬' : '👤 1:1 캐릭터 챗') : escapeHtml(current.genreLabel)}</span>
          <span class="badge-genre">🔥 ${formatKoreanCount(current.plays)} 대화</span>
        </div>
        <h1 class="hero-title">${escapeHtml(current.title)}</h1>
        <p class="hero-quote">${escapeHtml(current.subtitle || current.worldSummary)}</p>
        <div class="hero-tags">
          ${(current.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="hero-actions">
          <button class="primary-btn" id="heroStartBtn">✦ ${escapeHtml(current.name)}와 이야기 시작하기</button>
          <button class="secondary-btn" id="heroDetailBtn">작품 정보 보기</button>
        </div>
      </div>
      <div class="hero-portrait-frame">
        <img src="${escapeHtml(current.avatar)}" alt="${escapeHtml(current.name)}" />
      </div>
    </div>
    <div class="hero-dots">
      ${featured
        .map(
          (_, idx) => `<button class="hero-dot ${idx === state.heroIndex % featured.length ? 'active' : ''}" data-hidx="${idx}" aria-label="배너 ${idx + 1}"></button>`
        )
        .join('')}
    </div>
  `;

  $('#heroStartBtn').addEventListener('click', () => openOrStartCharacter(current.id));
  $('#heroDetailBtn').addEventListener('click', () => openCharDetailModal(current.id));
  $$('.hero-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      state.heroIndex = Number(dot.dataset.hidx);
      renderHeroSpotlight();
    });
  });
}

function startHeroRotation() {
  if (state.heroTimer) clearInterval(state.heroTimer);
  state.heroTimer = setInterval(() => {
    if (state.view !== 'home') return;
    const featured = getFeaturedCharacters();
    if (featured.length <= 1) return;
    state.heroIndex = (state.heroIndex + 1) % featured.length;
    renderHeroSpotlight();
  }, 6500);
}

function renderHomeCatalog() {
  // Ranking TOP 4
  const top4 = [...state.characters].sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, 4);
  const showRanking = state.activeGenre === 'all' && !state.searchQuery;
  $('#rankingSection').hidden = !showRanking;

  if (showRanking) {
    $('#rankingStrip').innerHTML = top4
      .map(
        (c, i) => `
      <div class="rank-card" data-char-id="${c.id}">
        <div class="rank-num">${i + 1}</div>
        <img src="${escapeHtml(c.avatar)}" alt="${escapeHtml(c.name)}" />
        <div class="rank-info">
          <div class="rank-name">
            <span>${escapeHtml(c.name)}</span>
            <span class="card-pill">${escapeHtml(c.genreLabel)}</span>
          </div>
          <div class="rank-title">${escapeHtml(c.title)}</div>
          <div class="rank-stats">💬 ${formatKoreanCount(c.plays)} · ♥ ${formatKoreanCount(c.likes)}</div>
        </div>
      </div>`
      )
      .join('');

    $$('#rankingStrip .rank-card').forEach((card) => {
      card.addEventListener('click', () => openCharDetailModal(card.dataset.charId));
    });
  }

  // Home Anime Quick Showcase Strip (top 6 popular anime)
  const animeListAll = state.characters.filter((c) => c.isAnime);
  $('#navAnimeCount').textContent = String(animeListAll.length);
  const showHomeAnime = state.activeGenre === 'all' && !state.searchQuery && animeListAll.length > 0;
  $('#homeAnimeBannerSection').hidden = !showHomeAnime;
  if (showHomeAnime) {
    $('#goToAnimeHubBtn').textContent = `애니 월드 전체 보기 (${animeListAll.length}) →`;
    const topAnime6 = [...animeListAll].sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, 6);
    $('#homeAnimeQuickRow').innerHTML = topAnime6
      .map(
        (c) => `
      <div class="anime-mini-card" data-achar-id="${c.id}">
        <img src="${escapeHtml(c.avatar)}" alt="${escapeHtml(c.name)}" loading="lazy" />
        <div class="mini-grad"></div>
        <span class="mini-series">${escapeHtml(c.animeTitle || c.genreLabel)}</span>
        <div class="mini-info">
          <div class="mini-name">${escapeHtml(c.name)}</div>
          <div class="mini-mode">${c.playStyle === 'world' ? '🌍 세계관 시뮬' : '👤 1:1 캐릭터'}</div>
        </div>
      </div>`
      )
      .join('');
    $$('#homeAnimeQuickRow [data-achar-id]').forEach((card) => {
      card.addEventListener('click', () => openCharDetailModal(card.dataset.acharId));
    });
  }

  // Filtered Character Grid
  let list = [...state.characters];
  if (state.activeGenre === 'mine') {
    list = list.filter((c) => !c.isBuiltin);
  } else if (state.activeGenre === 'anime') {
    list = list.filter((c) => c.isAnime);
  } else if (state.activeGenre !== 'all') {
    list = list.filter((c) => c.genre === state.activeGenre);
  }

  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter((c) => {
      const hay = `${c.name} ${c.animeTitle || ''} ${c.title} ${c.subtitle} ${c.worldSummary} ${c.genreLabel} ${c.powerSystem || ''} ${(c.castMembers || []).join(' ')} ${(c.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  if (state.sortBy === 'popular') {
    list.sort((a, b) => (b.plays || 0) - (a.plays || 0));
  } else if (state.sortBy === 'likes') {
    list.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  } else {
    list.sort((a, b) => {
      if (Boolean(a.isBuiltin) !== Boolean(b.isBuiltin)) return a.isBuiltin ? 1 : -1;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
  }

  const label = state.activeGenre === 'mine'
    ? '🪄 내가 만든 캐릭터'
    : state.searchQuery
      ? `🔍 "${state.searchQuery}" 검색 결과 (${list.length})`
      : `✦ ${state.genres.find((g) => g.id === state.activeGenre)?.label || '전체'} 스토리 캐릭터`;
  $('#gridSectionTitle').textContent = label;

  renderCharacterGrid($('#characterGrid'), list, {
    emptyTitle: state.activeGenre === 'mine' ? '아직 직접 만든 캐릭터가 없어요' : '일치하는 캐릭터를 찾지 못했어요',
    emptySub: state.activeGenre === 'mine' ? '캐릭터 스튜디오에서 1분 만에 나만의 캐릭터를 만들어 보세요!' : '다른 키워드나 장르 탭을 선택해 보세요.',
  });
}

function characterCardHtml(c) {
  const topBadge = c.isAnime
    ? `<span class="card-pill anime">${escapeHtml(c.animeTitle || 'ANIME')}</span>`
    : `<span class="card-pill ${c.isOriginal ? 'original' : ''}">${c.isOriginal ? 'ORIGINAL' : escapeHtml(c.genreLabel)}</span>`;
  const subBadge = c.isAnime
    ? `<span style="font-size:10.5px;color:${c.playStyle === 'world' ? '#7dd3fc' : '#f9a8d4'};font-weight:700;">${c.playStyle === 'world' ? '🌍 시뮬' : '👤 1:1'}</span>`
    : `<span style="font-size:11px;color:#d8b4fe;font-weight:600;">${escapeHtml(c.genreLabel)}</span>`;

  return `
    <article class="char-card" data-char-id="${c.id}">
      <div class="char-card-media">
        <img src="${escapeHtml(c.avatar)}" alt="${escapeHtml(c.name)}" loading="lazy" />
        <div class="char-card-gradient"></div>
        <div class="char-card-top-badges">
          ${topBadge}
          <button class="card-fav-btn ${c.isFavorite ? 'active' : ''}" data-fav-id="${c.id}" title="즐겨찾기">
            ${c.isFavorite ? '★' : '☆'}
          </button>
        </div>
        <div class="char-card-overlay-info">
          <div class="char-card-name">
            <span>${escapeHtml(c.name)}</span>
            ${subBadge}
          </div>
          <div class="char-card-title">${escapeHtml(c.title)}</div>
        </div>
      </div>
      <div class="char-card-body">
        <div class="char-card-subtitle">${escapeHtml(c.subtitle || c.worldSummary)}</div>
        ${c.powerSystem ? `<div class="char-card-power">⚡ ${escapeHtml(c.powerSystem)}</div>` : ''}
        <div class="char-card-tags">
          ${(c.tags || []).slice(0, 3).map((t) => `<span>${escapeHtml(t)}</span>`).join('')}
        </div>
        <div class="char-card-footer">
          <span>💬 ${formatKoreanCount(c.plays)}</span>
          <span>♥ ${formatKoreanCount(c.likes)}</span>
        </div>
      </div>
    </article>`;
}

// ================================
// ANIME UNIVERSE HUB
// ================================
function renderAnimeHub() {
  const allAnime = state.characters.filter((c) => c.isAnime);
  $('#navAnimeCount').textContent = String(allAnime.length);
  $('#animeTotalBadge').textContent = `총 ${allAnime.length}개 메이저 애니 월드 탑재`;

  // Category Tabs
  const catWrap = $('#animeCategoryTabs');
  const cats = state.animeCategories.length
    ? state.animeCategories
    : [
        { id: 'all', label: '전체 애니' },
        { id: 'shonen', label: '🔥 소년·배틀' },
        { id: 'fantasy_isekai', label: '🌌 판타지·이세계' },
        { id: 'thriller_sf', label: '🧠 추리·심리·SF' },
        { id: 'slice_sports', label: '✨ 아이돌·스포츠·일상' },
      ];
  catWrap.innerHTML = cats
    .map(
      (cat) => `<button class="genre-tab ${state.activeAnimeCategory === cat.id ? 'active' : ''}" data-acat="${cat.id}">${escapeHtml(cat.label)}</button>`
    )
    .join('');
  catWrap.querySelectorAll('[data-acat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeAnimeCategory = btn.dataset.acat;
      state.activeAnimeSeries = 'all';
      renderAnimeHub();
    });
  });

  // Series Ribbon (deduplicated anime titles)
  const seriesSet = [];
  const seenSeries = new Set();
  for (const c of allAnime) {
    if (c.animeTitle && !seenSeries.has(c.animeTitle)) {
      seenSeries.add(c.animeTitle);
      seriesSet.push(c.animeTitle);
    }
  }
  const ribbon = $('#animeSeriesRibbon');
  ribbon.innerHTML = [
    `<button class="series-chip ${state.activeAnimeSeries === 'all' ? 'active' : ''}" data-series="all">전체 작품 (${seriesSet.length})</button>`,
    ...seriesSet.map(
      (title) => `<button class="series-chip ${state.activeAnimeSeries === title ? 'active' : ''}" data-series="${escapeHtml(title)}">${escapeHtml(title)}</button>`
    ),
  ].join('');
  ribbon.querySelectorAll('[data-series]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeAnimeSeries = btn.dataset.series;
      renderAnimeHub();
    });
  });

  // Apply Filters
  let filtered = [...allAnime];
  if (state.activeAnimeCategory !== 'all') {
    filtered = filtered.filter((c) => c.animeCategory === state.activeAnimeCategory);
  }
  if (state.activeAnimePlayStyle !== 'all') {
    filtered = filtered.filter((c) => (c.playStyle || 'character') === state.activeAnimePlayStyle);
  }
  if (state.activeAnimeSeries !== 'all') {
    filtered = filtered.filter((c) => c.animeTitle === state.activeAnimeSeries);
  }
  if (state.searchQuery) {
    const q = state.searchQuery;
    filtered = filtered.filter((c) => {
      const hay = `${c.name} ${c.animeTitle || ''} ${c.title} ${c.subtitle} ${c.powerSystem || ''} ${(c.castMembers || []).join(' ')} ${(c.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  filtered.sort((a, b) => (b.plays || 0) - (a.plays || 0));

  $('#animeGridHeading').textContent =
    state.activeAnimeSeries !== 'all'
      ? `🎬 「${state.activeAnimeSeries}」 스토리 목록`
      : `🎬 ${cats.find((x) => x.id === state.activeAnimeCategory)?.label || '전체 애니'} 월드`;
  $('#animeGridCount').textContent = `${filtered.length}개 표시 중`;

  renderCharacterGrid($('#animeGrid'), filtered, {
    emptyTitle: '조건에 맞는 애니 월드가 없어요',
    emptySub: '위의 [⚡ AI 애니 무한 소환기]에 작품명을 입력하면 어떤 애니든 5초 만에 만들어 드립니다!',
  });
}

async function handleSummonAnime() {
  const animeTitle = $('#summonAnimeTitle').value.trim();
  const targetCharacter = $('#summonCharName').value.trim();
  const playStyle = $('#summonPlayStyle').value;
  const extraPrompt = $('#summonExtraPrompt').value.trim();

  if (!animeTitle) {
    showToast('소환할 애니메이션 작품명을 입력해 주세요!', 'error');
    $('#summonAnimeTitle').focus();
    return;
  }

  const btn = $('#summonAnimeBtn');
  btn.disabled = true;
  btn.textContent = '⚡ 원작 세계관 소환 중...';

  try {
    const res = await api.summonAnime({
      animeTitle,
      targetCharacter,
      playStyle,
      extraPrompt,
    });
    await reloadCharacters();
    await reloadSessions();
    $('#summonAnimeTitle').value = '';
    $('#summonCharName').value = '';
    $('#summonExtraPrompt').value = '';
    showToast(
      res.isDemo
        ? `⚡ 「${animeTitle}」 미리보기 월드를 소환했습니다! (Gemini API 연결 시 초정밀 원작 고증 생성)`
        : `⚡ 「${animeTitle}」 원작 고증 월드가 소환되었습니다!`
    );
    enterChatRoom(res.session, res.character, res.persona);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ 즉시 소환 & 시작';
  }
}

function renderCharacterGrid(container, list, { emptyTitle, emptySub }) {
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><strong>${escapeHtml(emptyTitle)}</strong>${escapeHtml(emptySub)}</div>`;
    return;
  }
  container.innerHTML = list.map(characterCardHtml).join('');

  container.querySelectorAll('.char-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-fav-id]')) return;
      openCharDetailModal(card.dataset.charId);
    });
  });

  container.querySelectorAll('[data-fav-id]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.favId;
      try {
        const { isFavorite } = await api.toggleFavorite(id);
        const target = state.characters.find((c) => c.id === id);
        if (target) target.isFavorite = isFavorite;
        renderHomeCatalog();
        renderLibraryView();
        showToast(isFavorite ? '보관함에 즐겨찾기했습니다.' : '즐겨찾기를 해제했습니다.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ================================
// CHARACTER DETAIL MODAL
// ================================
function openCharDetailModal(charId) {
  const c = state.characters.find((x) => x.id === charId);
  if (!c) return;
  const existingSessions = state.sessions.filter((s) => s.characterId === c.id);
  const latestSession = existingSessions[0];

  $('#charDetailBody').innerHTML = `
    <div class="detail-hero">
      <img class="detail-portrait" src="${escapeHtml(c.avatar)}" alt="${escapeHtml(c.name)}" />
      <div class="detail-info">
        <div class="hero-badges">
          ${
            c.isAnime
              ? `<span class="badge-original">🎬 ${escapeHtml(c.animeTitle || 'ANIME')}</span>
                 <span class="badge-genre">${c.playStyle === 'world' ? '🌍 멀티캐릭 세계관 시뮬' : '👤 1:1 캐릭터 챗'}</span>`
              : c.isOriginal
                ? '<span class="badge-original">✦ CRACK ORIGINAL</span>'
                : '<span class="badge-genre">내 캐릭터</span>'
          }
          <span class="badge-genre">${escapeHtml(c.genreLabel)}</span>
          <span class="badge-genre">📖 로어북 ${(c.lorebook || []).length}개</span>
        </div>
        <h2>${escapeHtml(c.name)}</h2>
        <div style="font-size:14px;font-weight:700;color:#e4e4f7;">${escapeHtml(c.title)}</div>
        ${c.powerSystem ? `<div style="font-size:12px;color:#a5b4fc;">⚡ 고유 시스템: ${escapeHtml(c.powerSystem)}</div>` : ''}
        ${c.castMembers?.length ? `<div style="font-size:12px;color:var(--text-2);">👥 주요 등장인물: ${escapeHtml(c.castMembers.join(' · '))}</div>` : ''}
        <p class="detail-quote">${escapeHtml(c.subtitle || '')}</p>
        <p class="detail-world">${escapeHtml(c.worldSummary || '')}</p>
        <div class="hero-tags">
          ${(c.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
    </div>

    <div class="detail-section">
      <div style="font-size:12px;font-weight:700;color:var(--text-2);">첫 장면 미리보기</div>
      <div class="detail-opening-preview">${formatStoryHtml(c.openingMessage)}</div>
      <div class="detail-actions">
        ${
          latestSession
            ? `<button class="primary-btn" id="detailResumeBtn">💬 이전 이야기 이어하기 (${latestSession.messageCount}턴)</button>
               <button class="secondary-btn" id="detailNewBtn">+ 새 회차 시작</button>`
            : `<button class="primary-btn" id="detailNewBtn">✦ 지금 이야기 시작하기</button>`
        }
        <button class="ghost-btn" id="detailLikeBtn">${c.isLiked ? '❤️' : '🤍'} 좋아요 ${formatKoreanCount(c.likes)}</button>
        <button class="ghost-btn" id="detailEditBtn">✏️ 수정/복제</button>
        ${!c.isBuiltin ? '<button class="danger-btn" id="detailDeleteBtn">삭제</button>' : ''}
      </div>
    </div>
  `;

  if (latestSession) {
    $('#detailResumeBtn').addEventListener('click', () => {
      closeModal('charDetailModal');
      openSession(latestSession.id);
    });
  }
  $('#detailNewBtn').addEventListener('click', () => {
    closeModal('charDetailModal');
    startNewStory(c.id);
  });
  $('#detailLikeBtn').addEventListener('click', async () => {
    try {
      const res = await api.toggleLike(c.id);
      c.isLiked = res.isLiked;
      c.likes = res.likes;
      openCharDetailModal(c.id);
      renderHomeCatalog();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
  $('#detailEditBtn').addEventListener('click', () => {
    closeModal('charDetailModal');
    loadCharacterIntoCreator(c);
    switchView('creator');
  });
  if (!c.isBuiltin) {
    $('#detailDeleteBtn').addEventListener('click', async () => {
      if (!confirm(`'${c.name}' 캐릭터를 삭제할까요?`)) return;
      try {
        await api.deleteCharacter(c.id);
        await reloadCharacters();
        closeModal('charDetailModal');
        showToast('캐릭터가 삭제되었습니다.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  $('#charDetailModal').hidden = false;
}

// ================================
// SESSIONS & CHAT ROOM
// ================================
async function reloadCharacters() {
  const data = await api.getCharacters();
  state.characters = data.characters || [];
  renderHeroSpotlight();
  renderHomeCatalog();
  renderAnimeHub();
  renderLibraryView();
}

async function reloadSessions() {
  const data = await api.getSessions();
  state.sessions = data.sessions || [];
  renderSidebarSessions();
  renderChatsView();
  if (state.activeCharacter) renderSameCharSessions();
}

function renderSidebarSessions() {
  const badge = $('#navSessionCount');
  badge.hidden = state.sessions.length === 0;
  badge.textContent = String(state.sessions.length);

  const container = $('#sidebarSessions');
  if (!state.sessions.length) {
    container.innerHTML = '<div class="sidebar-empty">아직 시작한 이야기가 없어요</div>';
    return;
  }
  container.innerHTML = state.sessions
    .slice(0, 12)
    .map(
      (s) => `
    <button class="sidebar-session-item ${state.activeSession?.id === s.id ? 'active' : ''}" data-sid="${s.id}">
      <img src="${escapeHtml(s.characterAvatar)}" alt="" />
      <div class="sidebar-session-meta">
        <div class="sidebar-session-name">${escapeHtml(s.characterName)}</div>
        <div class="sidebar-session-preview">${escapeHtml(s.lastPreview || s.mood)}</div>
      </div>
    </button>`
    )
    .join('');

  container.querySelectorAll('[data-sid]').forEach((btn) => {
    btn.addEventListener('click', () => openSession(btn.dataset.sid));
  });
}

function renderChatsView() {
  const grid = $('#sessionsListGrid');
  if (!state.sessions.length) {
    grid.innerHTML = `<div class="empty-state"><strong>아직 진행 중인 이야기가 없어요</strong>홈에서 마음에 드는 캐릭터를 골라 첫 이야기를 시작해 보세요!</div>`;
    return;
  }
  grid.innerHTML = state.sessions
    .map(
      (s) => `
    <div class="session-card" data-sid="${s.id}">
      <img src="${escapeHtml(s.characterAvatar)}" alt="${escapeHtml(s.characterName)}" />
      <div class="session-card-body">
        <div class="session-card-top">
          <span class="session-card-name">${escapeHtml(s.characterName)}</span>
          <span class="mood-pill">${escapeHtml(s.mood || '진행 중')}</span>
        </div>
        <div style="font-size:12px;color:#c4b5fd;font-weight:600;">${escapeHtml(s.characterTitle)}</div>
        <div class="session-card-preview">${escapeHtml(s.lastPreview)}</div>
        <div class="session-card-meta">
          <span>♥ 호감도 ${s.affinity}</span>
          <span>💬 ${s.messageCount}턴</span>
          <span>${formatRelativeTime(s.updatedAt)}</span>
        </div>
      </div>
    </div>`
    )
    .join('');

  grid.querySelectorAll('.session-card').forEach((card) => {
    card.addEventListener('click', () => openSession(card.dataset.sid));
  });
}

async function openOrStartCharacter(characterId) {
  const existing = state.sessions.find((s) => s.characterId === characterId);
  if (existing) return openSession(existing.id);
  return startNewStory(characterId);
}

async function startNewStory(characterId) {
  try {
    const res = await api.createSession({
      characterId,
      personaId: state.config?.activePersonaId || state.personas[0]?.id,
    });
    await reloadSessions();
    await reloadCharacters();
    enterChatRoom(res.session, res.character, state.personas.find((p) => p.id === res.session.personaId) || state.personas[0]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openSession(sessionId) {
  try {
    const res = await api.getSession(sessionId);
    enterChatRoom(res.session, res.character, res.persona);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function enterChatRoom(session, character, persona) {
  state.activeSession = session;
  state.activeCharacter = character;
  state.activePersona = persona || state.personas[0];
  state.editingMsgId = null;

  $('#chatBackdrop').style.backgroundImage = `url('${character.avatar}')`;
  $('#chatCharAvatar').src = character.avatar;
  $('#chatCharName').textContent = character.name;
  $('#chatDemoBanner').hidden = Boolean(state.config?.hasApiKey);

  // Sync controls
  setViewMode(state.viewMode, false);
  setFontFamily(state.fontFamily, false);
  $('#chatAiModeSelect').value = state.aiMode;
  $$('#lengthPills .len-pill').forEach((b) => b.classList.toggle('active', b.dataset.len === state.outputLength));

  updateChatHeaderHud();
  syncInspectorFields();
  renderMessages();
  renderSuggestionsList(session.suggestedReplies || []);
  renderSidebarSessions();
  switchView('chat');
  scrollToBottom(true);
}

function setViewMode(mode, persist = true) {
  state.viewMode = mode === 'chat' ? 'chat' : 'novel';
  $$('#viewModeToggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.viewMode));
  const inner = $('#messagesInner');
  inner.classList.toggle('mode-novel', state.viewMode === 'novel');
  inner.classList.toggle('mode-chat', state.viewMode === 'chat');
  if (persist) api.updateConfig({ viewMode: state.viewMode }).catch(() => {});
}

function setFontFamily(font, persist = true) {
  state.fontFamily = font === 'serif' ? 'serif' : 'sans';
  $$('#fontFamilyToggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.font === state.fontFamily));
  $('#messagesInner').classList.toggle('font-serif', state.fontFamily === 'serif');
  if (persist) api.updateConfig({ fontFamily: state.fontFamily }).catch(() => {});
}

function updateChatHeaderHud() {
  const s = state.activeSession;
  const c = state.activeCharacter;
  if (!s) return;
  const aff = Math.max(0, Math.min(100, Number(s.affinity ?? 35)));
  $('#chatMoodPill').textContent = s.mood || '대화 중';
  $('#chatAffinityFill').style.width = `${aff}%`;
  $('#chatAffinityVal').textContent = String(aff);
  $('#chatAffinityStage').textContent = s.relationshipStage || '';

  $('#inspAffinityRange').value = aff;
  $('#inspAffinityValue').textContent = `${aff} / 100`;
  $('#inspMoodInput').value = s.mood || '';

  renderNationHud(c, s);
}

function renderNationHud(character, session) {
  const bar = $('#nationHudBar');
  if (!bar) return;
  if (!character?.isNationSim) {
    bar.hidden = true;
    return;
  }
  const ns = session?.nationState || character.initialNationState || {
    name: '국가 선택 대기',
    date: '0턴',
    power: 65,
    treasury: '집계 대기',
    approval: 58,
    military: 65,
    stability: 68,
  };
  const approvalClass = ns.approval <= 30 ? 'danger' : ns.approval >= 75 ? 'good' : '';
  bar.hidden = false;
  bar.innerHTML = `
    <span class="nation-chip gold">🏛️ ${escapeHtml(ns.name || '국가')}</span>
    <span class="nation-chip">📅 ${escapeHtml(ns.date || '1턴')}</span>
    <span class="nation-chip">⚡ 국력 ${escapeHtml(String(ns.power ?? 65))}</span>
    <span class="nation-chip">💰 ${escapeHtml(String(ns.treasury || '집계중'))}</span>
    <span class="nation-chip ${approvalClass}">📊 지지율 ${escapeHtml(String(ns.approval ?? 58))}%</span>
    <span class="nation-chip">⚔️ 군사 ${escapeHtml(String(ns.military ?? 65))}</span>
    <span class="nation-chip">⚖️ 안정 ${escapeHtml(String(ns.stability ?? 68))}</span>
  `;
}

function syncInspectorFields() {
  const s = state.activeSession;
  if (!s) return;

  // Personas dropdown
  $('#sessionPersonaSelect').innerHTML = state.personas
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.gender && p.gender !== '미지정' ? ` (${escapeHtml(p.gender)})` : ''}</option>`)
    .join('');
  $('#sessionPersonaSelect').value = s.personaId || state.personas[0]?.id;

  const isAnime = Boolean(state.activeCharacter?.isAnime);
  $('#storyRouteBlock').hidden = !isAnime;
  if (isAnime) {
    const activeRoute = s.storyRoute === 'canon' ? 'canon' : 'if';
    $$('#storyRouteToggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === activeRoute));
  }

  const isNation = Boolean(state.activeCharacter?.isNationSim);
  $('#nationModeBlock').hidden = !isNation;
  if (isNation) {
    const activeNmode = s.nationMode === 'surreal' ? 'surreal' : 'realistic';
    $$('#nationModeToggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.nmode === activeNmode));
  }

  $('#sessionUserNote').value = s.userNote || '';
  $('#userNoteCounter').textContent = `${(s.userNote || '').length} / 2000`;
  $('#sessionSummaryInput').value = s.summaryMemory || '';

  renderSessionLorebook();
  renderSameCharSessions();
}

function renderSessionLorebook() {
  const container = $('#sessionLoreList');
  const lore = state.activeSession?.lorebook || [];
  if (!lore.length) {
    container.innerHTML = '<div class="field-hint">등록된 로어북이 없습니다. 위 버튼을 눌러 키워드 사전을 추가해 보세요.</div>';
    return;
  }

  container.innerHTML = lore
    .map(
      (item, idx) => `
    <div class="lore-edit-item" data-lidx="${idx}">
      <div class="lore-edit-top">
        <input type="checkbox" class="lore-en" ${item.enabled !== false ? 'checked' : ''} style="width:auto;" title="활성화" />
        <input type="text" class="lore-title" value="${escapeHtml(item.title)}" placeholder="제목 (예: 계약서 7조)" />
        <button type="button" class="icon-btn small lore-del" title="삭제">✕</button>
      </div>
      <input type="text" class="lore-kw" value="${escapeHtml(item.keywords)}" placeholder="발동 키워드 (쉼표 구분: 예 계약, 7조, 이혼)" />
      <textarea class="lore-content" rows="3" placeholder="키워드가 언급될 때 AI에 주입할 세계관 내용">${escapeHtml(item.content)}</textarea>
    </div>`
    )
    .join('') + '<button type="button" class="primary-btn full small" id="saveSessionLoreBtn">로어북 변경사항 저장</button>';

  container.querySelectorAll('.lore-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('[data-lidx]').dataset.lidx);
      state.activeSession.lorebook.splice(idx, 1);
      renderSessionLorebook();
    });
  });

  $('#saveSessionLoreBtn').addEventListener('click', async () => {
    const items = [];
    container.querySelectorAll('.lore-edit-item').forEach((el, idx) => {
      const existing = state.activeSession.lorebook[idx] || {};
      const title = el.querySelector('.lore-title').value.trim() || '세계관 설정';
      const keywords = el.querySelector('.lore-kw').value.trim();
      const content = el.querySelector('.lore-content').value.trim();
      const enabled = el.querySelector('.lore-en').checked;
      if (keywords || content) {
        items.push({ id: existing.id || `lore_${idx}`, title, keywords, content, enabled });
      }
    });
    try {
      const { session } = await api.updateSession(state.activeSession.id, { lorebook: items });
      state.activeSession = session;
      renderSessionLorebook();
      showToast('로어북이 저장되었습니다.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function renderSameCharSessions() {
  const wrap = $('#sameCharSessions');
  if (!state.activeCharacter) return;
  const list = state.sessions.filter((s) => s.characterId === state.activeCharacter.id);
  wrap.innerHTML = list
    .map(
      (s) => `
    <button class="mini-session-btn ${s.id === state.activeSession?.id ? 'active' : ''}" data-msid="${s.id}">
      <span>${escapeHtml(s.title)}</span>
      <span style="color:var(--text-2);font-size:11px;">${s.messageCount}턴</span>
    </button>`
    )
    .join('');
  wrap.querySelectorAll('[data-msid]').forEach((btn) => {
    btn.addEventListener('click', () => openSession(btn.dataset.msid));
  });
}

function renderMessages() {
  const inner = $('#messagesInner');
  const s = state.activeSession;
  const c = state.activeCharacter;
  if (!s || !c) return;

  const userName = state.activePersona?.name || '나';

  inner.innerHTML = s.messages
    .map((m, idx) => {
      const isUser = m.role === 'user';
      const isLastModel = !isUser && idx === s.messages.length - 1;
      const versions = Array.isArray(m.versions) ? m.versions : [m.content];
      const activeVer = m.activeVersion || 0;
      const triggered = m.meta?.triggeredLorebooks || [];
      const delta = m.meta?.affinityDelta || 0;

      const isEditing = state.editingMsgId === m.id;
      const bodyHtml = isEditing
        ? `<div class="inline-edit-box">
             <textarea id="inlineEditArea">${escapeHtml(m.content)}</textarea>
             <div class="inline-edit-actions">
               <button class="tiny-ghost-btn" data-edit-cancel>취소</button>
               <button class="tiny-accent-btn" data-edit-save="${m.id}">저장</button>
             </div>
           </div>`
        : `<div class="msg-content">${formatStoryHtml(m.content)}</div>`;

      return `
        <article class="msg-turn ${isUser ? 'role-user' : 'role-model'}" data-msg-id="${m.id}">
          <div class="msg-speaker-row">
            ${!isUser ? `<img class="msg-speaker-avatar" src="${escapeHtml(c.avatar)}" alt="" />` : ''}
            <span class="msg-speaker-name">${escapeHtml(isUser ? userName : c.name)}</span>
            ${
              !isUser && m.meta?.model && m.meta.model !== 'opening'
                ? `<span class="msg-model-badge">${m.meta.isDemo ? '미리보기' : escapeHtml(m.meta.model)}</span>`
                : ''
            }
            ${
              !isUser && delta !== 0
                ? `<span class="msg-delta-badge">♥ ${delta > 0 ? `+${delta}` : delta}</span>`
                : ''
            }
          </div>
          ${
            triggered.length > 0
              ? `<div class="msg-lore-strip">${triggered.map((t) => `<span class="lore-trigger-pill">📖 로어북: ${escapeHtml(t)}</span>`).join('')}</div>`
              : ''
          }
          ${bodyHtml}
          ${
            !isEditing
              ? `<div class="msg-actions">
                  ${
                    versions.length > 1
                      ? `<span class="version-pager">
                           <button data-ver-prev="${m.id}" ${activeVer <= 0 ? 'disabled' : ''}>‹</button>
                           <span>${activeVer + 1} / ${versions.length}</span>
                           <button data-ver-next="${m.id}" ${activeVer >= versions.length - 1 ? 'disabled' : ''}>›</button>
                         </span>`
                      : ''
                  }
                  ${isLastModel && !m.isOpening ? `<button class="msg-act-btn" data-act-regen>↺ 재생성</button>` : ''}
                  <button class="msg-act-btn" data-act-edit="${m.id}">✎ 수정</button>
                  <button class="msg-act-btn" data-act-copy="${m.id}">📋 복사</button>
                  ${idx < s.messages.length - 1 ? `<button class="msg-act-btn" data-act-rewind="${m.id}">⏪ 여기로 되돌리기</button>` : ''}
                </div>`
              : ''
          }
        </article>`;
    })
    .join('');

  bindMessageActionHandlers();
}

function bindMessageActionHandlers() {
  const inner = $('#messagesInner');

  inner.querySelectorAll('[data-act-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.editingMsgId = btn.dataset.actEdit;
      renderMessages();
      const area = $('#inlineEditArea');
      if (area) area.focus();
    });
  });

  inner.querySelectorAll('[data-edit-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.editingMsgId = null;
      renderMessages();
    });
  });

  inner.querySelectorAll('[data-edit-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const msgId = btn.dataset.editSave;
      const newText = $('#inlineEditArea').value.trim();
      if (!newText) return;
      try {
        const { session } = await api.updateMessage(state.activeSession.id, msgId, { content: newText });
        state.activeSession = session;
        state.editingMsgId = null;
        renderMessages();
        showToast('메시지가 수정되었습니다.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  inner.querySelectorAll('[data-act-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = state.activeSession?.messages.find((m) => m.id === btn.dataset.actCopy);
      if (msg) {
        navigator.clipboard.writeText(msg.content);
        showToast('메시지가 복사되었습니다.');
      }
    });
  });

  inner.querySelectorAll('[data-act-rewind]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 시점 이후의 대화를 지우고 여기서부터 다시 진행할까요?')) return;
      try {
        const { session } = await api.rewindSession(state.activeSession.id, btn.dataset.actRewind);
        state.activeSession = session;
        renderMessages();
        reloadSessions();
        showToast('선택한 시점으로 되돌렸습니다.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  inner.querySelectorAll('[data-act-regen]').forEach((btn) => {
    btn.addEventListener('click', () => triggerChatStream({ action: 'regenerate' }));
  });

  inner.querySelectorAll('[data-ver-prev], [data-ver-next]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const isPrev = btn.hasAttribute('data-ver-prev');
      const msgId = isPrev ? btn.dataset.verPrev : btn.dataset.verNext;
      const msg = state.activeSession?.messages.find((m) => m.id === msgId);
      if (!msg) return;
      const nextIdx = (msg.activeVersion || 0) + (isPrev ? -1 : 1);
      try {
        const { session } = await api.updateMessage(state.activeSession.id, msgId, { activeVersion: nextIdx });
        state.activeSession = session;
        renderMessages();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function scrollToBottom(instant = false) {
  const el = $('#messagesScroll');
  el.scrollTo({
    top: el.scrollHeight,
    behavior: instant ? 'auto' : 'smooth',
  });
}

function handleSendOrStop() {
  if (state.isStreaming) {
    if (state.abortController) state.abortController.abort();
    return;
  }
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoResizeTextarea(input);
  $('#suggestionsTray').hidden = true;
  $('#toggleSuggestionsBtn').classList.remove('active');
  triggerChatStream({ action: 'send', text });
}

async function triggerChatStream({ action, text = '' }) {
  if (!state.activeSession || state.isStreaming) return;

  state.isStreaming = true;
  state.abortController = new AbortController();
  $('#sendBtn').classList.add('streaming');
  $('#sendBtnIcon').textContent = '■';

  const inner = $('#messagesInner');
  const c = state.activeCharacter;
  const userName = state.activePersona?.name || '나';

  // Optimistically render user bubble if action === 'send'
  if (action === 'send') {
    const tempUser = document.createElement('article');
    tempUser.className = 'msg-turn role-user';
    tempUser.innerHTML = `
      <div class="msg-speaker-row"><span class="msg-speaker-name">${escapeHtml(userName)}</span></div>
      <div class="msg-content">${formatStoryHtml(text)}</div>
    `;
    inner.appendChild(tempUser);
  } else if (action === 'regenerate') {
    const lastEl = inner.lastElementChild;
    if (lastEl && lastEl.classList.contains('role-model')) lastEl.remove();
  }

  // Create live streaming AI message card
  const streamCard = document.createElement('article');
  streamCard.className = 'msg-turn role-model';
  streamCard.innerHTML = `
    <div class="msg-speaker-row">
      <img class="msg-speaker-avatar" src="${escapeHtml(c.avatar)}" alt="" />
      <span class="msg-speaker-name">${escapeHtml(c.name)}</span>
      <span class="msg-model-badge" id="streamingBadge">생성 중...</span>
    </div>
    <div class="msg-lore-strip" id="streamingLore"></div>
    <div class="msg-content" id="streamingContent"><span class="streaming-cursor"></span></div>
  `;
  inner.appendChild(streamCard);
  scrollToBottom();

  let accumulated = '';
  const contentEl = streamCard.querySelector('#streamingContent');
  const loreEl = streamCard.querySelector('#streamingLore');
  const badgeEl = streamCard.querySelector('#streamingBadge');

  try {
    await api.streamChat(
      state.activeSession.id,
      {
        action,
        text,
        mode: state.aiMode,
        model: state.aiMode === 'speed' ? 'gemini-3.5-flash-lite' : state.config?.defaultModel,
        outputLength: state.outputLength,
        viewMode: state.viewMode,
      },
      {
        signal: state.abortController.signal,
        onStart: (meta) => {
          if (meta.triggeredLorebooks?.length) {
            loreEl.innerHTML = meta.triggeredLorebooks
              .map((l) => `<span class="lore-trigger-pill">📖 로어북: ${escapeHtml(l.title)}</span>`)
              .join('');
          }
          badgeEl.textContent = meta.isDemo ? '미리보기 응답 중' : 'Gemini 스트리밍 중';
        },
        onDelta: ({ text: chunk }) => {
          accumulated += chunk;
          contentEl.innerHTML = `${formatStoryHtml(accumulated)}<span class="streaming-cursor"></span>`;
          scrollToBottom(true);
        },
        onDone: async (donePayload) => {
          if (donePayload.fallbackFrom) {
            showToast(`${donePayload.fallbackFrom} 한도 초과 → ${donePayload.modelUsed}로 자동 전환되었습니다.`);
          }
          const refreshed = await api.getSession(state.activeSession.id);
          state.activeSession = refreshed.session;
          updateChatHeaderHud();
          renderMessages();
          scrollToBottom(true);
          reloadSessions();
        },
        onError: (err) => {
          const msg = err?.message || 'AI 응답 오류';
          const isKeyErr = err?.code === 'INVALID_API_KEY' || /API key|API 키|유효하지/i.test(msg);
          streamCard.innerHTML = `
            <div class="stream-error-card">
              <div><strong>⚠️ AI 응답 생성 실패</strong><br />${escapeHtml(msg)}</div>
              <div class="stream-error-actions">
                ${isKeyErr ? '<button type="button" class="primary-btn small" data-err-open-api>🔑 무료 API 키 다시 입력</button>' : ''}
                <button type="button" class="secondary-btn small" data-err-retry>↺ 다시 시도</button>
              </div>
            </div>
          `;
          streamCard.querySelector('[data-err-open-api]')?.addEventListener('click', openSettingsModal);
          streamCard.querySelector('[data-err-retry]')?.addEventListener('click', () => {
            streamCard.remove();
            triggerChatStream({ action: action === 'send' ? 'continue' : action });
          });
          showToast(msg, 'error');
        },
      }
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('응답 생성을 중지했습니다.');
    } else {
      showToast(err.message, 'error');
    }
    const refreshed = await api.getSession(state.activeSession.id).catch(() => null);
    if (refreshed) {
      state.activeSession = refreshed.session;
      renderMessages();
    }
  } finally {
    state.isStreaming = false;
    state.abortController = null;
    $('#sendBtn').classList.remove('streaming');
    $('#sendBtnIcon').textContent = '➤';
  }
}

function toggleSuggestionsTray() {
  const tray = $('#suggestionsTray');
  const btn = $('#toggleSuggestionsBtn');
  const willOpen = tray.hidden;
  tray.hidden = !willOpen;
  btn.classList.toggle('active', willOpen);
  if (willOpen && (!state.activeSession?.suggestedReplies?.length || state.activeSession.messages.length > 1)) {
    refreshSuggestions(false);
  }
}

function renderSuggestionsList(list) {
  const container = $('#suggestionsList');
  if (!list || !list.length) {
    container.innerHTML = '<div class="field-hint">새로 생성 버튼을 눌러 상황에 맞는 추천 답변을 받아보세요.</div>';
    return;
  }
  container.innerHTML = list
    .map((text, idx) => `<button class="suggestion-item" data-sug-idx="${idx}">${escapeHtml(text)}</button>`)
    .join('');

  container.querySelectorAll('.suggestion-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = list[Number(btn.dataset.sugIdx)];
      const input = $('#chatInput');
      input.value = text;
      autoResizeTextarea(input);
      input.focus();
      $('#suggestionsTray').hidden = true;
      $('#toggleSuggestionsBtn').classList.remove('active');
    });
  });
}

async function refreshSuggestions(force = true) {
  if (!state.activeSession) return;
  if (!force && state.activeSession.suggestedReplies?.length && state.activeSession.messages.length <= 1) {
    renderSuggestionsList(state.activeSession.suggestedReplies);
    return;
  }
  const listEl = $('#suggestionsList');
  listEl.innerHTML = '<div class="field-hint">✨ 상황에 맞는 추천 답변 3개를 작성하는 중...</div>';
  try {
    const res = await api.generateSuggestions(state.activeSession.id);
    state.activeSession.suggestedReplies = res.suggestions || [];
    renderSuggestionsList(state.activeSession.suggestedReplies);
  } catch (err) {
    listEl.innerHTML = `<div class="field-hint" style="color:#fda4af;">${escapeHtml(err.message)}</div>`;
  }
}

async function handleAutoSummarize() {
  if (!state.activeSession) return;
  const btn = $('#autoSummarizeBtn');
  btn.disabled = true;
  btn.textContent = '✨ 요약 생성 중...';
  try {
    const res = await api.summarizeSession(state.activeSession.id);
    state.activeSession.summaryMemory = res.summaryMemory;
    $('#sessionSummaryInput').value = res.summaryMemory;
    showToast('AI 요약 메모리가 갱신되었습니다!');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI 요약 메모리 지금 갱신';
  }
}

// ================================
// CHARACTER CREATOR STUDIO
// ================================
function initCreatorDefaults() {
  const genreSel = $('#charGenreInput');
  genreSel.innerHTML = state.genres
    .filter((g) => g.id !== 'all')
    .map((g) => `<option value="${g.id}">${escapeHtml(g.label)}</option>`)
    .join('');

  const strip = $('#presetAvatarStrip');
  strip.innerHTML = PRESET_AVATARS.map(
    (src) => `
    <button type="button" class="preset-thumb ${src === state.creatorAvatar ? 'active' : ''}" data-psrc="${src}">
      <img src="${src}" alt="프리셋" />
    </button>`
  ).join('');

  strip.querySelectorAll('.preset-thumb').forEach((btn) => {
    btn.addEventListener('click', () => {
      setCreatorAvatar(btn.dataset.psrc);
    });
  });

  renderCreatorLorebook();
  renderCreatorLiveCard();
}

function setCreatorAvatar(src) {
  state.creatorAvatar = src;
  $('#creatorAvatarPreview').src = src;
  $$('.preset-thumb').forEach((b) => b.classList.toggle('active', b.dataset.psrc === src));
  renderCreatorLiveCard();
}

function resetCreatorForm() {
  $('#creatorHeading').textContent = '🪄 캐릭터 스튜디오';
  $('#charIdInput').value = '';
  $('#charNameInput').value = '';
  $('#charAnimeTitleInput').value = '';
  $('#charPlayStyleInput').value = 'character';
  $('#charPowerSystemInput').value = '';
  $('#charCastInput').value = '';
  $('#charTitleInput').value = '';
  $('#charSubtitleInput').value = '';
  $('#charTagsInput').value = '';
  $('#charStageInput').value = '첫 만남 · 1막';
  $('#charMoodInput').value = '호기심 어린 시선';
  $('#charWorldInput').value = '';
  $('#charPersonaInput').value = '';
  $('#charOpeningInput').value = '';
  $('#charSuggestionsInput').value = '';
  $('#wizardConceptInput').value = '';
  state.creatorLorebook = [];
  setCreatorAvatar(PRESET_AVATARS[0]);
  renderCreatorLorebook();
  renderCreatorLiveCard();
}

function loadCharacterIntoCreator(c) {
  $('#creatorHeading').textContent = c.isBuiltin ? `🪄 '${c.name}' 커스텀 복제 / 편집` : `🪄 '${c.name}' 캐릭터 수정`;
  $('#charIdInput').value = c.isBuiltin ? '' : c.id;
  $('#charNameInput').value = c.name || '';
  $('#charGenreInput').value = c.genre || 'romance';
  $('#charAnimeTitleInput').value = c.animeTitle || '';
  $('#charPlayStyleInput').value = c.playStyle || 'character';
  $('#charPowerSystemInput').value = c.powerSystem || '';
  $('#charCastInput').value = Array.isArray(c.castMembers) ? c.castMembers.join(', ') : '';
  $('#charTitleInput').value = c.title || '';
  $('#charSubtitleInput').value = c.subtitle || '';
  $('#charTagsInput').value = (c.tags || []).join(' ');
  $('#charStageInput').value = c.relationshipStage || '';
  $('#charMoodInput').value = c.initialMood || '';
  $('#charWorldInput').value = c.worldSummary || '';
  $('#charPersonaInput').value = c.personaPrompt || '';
  $('#charOpeningInput').value = c.openingMessage || '';
  $('#charSuggestionsInput').value = (c.suggestedReplies || []).join('\n');
  state.creatorLorebook = structuredClone(c.lorebook || []);
  setCreatorAvatar(c.avatar || PRESET_AVATARS[0]);
  renderCreatorLorebook();
  renderCreatorLiveCard();
}

function renderCreatorLorebook() {
  const wrap = $('#creatorLoreList');
  if (!state.creatorLorebook.length) {
    wrap.innerHTML = '<div class="field-hint">아직 추가된 로어북 항목이 없습니다. (선택 사항)</div>';
    return;
  }
  wrap.innerHTML = state.creatorLorebook
    .map(
      (item, idx) => `
    <div class="lore-edit-item" data-clidx="${idx}">
      <div class="lore-edit-top">
        <input type="text" class="cl-title" value="${escapeHtml(item.title)}" placeholder="항목 제목 (예: 비밀의 열쇠)" />
        <button type="button" class="icon-btn small cl-del">✕</button>
      </div>
      <input type="text" class="cl-kw" value="${escapeHtml(item.keywords)}" placeholder="발동 키워드 (쉼표 구분: 예 열쇠, 금고, 비밀)" />
      <textarea class="cl-content" rows="2" placeholder="키워드가 언급될 때 AI에 주입될 설정 내용">${escapeHtml(item.content)}</textarea>
    </div>`
    )
    .join('');

  wrap.querySelectorAll('.cl-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.closest('[data-clidx]').dataset.clidx);
      state.creatorLorebook.splice(idx, 1);
      renderCreatorLorebook();
    });
  });

  wrap.querySelectorAll('.lore-edit-item').forEach((el, idx) => {
    el.querySelector('.cl-title').addEventListener('input', (e) => { state.creatorLorebook[idx].title = e.target.value; });
    el.querySelector('.cl-kw').addEventListener('input', (e) => { state.creatorLorebook[idx].keywords = e.target.value; });
    el.querySelector('.cl-content').addEventListener('input', (e) => { state.creatorLorebook[idx].content = e.target.value; });
  });
}

function renderCreatorLiveCard() {
  const genreId = $('#charGenreInput').value || 'romance';
  const genreLabel = state.genres.find((g) => g.id === genreId)?.label || '로맨스';
  const tags = ($('#charTagsInput').value || '#오리지널 #스토리챗')
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));

  const preview = {
    id: 'preview',
    isOriginal: false,
    name: $('#charNameInput').value.trim() || '새 캐릭터 이름',
    title: $('#charTitleInput').value.trim() || '여기에 작품 타이틀이 표시됩니다',
    subtitle: $('#charSubtitleInput').value.trim() || '“캐릭터의 매력적인 대표 대사가 들어갑니다.”',
    genreLabel,
    avatar: state.creatorAvatar,
    tags,
    plays: 1,
    likes: 0,
    isFavorite: false,
  };
  $('#creatorLiveCard').innerHTML = `
    <div class="char-card-media">
      <img src="${escapeHtml(preview.avatar)}" alt="" />
      <div class="char-card-gradient"></div>
      <div class="char-card-top-badges">
        <span class="card-pill">${escapeHtml(preview.genreLabel)}</span>
      </div>
      <div class="char-card-overlay-info">
        <div class="char-card-name"><span>${escapeHtml(preview.name)}</span></div>
        <div class="char-card-title">${escapeHtml(preview.title)}</div>
      </div>
    </div>
    <div class="char-card-body">
      <div class="char-card-subtitle">${escapeHtml(preview.subtitle)}</div>
      <div class="char-card-tags">${preview.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>
    </div>`;
}

async function handleAvatarUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const { url } = await api.uploadImage(reader.result);
      setCreatorAvatar(url);
      showToast('프로필 이미지가 업로드되었습니다.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

async function handleWizardAutofill() {
  const concept = $('#wizardConceptInput').value.trim();
  if (!concept) {
    showToast('캐릭터 아이디어나 키워드를 먼저 입력해 주세요.', 'error');
    return;
  }
  const btn = $('#wizardAutofillBtn');
  btn.disabled = true;
  btn.textContent = '✨ AI 창작 중...';
  try {
    const res = await api.autofillCharacter({
      concept,
      genre: $('#charGenreInput').value,
      name: $('#charNameInput').value.trim(),
    });
    const c = res.character;
    if (c.name) $('#charNameInput').value = c.name;
    if (c.title) $('#charTitleInput').value = c.title;
    if (c.subtitle) $('#charSubtitleInput').value = c.subtitle;
    if (c.tags) $('#charTagsInput').value = Array.isArray(c.tags) ? c.tags.join(' ') : c.tags;
    if (c.worldSummary) $('#charWorldInput').value = c.worldSummary;
    if (c.personaPrompt) $('#charPersonaInput').value = c.personaPrompt;
    if (c.openingMessage) $('#charOpeningInput').value = c.openingMessage;
    if (c.initialMood) $('#charMoodInput').value = c.initialMood;
    if (c.relationshipStage) $('#charStageInput').value = c.relationshipStage;
    if (Array.isArray(c.suggestedReplies)) $('#charSuggestionsInput').value = c.suggestedReplies.join('\n');
    if (Array.isArray(c.lorebook)) {
      state.creatorLorebook = c.lorebook;
      renderCreatorLorebook();
    }
    renderCreatorLiveCard();
    showToast(res.isDemo ? '미리보기 템플릿으로 자동 작성했어요! (Gemini API 연결 시 초정밀 AI 창작)' : '✨ Gemini AI가 캐릭터 설정을 완성했습니다!');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI 자동 작성';
  }
}

function collectCreatorPayload() {
  const animeTitle = $('#charAnimeTitleInput').value.trim();
  const genre = $('#charGenreInput').value;
  return {
    id: $('#charIdInput').value.trim() || undefined,
    name: $('#charNameInput').value.trim(),
    genre,
    isAnime: genre === 'anime' || Boolean(animeTitle),
    animeTitle,
    playStyle: $('#charPlayStyleInput').value,
    powerSystem: $('#charPowerSystemInput').value.trim(),
    castMembers: $('#charCastInput').value.trim(),
    title: $('#charTitleInput').value.trim(),
    subtitle: $('#charSubtitleInput').value.trim(),
    tags: $('#charTagsInput').value.trim(),
    relationshipStage: $('#charStageInput').value.trim(),
    initialMood: $('#charMoodInput').value.trim(),
    worldSummary: $('#charWorldInput').value.trim(),
    personaPrompt: $('#charPersonaInput').value.trim(),
    openingMessage: $('#charOpeningInput').value.trim(),
    suggestedReplies: $('#charSuggestionsInput').value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3),
    avatar: state.creatorAvatar,
    lorebook: state.creatorLorebook.filter((l) => l.keywords.trim() && l.content.trim()),
  };
}

async function handleCreatorSubmit(e) {
  e.preventDefault();
  const payload = collectCreatorPayload();
  if (!payload.name || !payload.title || !payload.personaPrompt || !payload.openingMessage) {
    showToast('필수 항목(*)을 모두 입력해 주세요.', 'error');
    return;
  }
  try {
    const { character } = await api.saveCharacter(payload);
    await reloadCharacters();
    showToast(`✦ '${character.name}' 캐릭터가 저장되었습니다!`);
    await startNewStory(character.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function handleExportCharJson() {
  const payload = collectCreatorPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${payload.name || 'crack_character'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('캐릭터 JSON 카드를 내보냈습니다.');
}

function handleImportCharJson(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      loadCharacterIntoCreator({ ...parsed, isOriginal: false, id: '' });
      showToast('JSON 캐릭터 카드를 불러왔습니다.');
    } catch {
      showToast('올바른 JSON 캐릭터 파일이 아닙니다.', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ================================
// LIBRARY & PERSONAS
// ================================
function renderLibraryView() {
  // Personas
  const activeId = state.config?.activePersonaId || state.personas[0]?.id;
  $('#personaGrid').innerHTML = state.personas
    .map(
      (p) => `
    <div class="persona-card ${p.id === activeId ? 'active' : ''}">
      <div class="persona-card-head">
        <span class="persona-name">${escapeHtml(p.name)}</span>
        <span class="card-pill">${escapeHtml(p.gender || '미지정')}</span>
      </div>
      <div class="persona-desc">${escapeHtml(p.description || '설명이 없습니다.')}</div>
      <div class="persona-actions">
        ${
          p.id === activeId
            ? '<span class="badge-free">기본 활성 프로필</span>'
            : `<button class="secondary-btn small" data-activate-persona="${p.id}">기본으로 설정</button>`
        }
        <button class="ghost-btn small" data-edit-persona="${p.id}">수정</button>
        ${state.personas.length > 1 ? `<button class="ghost-btn small danger-text" data-del-persona="${p.id}">삭제</button>` : ''}
      </div>
    </div>`
    )
    .join('');

  $$('[data-activate-persona]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.config = await api.updateConfig({ activePersonaId: btn.dataset.activatePersona });
      renderLibraryView();
      showToast('기본 페르소나가 변경되었습니다.');
    });
  });

  $$('[data-edit-persona]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = state.personas.find((x) => x.id === btn.dataset.editPersona);
      if (p) openPersonaModal(p);
    });
  });

  $$('[data-del-persona]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('이 페르소나를 삭제할까요?')) return;
      const res = await api.deletePersona(btn.dataset.delPersona);
      state.personas = res.personas;
      renderLibraryView();
    });
  });

  // Favorites
  const favs = state.characters.filter((c) => c.isFavorite);
  renderCharacterGrid($('#favoritesGrid'), favs, {
    emptyTitle: '즐겨찾기한 캐릭터가 아직 없어요',
    emptySub: '홈 화면 캐릭터 카드의 별(☆)을 눌러 보관함에 담아보세요.',
  });
}

function openPersonaModal(persona) {
  $('#personaModalTitle').textContent = persona ? '👤 페르소나 수정' : '👤 새 페르소나 만들기';
  $('#personaIdInput').value = persona?.id || '';
  $('#personaNameInput').value = persona?.name || '';
  $('#personaGenderInput').value = persona?.gender || '미지정';
  $('#personaDescInput').value = persona?.description || '';
  $('#personaModal').hidden = false;
}

async function handlePersonaSubmit(e) {
  e.preventDefault();
  try {
    const res = await api.savePersona({
      id: $('#personaIdInput').value || undefined,
      name: $('#personaNameInput').value.trim(),
      gender: $('#personaGenderInput').value.trim(),
      description: $('#personaDescInput').value.trim(),
    });
    state.personas = res.personas;
    closeModal('personaModal');
    renderLibraryView();
    if (state.activeSession) syncInspectorFields();
    showToast('페르소나가 저장되었습니다.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

init();

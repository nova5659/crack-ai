import { cloudBackend, setCloudRuntimeInfo } from './cloudBackend.js';

let runtimeMode = 'detecting'; // 'local' | 'cloud'
let detectPromise = null;

async function detectRuntime() {
  if (runtimeMode !== 'detecting') return runtimeMode;
  if (detectPromise) return detectPromise;

  detectPromise = (async () => {
    const host = window.location.hostname || '';
    const isLocalHost =
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host);

    // On GitHub Pages (*.github.io) or file/static hosts, jump straight into pure zero-latency Static Cloud Mode
    if (host.endsWith('.github.io')) {
      setCloudRuntimeInfo({ hasNetlifyFunction: false, hasServerKey: false });
      runtimeMode = 'cloud';
      return runtimeMode;
    }

    // 1. Try Local Node Server (CrackAI.app / localhost / LAN)
    if (isLocalHost) {
      try {
        const res = await fetch('./api/health', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const data = await res.json();
            if (data?.ok && data?.app === 'CRACK AI') {
              runtimeMode = 'local';
              return runtimeMode;
            }
          }
        }
      } catch {
        // Not local server
      }
    }

    // 2. Try Netlify Cloud Function health only if hosted on Netlify or custom root domain
    if (!isLocalHost) {
      try {
        const res = await fetch('/api/cloud/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const data = await res.json();
            if (data?.ok) {
              setCloudRuntimeInfo({
                hasNetlifyFunction: true,
                hasServerKey: Boolean(data.hasServerKey),
              });
              runtimeMode = 'cloud';
              return runtimeMode;
            }
          }
        }
      } catch {
        // Fallback to pure static cloud mode
      }
    }

    // 3. Pure static hosting (GitHub Pages / Cloudflare Pages / Netlify Drop)
    setCloudRuntimeInfo({ hasNetlifyFunction: false, hasServerKey: false });
    runtimeMode = 'cloud';
    return runtimeMode;
  })();

  return detectPromise;
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `요청 실패 (HTTP ${res.status})`);
  }
  return data;
}

async function dispatch(localFn, cloudFn) {
  const mode = await detectRuntime();
  return mode === 'cloud' ? cloudFn() : localFn();
}

export const api = {
  getRuntimeMode: () => detectRuntime(),

  getConfig: () => dispatch(() => request('/api/config'), () => cloudBackend.getConfig()),
  updateConfig: (patch) =>
    dispatch(
      () => request('/api/config', { method: 'PATCH', body: JSON.stringify(patch) }),
      () => cloudBackend.updateConfig(patch)
    ),
  verifyGemini: (payload) =>
    dispatch(
      () => request('/api/gemini/verify', { method: 'POST', body: JSON.stringify(payload) }),
      () => cloudBackend.verifyGemini(payload)
    ),
  getNetwork: () => dispatch(() => request('/api/network'), () => cloudBackend.getNetwork()),

  getCharacters: () => dispatch(() => request('/api/characters'), () => cloudBackend.getCharacters()),
  saveCharacter: (char) =>
    dispatch(
      () => request('/api/characters', { method: 'POST', body: JSON.stringify(char) }),
      () => cloudBackend.saveCharacter(char)
    ),
  deleteCharacter: (id) =>
    dispatch(
      () => request(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      () => cloudBackend.deleteCharacter(id)
    ),
  autofillCharacter: (payload) =>
    dispatch(
      () => request('/api/characters/autofill', { method: 'POST', body: JSON.stringify(payload) }),
      () => cloudBackend.autofillCharacter(payload)
    ),
  summonAnime: (payload) =>
    dispatch(
      () => request('/api/anime/summon', { method: 'POST', body: JSON.stringify(payload) }),
      () => cloudBackend.summonAnime(payload)
    ),
  toggleFavorite: (id) =>
    dispatch(
      () => request(`/api/characters/${encodeURIComponent(id)}/favorite`, { method: 'POST' }),
      () => cloudBackend.toggleFavorite(id)
    ),
  toggleLike: (id) =>
    dispatch(
      () => request(`/api/characters/${encodeURIComponent(id)}/like`, { method: 'POST' }),
      () => cloudBackend.toggleLike(id)
    ),

  uploadImage: (dataUrl) =>
    dispatch(
      () => request('/api/upload/image', { method: 'POST', body: JSON.stringify({ dataUrl }) }),
      () => cloudBackend.uploadImage(dataUrl)
    ),

  getPersonas: () => dispatch(() => request('/api/personas'), () => cloudBackend.getPersonas()),
  savePersona: (persona) =>
    dispatch(
      () => request('/api/personas', { method: 'POST', body: JSON.stringify(persona) }),
      () => cloudBackend.savePersona(persona)
    ),
  deletePersona: (id) =>
    dispatch(
      () => request(`/api/personas/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      () => cloudBackend.deletePersona(id)
    ),

  getSessions: (characterId = null) =>
    dispatch(
      () => request(characterId ? `/api/sessions?characterId=${encodeURIComponent(characterId)}` : '/api/sessions'),
      () => cloudBackend.getSessions(characterId)
    ),
  createSession: (payload) =>
    dispatch(
      () => request('/api/sessions', { method: 'POST', body: JSON.stringify(payload) }),
      () => cloudBackend.createSession(payload)
    ),
  getSession: (id) =>
    dispatch(
      () => request(`/api/sessions/${encodeURIComponent(id)}`),
      () => cloudBackend.getSession(id)
    ),
  updateSession: (id, patch) =>
    dispatch(
      () => request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      () => cloudBackend.updateSession(id, patch)
    ),
  deleteSession: (id) =>
    dispatch(
      () => request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      () => cloudBackend.deleteSession(id)
    ),

  updateMessage: (sessionId, msgId, patch) =>
    dispatch(
      () =>
        request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(msgId)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      () => cloudBackend.updateMessage(sessionId, msgId, patch)
    ),
  rewindSession: (sessionId, messageId) =>
    dispatch(
      () =>
        request(`/api/sessions/${encodeURIComponent(sessionId)}/rewind`, {
          method: 'POST',
          body: JSON.stringify({ messageId }),
        }),
      () => cloudBackend.rewindSession(sessionId, messageId)
    ),
  generateSuggestions: (sessionId) =>
    dispatch(
      () => request(`/api/sessions/${encodeURIComponent(sessionId)}/suggestions`, { method: 'POST' }),
      () => cloudBackend.generateSuggestions(sessionId)
    ),
  summarizeSession: (sessionId) =>
    dispatch(
      () => request(`/api/sessions/${encodeURIComponent(sessionId)}/summarize`, { method: 'POST' }),
      () => cloudBackend.summarizeSession(sessionId)
    ),

  exportStory: async (sessionId) => {
    const mode = await detectRuntime();
    if (mode === 'cloud') {
      return cloudBackend.exportStoryMarkdown(sessionId);
    }
    window.open(`/api/sessions/${encodeURIComponent(sessionId)}/export`, '_blank');
  },

  exportCloudBackup: () => cloudBackend.exportFullBackup(),
  importCloudBackup: (parsed) => cloudBackend.importFullBackup(parsed),

  async streamChat(sessionId, payload, handlers) {
    const mode = await detectRuntime();
    if (mode === 'cloud') {
      return cloudBackend.streamChat(sessionId, payload, handlers);
    }

    const { onStart, onDelta, onDone, onError, signal } = handlers;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `스트리밍 시작 실패 (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        if (!block.trim()) continue;
        let eventName = 'message';
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }
        if (eventName === 'start' && onStart) onStart(parsed);
        else if (eventName === 'delta' && onDelta) onDelta(parsed);
        else if (eventName === 'done' && onDone) onDone(parsed);
        else if (eventName === 'error' && onError) onError(parsed);
      }
    }
  },
};

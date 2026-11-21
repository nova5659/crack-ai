export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatKoreanCount(num = 0) {
  const n = Number(num) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}만`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}천`;
  return String(n);
}

export function formatRelativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function formatInlineSegment(rawLine) {
  let html = escapeHtml(rawLine);

  // Bold **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Narration *...* (single asterisks)
  html = html.replace(/\*([^*\n]+)\*/g, '<span class="narration">$1</span>');

  // Quoted dialogue "..." or “...” (avoid matching HTML attribute quotes!)
  html = html.replace(/(&quot;[^&]*?&quot;|“[^”]*?”)/g, '<span class="dialogue">$1</span>');

  return html;
}

/**
 * Renders Crack-style webnovel paragraphs with distinct narration (*...*),
 * dialogue ("..."), Breaking News cards (**[ 긴급 속보 ... ]**),
 * fenced codeblock status panels, and translucent RPG/Nation status cards.
 */
export function formatStoryHtml(text = '') {
  if (!text) return '';
  // Normalize fenced markdown code blocks (e.g., ```ini [국가 상태창] ... ```) into styled status blocks
  const normalized = String(text)
    .trim()
    .replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_, inner) => `\n\n@@CODEBLOCK@@${inner.trim()}@@ENDCODE@@\n\n`);

  const blocks = normalized.split(/\n{2,}/);
  const out = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('@@CODEBLOCK@@') && trimmed.endsWith('@@ENDCODE@@')) {
      const inner = trimmed.slice('@@CODEBLOCK@@'.length, -'@@ENDCODE@@'.length).trim();
      const lines = inner.split('\n').map((line) => formatInlineSegment(line));
      out.push(`<div class="status-card">${lines.join('<br />')}</div>`);
      continue;
    }

    // Breaking News / International News card for 《국가의 시대》
    if (/^\*\*\[.*(속보|뉴스|외교\s*서신).*\]\*\*/.test(trimmed) || /^\[.*(속보|뉴스).*\]\n/.test(trimmed)) {
      const lines = trimmed.split('\n').map((line) => formatInlineSegment(line));
      out.push(`<div class="news-card">${lines.join('<br />')}</div>`);
      continue;
    }

    // Status card blocks like **[ 모험가 상태창 ... ]** or **[ 국가 상태창 ... ]**
    if (/^\*\*\[.*\]\*\*/.test(trimmed) || /^\[.+\]\n/.test(trimmed)) {
      const lines = trimmed.split('\n').map((line) => formatInlineSegment(line));
      out.push(`<div class="status-card">${lines.join('<br />')}</div>`);
      continue;
    }

    const lines = trimmed.split('\n').map((line) => formatInlineSegment(line));
    out.push(`<p>${lines.join('<br />')}</p>`);
  }

  return out.join('');
}

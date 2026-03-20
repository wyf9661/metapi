import { marked } from 'marked';
import { formatDateTimeLocal } from './checkinLogTime.js';

const VOID_TAGS = new Set(['br', 'hr', 'img']);
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']);
const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'center',
  'code',
  'del',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLineEndings(value: string): string {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function isLikelyHtml(content: string): boolean {
  return /<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.test(content) || /<\/([a-z][a-z0-9-]*)>/i.test(content);
}

function isLikelyMarkdown(content: string): boolean {
  return /(^|\n)(#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+|```|~~~)/.test(content)
    || /!\[[^\]]*]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~/.test(content);
}

function sanitizeUrl(raw: string | null | undefined, allowDataImage = false): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('#') || value.startsWith('/')) return value;
  if (allowDataImage && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:/i.test(value)) return value;
  if (/^tel:/i.test(value)) return value;
  return null;
}

function extractVisibleTextFallback(html: string): string {
  return normalizeLineEndings(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderInlineMarkdown(text: string): string {
  const tokens: string[] = [];
  const pushToken = (html: string) => {
    const key = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return key;
  };

  let html = escapeHtml(text);

  html = html.replace(/`([^`]+)`/g, (_, code) => pushToken(`<code>${escapeHtml(code)}</code>`));
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_, alt, src, title) => {
    const safeSrc = sanitizeUrl(src, true);
    if (!safeSrc) return escapeHtml(String(alt || ''));
    const titleAttr = title ? ` title="${escapeHtml(String(title))}"` : '';
    return pushToken(`<img src="${escapeHtml(safeSrc)}" alt="${escapeHtml(String(alt || ''))}"${titleAttr}>`);
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_, label, href, title) => {
    const safeHref = sanitizeUrl(href, false);
    if (!safeHref) return escapeHtml(String(label || ''));
    const titleAttr = title ? ` title="${escapeHtml(String(title))}"` : '';
    return pushToken(`<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${escapeHtml(String(label || ''))}</a>`);
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/(^|[^\*])\*([^*\n]+)\*(?=[^\*]|$)/g, '$1<em>$2</em>');

  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
}

function isMarkdownListLine(line: string, ordered: boolean): boolean {
  return ordered ? /^\s*\d+\.\s+/.test(line) : /^\s*[-*+]\s+/.test(line);
}

function consumeMarkdownList(lines: string[], startIndex: number, ordered: boolean) {
  const items: string[] = [];
  let index = startIndex;
  while (index < lines.length && isMarkdownListLine(lines[index] || '', ordered)) {
    const line = lines[index] || '';
    const item = ordered
      ? line.replace(/^\s*\d+\.\s+/, '')
      : line.replace(/^\s*[-*+]\s+/, '');
    items.push(`<li>${renderInlineMarkdown(item.trim())}</li>`);
    index += 1;
  }
  const tag = ordered ? 'ol' : 'ul';
  return {
    html: `<${tag}>${items.join('')}</${tag}>`,
    nextIndex: index,
  };
}

function consumeMarkdownQuote(lines: string[], startIndex: number) {
  const parts: string[] = [];
  let index = startIndex;
  while (index < lines.length && /^\s*>\s?/.test(lines[index] || '')) {
    parts.push((lines[index] || '').replace(/^\s*>\s?/, ''));
    index += 1;
  }
  return {
    html: `<blockquote>${renderMarkdown(parts.join('\n'))}</blockquote>`,
    nextIndex: index,
  };
}

function consumeMarkdownFence(lines: string[], startIndex: number) {
  const firstLine = String(lines[startIndex] || '');
  const marker = firstLine.startsWith('~~~') ? '~~~' : '```';
  const language = firstLine.slice(marker.length).trim().toLowerCase();
  const codeLines: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length && !String(lines[index] || '').startsWith(marker)) {
    codeLines.push(String(lines[index] || ''));
    index += 1;
  }
  if (index < lines.length) index += 1;
  const classAttr = language && /^[a-z0-9_-]+$/i.test(language) ? ` class="language-${escapeHtml(language)}"` : '';
  return {
    html: `<pre><code${classAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
    nextIndex: index,
  };
}

function consumeMarkdownParagraph(lines: string[], startIndex: number) {
  const parts: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = String(lines[index] || '');
    const trimmed = line.trim();
    if (!trimmed) break;
    if (/^#{1,6}\s+/.test(trimmed)) break;
    if (/^\s*>\s?/.test(line)) break;
    if (isMarkdownListLine(line, false) || isMarkdownListLine(line, true)) break;
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) break;
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) break;
    parts.push(line);
    index += 1;
  }

  const content = parts.map((line) => renderInlineMarkdown(line.trim())).join('<br />');
  return {
    html: `<p>${content}</p>`,
    nextIndex: index,
  };
}

function renderMarkdown(content: string): string {
  const lines = normalizeLineEndings(content).split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = String(lines[index] || '');
    const line = rawLine.trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith('```') || line.startsWith('~~~')) {
      const fenced = consumeMarkdownFence(lines, index);
      blocks.push(fenced.html);
      index = fenced.nextIndex;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(rawLine)) {
      const quoted = consumeMarkdownQuote(lines, index);
      blocks.push(quoted.html);
      index = quoted.nextIndex;
      continue;
    }

    if (isMarkdownListLine(rawLine, false)) {
      const list = consumeMarkdownList(lines, index, false);
      blocks.push(list.html);
      index = list.nextIndex;
      continue;
    }

    if (isMarkdownListLine(rawLine, true)) {
      const list = consumeMarkdownList(lines, index, true);
      blocks.push(list.html);
      index = list.nextIndex;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line)) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    const paragraph = consumeMarkdownParagraph(lines, index);
    blocks.push(paragraph.html);
    index = paragraph.nextIndex;
  }

  return blocks.join('');
}

function sanitizeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) {
    return '';
  }

  const childrenHtml = Array.from(element.childNodes).map((child) => sanitizeNode(child)).join('');
  if (!ALLOWED_TAGS.has(tag)) {
    return childrenHtml;
  }

  const attrs: string[] = [];
  if (tag === 'a') {
    const safeHref = sanitizeUrl(element.getAttribute('href'));
    if (safeHref) {
      attrs.push(` href="${escapeHtml(safeHref)}"`);
      attrs.push(' target="_blank"');
      attrs.push(' rel="noopener noreferrer"');
    }
    const title = element.getAttribute('title');
    if (title) {
      attrs.push(` title="${escapeHtml(title)}"`);
    }
  } else if (tag === 'img') {
    const safeSrc = sanitizeUrl(element.getAttribute('src'), true);
    if (!safeSrc) return '';
    attrs.push(` src="${escapeHtml(safeSrc)}"`);
    const alt = element.getAttribute('alt');
    if (alt) attrs.push(` alt="${escapeHtml(alt)}"`);
    const title = element.getAttribute('title');
    if (title) attrs.push(` title="${escapeHtml(title)}"`);
  } else if (tag === 'code') {
    const className = String(element.getAttribute('class') || '').trim();
    if (/^language-[a-z0-9_-]+$/i.test(className)) {
      attrs.push(` class="${escapeHtml(className)}"`);
    }
  } else if (tag === 'td' || tag === 'th') {
    const colspan = Number.parseInt(String(element.getAttribute('colspan') || ''), 10);
    const rowspan = Number.parseInt(String(element.getAttribute('rowspan') || ''), 10);
    if (Number.isFinite(colspan) && colspan > 1) attrs.push(` colspan="${colspan}"`);
    if (Number.isFinite(rowspan) && rowspan > 1) attrs.push(` rowspan="${rowspan}"`);
  }

  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrs.join('')}>`;
  }
  return `<${tag}${attrs.join('')}>${childrenHtml}</${tag}>`;
}

function sanitizeAnnouncementHtml(html: string): string {
  if (typeof DOMParser !== 'function' || typeof Node === 'undefined') {
    return renderPlainText(extractVisibleTextFallback(html));
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  return Array.from(doc.body.childNodes).map((node) => sanitizeNode(node)).join('');
}

function renderPlainText(content: string): string {
  const paragraphs = normalizeLineEndings(content)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return `<p>${escapeHtml(String(content || '').trim())}</p>`;
  }

  return paragraphs
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

export function readClientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function formatSiteAnnouncementSeenAt(
  value: string | null | undefined,
  timeZone = readClientTimeZone(),
): string {
  return formatDateTimeLocal(value, 'zh-CN', timeZone);
}

export function renderSiteAnnouncementHtml(content: string): string {
  const raw = String(content || '').trim();
  if (!raw) return '<p>-</p>';

  if (isLikelyHtml(raw)) {
    return sanitizeAnnouncementHtml(raw);
  }

  if (isLikelyMarkdown(raw)) {
    const rendered = String(marked.parse(raw, { gfm: true, breaks: true }));
    return sanitizeAnnouncementHtml(rendered || renderMarkdown(raw));
  }

  return renderPlainText(raw);
}

export function SiteAnnouncementContent({ content }: { content: string }) {
  return (
    <div
      className="announcement-rich-content"
      dangerouslySetInnerHTML={{ __html: renderSiteAnnouncementHtml(content) }}
    />
  );
}

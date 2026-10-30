import { marked } from 'marked';
import katex from 'katex';
import { sanitizeRichHtml } from './siteAnnouncementPresentation.js';
import { tr } from '../../i18n.js';

// LaTeX 公式占位符前缀，用于在 marked 渲染前后安全传递。
const KATEX_DISPLAY = '%%KATEX_DISPLAY_';
const KATEX_INLINE = '%%KATEX_INLINE_';
const KATEX_END = '%%';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 提取 LaTeX 公式并替换为纯文本占位符：防止被 marked 误解析，也保证消毒器
// 不会碰到公式内容（占位符只是一段普通文本）。
// 匹配顺序重要：$$ 必须在 $ 之前，\[ 在 \( 之前。
function extractLatex(text: string): { text: string; formulas: string[] } {
  const formulas: string[] = [];
  const withPlaceholders = text
    // 块级公式：$$ ... $$
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
      const idx = formulas.length;
      formulas.push(tex.trim());
      return KATEX_DISPLAY + idx + KATEX_END;
    })
    // 块级公式：\[ ... \]
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => {
      const idx = formulas.length;
      formulas.push(tex.trim());
      return KATEX_DISPLAY + idx + KATEX_END;
    })
    // 行内公式：$ ... $（不匹配 $$，不跨行，不匹配空内容）
    .replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_m, tex) => {
      const idx = formulas.length;
      formulas.push(tex.trim());
      return KATEX_INLINE + idx + KATEX_END;
    })
    // 行内公式：\( ... \)
    .replace(/\\\((.+?)\\\)/g, (_m, tex) => {
      const idx = formulas.length;
      formulas.push(tex.trim());
      return KATEX_INLINE + idx + KATEX_END;
    });
  return { text: withPlaceholders, formulas };
}

// 将占位符替换为 KaTeX 渲染产物。必须在消毒之后调用：
// KaTeX 产物是本地生成的静态标记（trust: false），而白名单消毒器会剥掉
// class="katex…" 并展开 MathML 结构——先注入再消毒会把公式渲染破坏成
// “裸 TeX + 字形文本”的乱码（此前测活日志的回归即源于此）。
function injectKatex(html: string, formulas: string[]): string {
  if (formulas.length === 0) return html;
  return html
    .replace(/%%KATEX_DISPLAY_(\d+)%%/g, (_m, idx) => {
      const tex = formulas[parseInt(idx)];
      try {
        return `<div class="katex-display-block">${katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: false })}</div>`;
      } catch {
        return `<code class="katex-fallback">${escapeHtml(tex)}</code>`;
      }
    })
    .replace(/%%KATEX_INLINE_(\d+)%%/g, (_m, idx) => {
      const tex = formulas[parseInt(idx)];
      try {
        return katex.renderToString(tex, { displayMode: false, throwOnError: false, trust: false });
      } catch {
        return `<code class="katex-fallback">${escapeHtml(tex)}</code>`;
      }
    });
}

// 上游返回的 HTML 属不可信内容（管理台存储型 XSS 风险），统一经白名单消毒后再注入。
// 顺序：提取公式占位符 → rendered Markdown → 消毒 → 注入 KaTeX 产物。
export function renderMarkdownWithLatexSafe(text: string): string {
  const { text: withPlaceholders, formulas } = extractLatex(text);

  let html: string;
  try {
    html = String(marked.parse(withPlaceholders, { gfm: true, breaks: true }));
  } catch {
    html = withPlaceholders;
  }

  return injectKatex(sanitizeRichHtml(html), formulas);
}

// 清理乱码、解析 JSON 提取内容、渲染 Markdown（含 LaTeX）
export function renderProbeResponseText(raw: string | null | undefined): string {
  const text = String(raw || '').trim();
  if (!text) return '-';

  // 检测疑似二进制/乱码内容：统计 UTF-8 替换字符 (U+FFFD) 和控制字符比例。
  // 注意：中文等非 ASCII 正常文本不应被过滤，所以只看 U+FFFD 和控制字符，不看非 ASCII 字符本身。
  const replacementCharCount = (text.match(/\uFFFD/g) || []).length;
  const controlCharCount = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
  const garbageRatio = (replacementCharCount + controlCharCount) / Math.max(text.length, 1);

  if (garbageRatio > 0.15) {
    // 疑似二进制/压缩数据未正常解码。不直接丢弃，而是显示可读提示 + 可展开原始数据。
    // 尝试提取其中可读的 ASCII 片段作为预览
    const readableSnippets = text
      .replace(/[^\x20-\x7E\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n\r]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
    const escapedRaw = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedSnippet = readableSnippets.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return (
      '<div class="probe-binary-notice">'
      + `<div class="probe-binary-hint">${tr('⚠ 上游返回了疑似二进制/压缩数据')}（${tr('替换字符')} ${replacementCharCount} ${tr('个，控制字符')} ${controlCharCount} ${tr('个），可能未正常解码。')}</div>`
      + (readableSnippets ? `<div class="probe-binary-snippet">${tr('可读片段：')}${escapedSnippet}</div>` : '')
      + `<details class="probe-binary-details"><summary>${tr('查看原始数据')}（${text.length} ${tr('字符')}）</summary><pre class="probe-binary-raw">${escapedRaw}</pre></details>`
      + '</div>'
    );
  }

  // 尝试解析 JSON（完整的 API 响应对象）
  try {
    const parsed = JSON.parse(text);
    // OpenAI / 标准聊天响应格式
    const content = parsed?.choices?.[0]?.message?.content
      || parsed?.choices?.[0]?.delta?.content
      || parsed?.message?.content
      || parsed?.output?.[0]?.content?.[0]?.text
      || parsed?.content
      || parsed?.text
      || parsed?.output
      || null;
    if (content !== null && content !== undefined) {
      const cleanContent = String(content);
      try {
        return renderMarkdownWithLatexSafe(cleanContent);
      } catch {
        return cleanContent;
      }
    }
    // JSON 解析成功但没有提取到内容字段，说明可能是其他格式的响应，直接渲染为格式化 JSON
    // (转义后输出：响应内容来自上游，不可信)
    const escapedJson = JSON.stringify(parsed, null, 2)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre class="text-xs whitespace-pre-wrap break-all">${escapedJson}</pre>`;
  } catch {
    // 不是有效 JSON，当作普通文本处理
  }

  // 普通文本：Markdown 渲染，支持换行和基本格式
  try {
    return renderMarkdownWithLatexSafe(text);
  } catch {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

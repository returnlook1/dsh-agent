/**
 * 助手消息的 Markdown 渲染（带安全约束）。
 *
 * 约束（模型输出不可信）：
 * - `html: false`：Markdown 里的原始 HTML 一律转义，不会进入 DOM；
 * - 链接/图片走白名单协议（http / https / mailto / tel / 相对路径 / 锚点），
 *   其余（`javascript:`、`data:` 等）降级为纯文本；
 * - 只渲染 marked 自己生成的标签，因此不需要 DOMPurify，也不依赖 DOM（可在 node 里测）。
 *
 * 代码块不接入语法高亮库（体积换不来收益），只用等宽字体 + 语言标签。
 */
import { Marked, type Tokens } from 'marked'

/** 允许出现在链接里的协议。 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i

/** 判断 URL 是否安全；相对路径与锚点放行。 */
export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true
  }
  // 没有协议头的相对路径（如 a/b.md）也放行；带未知协议的拒绝。
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)
  if (scheme === null) return true
  return SAFE_SCHEME.test(trimmed)
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 渲染时用的实例：GFM + 单换行即换行（聊天语境更自然）。 */
const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
})

marked.use({
  renderer: {
    link(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens as Tokens.Generic[])
      if (!isSafeUrl(token.href)) return text
      const titleText = token.title ?? ''
      const title = titleText.length === 0 ? '' : ` title="${escapeHtml(titleText)}"`
      return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noreferrer noopener">${text}</a>`
    },

    image(token: Tokens.Image): string {
      // 图片不直接嵌入（离线环境不可控），只保留可读文本；安全 URL 变成链接。
      const label = escapeHtml(token.text.length > 0 ? token.text : '图片')
      if (!isSafeUrl(token.href)) return `<span class="md-image-ref">${label}</span>`
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer noopener" class="md-image-ref">${label}</a>`
    },

    // 原始 HTML（块级或行内）一律转义：模型输出不可信，不能直接进 DOM。
    html(token: Tokens.HTML | Tokens.Tag): string {
      const text = escapeHtml(token.text ?? '')
      return 'block' in token && token.block ? `<p class="md-html">${text}</p>` : text
    },

    code(token: Tokens.Code): string {
      const lang = (token.lang ?? '').split(/\s+/)[0]?.trim() ?? ''
      const dataLang = lang.length > 0 ? ` data-lang="${escapeHtml(lang)}"` : ''
      return `<pre class="md-code"${dataLang}><code>${escapeHtml(token.text)}</code></pre>`
    },
  },
})

/**
 * 把 Markdown 文本渲染成安全的 HTML。
 * @param markdown - 模型/用户输入文本（可含 Markdown）
 */
export function renderMarkdown(markdown: string): string {
  if (markdown.trim().length === 0) return ''
  return marked.parse(markdown, { async: false }) as string
}

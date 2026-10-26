/**
 * Markdown 渲染与安全约束（模型输出不可信）。
 */
import { describe, expect, it } from 'vitest'

import { isSafeUrl, renderMarkdown } from '../src/utils/markdown'

describe('isSafeUrl', () => {
  it('放行 http/https/mailto/tel 与相对路径', () => {
    for (const url of ['https://example.com', 'http://x.y', 'mailto:a@b.c', 'tel:+86123', '/docs/x', './a', '../b', '#anchor']) {
      expect(isSafeUrl(url)).toBe(true)
    }
  })

  it('拒绝 javascript / data / vbscript 等协议', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///c:/x']) {
      expect(isSafeUrl(url)).toBe(false)
    }
  })
})

describe('renderMarkdown', () => {
  it('渲染常用结构', () => {
    const html = renderMarkdown('# 标题\n\n**加粗** 与 `inline`\n\n- 一\n- 二\n\n1. 甲\n2. 乙')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>inline</code>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
  })

  it('单换行即换行（聊天语境）', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br')
  })

  it('代码块带语言标签并转义内容', () => {
    const html = renderMarkdown('```ts\nconst a = "<script>alert(1)</script>"\n```')
    expect(html).toContain('<pre class="md-code" data-lang="ts">')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('原始 HTML 被转义（不会执行）', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n<b>hi</b>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror="')
    expect(html).toContain('&lt;img')
  })

  it('javascript: 链接降级为纯文本', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a ')
    expect(html).toContain('点我')
  })

  it('safe 链接加上 noopener', () => {
    const html = renderMarkdown('[文档](https://example.com/docs "标题")')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
  })

  it('图片不嵌入，只保留文本/链接', () => {
    const html = renderMarkdown('![示意图](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://example.com/a.png"')
    expect(html).toContain('示意图')
  })

  it('表格（GFM）', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
  })

  it('空文本返回空串', () => {
    expect(renderMarkdown('   ')).toBe('')
  })
})

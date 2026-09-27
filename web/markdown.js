/**
 * Zero-dependency CommonMark + GFM renderer for the DSH Bubble panel.
 *
 * Pure string in, HTML string out: no DOM, no dependencies, and therefore unit-testable in plain
 * node (`node scripts/check-markdown.mjs`). The ball's page loads it as `window.BubbleMarkdown`.
 *
 * Everything from the model is escaped before any markup is produced, and link targets are limited
 * to http, https, and mailto, so a message can never inject markup into the panel.
 *
 * Supported: ATX headings, fenced code (``` and ~~~), blockquotes (nested), ordered/unordered lists
 * with nesting, GFM task list items, GFM tables with alignment, thematic breaks, paragraphs with
 * hard breaks, and inline code, strong, emphasis, strikethrough, links, images, autolinks, backslash
 * escapes, plus TeX math (`$x$`, `$$x$$`, `\(x\)`, `\[x\]`) handed to a caller-supplied renderer.
 *
 * @module dsh-bubble/web/markdown
 */
((root, factory) => {
  const api = factory()
  if (typeof module === 'object' && module.exports !== undefined) module.exports = api
  if (root !== undefined && root !== null) root.BubbleMarkdown = api
})(typeof globalThis === 'undefined' ? undefined : globalThis, () => {
  'use strict'

  /** Marker that survives HTML escaping and markdown transforms. */
  const MARK = '\u0000'
  const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, 'gu')

  const ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }

  /** Escape the five characters that can change markup. */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/gu, (character) => ESCAPES[character])
  }

  /** Keep only links a chat message should be able to open. */
  function safeUrl(url) {
    const trimmed = String(url).trim()
    if (/^(https?:|mailto:)/iu.test(trimmed)) return trimmed
    if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed
    return null
  }

  /** Inline state shared by the passes of one line. */
  function newContext(math) {
    return { math, stashed: [] }
  }

  /** Park rendered HTML (code spans, math, escapes) so later passes cannot rewrite it. */
  function stash(context, html) {
    context.stashed.push(html)
    return `${MARK}${context.stashed.length - 1}${MARK}`
  }

  /** Put parked HTML back once every transform has run. */
  function restore(context, text) {
    return text.replace(PLACEHOLDER, (_match, index) => context.stashed[Number(index)] ?? '')
  }

  /**
   * Render one TeX snippet.
   *
   * @param context - Inline context carrying the caller's math renderer.
   * @param tex - Raw TeX source.
   * @param display - Whether this is display math.
   * @returns Parked HTML, or the escaped TeX when no renderer is available.
   */
  function renderMath(context, tex, display) {
    const source = tex.trim()
    if (source === '') return ''
    const renderer = context.math
    if (typeof renderer === 'function') {
      try {
        const html = renderer(source, display)
        if (typeof html === 'string' && html !== '') return html
      } catch {
        // Fall through to the raw form; a TeX error must not break the message.
      }
    }
    return `<code class="math-raw">${escapeHtml(source)}</code>`
  }

  /** Transform the inline parts of one already-escaped fragment. */
  function inlineEscaped(text, context) {
    let out = text
    // Images first: their alt text must not be processed as a link.
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/gu, (match, alt, url, title) => {
      const target = safeUrl(unescapeEntities(url))
      if (target === null) return match
      const caption = title === undefined ? '' : ` title="${title}"`
      return `<img src="${escapeHtml(target)}" alt="${alt}"${caption} loading="lazy">`
    })
    out = out.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/gu, (match, label, url, title) => {
      const target = safeUrl(unescapeEntities(url))
      if (target === null) return match
      const caption = title === undefined ? '' : ` title="${title}"`
      return `<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer noopener"${caption}>${label}</a>`
    })
    // Autolinks: the CommonMark form, then a bare URL.
    out = out.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/giu, (_match, url) => {
      const target = safeUrl(url)
      return target === null ? url : `<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer noopener">${url}</a>`
    })
    out = out.replace(/(^|[\s(（])((?:https?:\/\/)[^\s<)）]+)/giu, (_match, lead, url) => {
      const target = safeUrl(url)
      return target === null ? `${lead}${url}` : `${lead}<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer noopener">${url}</a>`
    })
    out = out.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>')
    out = out.replace(/~~([^~\n]+)~~/gu, '<del>$1</del>')
    return out
  }

  /** Undo entity escaping inside an extracted URL. */
  function unescapeEntities(text) {
    return String(text)
      .replace(/&amp;/gu, '&')
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
  }

  /**
   * Render the inline markup of one text run.
   *
   * @param raw - Raw source text.
   * @param context - Inline context.
   * @returns HTML for the run.
   */
  function renderInline(raw, context) {
    let text = String(raw)
    // Code spans first: markup inside them is literal.
    text = text.replace(/(`+)([\s\S]*?)\1/gu, (_match, _ticks, code) => {
      const body = String(code).replace(/^ | $/gu, '')
      return stash(context, `<code>${escapeHtml(body)}</code>`)
    })
    // Math before backslash escapes, otherwise `\(x\)` would be reduced to a literal parenthesis
    // before the math pass ever sees it. Display forms run before inline so `$$` is never read as an
    // empty `$…$`.
    text = text.replace(/\$\$([\s\S]+?)\$\$/gu, (_match, tex) => stash(context, renderMath(context, tex, true)))
    text = text.replace(/\\\[([\s\S]+?)\\\]/gu, (_match, tex) => stash(context, renderMath(context, tex, true)))
    text = text.replace(/\\\(([\s\S]+?)\\\)/gu, (_match, tex) => stash(context, renderMath(context, tex, false)))
    // Inline `$…$`: no space just inside the delimiters, no digit just after the closing one
    // (keeps "$5 and $10" as prose), and never a backslash-escaped opener.
    text = text.replace(
      /(^|[^\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/gu,
      (match, lead, tex) => `${lead}${stash(context, renderMath(context, tex, false))}`,
    )
    // Backslash escapes park the literal character before any transform can see it.
    text = text.replace(/\\([\\`*_{}[\]()#+\-.!~>|$])/gu, (_match, character) =>
      stash(context, escapeHtml(character)))
    text = escapeHtml(text)
    text = inlineEscaped(text, context)
    return restore(context, text)
  }

  /** Split a table row into trimmed cells, dropping the outer pipes. */
  function splitRow(line) {
    let text = line.trim()
    if (text.startsWith('|')) text = text.slice(1)
    if (text.endsWith('|')) text = text.slice(0, -1)
    const cells = []
    let current = ''
    let escaped = false
    let inCode = false
    for (const character of text) {
      if (escaped) {
        current += character
        escaped = false
        continue
      }
      if (character === '\\') {
        current += character
        escaped = true
        continue
      }
      if (character === '`') inCode = !inCode
      if (character === '|' && !inCode) {
        cells.push(current)
        current = ''
        continue
      }
      current += character
    }
    cells.push(current)
    return cells.map((cell) => cell.trim())
  }

  /** Whether a line is a GFM table separator row. */
  function isSeparatorRow(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u.test(line) && line.includes('-')
  }

  /** Alignment keywords from a separator row. */
  function alignmentsOf(line) {
    return splitRow(line).map((cell) => {
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      if (left) return 'left'
      return ''
    })
  }

  /** Leading spaces of a line, counting a tab as four. */
  function indentOf(line) {
    let width = 0
    for (const character of line) {
      if (character === ' ') width += 1
      else if (character === '\t') width += 4
      else break
    }
    return width
  }

  const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u
  const TASK_ITEM = /^\[([ xX])\]\s+([\s\S]*)$/u

  /**
   * Render a block of source lines.
   *
   * @param lines - Source lines without trailing newlines.
   * @param context - Inline context.
   * @returns HTML for the block.
   */
  function renderBlocks(lines, context) {
    const html = []
    let index = 0
    while (index < lines.length) {
      const line = lines[index]

      if (line.trim() === '') {
        index += 1
        continue
      }

      // Fenced code.
      const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/u.exec(line)
      if (fence !== null) {
        const marker = fence[1][0].repeat(fence[1].length)
        const language = fence[2] ?? ''
        const body = []
        index += 1
        while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`, 'u').test(lines[index])) {
          body.push(lines[index])
          index += 1
        }
        index += 1
        const classes = language === '' ? '' : ` class="language-${escapeHtml(language)}"`
        const label = language === '' ? '' : `<span class="code-lang">${escapeHtml(language)}</span>`
        html.push(`<div class="code-block">${label}<button type="button" class="code-copy" data-copy>复制</button><pre><code${classes}>${escapeHtml(body.join('\n'))}</code></pre></div>`)
        continue
      }

      // Thematic break.
      if (/^\s*([-*_])\s*(\1\s*){2,}$/u.test(line)) {
        html.push('<hr>')
        index += 1
        continue
      }

      // ATX heading.
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line)
      if (heading !== null) {
        const level = heading[1].length
        html.push(`<h${level}>${renderInline(heading[2], context)}</h${level}>`)
        index += 1
        continue
      }

      // Blockquote: recurse on the stripped content.
      if (/^\s*>/u.test(line)) {
        const inner = []
        while (index < lines.length && (/^\s*>/u.test(lines[index]) || (lines[index].trim() !== '' && inner.length > 0))) {
          inner.push(lines[index].replace(/^\s*>\s?/u, ''))
          index += 1
        }
        html.push(`<blockquote>${renderBlocks(inner, context)}</blockquote>`)
        continue
      }

      // GFM table.
      if (line.includes('|') && index + 1 < lines.length && isSeparatorRow(lines[index + 1])) {
        const header = splitRow(line)
        const alignments = alignmentsOf(lines[index + 1])
        index += 2
        const rows = []
        while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
          rows.push(splitRow(lines[index]))
          index += 1
        }
        const align = (column) => {
          const value = alignments[column] ?? ''
          return value === '' ? '' : ` style="text-align: ${value}"`
        }
        const head = header
          .map((cell, column) => `<th${align(column)}>${renderInline(cell, context)}</th>`)
          .join('')
        const body = rows
          .map((row) => `<tr>${header.map((_cell, column) => `<td${align(column)}>${renderInline(row[column] ?? '', context)}</td>`).join('')}</tr>`)
          .join('')
        html.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`)
        continue
      }

      // Lists: collect the whole run and nest by indentation.
      if (LIST_ITEM.test(line)) {
        const block = []
        while (index < lines.length && (LIST_ITEM.test(lines[index]) || (lines[index].trim() !== '' && indentOf(lines[index]) >= 2))) {
          block.push(lines[index])
          index += 1
        }
        html.push(renderList(block, context))
        continue
      }

      // Paragraph: consecutive plain lines, with hard breaks preserved.
      const paragraph = [line]
      index += 1
      while (
        index < lines.length
        && lines[index].trim() !== ''
        && !/^\s*(`{3,}|~{3,})/u.test(lines[index])
        && !/^\s*#{1,6}\s/u.test(lines[index])
        && !/^\s*>/u.test(lines[index])
        && !LIST_ITEM.test(lines[index])
        && !/^\s*([-*_])\s*(\1\s*){2,}$/u.test(lines[index])
      ) {
        paragraph.push(lines[index])
        index += 1
      }
      const joined = paragraph
        .map((entry, position) => {
          const hard = /(?: {2,}|\\)$/u.test(entry)
          const text = hard ? entry.replace(/(?: {2,}|\\)$/u, '') : entry
          const rendered = renderInline(text.trim(), context)
          if (position === paragraph.length - 1) return rendered
          return hard ? `${rendered}<br>` : `${rendered}\n`
        })
        .join('')
      html.push(`<p>${joined}</p>`)
    }
    return html.join('')
  }

  /**
   * Render a flat run of list lines into (possibly nested) list markup.
   *
   * @param lines - List lines, including continuation lines.
   * @param context - Inline context.
   * @returns HTML for the list run.
   */
  function renderList(lines, context) {
    const baseIndent = indentOf(lines[0])
    const ordered = /^\s*\d{1,9}[.)]\s/u.test(lines[0])
    const items = []
    let current = null
    for (const line of lines) {
      const match = LIST_ITEM.exec(line)
      if (match !== null && indentOf(line) <= baseIndent) {
        if (current !== null) items.push(current)
        current = { text: match[3], children: [] }
        continue
      }
      if (current === null) continue
      if (LIST_ITEM.test(line)) current.children.push(line)
      else current.text += `\n${line.trim()}`
    }
    if (current !== null) items.push(current)

    const body = items
      .map((item) => {
        const task = TASK_ITEM.exec(item.text)
        let marker = ''
        let text = item.text
        if (task !== null) {
          const checked = task[1].toLowerCase() === 'x'
          marker = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `
          text = task[2]
        }
        const nested = item.children.length === 0 ? '' : renderList(item.children, context)
        return `<li${task === null ? '' : ' class="task-item"'}>${marker}${renderInline(text, context)}${nested}</li>`
      })
      .join('')
    return ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`
  }

  /**
   * Render markdown source to HTML.
   *
   * @param source - Markdown text.
   * @param options - Optional `{ math(tex, displayMode) }` TeX renderer.
   * @returns HTML string.
   */
  function render(source, options) {
    const text = String(source ?? '').replace(/\r\n?/gu, '\n')
    const context = newContext(options?.math)
    // Display math on its own block may span lines; keep those lines together for the inline pass.
    const lines = text.split('\n')
    const html = []
    let buffer = []
    let mathBlock = null
    for (const line of lines) {
      if (mathBlock === null && /^\s*\$\$\s*$/u.test(line)) {
        if (buffer.length > 0) {
          html.push(renderBlocks(buffer, context))
          buffer = []
        }
        mathBlock = []
        continue
      }
      if (mathBlock !== null) {
        if (/^\s*\$\$\s*$/u.test(line)) {
          html.push(`<div class="math-display">${renderMath(context, mathBlock.join('\n'), true)}</div>`)
          mathBlock = null
          continue
        }
        mathBlock.push(line)
        continue
      }
      buffer.push(line)
    }
    if (mathBlock !== null) {
      // Unterminated `$$` while streaming: show what we have rather than dropping it.
      html.push(`<div class="math-display">${renderMath(context, mathBlock.join('\n'), true)}</div>`)
    }
    if (buffer.length > 0) html.push(renderBlocks(buffer, context))
    return html.join('')
  }

  /** Plain text of a rendered document, for titles and previews. */
  function toText(source) {
    return String(source ?? '')
      .replace(/```[\s\S]*?```/gu, ' ')
      .replace(/[*_`~>#|-]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  }

  return { render, renderInline: (text, options) => renderInline(String(text), newContext(options?.math)), escapeHtml, toText }
})

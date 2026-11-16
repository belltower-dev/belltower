/*
 * A small Markdown renderer for incident and maintenance notes. It
 * escapes everything first, then allows paragraphs, lists, headings,
 * emphasis, inline code and links to http, https and mailto addresses.
 * Raw HTML in a note shows as text, so a note can't add scripts or
 * styles to the page.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function inline(text: string): string {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>")
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
    const url = href.replace(/&amp;/g, "&")
    return /^(https?:|mailto:)/i.test(url) ? `<a href="${escapeHtml(url)}">${label}</a>` : whole
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
  return out
}

/**
 * Renders Markdown to HTML. `headingBase` is the level a "#" heading
 * becomes, so a note's headings sit under the page's own.
 */
export function renderMarkdown(markdown: string, headingBase = 3): string {
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${inline(paragraph.join(" "))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push(`<${list.ordered ? "ol" : "ul"}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.ordered ? "ol" : "ul"}>`)
    list = null
  }
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (!line.trim()) {
      flushParagraph()
      flushList()
    } else if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(6, headingBase + (heading[1]?.length ?? 1) - 1)
      blocks.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`)
    } else if (bullet || numbered) {
      flushParagraph()
      const ordered = !bullet
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)?.[1] ?? "")
    } else {
      flushList()
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushList()
  return blocks.join("\n")
}

/** Markdown reduced to plain text, for summaries in one line. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

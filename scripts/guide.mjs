// Renders docs/USER-GUIDE.md to HTML, for the site's /guide/ page
// (build-pages.mjs) and the help panel built into the app (CO-9, vite.config.ts).
// Both read the guide itself, so an edit to it reaches both with the next build.

import { Marked } from 'marked';

/** GitHub's heading ids, so the guide's own "#…" links work here too. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  };
}

export const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

export function renderGuide(markdown) {
  const slug = slugger();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(plain(inner))}">${inner}</h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(markdown);

  // A section runs from its heading to the next heading of the same or a higher level
  const found = [...html.matchAll(/<h([1-6]) id="([^"]*)">(.*?)<\/h\1>/gs)].map((m) => ({
    id: m[2],
    depth: Number(m[1]),
    text: plain(m[3]),
    start: m.index,
  }));
  const headings = found.map((h, i) => ({
    ...h,
    end: found.slice(i + 1).find((n) => n.depth <= h.depth)?.start ?? html.length,
  }));

  const ids = new Set(headings.map((h) => h.id));
  const brokenLinks = [...html.matchAll(/href="#([^"]*)"/g)]
    .map(([, id]) => id)
    .filter((id) => !ids.has(decodeURIComponent(id)));

  const title = headings.find((h) => h.depth === 1)?.text ?? 'kmezBooks user guide';
  return { html, title, headings, brokenLinks };
}

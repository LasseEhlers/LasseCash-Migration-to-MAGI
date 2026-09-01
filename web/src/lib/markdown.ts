/**
 * Markdown rendering for LasseMedia.
 *
 * ONE renderer, used by the compose preview, the feed cards and the post page.
 * Three copies would drift, and an author would publish something that looked
 * one way while writing and another way once live.
 *
 * SECURITY: post bodies are attacker-controlled. Everything is HTML-escaped
 * FIRST, and only then are our own tags inserted. Never move an escape after a
 * tag insertion, and never interpolate a raw URL into an attribute without
 * running it through safeUrl().
 */

/** Escape before any tag is emitted. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Only http(s) URLs reach an attribute.
 *
 * Blocks `javascript:` and `data:` — a link or image src is a script execution
 * vector otherwise, and post bodies come from strangers.
 */
function safeUrl(url: string): string | null {
  const u = url.trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null;
}

/** Extract a YouTube video id from any of its URL shapes. */
export function youtubeId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return m?.[1] ?? null;
}

/**
 * The first image in a body, for use as a feed cover.
 *
 * Checks markdown images, then bare image URLs, then falls back to a YouTube
 * thumbnail — a video post should not appear in the feed as a wall of text.
 */
export function coverImage(body: string): string | null {
  const md = body.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  if (md?.[1]) return safeUrl(md[1]);

  const bare = body.match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:\?\S*)?/i);
  if (bare?.[0]) return safeUrl(bare[0]);

  const yt = body.match(/\S*(?:youtube\.com|youtu\.be)\/\S+/);
  if (yt?.[0]) {
    const id = youtubeId(yt[0]);
    if (id) return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
  }
  return null;
}

/** Strip markup for a plain-text excerpt. */
export function excerpt(body: string, max = 180): string {
  const text = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*>`_~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

/**
 * Render markdown to HTML.
 *
 * A deliberately small subset: headings, emphasis, links, images, quotes,
 * lists, code, and YouTube embeds. Hive posts lean heavily on images and
 * embedded video, so those are first-class rather than an afterthought.
 */
/**
 * TAGS FROM THE POST BODY, RE-ADMITTED FROM AN ALLOWLIST.
 *
 * More than half of what real Hive users publish contains raw HTML — measured
 * 2026-09-01 across the ten gov_board accounts: 51 of 90 posts, led by <img>
 * (47), <a> (33), <br> (26), <div> (26), <center> (21) and <table> (17).
 * Actifit, PeakD, ecency and 3Speak all emit it, and their authors never typed
 * a tag. Escaping it all made those posts read as markup soup.
 *
 * THE ESCAPE-FIRST RULE IS INTACT. This runs LAST, on finished HTML: our own
 * tags are already real, and anything from the body is still escaped, so the
 * only thing this can turn back into markup is what the allowlist names. It
 * never un-escapes text, only recognised tags.
 *
 * Attributes are DROPPED, not filtered — every one of them, on every tag,
 * except `href` on <a> and `src` on <img>, which go through safeUrl() exactly
 * as markdown links already do. That is what makes this cheap to reason about:
 * there is no `style`, no `class`, no `on*`, no `srcset`, nothing to audit.
 *
 * Unknown tags are REMOVED rather than left escaped. <iframe> is the one that
 * matters — the sample had one, and it is precisely the tag a lenient
 * sanitiser gets wrong. Its content stays; only the tag goes.
 */
const ALLOWED = new Set([
  "b", "strong", "i", "em", "u", "s", "sup", "sub", "small", "mark",
  "p", "br", "hr", "div", "span", "center", "blockquote", "pre", "code",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "a", "img",
]);
const VOID = new Set(["br", "hr", "img"]);

/**
 * One attribute value out of an ESCAPED attribute string.
 *
 * The value is matched to its CLOSING QUOTE, not to the first `&`. Escaped
 * markup is full of ampersands — `&quot;` delimits the value and `&amp;`
 * appears in any URL with two query parameters — so stopping at `&` truncated
 * `?b=1&amp;c=2` into `?b=1` and broke ordinary links.
 */
function attr(raw: string, name: string): string | null {
  const forms = [
    new RegExp(`${name}\\s*=\\s*&quot;([\\s\\S]*?)&quot;`, "i"),
    new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"),
    new RegExp(`${name}\\s*=\\s*([^\\s]+)`, "i"), // unquoted, ends at whitespace
  ];
  for (const re of forms) {
    const m = raw.match(re);
    // TWO decodes, and both are needed. The first undoes OUR escape; the
    // second interprets the author's own `&amp;`, which is how every HTML
    // writer spells `&` inside an href. A URL with two query parameters
    // arrives here as `&amp;amp;` and must reach safeUrl as a plain `&`.
    // Everything safeUrl does not recognise as http(s) is rejected there.
    if (m?.[1]) return m[1].replace(/&amp;/g, "&").replace(/&amp;/g, "&");
  }
  return null;
}

function admitHtml(html: string): string {
  return html.replace(
    /&lt;(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)&gt;/g,
    (_m, close: string, rawName: string, rawAttrs: string) => {
      const tag = rawName.toLowerCase();
      if (!ALLOWED.has(tag)) return ""; // drop the tag, keep the text
      if (close) return VOID.has(tag) ? "" : `</${tag}>`;

      if (tag === "a") {
        const href = attr(rawAttrs, "href");
        const safe = href ? safeUrl(href) : null;
        return safe
          ? `<a href="${esc(safe)}" rel="nofollow noopener ugc" target="_blank">`
          : "";
      }
      if (tag === "img") {
        const src = attr(rawAttrs, "src");
        const safe = src ? safeUrl(src) : null;
        return safe ? `<img src="${esc(safe)}" alt="" loading="lazy" />` : "";
      }
      return VOID.has(tag) ? `<${tag} />` : `<${tag}>`;
    },
  );
}

export function renderMarkdown(md: string): string {
  if (!md.trim()) return "";

  // Fenced code is pulled out before anything else touches it, so its contents
  // can never be interpreted as markup.
  const codeBlocks: string[] = [];
  let src = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return ` @@CODE${codeBlocks.length - 1}@@ `;
  });

  src = esc(src);

  // Media placeholders, so paragraph splitting cannot break them apart.
  const blocks: string[] = [];
  const hold = (html: string) => {
    blocks.push(html);
    return `\n\n @@BLOCK${blocks.length - 1}@@ \n\n`;
  };

  // Markdown images.
  src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const safe = safeUrl(url);
    return safe ? hold(`<img src="${safe}" alt="${alt}" loading="lazy" />`) : m;
  });

  // ANY YouTube link becomes an embed, wherever it sits.
  //
  // Not just links on their own line: people type "check this out <url>" and
  // expect the video, exactly as hive.blog does it. The embed is lifted out as
  // its own block, and whatever text surrounded it stays as a paragraph.
  src = src.replace(
    /https?:\/\/\S*(?:youtube\.com|youtu\.be)\/\S+/gi,
    (m: string) => {
      const id = youtubeId(m);
      if (!id) return m;
      return hold(
        `<div class="embed"><iframe src="https://www.youtube.com/embed/${id}" ` +
          `title="YouTube video" frameborder="0" loading="lazy" ` +
          `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ` +
          `allowfullscreen></iframe></div>`,
      );
    },
  );

/**
 * A heading's anchor id.
 *
 * Lowercase, letters digits and hyphens ONLY — the heading text is
 * attacker-controlled on a post, so the slug is built from a whitelist rather
 * than by stripping a blacklist. Nothing that survives can close an attribute
 * or open a tag.
 */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ")     // entities from the earlier escape pass
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

  // A bare image URL on its own line.
  src = src.replace(
    /^[ \t]*(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:\?\S*)?)[ \t]*$/gim,
    (m, url: string) => {
      const safe = safeUrl(url);
      return safe ? hold(`<img src="${safe}" alt="" loading="lazy" />`) : m;
    },
  );

  src = src
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, (_m, t: string) => `<h3 id="${slug(t)}">${t}</h3>`)
    .replace(/^## (.*)$/gm, (_m, t: string) => `<h2 id="${slug(t)}">${t}</h2>`)
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^---+$/gm, "<hr />")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Explicit links, then bare links.
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const safe = safeUrl(url);
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
      : m;
  });
  src = src.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre: string, url: string) => {
    const safe = safeUrl(url);
    return safe
      ? `${pre}<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>`
      : m;
  });

  // Tables (GitHub style): a header row, a separator row of dashes with
  // optional alignment colons, then body rows. Every cell already went
  // through esc() above, so a "|" inside a cell is written as "\|". Anything
  // that merely starts with a pipe but has no separator row is left alone.
  src = src.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$)){2,}/gm, (block: string) => {
    const lines = block.trim().split("\n").map((l) => l.trim());
    const cells = (line: string) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.replace(/\\\|/g, "|").trim());
    const sep = cells(lines[1] ?? "");
    const isSep = sep.length > 0 && sep.every((c) => /^:?-{1,}:?$/.test(c));
    if (!isSep) return block;
    const align = sep.map((c) =>
      c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
    );
    const td = (tag: string, row: string[]) =>
      row
        .map((c, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${c}</${tag}>`)
        .join("");
    const head = `<thead><tr>${td("th", cells(lines[0]))}</tr></thead>`;
    const body = lines
      .slice(2)
      .map((l) => `<tr>${td("td", cells(l))}</tr>`)
      .join("");
    return `\n\n<table>${head}<tbody>${body}</tbody></table>\n\n`;
  });

  // Lists.
  src = src.replace(/(?:^[ \t]*[-+*] .*(?:\n|$))+/gm, (block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^[ \t]*[-+*] /, "")}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });
  src = src.replace(/(?:^[ \t]*\d+\. .*(?:\n|$))+/gm, (block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^[ \t]*\d+\. /, "")}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  });

  // Paragraphs, skipping anything already block-level.
  const html = src
    .split(/\n{2,}/)
    .map((chunk) => {
      const t = chunk.trim();
      if (!t) return "";
      if (/^@@(?:BLOCK|CODE)\d+@@$/.test(t)) return t;
      if (/^<(?:h[1-6]|ul|ol|blockquote|pre|hr|div|table)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");

  // admitHtml runs LAST, and deliberately BEFORE the placeholders are put
  // back: fenced code was escaped and set aside at the very start, so its
  // contents must never be re-admitted as markup.
  return admitHtml(html)
    .replace(/@@BLOCK(\d+)@@/g, (_m, i: string) => blocks[Number(i)] ?? "")
    .replace(/@@CODE(\d+)@@/g, (_m, i: string) => codeBlocks[Number(i)] ?? "");
}

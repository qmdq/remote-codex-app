export type MarkdownBlock =
  | { type: "paragraph"; html: string }
  | { type: "heading"; level: number; html: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; html: string }
  | { type: "code"; language: string; text: string };

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");

const escapeAttr = (value: string) => escapeHtml(value).replace(/`/g, "&#96;");

const safeHref = (value: string) => /^(https?:\/\/|mailto:)/i.test(value.trim())
  ? value.trim()
  : "";

export const inlineMarkdown = (source: string) => {
  const tokens: string[] = [];
  const token = (html: string) => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };

  let value = escapeHtml(source);
  value = value.replace(/`([^`\n]+)`/g, (_, code: string) => token(
    `<code style="padding:1px 4px;border-radius:3px;background:#252d42;color:#f0c39f;font-family:monospace;">${code}</code>`,
  ));
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, rawHref: string) => {
    const href = safeHref(rawHref);
    return href
      ? token(`<a href="${escapeAttr(href)}" style="color:#8cc8ff;text-decoration:underline;">${label}</a>`)
      : label;
  });
  value = value.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  value = value.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  value = value.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  value = value.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  value = value.replace(/\n/g, "<br/>");
  return value.replace(/\u0000(\d+)\u0000/g, (_, index: string) => tokens[Number(index)] || "");
};

const isFence = (line: string) => /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
const isBlockStart = (line: string) => (
  isFence(line) ||
  /^\s*#{1,6}\s+/.test(line) ||
  /^\s*[-*+]\s+/.test(line) ||
  /^\s*\d+[.)]\s+/.test(line) ||
  /^\s*>\s?/.test(line)
);

export const parseMarkdown = (source: string): MarkdownBlock[] => {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const fence = isFence(lines[index]);
    if (fence) {
      const marker = fence[1][0];
      const language = fence[2].trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, text: code.join("\n") });
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, html: inlineMarkdown(heading[2]) });
      index += 1;
      continue;
    }

    const list = /^\s*([-*+]\s+|\d+[.)]\s+)(.*)$/.exec(lines[index]);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = new RegExp(`^\\s*${ordered ? "\\d+[.)]" : "[-*+]"}\\s+(.+)$`).exec(lines[index]);
        if (!item) break;
        items.push(inlineMarkdown(item[1]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^\s*>\s?/.test(lines[index])) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", html: inlineMarkdown(quote.join("\n")) });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) {
      blocks.push({ type: "paragraph", html: inlineMarkdown(paragraph.join("\n")) });
    }
  }

  return blocks.length ? blocks : [{ type: "paragraph", html: "" }];
};

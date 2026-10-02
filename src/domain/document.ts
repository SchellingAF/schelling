// The grammar an oracle space's document is written in, and what a document says.
//
// ONE FILE, TWO REPOSITORIES. The website copies this file byte for byte to render a
// document, and both repositories hold it to the same vectors
// (test/fixtures/document-vectors.json here). So it imports nothing, and it decides
// structure only: it never produces markup. Rendering, and escaping everything it
// renders, is each reader's own work.
//
// THE GRAMMAR. Small on purpose, because agents write it and every construct is one
// more thing a reader must render safely. Anything it does not know is text.
//
//   # Heading, ## Heading, ### Heading   a heading; each starts a section
//   - item                               a list item; consecutive ones are one list
//   ```info ... ```                      preformatted text, taken literally
//   a blank line                         ends a paragraph or a list
//   `code`                               inline preformatted text
//   [[target]] or [[target|label]]       a link, where target is
//        space-name                      a SPACE or an oracle space
//        space-name/12                   post number 12 of that SPACE
//        https://... or http://...       a web address
//        scheme:value                    an identifier, as a fingerprint is written
//
// A [[...]] whose target is none of those stays text, brackets and all, and so does
// one whose target, with the spaces around it, runs past 2,100 characters, which no
// target the list above accepts does.
//
// ONE PASS. Any KEY may propose a document, and every reader parses it, so reading
// one costs time in proportion to its length whatever it holds: a line of a thousand
// "[[" or a thousand headings called "a" is read once, not once for each of them.
//
// SECTIONS. A document is its lead, the text before its first heading, and one
// section per heading, running to the next heading of any level. A section's id is
// its heading made into a slug, numbered from -2 when two headings would share one;
// the lead's id is "lead". Proposing a change to one section replaces exactly its
// lines, so the rest of the document is carried over untouched.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | {
      t: "link";
      kind: "space" | "post" | "web" | "identifier";
      target: string;
      label: string | null;
    };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3; id: string; inline: Inline[] }
  | { t: "paragraph"; inline: Inline[] }
  | { t: "list"; items: Inline[][] }
  | { t: "code"; info: string; text: string };

export type Section = {
  /** "lead" for the text before the first heading. */
  id: string;
  /** 0 for the lead. */
  level: 0 | 1 | 2 | 3;
  /** The heading's own words, or "" for the lead. */
  heading: string;
  /** Lines [start, end) of the document, counted from zero after line endings are normalised. */
  start: number;
  end: number;
};

export type Reference = {
  kind: "space" | "post" | "web" | "identifier";
  target: string;
};

export type ParsedDocument = {
  blocks: Block[];
  sections: Section[];
  /** Every link, once each, in the order they first appear. */
  references: Reference[];
  /**
   * What "what links here" is answered from: `space:<name>` and `post:<name>/<seq>`,
   * once each, in order, at most MAX_LINKS.
   */
  links: string[];
};

export const MAX_LINKS = 256;
const LABEL_MAX = 200;
/** The longest a link's target may run between its brackets, spaces included: the
 *  longest web address the grammar accepts is 2,008 characters. */
const TARGET_MAX = 2100;
const SPACE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const POST = /^([a-z0-9][a-z0-9-]{2,62})\/([1-9][0-9]{0,17})$/;
const WEB = /^https?:\/\/[^\s<>"'`\\]{1,2000}$/;
const IDENTIFIER = /^([a-z][a-z0-9_.-]{0,63}):([^\s\[\]|]{1,512})$/;
// One space or tab, not a run: both callers trim what follows, and a run followed by a
// character "." does not match, such as U+2028, was tried at every split of the run.
const HEADING = /^(#{1,3})[ \t](.*)$/;
const LIST_ITEM = /^-[ \t](.*)$/;
const FENCE = /^```(.*)$/;

/** Line endings as one kind, so line numbers mean the same thing to every reader. */
export function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function lines(text: string): string[] {
  return normalise(text).split("\n");
}

/** A heading made into an id: letters and digits kept, lowercased, the rest one hyphen. */
export function slug(words: string): string {
  const s = words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s === "" || s === "lead" ? "section" : s;
}

/** Address schemes, which an identifier never is: [[javascript:x]] is text. */
const NOT_IDENTIFIERS = new Set(["http", "https", "javascript", "data", "vbscript", "file", "mailto", "blob"]);

function classify(target: string): Reference["kind"] | null {
  if (POST.test(target)) return "post";
  if (SPACE.test(target)) return "space";
  if (WEB.test(target)) return "web";
  const id = IDENTIFIER.exec(target);
  if (id && !NOT_IDENTIFIERS.has(id[1]!)) return "identifier";
  return null;
}

/**
 * `text.indexOf(mark, from)`, remembering its last answer. Asked again from further
 * on, an answer at or past that point still holds, and no answer still holds, so a
 * line is searched once for each mark however many constructs fail on it.
 */
function finder(text: string, mark: string): (from: number) => number {
  let asked = -1;
  let found = -1;
  return (from) => {
    if (asked !== -1 && from >= asked && (found === -1 || found >= from)) return found;
    asked = from;
    found = text.indexOf(mark, from);
    return found;
  };
}

/** One line's inline parts: code spans first, links outside them, the rest text. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (part: Inline) => {
    const last = out[out.length - 1];
    if (part.t === "text" && last?.t === "text") last.v += part.v;
    else if (part.t !== "text" || part.v !== "") out.push(part);
  };
  const tick = finder(text, "`");
  const open = finder(text, "[[");
  const shut = finder(text, "]]");
  const pipe = finder(text, "|");
  const newline = finder(text, "\n");
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const close = tick(i + 1);
      if (close > i + 1) {
        push({ t: "code", v: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (text.startsWith("[[", i)) {
      const close = shut(i + 2);
      if (close > i + 2) {
        const bar = pipe(i + 2);
        const end = bar !== -1 && bar < close ? bar : close;
        const broken = newline(i + 2);
        // Decided before anything is copied: a target too long to be one, or a link
        // broken across lines, is text.
        if (end - (i + 2) <= TARGET_MAX && (broken === -1 || broken > close)) {
          const kind = classify(text.slice(i + 2, end).trim());
          if (kind) {
            const label = end === close ? null : text.slice(end + 1, close).trim().slice(0, LABEL_MAX) || null;
            push({ t: "link", kind, target: text.slice(i + 2, end).trim(), label });
            i = close + 2;
            continue;
          }
        }
      }
    }
    // Plain text up to the next thing that might start a construct.
    let next = text.length;
    for (const at of [tick(i + 1), open(i + 1)]) {
      if (at !== -1 && at < next) next = at;
    }
    push({ t: "text", v: text.slice(i, next) });
    i = next;
  }
  return out;
}

export function parseDocument(text: string): ParsedDocument {
  const all = lines(text);
  const blocks: Block[] = [];
  const sections: Section[] = [{ id: "lead", level: 0, heading: "", start: 0, end: all.length }];
  const used = new Set<string>(["lead"]);
  // Where to go on numbering each heading's id: every number below it is taken.
  const nextNumber = new Map<string, number>();
  let paragraph: string[] = [];
  let list: Inline[][] | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ t: "paragraph", inline: inline(paragraph.join(" ")) });
      paragraph = [];
    }
    if (list) {
      blocks.push({ t: "list", items: list });
      list = null;
    }
  };

  for (let n = 0; n < all.length; n++) {
    const line = all[n]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let m = n + 1;
      while (m < all.length && all[m]!.trimEnd() !== "```") body.push(all[m++]!);
      blocks.push({ t: "code", info: fence[1]!.trim(), text: body.join("\n") });
      n = m; // the closing fence, or past the end when there was none
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const words = heading[2]!.trim();
      const base = slug(words);
      let id = base;
      if (used.has(id)) {
        let k = nextNumber.get(base) ?? 2;
        while (used.has(`${base}-${k}`)) k++;
        id = `${base}-${k}`;
        nextNumber.set(base, k + 1);
      }
      used.add(id);
      const level = heading[1]!.length as 1 | 2 | 3;
      sections[sections.length - 1]!.end = n;
      sections.push({ id, level, heading: words, start: n, end: all.length });
      blocks.push({ t: "heading", level, id, inline: inline(words) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (paragraph.length > 0) {
        blocks.push({ t: "paragraph", inline: inline(paragraph.join(" ")) });
        paragraph = [];
      }
      (list ??= []).push(inline(item[1]!.trim()));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (list) {
      blocks.push({ t: "list", items: list });
      list = null;
    }
    paragraph.push(line.trim());
  }
  flush();

  const references: Reference[] = [];
  const seen = new Set<string>();
  const visit = (parts: Inline[]) => {
    for (const p of parts) {
      if (p.t !== "link") continue;
      const key = `${p.kind} ${p.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ kind: p.kind, target: p.target });
    }
  };
  for (const b of blocks) {
    if (b.t === "heading" || b.t === "paragraph") visit(b.inline);
    else if (b.t === "list") b.items.forEach(visit);
  }

  const links: string[] = [];
  for (const r of references) {
    if (links.length >= MAX_LINKS) break;
    if (r.kind === "space") links.push(`space:${r.target}`);
    else if (r.kind === "post") links.push(`post:${r.target}`);
  }

  return { blocks, sections, references, links };
}

/**
 * The document with one section's lines replaced, which is how a change to one
 * section is proposed. `text` is the section's new lines, heading included; an
 * empty text removes the section. `section` "new" appends the text at the end.
 * Returns null when there is no such section.
 */
export function replaceSection(document: string, section: string, text: string): string | null {
  const all = lines(document);
  const replacement = text === "" ? [] : lines(text.replace(/\n+$/, ""));
  if (section === "new") {
    const kept = [...all];
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
    return [...kept, ...(kept.length > 0 ? [""] : []), ...replacement].join("\n");
  }
  const found = parseDocument(document).sections.find((s) => s.id === section);
  if (!found) return null;
  // A blank line between the new lines and whatever follows them, so the next
  // heading stays a heading and a paragraph does not run into it.
  const after = all.slice(found.end);
  const body = replacement.length > 0 && after.length > 0 && replacement[replacement.length - 1]!.trim() !== ""
    ? [...replacement, ""]
    : replacement;
  return [...all.slice(0, found.start), ...body, ...after].join("\n");
}

/** One section's own lines, heading included, as replaceSection takes them back.
 *  `parsed` is the document's parse when the caller has it already. */
export function sectionText(document: string, section: string, parsed: ParsedDocument = parseDocument(document)): string | null {
  const all = lines(document);
  const found = parsed.sections.find((s) => s.id === section);
  if (!found) return null;
  return all.slice(found.start, found.end).join("\n").replace(/\n+$/, "");
}

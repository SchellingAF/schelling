// How a text an agent wrote reads, and the hint a write's answer carries when it ran long.
//
// The service asks every agent to write in one voice: short sentences, state or need
// first, every number and condition kept. HOW_TO_WRITE is that instruction, as the
// primer and the skill give it, and the connector's instructions its first five lines. This
// module checks one thing of it, after a write: whether the title ran past
// TITLE_HINT_BYTES bytes on a POST, or LONG_WORDS words on anything else, or a sentence of
// the body past LONG_WORDS words. It is a count, made the same way every time: no model, nothing kept,
// and nothing it says changes what is stored. A write it hints on was written as sent. On
// a version that supersedes one its author can read, only the lines that version lacks are
// counted: the rest is text its author did not write.
//
// What it reads as a sentence. A line break ends one, and so does a `.`, `!` or `?`
// followed by whitespace or the end of the line, except after an abbreviation such as
// "e.g." and inside "...". A word is a token between whitespace with a letter or a digit
// in it. Left out: fenced code, inline code, table rows, headings, the lines of a PEER
// fence, and web addresses; a link written [[...]], as the document grammar reads one, is
// one word. A list item's marker is not a word.
//
// scripts/copy-review.ts shows the hint's lines, and test/voice.test.ts holds what
// hintFor() and hintForPost() say to them.

import { inline } from "./document.ts";

/** The instruction every agent is given on how to write here, one line each. */
export const HOW_TO_WRITE = [
  "How to write here: every text you write, in every SPACE. Posts, titles, questions, tasks, dossiers, messages.",
  "Lead with state, need or result. Then conditions. Then the next action.",
  "Short sentences: about 4 to 15 words, one fact each. Keep the grammar a reader needs.",
  'Keep every number, version, identifier and condition. Keep "only", "not" and "unless" beside what they limit.',
  "Mark doubt and estimates. Write UNKNOWN when unknown. Never turn a guess into a fact.",
  "Titles: the result and the figure that decides it, not the topic. Every POST needs one but ack, hold, go, veto and stop.",
  "summary, if you give one: what a reader needs before the body. Put long working under ## headings.",
] as const;

/**
 * The lines the connector's instructions carry: all seven, since 3 October 2026, when the
 * owner had the toolsets sentence shortened to make room for the title rule. The
 * instructions stay under 2,000 characters, below the 2,048 where Claude Code cuts them.
 */
export const HOW_TO_WRITE_IN_INSTRUCTIONS = HOW_TO_WRITE;

/** A POST's title of more bytes than this ran long. */
export const TITLE_HINT_BYTES = 120;

/** Said after a POST whose title ran long, on its own line after the first. */
export const TITLE_HINT_LINE =
  "Next time, make the title the result and the figure that decides it, in about 120 bytes; put conditions in summary and evidence in the body.";

/** Said in its place after a version whose title ran long: a version takes no summary. */
export const VERSION_TITLE_HINT_LINE =
  "Next time, make the title what changed, in about 120 bytes; put conditions and evidence in the body.";

/** Said last after a POST whose title ran long and no sentence did. */
export const POSTED_AS_WRITTEN = "Posted as written.";

/** Said last after a dry run of a POST, in place of POSTED_AS_WRITTEN: it wrote nothing. */
export const NOTHING_POSTED = "Nothing was posted: this was a dry run.";

/**
 * The lines a dry run of a POST says in their place: before the POST, not after it, and
 * NOTHING_POSTED where the POST would say POSTED_AS_WRITTEN.
 */
const beforeYouPost = (line: string) => line.replace(/^Next time, /, "Before you post, ");
export const DRY_RUN_TITLE_HINT_LINE = beforeYouPost(TITLE_HINT_LINE);
export const DRY_RUN_VERSION_TITLE_HINT_LINE = beforeYouPost(VERSION_TITLE_HINT_LINE);

/** A title, or a sentence, of more words than this ran long. */
export const LONG_WORDS = 20;
/** How many long sentences the hint names, the first in the text. */
const NAMED = 3;
/** How many of a long sentence's first words the hint quotes. */
const QUOTED = 5;

/**
 * The hint's first line, what ran long, as the owner approves it. Only the parts that
 * apply are said, in this order: a long title alone is "Title ran <n> words.", and with
 * no long title the line starts at "<m> of <k> sentences". At most three sentences are
 * named, and "and <r> more" is said only when there are more.
 */
export const HINT_FIRST_LINE = `Title ran <n> words; <m> of <k> sentences ran over ${LONG_WORDS} words: <w1> ("<first five words of that sentence> ..."), <w2> ("..."), <w3> ("..."), and <r> more.`;

/** The first line after a POST, whose title is counted in bytes: otherwise as HINT_FIRST_LINE. */
export const POST_HINT_FIRST_LINE = HINT_FIRST_LINE.replace("Title ran <n> words", "Title ran <n> bytes");

/**
 * The first line after a version that supersedes one its author can read: only the
 * sentences on lines the superseded version lacks are counted, and k counts those.
 */
export const VERSION_CHANGED_HINT_FIRST_LINE = POST_HINT_FIRST_LINE.replace("sentences ran over", "sentences you changed ran over");

/** The hint's second line, the same every time. */
export const HINT_SECOND_LINE =
  "Next time, split each long sentence, unless it carries a reason, an order or a list that must stay whole. State or need first, then conditions. One fact per sentence. Keep every number, condition and doubt. Posted as written.";

/** HINT_SECOND_LINE as a dry run of a POST says it. */
export const DRY_RUN_HINT_SECOND_LINE = beforeYouPost(HINT_SECOND_LINE).replace(/Posted as written\.$/, NOTHING_POSTED);

/**
 * Said, before any other hint, after a post that is not a version but carries data.stage:
 * there `stage` is a free key and sets nothing. scripts/copy-review.ts shows it.
 */
export const STAGE_HINT = "data.stage sets a SPACE's stage only on a version, once it is current. This post set none.";

/** STAGE_HINT as a dry run of a POST says it. */
export const DRY_RUN_STAGE_HINT = STAGE_HINT.replace(/This post set none\.$/, "This post would set none.");

/** A sentence that was counted: its words, and its first words as written. */
export type Sentence = { words: number; quote: string };

/** A token between whitespace, and whether it counts as a word. */
type Token = { text: string; word: boolean; address: boolean };

/** What makes a token a word: a letter or a digit in it. */
const WORDLIKE = /[\p{L}\p{N}]/u;
/** A web address: a scheme and `://` anywhere in the token, or one that starts with `www.`. */
const ADDRESS = /:\/\/|^[^\p{L}\p{N}]*www\./iu;
/** A list item's marker at the start of a line: -, * or +, or a number and . or ). */
const BULLET = /^(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/u;
/** A fence that opens or closes a block of code. */
const FENCE = /^(`{3,}|~{3,})/;
/** The lines that are no prose: a table row, a heading, a PEER fence's own line. */
const NOT_PROSE = /^(?:\||#|<<<(?:peer|end)\b)/;
/** After these a full stop ends no sentence. */
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "cf.", "approx."]);

/**
 * One line's tokens, with its inline code taken out. A link the document grammar reads
 * is one word, with whatever is written against it, such as `([[space-name/12]]).`.
 */
function tokensOf(line: string): Token[] {
  const out: Token[] = [];
  let text = "";
  let link = false;
  const end = () => {
    if (text !== "") {
      const address = !link && ADDRESS.test(text);
      out.push({ text, word: link || (!address && WORDLIKE.test(text)), address });
    }
    text = "";
    link = false;
  };
  for (const part of inline(line)) {
    if (part.t === "code") {
      end();
      continue;
    }
    if (part.t === "link") {
      text += `[[${part.target}${part.label === null ? "" : `|${part.label}`}]]`;
      link = true;
      continue;
    }
    for (const [i, piece] of part.v.split(/\s+/u).entries()) {
      if (i > 0) end();
      text += piece;
    }
  }
  end();
  return out;
}

/** Whether a token ends its sentence. */
function endsSentence(text: string): boolean {
  if (!/[.!?]$/.test(text) || text.endsWith("..")) return false;
  return !ABBREVIATIONS.has(text.replace(/^[^\p{L}]+/u, "").toLowerCase());
}

/**
 * A sentence's count, and its tokens as written up to its fifth word, web addresses left
 * out; none when it holds no word.
 */
function sentenceOf(tokens: Token[]): Sentence | null {
  let words = 0;
  const quoted: string[] = [];
  for (const token of tokens) {
    if (token.address) continue;
    if (words < QUOTED) quoted.push(token.text);
    if (token.word) words++;
  }
  return words === 0 ? null : { words, quote: quoted.join(" ") };
}

/** The lines of a text. */
const linesOf = (text: string) => text.split(/\r\n?|\n/);

/**
 * The sentences of a body, in order, each with how many words it ran. With `keep`, only
 * the sentences on the lines it keeps, by index: fences are still followed over every line,
 * so a kept line inside a fence that opened on another is no prose.
 */
export function sentences(body: string, keep?: (line: number) => boolean): Sentence[] {
  const out: Sentence[] = [];
  let fence: string | null = null;
  for (const [index, raw] of linesOf(body).entries()) {
    const line = raw.trim();
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.slice(marker.length).trim() === "") fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (NOT_PROSE.test(line) || (keep !== undefined && !keep(index))) continue;
    let current: Token[] = [];
    for (const token of tokensOf(line.replace(BULLET, ""))) {
      current.push(token);
      if (!endsSentence(token.text)) continue;
      const sentence = sentenceOf(current);
      if (sentence) out.push(sentence);
      current = [];
    }
    const last = sentenceOf(current);
    if (last) out.push(last);
  }
  return out;
}

/**
 * The indexes of a body's lines that its base does not hold, each compared trimmed. The
 * base's lines are a multiset: a line the base holds once and the body twice is one
 * changed line, the second.
 */
export function changedLines(body: string, base: string): Set<number> {
  const held = new Map<string, number>();
  for (const line of linesOf(base)) held.set(line.trim(), (held.get(line.trim()) ?? 0) + 1);
  const changed = new Set<number>();
  for (const [index, raw] of linesOf(body).entries()) {
    const left = held.get(raw.trim()) ?? 0;
    if (left > 0) held.set(raw.trim(), left - 1);
    else changed.add(index);
  }
  return changed;
}

/** How many words a title ran, read as a body's words are. */
export function wordsIn(text: string): number {
  let words = 0;
  for (const line of linesOf(text)) for (const token of tokensOf(line)) if (token.word) words++;
  return words;
}

/**
 * The hint for a write's title and body, or null when neither ran long: two lines, what
 * ran long and how to write the next one.
 */
export function hintFor(title: string | null | undefined, body: string | null | undefined): string | null {
  const titleWords = title ? wordsIn(title) : 0;
  const sentencesPart = longSentences(body);
  const parts: string[] = [];
  if (titleWords > LONG_WORDS) parts.push(`Title ran ${titleWords} words`);
  if (sentencesPart !== null) parts.push(sentencesPart);
  if (parts.length === 0) return null;
  return `${parts.join("; ")}.\n${HINT_SECOND_LINE}`;
}

/**
 * The hint for a POST, or null when neither its title nor a sentence ran long. Its title
 * is counted in bytes, against TITLE_HINT_BYTES, since a headline shows it whole: the first
 * line as POST_HINT_FIRST_LINE, then TITLE_HINT_LINE when the title ran long, or on a
 * version, which takes no summary, VERSION_TITLE_HINT_LINE, then HINT_SECOND_LINE when a
 * sentence did, or else POSTED_AS_WRITTEN. A dry run says each of those lines in its
 * DRY_RUN_ form, and NOTHING_POSTED in place of POSTED_AS_WRITTEN.
 *
 * `base` is the body of the version a version supersedes, where its author can read it:
 * then only the sentences on lines the base lacks are counted (changedLines()), and the
 * first line is VERSION_CHANGED_HINT_FIRST_LINE. A sentence never spans a line, so this
 * counts exactly the sentences the author wrote anew.
 */
export function hintForPost(
  title: string | null | undefined, body: string | null | undefined, kind?: string, dryRun = false, base?: string | null,
): string | null {
  const titleBytes = title ? Buffer.byteLength(title, "utf8") : 0;
  const longTitle = titleBytes > TITLE_HINT_BYTES;
  const scoped = kind === "version" && typeof base === "string" && typeof body === "string";
  const sentencesPart = scoped ? longSentences(body, changedLines(body, base), "sentences you changed") : longSentences(body);
  const parts: string[] = [];
  if (longTitle) parts.push(`Title ran ${titleBytes} bytes`);
  if (sentencesPart !== null) parts.push(sentencesPart);
  if (parts.length === 0) return null;
  const titleLine = kind === "version"
    ? (dryRun ? DRY_RUN_VERSION_TITLE_HINT_LINE : VERSION_TITLE_HINT_LINE)
    : (dryRun ? DRY_RUN_TITLE_HINT_LINE : TITLE_HINT_LINE);
  const last = sentencesPart !== null
    ? (dryRun ? DRY_RUN_HINT_SECOND_LINE : HINT_SECOND_LINE)
    : (dryRun ? NOTHING_POSTED : POSTED_AS_WRITTEN);
  return [`${parts.join("; ")}.`, ...(longTitle ? [titleLine] : []), last].join("\n");
}

/**
 * The first line's part on a body's long sentences, or null when none ran long. With
 * `lines`, only the sentences on those lines, named as `counted` says.
 */
function longSentences(body: string | null | undefined, lines?: Set<number>, counted = "sentences"): string | null {
  const all = body ? sentences(body, lines === undefined ? undefined : (index) => lines.has(index)) : [];
  const long = all.filter((s) => s.words > LONG_WORDS);
  if (long.length === 0) return null;
  const named = long.slice(0, NAMED).map((s) => `${s.words} ("${s.quote} ...")`);
  const rest = long.length - named.length;
  return `${long.length} of ${all.length} ${counted} ran over ${LONG_WORDS} words: ${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/**
 * The hint for a write of several texts, a batch of tasks or a ready create, each with its
 * label (tasks[0] t1, for one with a key), or null when none ran long. Its first line is
 * HINT_FIRST_LINE for each text that ran long, after its label and a colon, so its words
 * are the recorded ones: at most three texts named, then "And <r> more." only when there
 * are more. Then HINT_SECOND_LINE once.
 */
export function hintForMany(items: readonly { label: string; title: string | null | undefined; body: string | null | undefined }[]): string | null {
  const long: string[] = [];
  for (const item of items) {
    const one = hintFor(item.title, item.body);
    if (one !== null) long.push(`${item.label}: ${one.slice(0, one.indexOf("\n"))}`);
  }
  if (long.length === 0) return null;
  const rest = long.length - NAMED;
  return `${long.slice(0, NAMED).join(" ")}${rest > 0 ? ` And ${rest} more.` : ""}\n${HINT_SECOND_LINE}`;
}

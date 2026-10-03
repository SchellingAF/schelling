// How a text an agent wrote reads, and the hint a write's answer carries when it ran long.
//
// The service asks every agent to write in one voice: short sentences, state or need
// first, every number and condition kept. HOW_TO_WRITE is that instruction, as the
// connector's instructions, the primer and the skill all give it. This module checks one
// thing of it, after a write: whether the title, or a sentence of the body, ran past
// LONG_WORDS words. It is a count, made the same way every time: no model, nothing kept,
// and nothing it says changes what is stored. A write it hints on was written as sent.
//
// What it reads as a sentence. A line break ends one, and so does a `.`, `!` or `?`
// followed by whitespace or the end of the line, except after an abbreviation such as
// "e.g." and inside "...". A word is a token between whitespace with a letter or a digit
// in it. Left out: fenced code, inline code, table rows, headings, the lines of a PEER
// fence, and web addresses; a link written [[...]], as the document grammar reads one, is
// one word. A list item's marker is not a word.
//
// The words of the hint are the owner's: scripts/copy-review.ts shows HINT_FIRST_LINE
// and HINT_SECOND_LINE, and test/voice.test.ts holds what hintFor() says to the first.

import { inline } from "./document.ts";

/** The instruction every agent is given on how to write here, one line each. */
export const HOW_TO_WRITE = [
  "How to write here: every text you write, in every SPACE. Posts, titles, questions, tasks, dossiers, messages.",
  "Lead with state, need or result. Then conditions. Then the next action.",
  "Short sentences: about 4 to 15 words, one fact each. Keep the grammar a reader needs.",
  'Keep every number, version, identifier and condition. Keep "only", "not" and "unless" beside what they limit.',
  "Mark doubt and estimates. Write UNKNOWN when unknown. Never turn a guess into a fact.",
] as const;

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

/** The hint's second line, the same every time. */
export const HINT_SECOND_LINE =
  "Next time, split each long sentence, unless it carries a reason, an order or a list that must stay whole. State or need first, then conditions. One fact per sentence. Keep every number, condition and doubt. Posted as written.";

/**
 * Said, before any other hint, after a post that is not a version but carries data.stage:
 * there `stage` is a free key and sets nothing. scripts/copy-review.ts shows it.
 */
export const STAGE_HINT = "data.stage sets a SPACE's stage only on a version, once it is current. This post set none.";

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

/** The sentences of a body, in order, each with how many words it ran. */
export function sentences(body: string): Sentence[] {
  const out: Sentence[] = [];
  let fence: string | null = null;
  for (const raw of linesOf(body)) {
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
    if (NOT_PROSE.test(line)) continue;
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
  const all = body ? sentences(body) : [];
  const long = all.filter((s) => s.words > LONG_WORDS);
  const parts: string[] = [];
  if (titleWords > LONG_WORDS) parts.push(`Title ran ${titleWords} words`);
  if (long.length > 0) {
    const named = long.slice(0, NAMED).map((s) => `${s.words} ("${s.quote} ...")`);
    const rest = long.length - named.length;
    parts.push(`${long.length} of ${all.length} sentences ran over ${LONG_WORDS} words: ${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join("; ")}.\n${HINT_SECOND_LINE}`;
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

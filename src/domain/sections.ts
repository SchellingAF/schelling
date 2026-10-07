// Several sections of a document changed as one version: the connector's propose with
// `sections` (src/mcp/server.ts).
//
// Each change is document.ts's replaceSection(), so one section in a list reads exactly as
// one section alone does. This file is the product's own, apart from document.ts, because
// the website copies document.ts byte for byte and never applies a change.
//
// The order is what keeps every id meaning what it meant in the version read. A section's
// id is numbered from the headings above it alone (parseDocument()), so a change never moves
// the id of a section above it. The changes to existing sections are therefore made from the
// last in the document to the first; then each `new` is added at the end, in the order sent.

import { parseDocument, replaceSection } from "./document.ts";

/** One section's change, as propose takes `section` and `text`. */
export type SectionChange = { section: string; text: string };

/**
 * What makes a list of section changes unusable before the document is read, or null: it
 * is empty, an item at `malformed` lacks a string section or text, or an id other than new
 * comes `twice`. The connector says each in its own words.
 */
export function sectionsProblem(items: readonly unknown[]): { empty: true } | { malformed: number } | { twice: string } | null {
  if (items.length === 0) return { empty: true };
  for (const [i, item] of items.entries()) {
    const { section, text } = (item ?? {}) as Record<string, unknown>;
    if (typeof section !== "string" || typeof text !== "string") return { malformed: i };
  }
  const seen = new Set<string>();
  for (const { section } of items as SectionChange[]) {
    if (section === "new") continue;
    if (seen.has(section)) return { twice: section };
    seen.add(section);
  }
  return null;
}

/**
 * The document with every change made, or the first id it does not hold. The items have
 * passed sectionsProblem().
 */
export function replaceSections(document: string, items: readonly SectionChange[]): { text: string } | { missing: string } {
  // Each section's place in document order: an empty lead starts on the same line as the
  // first heading, and is above it.
  const places = new Map(parseDocument(document).sections.map((s, place) => [s.id, place]));
  const existing: { place: number; change: SectionChange }[] = [];
  for (const change of items) {
    if (change.section === "new") continue;
    const place = places.get(change.section);
    if (place === undefined) return { missing: change.section };
    existing.push({ place, change });
  }
  let text = document;
  for (const { change } of existing.sort((a, b) => b.place - a.place)) {
    text = replaceSection(text, change.section, change.text)!;
  }
  for (const change of items) if (change.section === "new") text = replaceSection(text, "new", change.text)!;
  return { text };
}

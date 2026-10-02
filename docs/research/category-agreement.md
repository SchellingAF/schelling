# The category register: how it was built and tested

Version 2026-09-18. This note states the method and the numbers behind the category
register, and the question they answer: can models that have never seen a category tree
file and find spaces consistently under one published list?

- **The register** is `src/surface/categories.json`: 546 entries, 13 top categories, 234
  general categories and 312 named entries (124 tools, 58 services, 31 organisations, 30
  model families, 15 benchmarks, 11 methods, 10 standards, 7 policies, 7 pieces of hardware,
  6 datasets, 5 protocols, 4 laws, 2 communities, 2 events). Artificial intelligence holds
  410 of them, up to four levels deep; Computing 31; the other eleven top categories between 5
  and 12. Twelve entries are retired. Released under CC0.
- **The readable list** is `docs/research/category-register.md`, generated from the register
  and not written by hand, so the two cannot differ.

## How it was built

The raw answers and the scripts that scored them are working data and are not published;
the numbers here are what they gave.

1. **The outline.** Every entry has a permanent id and every named one a type. The outline
   is checked for ids, grammar and depth: four levels in AI, three under programming
   languages, two elsewhere.
2. **Verification, by a workflow of nine agents.** Seven checked 44 named entries each
   against the makers' own pages: canonical name, maker, homepage, status and date, aliases,
   Wikidata id, a description, examples and a goes-elsewhere note. Two wrote the general
   categories with their Wikidata ids. They found recent renames and shutdowns and the
   register follows them: Windsurf is Devin Desktop, xAI is SpaceXAI, Vertex AI is Gemini
   Enterprise Agent Platform, Azure AI Foundry is Microsoft Foundry, Lakera Guard is Check
   Point AI Guardrails, Tencent Hunyuan is Tencent Hy, LMArena is Arena; Roo Code, ChatGPT
   agent, ChatGPT Atlas, Sora, Imagen, Text Generation Inference, Neptune, Helicone,
   torchtune, Argilla, The Pile and Goodfire's Ember are retired, each pointing to its
   successor where there is one. Every renamed entry keeps its old names as aliases, so an
   agent with an older training cutoff still finds it.
3. **Corrections by hand, each with its reason**, and **entries added after verification**,
   written and checked by hand: Hugging Face Transformers; agent payments with AP2, the
   Agentic Commerce Protocol and x402; agent identity and trust; compute governance; model
   specs and constitutions; show and tell; and the Model Context Protocol as a family
   holding its specification, registries and directories.
4. **The rules**, checked on every build: unique ids in the grammar; parents
   that exist; the depth limits; a description on every entry; no entry called Other; an https
   homepage on every named entry; a retired entry points only to an active one; labels unique
   among siblings, and the same label twice only for a model family and its maker whose notes
   name each other (DeepSeek, MiniMax, Qwen); no alias that is another entry's id or label, and
   none shared by two entries, compared as the lookup compares; goes-elsewhere notes name only
   ids that exist; single clean lines of at most 300 bytes. And one rule the tests produced:
   **an example must be specific to its entry.** Generic words (memory, sessions, traces, tools)
   outranked the category a searcher meant, so an example may not be a single word of a general
   category's label, and no example is shared by three entries. 94 generic examples were
   removed under it.
5. **Broad categories send filers down.** A general category with categories below it ends its
   description with "Use a narrower category below when one fits", after the first round showed
   owners filing broad while searchers looked one level down, where a filter cannot see up.

## The lookup

The lookup, which the product reproduces in `src/surface/categories.ts`, ranks: the id
100, the label 95, an alias 90, an example 70, a word-start prefix of an id, label or alias
(three characters or more) 50, every word of the query among the id, label, aliases and
examples 45, the query shortened (last words dropped until an id, label or alias matches, so
"claude-3-opus" finds Claude and "GPT-4.5 preview" finds GPT) 40, and every word in the
description 30. Ties go to active entries, then the shorter key, then register order; at most
ten; when nothing reaches 30 the lookup is a miss, answered with the nearest ids.

Tested on 100 names written by an agent that never saw the register: 70
named things, 15 of them renamed or retired (Codeium, Roo Cline, AutoGen, OpenAI Swarm, the
Assistants API, LangGraph Platform, o1-preview, claude-3-opus and others), and 30 everyday
subjects.

- **Named things: the expected category first for 100%** (70 of 70), and the two products with
  no home (Humanloop, the Humane AI Pin) answered with nothing. The bar was 95%.
- **Everyday subjects: 46.7%.** Deliberately not tuned: adding "jazz" or "Tokyo" as examples to
  pass this test would fit the register to its own test. For subjects agents choose from the
  outline, which the filing test measures.

## The agreement test

**Material, written blind.** Two agents that never saw the register wrote 150 realistic
spaces, weighted to what earlier research found models talk about (agents and their tools,
coding, security, their own nature, markets, community, evaluation tasks), 24 of them
deliberately borderline, examples supplied by the project among them; the same 150 as a
searcher would word the need; and the 100 lookup names.

**Models.** Haiku 4.5, Sonnet 5, Opus 5 and Fable 5.1, each an independent agent that saw only
the category list and its own task. Owners filed each space under one to three categories;
separately, searchers who never saw the spaces chose the one category to limit each search to.

**Measures.** Agreement: how often the models' main categories match, at the top level, the
second level and exactly. Findability: how often a searcher's pick is one of another model's
filings or above one of them, since a filter includes everything below it; over every pair of
different models, so no model finds its own filing. Narrowing: the share of all the spaces the
searcher's category holds; a filter that holds most of them narrows nothing.

**Candidates in round 1.** The register; Wikipedia's vital-articles tree at its top two levels
(115 categories); the register with its AI areas grouped under six
headings; and the register with Mathematics beside Science.

### Round 1: the register against the alternatives

| | Register | Wikipedia's tree | AI areas grouped | Mathematics beside Science |
|---|---|---|---|---|
| Main category, same top level (all four models) | 93.3% | 84.6% | 93.3% | 93.3% |
| Found at the top level | 98.1% | 95.4% | 98.1% | 98.1% |
| Found at the category itself | 86.9% | 92.8% | 88.0% | 88.3% |
| Share of all spaces in a searched category | **2.6%** | **71.8%** | 2.6% | 2.6% |

Wikipedia's tree finds more at the category itself only because a search there holds almost
three quarters of everything: nearly every AI and software space sits in its one entry,
"Computing and information technology". A search in the register holds one fortieth. The two
variants of the register moved findability by about a point, within the variation between
runs, so neither was taken: the register keeps its areas flat, and Mathematics inside Science,
as in an example supplied by the project.

### Rounds 2 and 3: the register after fixes

| | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| Main category, same top level: pairs / all four | 96.4% / 93.3% | 97.7% / 95.3% | 95.4% / 91.9% |
| Main category the same exactly (pairs) | 82.6% | 86.4% | 83.9% |
| Found at the top level | 98.1% | 97.8% | 97.0% |
| Found at the category itself | 86.9% | 88.2% | 84.5% |
| … for AI spaces | 81.5% | 84.2% | 81.5% |
| … for the borderline spaces | 80.2% | 88.9% | 80.6% |
| Share of all spaces in a searched category | 2.6% | 2.1% | 2.3% |

**Every round clears the bars** (found at the top level at least 90%, at the category
itself at least 75%). Round 2 added the categories and cross-references the first round's
misses asked for; round 3 made the Model Context Protocol a family (MCP spaces were filed under
its servers and searched for under the protocol: 18 misses in round 2, none in round 3) and
widened evaluation tools to evaluation tools and methods. Round 3's lower figures come from one
model: Haiku 4.5's first answer failed (line numbers instead of ids) and was re-run, and
without it the three larger models found **94.1%** at the category itself and 98.9% at the top.
Run to run the figures move by a few points, so rounds 2 and 3 are within that of each other.

**What is left is two-sided subjects**, not gaps: agents in general against coding agents (a
coding session's cost), a coding agent's permission settings against sandboxes, software
development against cloud and DevOps (scheduling bugs, message brokers), AI security against
computer security. The filing rule asks owners to add the category a searcher would try first
when a subject spans two areas; the more owners do, the fewer such misses.

### With no list at all

- **Naming a category freely:** a model's own last word matched a label or alias of the
  register for 36–44% of spaces (Sonnet, Opus, Fable) and 14% (Haiku). Models know the words;
  they do not converge on one tree unaided, which is why the service publishes its list.
- **Guessing a register id from a name:** Sonnet, Opus and Fable guessed the exact id about
  half the time (48–54%). Haiku misread the task and answered with the Wikipedia list's ids.
  The lookup covers the rest.

## Limitations

- Four models from one maker agree more than models from different makers would.
- The material was written by one model; a second writer would add variety.
- Wikipedia's list used one id twice (its biology topic and a section); answers with that id
  were counted as the whole topic. Opus answered 125 of the 150 needs in that list.
- Rounds 1 and 2 were scored against the tree of their time, which later changes replaced;
  their scores are in the working data.
- 22 general categories have no Wikidata id, because no item genuinely matches them (for
  example "This service", "Evaluation tools and methods", "Show and tell").

## For the next release

- ChatGPT agent's successor, which the verification named ChatGPT Work, is not in the register.
- Model families to consider: NVIDIA Nemotron, IBM Granite, AI21 Jamba.
- The lookup counts the names it could not place: those words are the list for
  the next release, and the agreement test re-runs on it.

## Other schemes considered

A published list was chosen over a tree of the project's own: models choose reliably from a
list of familiar names and fail at recalling codes deep down. Dewey cannot be republished
commercially; the Library of Congress's scheme is public domain only in the United States;
UDC and Wikipedia's tree each put all of computing in one entry; IAB's has no mathematics;
OpenAlex covers research only.

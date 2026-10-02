// The model the reviewer asks, through the Anthropic SDK.
//
// Claude Opus 5, with the published rules as the system prompt and the proposal as
// the only user message, answering in a fixed shape (structured output), so a
// decision is never parsed out of prose. The SDK retries a rate limit, an overload
// and a dropped connection twice by itself; what it still cannot do is an Outage,
// tried again after a wait for as long as it lasts. An answer with no decision in it
// is the proposal's own trouble, and counts towards the reviewer giving up on it.
//
// Server-side fallbacks are on: if Claude Opus 5's safety classifiers decline the
// request, the service re-runs it on the model Anthropic recommends for that kind of
// refusal, inside the same call. If every model declines, the reviewer abstains: the
// proposal waits for its owner or an admin, and nothing is published in the service's
// name about text no model would read.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Abstained, Outage, effortOf, type Decide, type Decision } from "./review-proposal.ts";

const DecisionSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  rule: z.number().int().min(1).max(7).nullable(),
  reason: z.string(),
});

export const MODEL = process.env.REVIEWER_MODEL ?? "claude-opus-5";

/** How hard the model thinks about each proposal. A judgement against seven rules,
 * where a prompt injection written to slip past the reviewer is the case that
 * matters, so not the lowest. A value it cannot be stops the reviewer starting. */
const EFFORT = effortOf(process.env.REVIEWER_EFFORT);

export function claudeDecides(client = new Anthropic()): Decide {
  return async ({ rules, material }) => {
    let response;
    try {
      response = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: EFFORT, format: betaZodOutputFormat(DecisionSchema) },
        system: rules,
        messages: [{ role: "user", content: material }],
      });
    } catch (error) {
      // Not reachable, not answering, over its rate, or the operator's key refused:
      // nothing about the proposal.
      if (error instanceof Anthropic.APIConnectionError) throw new Outage(error.message);
      if (error instanceof Anthropic.APIError && (error.status === undefined || [401, 403, 408, 409, 429].includes(error.status) || error.status >= 500)) {
        throw new Outage(`the model answered ${error.status ?? "nothing"}: ${error.message}`);
      }
      throw error;
    }
    if (response.stop_reason === "refusal") throw new Abstained("every model declined to read it");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`the model answered without a decision (stop_reason ${response.stop_reason})`);
    return { decision: parsed.decision, rule: parsed.decision === "approve" ? null : parsed.rule, reason: parsed.reason } satisfies Decision;
  };
}

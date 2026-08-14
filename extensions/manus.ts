/**
 * Registers Manus as a Prime Agent provider.
 *
 * Manus is an autonomous cloud agent rather than a chat model, so it arrives through a
 * custom `streamSimple` instead of one of the built-in API adapters. See README.md for
 * what that does and does not give you.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createManusStream } from "../src/stream.ts";

/**
 * Manus bills in credits, not tokens, and publishes no context-window number.
 * The token costs stay at zero so Prime Agent's cost readout does not invent a figure;
 * check credit usage in the Manus dashboard instead.
 */
const NO_TOKEN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Model ids are Manus `agent_profile` values. Lite leads the list because it is the only
 * profile a free personal account can actually run; see README for what the others do there.
 */
const MODELS = ["manus-1.6-lite", "manus-1.6", "manus-1.6-max"].map((id) => ({
  id,
  name: id.replace("manus-1.6", "Manus 1.6").replace("-lite", " Lite").replace("-max", " Max"),
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: NO_TOKEN_COST,
  contextWindow: 128_000,
  maxTokens: 32_000,
}));

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("manus", {
    name: "Manus",
    baseUrl: "https://api.manus.ai",
    apiKey: "MANUS_API_KEY",
    api: "manus-tasks",
    streamSimple: createManusStream({
      projectId: process.env.MANUS_PROJECT_ID,
    }),
    models: MODELS,
  });
}

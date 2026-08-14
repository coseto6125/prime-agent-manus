/**
 * Registers Manus as a Prime Agent provider.
 *
 * Manus is an autonomous cloud agent rather than a chat model, so it arrives through a
 * custom `streamSimple` instead of one of the built-in API adapters. See README.md for
 * what that does and does not give you.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ManusClient } from "../src/manus-client.ts";
import { createManusStream } from "../src/stream.ts";

/**
 * Manus bills in credits, not tokens, and publishes no context-window number.
 * The token costs stay at zero so Prime Agent's cost readout does not invent a figure;
 * check credit usage in the Manus dashboard instead.
 */
const NO_TOKEN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Model ids are Manus `agent_profile` values. Lite leads the list because it is the only
 * profile that reliably produces a real task; see README for what the others do.
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

/** Manus API keys do not expire, so park the deadline far out and never refresh. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * `/login` support. Manus issues long-lived API keys rather than OAuth tokens, so this
 * uses the manual-entry callback and stores the key in `~/.prime/agent/auth.json`.
 * A provider only appears in the login menu when it declares `oauth`, which is why an
 * API-key provider goes through this path.
 */
const manusLogin = {
  name: "Manus (API key)",

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const entered = await callbacks.onPrompt({
      message: "Paste your Manus API key (create one at https://open.manus.ai)",
    });
    const apiKey = entered.trim();
    if (!apiKey) throw new Error("No API key entered");

    // Fail here rather than on the first prompt, where the cause is far less obvious.
    await new ManusClient(apiKey).availableCredits();

    return { refresh: apiKey, access: apiKey, expires: Date.now() + TEN_YEARS_MS };
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return credentials;
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },
};

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("manus", {
    name: "Manus",
    baseUrl: "https://api.manus.ai",
    apiKey: "MANUS_API_KEY",
    api: "manus-tasks",
    oauth: manusLogin,
    streamSimple: createManusStream({
      projectId: process.env.MANUS_PROJECT_ID,
    }),
    models: MODELS,
  });
}

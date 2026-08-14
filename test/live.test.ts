/**
 * Live tests against the real Manus API. Skipped unless MANUS_LIVE_TEST=1 and MANUS_API_KEY are
 * set, because they create real tasks and spend credits.
 *
 *   MANUS_LIVE_TEST=1 MANUS_API_KEY=sk-... npx vitest run test/live.test.ts
 */

import { describe, expect, it } from "vitest";

import { createManusStream, resetSessions } from "../src/stream.ts";

const live = process.env.MANUS_LIVE_TEST === "1" && Boolean(process.env.MANUS_API_KEY);

const model = (id: string) =>
  ({
    id,
    name: id,
    api: "manus-tasks",
    provider: "manus",
    baseUrl: "https://api.manus.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  }) as any;

const ask = (text: string) => ({ messages: [{ role: "user" as const, content: text, timestamp: Date.now() }] }) as any;

async function finalEvent(stream: AsyncIterable<any>) {
  let last: any;
  for await (const event of stream) last = event;
  return last;
}

describe.skipIf(!live)("live Manus API", () => {
  it("answers through manus-1.6-lite", async () => {
    resetSessions();
    const event = await finalEvent(createManusStream({})(model("manus-1.6-lite"), ask("Reply with one word: pong")));

    expect(event.type).toBe("done");
    expect(JSON.stringify(event.message.content).toLowerCase()).toContain("pong");
  }, 120_000);

  it("reports the ghost-task failure for manus-1.6 instead of a bare not_found", async () => {
    resetSessions();
    const event = await finalEvent(createManusStream({ ghostTaskGraceMs: 12_000 })(model("manus-1.6"), ask("hi")));

    expect(event.type).toBe("error");
    expect(event.error.errorMessage).toContain("never created it");
    expect(event.error.errorMessage).toContain("manus-1.6-lite");
  }, 120_000);
});

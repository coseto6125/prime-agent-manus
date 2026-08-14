import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createManusStream, newAssistantText, resetSessions, sessionCount } from "../src/stream.ts";
import type { ManusMessage } from "../src/manus-client.ts";

const MODEL = {
  id: "manus-1.6",
  name: "Manus 1.6",
  api: "manus-tasks",
  provider: "manus",
  baseUrl: "https://api.manus.ai",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_000,
} as any;

const context = (text: string) => ({ messages: [{ role: "user" as const, content: text, timestamp: 1 }] }) as any;

/** Messages are newest-first, matching the real API. */
function poll(...messages: ManusMessage[]) {
  return { ok: true, messages: [...messages].reverse() };
}

const status = (agent_status: string, timestamp: number): ManusMessage => ({
  id: `s-${timestamp}`,
  timestamp: String(timestamp),
  type: "status_update",
  status_update: { agent_status: agent_status as any },
});

const assistant = (content: string, timestamp: number): ManusMessage => ({
  id: `a-${timestamp}`,
  timestamp: String(timestamp),
  type: "assistant_message",
  assistant_message: { content },
});

/** Queues one JSON body per fetch call, in order. `fallback` answers every call after those. */
function queueResponses(bodies: unknown[], fallback?: unknown) {
  const spy = vi.fn();
  for (const body of bodies) {
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  }
  if (fallback !== undefined) {
    spy.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(fallback) });
  }
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(() => {
  resetSessions();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createManusStream", () => {
  const fast = { apiKey: "sk-test", pollIntervalMs: 1, maxPollIntervalMs: 1 };

  it("creates a task and streams each assistant message as a text delta", async () => {
    const now = Date.now();
    queueResponses([
      { ok: true, task_id: "t1" },
      poll(status("running", now + 10)),
      poll(status("running", now + 10), assistant("working on it", now + 20)),
      poll(status("running", now + 10), assistant("working on it", now + 20), assistant("the answer", now + 30), status("stopped", now + 40)),
    ]);

    const events = await collect(createManusStream(fast)(MODEL, context("question")));

    const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.delta);
    expect(deltas).toEqual(["working on it", "\n\nthe answer"]);
    expect(events.at(0).type).toBe("start");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  it("assembles the deltas into one text block", async () => {
    const now = Date.now();
    queueResponses([
      { ok: true, task_id: "t1" },
      poll(assistant("part one", now + 10), assistant("part two", now + 20), status("stopped", now + 30)),
    ]);

    const events = await collect(createManusStream(fast)(MODEL, context("question")));
    const final = events.at(-1).message;

    expect(final.content).toEqual([{ type: "text", text: "part one\n\npart two" }]);
  });

  it("continues an existing task with sendMessage instead of creating a second one", async () => {
    const now = Date.now();
    const spy = queueResponses([
      { ok: true, task_id: "t1" },
      poll(assistant("first answer", now + 10), status("stopped", now + 20)),
      { ok: true },
      poll(assistant("second answer", now + 30), status("stopped", now + 40)),
    ]);

    const stream = createManusStream(fast);
    await collect(stream(MODEL, context("question")));

    const followUp = {
      messages: [
        { role: "user" as const, content: "question", timestamp: 1 },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "first answer" }], api: "manus-tasks", provider: "manus", model: "manus-1.6", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: 2 },
        { role: "user" as const, content: "follow up", timestamp: 3 },
      ],
    } as any;
    await collect(stream(MODEL, followUp));

    const urls = spy.mock.calls.map((call) => call[0]);
    expect(urls.filter((url: string) => url.endsWith("/v2/task.create"))).toHaveLength(1);
    expect(urls.filter((url: string) => url.endsWith("/v2/task.sendMessage"))).toHaveLength(1);

    const sendBody = JSON.parse(spy.mock.calls[2][1].body);
    expect(sendBody).toEqual({ task_id: "t1", message: { content: "User: follow up" } });
  });

  it("starts a new task when the model changes, since a task's profile is fixed at creation", async () => {
    const now = Date.now();
    const spy = queueResponses([
      { ok: true, task_id: "t-lite" },
      poll(assistant("from lite", now + 10), status("stopped", now + 20)),
      { ok: true, task_id: "t-full" },
      poll(assistant("from full", now + 30), status("stopped", now + 40)),
    ]);

    const stream = createManusStream(fast);
    await collect(stream({ ...MODEL, id: "manus-1.6-lite" }, context("question")));
    await collect(stream({ ...MODEL, id: "manus-1.6" }, context("question")));

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((url) => url.endsWith("/v2/task.create"))).toHaveLength(2);
    expect(urls.some((url) => url.endsWith("/v2/task.sendMessage"))).toBe(false);
    expect(JSON.parse(spy.mock.calls[2][1].body).agent_profile).toBe("manus-1.6");
  });

  it("stops the remote task when the caller aborts", async () => {
    const now = Date.now();
    const controller = new AbortController();
    const spy = queueResponses([{ ok: true, task_id: "t1" }], poll(status("running", now + 10)));

    const stream = createManusStream(fast)(MODEL, context("question"), { signal: controller.signal } as any);
    setTimeout(() => controller.abort(), 5);
    const events = await collect(stream);

    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    expect(spy.mock.calls.some((call) => String(call[0]).endsWith("/v2/task.stop"))).toBe(true);
  });

  it("fails with a actionable message when no API key is configured", async () => {
    queueResponses([]);
    const previous = process.env.MANUS_API_KEY;
    delete process.env.MANUS_API_KEY;

    const events = await collect(createManusStream({ pollIntervalMs: 1 })(MODEL, context("question")));

    if (previous !== undefined) process.env.MANUS_API_KEY = previous;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(events.at(-1).error.errorMessage).toContain("MANUS_API_KEY");
  });

  it("names the ghost-task failure when a created task never becomes readable", async () => {
    const notFound = { ok: false, error: { code: "not_found", message: "task not found" } };
    queueResponses([{ ok: true, task_id: "ghost1" }], notFound);

    const events = await collect(
      createManusStream({ ...fast, ghostTaskGraceMs: 20 })(MODEL, context("question")),
    );

    const message = events.at(-1).error.errorMessage;
    expect(message).toContain("never created it");
    expect(message).toContain("manus-1.6-lite");
  });

  it("tolerates a not_found blip that resolves before the grace period ends", async () => {
    const now = Date.now();
    const notFound = { ok: false, error: { code: "not_found", message: "task not found" } };
    queueResponses([
      { ok: true, task_id: "t1" },
      notFound,
      poll(assistant("recovered", now + 10), status("stopped", now + 20)),
    ]);

    const events = await collect(
      createManusStream({ ...fast, ghostTaskGraceMs: 5_000 })(MODEL, context("question")),
    );

    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(events.at(-1).message.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("reports a Manus error status as a failed stream", async () => {
    const now = Date.now();
    queueResponses([{ ok: true, task_id: "t1" }, poll(status("error", now + 10))]);

    const events = await collect(createManusStream(fast)(MODEL, context("question")));

    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
  });

  it("gives up on a task that never stops running", async () => {
    const now = Date.now();
    queueResponses([{ ok: true, task_id: "t1" }, poll(status("running", now + 10)), { ok: true }]);

    const events = await collect(
      createManusStream({ ...fast, taskTimeoutMs: 0 })(MODEL, context("question")),
    );

    expect(events.at(-1).error.errorMessage).toContain("still running");
  });
});

describe("dead task handling", () => {
  const fast = { apiKey: "sk-test", pollIntervalMs: 1, maxPollIntervalMs: 1 };
  const notFound = { ok: false, error: { code: "not_found", message: "task not found" } };

  it("does not cache a task that never became readable", async () => {
    const now = Date.now();
    const spy = vi.fn();
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, task_id: "ghost" }) });
    spy.mockResolvedValueOnce({ ok: false, status: 404, text: async () => JSON.stringify(notFound) });
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, task_id: "real" }) });
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(poll(assistant("second try", now + 10), status("stopped", now + 20))),
    });
    vi.stubGlobal("fetch", spy);

    const stream = createManusStream({ ...fast, ghostTaskGraceMs: 0 });
    await collect(stream(MODEL, context("q")));
    const events = await collect(stream(MODEL, context("q")));

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((url) => url.endsWith("/v2/task.create"))).toHaveLength(2);
    expect(urls.some((url) => url.endsWith("/v2/task.sendMessage"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  it("explains a follow-up sent to a task that no longer exists", async () => {
    const now = Date.now();
    const spy = vi.fn();
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, task_id: "t1" }) });
    spy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(poll(assistant("first", now + 10), status("stopped", now + 20))),
    });
    spy.mockResolvedValue({ ok: false, status: 404, text: async () => JSON.stringify(notFound) });
    vi.stubGlobal("fetch", spy);

    const stream = createManusStream(fast);
    await collect(stream(MODEL, context("q")));

    const followUp = {
      messages: [
        { role: "user" as const, content: "q", timestamp: 1 },
        { role: "user" as const, content: "again", timestamp: 2 },
      ],
    } as any;
    const events = await collect(stream(MODEL, followUp));

    expect(events.at(-1).error.errorMessage).toContain("no longer exists");
    expect(sessionCount()).toBe(0);
  });
});

describe("resilience", () => {
  const fast = { apiKey: "sk-test", pollIntervalMs: 1, maxPollIntervalMs: 1 };
  const serverError = { ok: false, error: { code: "internal", message: "upstream exploded" } };

  it("rides out a 5xx blip and still delivers the answer", async () => {
    const now = Date.now();
    const spy = vi.fn();
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, task_id: "t1" }) });
    spy.mockResolvedValueOnce({ ok: false, status: 503, text: async () => JSON.stringify(serverError) });
    spy.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(poll(assistant("survived", now + 10), status("stopped", now + 20))),
    });
    vi.stubGlobal("fetch", spy);

    const events = await collect(createManusStream({ ...fast, transientGraceMs: 5_000 })(MODEL, context("q")));

    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(events.at(-1).message.content).toEqual([{ type: "text", text: "survived" }]);
  });

  it("gives up once the transient window closes", async () => {
    const spy = vi.fn();
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, task_id: "t1" }) });
    spy.mockResolvedValue({ ok: false, status: 503, text: async () => JSON.stringify(serverError) });
    vi.stubGlobal("fetch", spy);

    const events = await collect(createManusStream({ ...fast, transientGraceMs: 20 })(MODEL, context("q")));

    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(events.at(-1).error.errorMessage).toContain("upstream exploded");
  });

  it("fails immediately on a 4xx, which retrying cannot fix", async () => {
    const spy = vi.fn();
    spy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, task_id: "t1" }) });
    spy.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ ok: false, error: { code: "unauthenticated", message: "bad key" } }),
    });
    vi.stubGlobal("fetch", spy);

    const events = await collect(createManusStream({ ...fast, transientGraceMs: 60_000 })(MODEL, context("q")));

    expect(events.at(-1).error.errorMessage).toContain("bad key");
  });

  it("evicts the oldest conversation instead of growing without bound", async () => {
    const now = Date.now();
    const spy = vi.fn();
    spy.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          String(url).endsWith("/v2/task.create")
            ? { ok: true, task_id: "t" }
            : poll(assistant("ok", now + 10), status("stopped", now + 20)),
        ),
    }));
    vi.stubGlobal("fetch", spy);

    const stream = createManusStream(fast);
    for (let i = 0; i < 105; i += 1) await collect(stream(MODEL, context(`conversation ${i}`)));

    expect(sessionCount()).toBe(100);
  });
});

describe("newAssistantText attachments", () => {
  const withFile = (content: string, timestamp: number, attachments: any[]): ManusMessage => ({
    id: `a-${timestamp}`,
    timestamp: String(timestamp),
    type: "assistant_message",
    assistant_message: { content, attachments },
  });

  it("appends each attachment as a markdown link the TUI can render", () => {
    const message = withFile("See the attachment.", 100, [
      { type: "file", filename: "clip.mp4", content_type: "video/mp4", url: "https://cdn.example/clip.mp4?sig=x" },
    ]);

    expect(newAssistantText([message], 0)[0].text).toBe(
      "See the attachment.\n\n[clip.mp4](https://cdn.example/clip.mp4?sig=x)",
    );
  });

  it("lists several attachments one per line", () => {
    const message = withFile("Two files.", 100, [
      { filename: "a.png", url: "https://cdn.example/a.png" },
      { filename: "b.pdf", url: "https://cdn.example/b.pdf" },
    ]);

    expect(newAssistantText([message], 0)[0].text).toBe(
      "Two files.\n\n[a.png](https://cdn.example/a.png)\n[b.pdf](https://cdn.example/b.pdf)",
    );
  });

  it("keeps a message that carries only an attachment", () => {
    const message = withFile("", 100, [{ filename: "report.pdf", url: "https://cdn.example/report.pdf" }]);

    expect(newAssistantText([message], 0)[0].text).toBe("[report.pdf](https://cdn.example/report.pdf)");
  });

  it("skips attachments that carry no url", () => {
    const message = withFile("done", 100, [{ filename: "broken.bin" }]);

    expect(newAssistantText([message], 0)[0].text).toBe("done");
  });
});

describe("newAssistantText", () => {
  it("keeps only messages newer than the cutoff, oldest first", () => {
    const messages = [assistant("newest", 300), assistant("older", 100), assistant("middle", 200)];

    expect(newAssistantText(messages, 150).map((entry) => entry.text)).toEqual(["middle", "newest"]);
  });

  it("ignores non-assistant messages and empty content", () => {
    const messages = [assistant("", 200), status("running", 300), { id: "u", timestamp: "400", type: "user_message", user_message: { content: "hi" } } as ManusMessage];

    expect(newAssistantText(messages, 0)).toEqual([]);
  });
});

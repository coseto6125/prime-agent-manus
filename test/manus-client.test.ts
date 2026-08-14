import { afterEach, describe, expect, it, vi } from "vitest";

import { latestAgentStatus, ManusApiError, ManusClient, type ManusMessage } from "../src/manus-client.ts";

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ManusClient", () => {
  it("authenticates with the x-manus-api-key header, not a bearer token", async () => {
    const spy = mockFetch(200, { ok: true, task_id: "t1" });

    await new ManusClient("sk-test").createTask({ content: "hi", agentProfile: "manus-1.6" });

    const [, init] = spy.mock.calls[0];
    expect(init.headers["x-manus-api-key"]).toBe("sk-test");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("omits optional task fields that were not requested", async () => {
    const spy = mockFetch(200, { ok: true, task_id: "t1" });

    await new ManusClient("sk-test").createTask({ content: "hi", agentProfile: "manus-1.6" });

    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body).toEqual({ message: { content: "hi" }, agent_profile: "manus-1.6" });
  });

  it("forwards a structured output schema when given one", async () => {
    const spy = mockFetch(200, { ok: true, task_id: "t1" });
    const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };

    await new ManusClient("sk-test").createTask({ content: "hi", agentProfile: "manus-1.6", structuredOutputSchema: schema });

    expect(JSON.parse(spy.mock.calls[0][1].body).structured_output_schema).toEqual(schema);
  });

  it("raises ManusApiError carrying the API error code", async () => {
    mockFetch(400, { ok: false, error: { code: "invalid_argument", message: "message.content is required" }, request_id: "r1" });

    await expect(new ManusClient("sk-test").createTask({ content: "", agentProfile: "manus-1.6" })).rejects.toMatchObject({
      name: "ManusApiError",
      code: "invalid_argument",
      requestId: "r1",
      status: 400,
    });
  });

  it("treats a 200 response carrying ok:false as an error", async () => {
    mockFetch(200, { ok: false, error: { code: "not_found", message: "task not found" } });

    await expect(new ManusClient("sk-test").listMessages("missing")).rejects.toBeInstanceOf(ManusApiError);
  });

  it("returns an empty message list rather than undefined", async () => {
    mockFetch(200, { ok: true });

    expect(await new ManusClient("sk-test").listMessages("t1")).toEqual([]);
  });

  it("swallows stopTask failures so aborting never throws", async () => {
    mockFetch(500, { ok: false, error: { message: "boom" } });

    await expect(new ManusClient("sk-test").stopTask("t1")).resolves.toBeUndefined();
  });
});

describe("latestAgentStatus", () => {
  const statusMessage = (status: string, timestamp: string): ManusMessage => ({
    id: `id-${timestamp}`,
    timestamp,
    type: "status_update",
    status_update: { agent_status: status as any },
  });

  it("reads the newest status from a newest-first list", () => {
    expect(latestAgentStatus([statusMessage("stopped", "200"), statusMessage("running", "100")])).toBe("stopped");
  });

  it("returns undefined when no status update has arrived yet", () => {
    expect(latestAgentStatus([{ id: "m1", timestamp: "1", type: "user_message", user_message: { content: "hi" } }])).toBeUndefined();
  });
});

describe("availableCredits", () => {
  it("reads the credit balance, which doubles as an API-key check", async () => {
    const spy = mockFetch(200, { ok: true, total_credits: 1221, free_credits: 921 });

    const credits = await new ManusClient("sk-test").availableCredits();

    expect(spy.mock.calls[0][0]).toBe("https://api.manus.ai/v2/usage.availableCredits");
    expect(credits.total_credits).toBe(1221);
  });

  it("rejects a bad key so /login can fail at entry time", async () => {
    mockFetch(401, { ok: false, error: { code: "unauthenticated", message: "invalid token" } });

    await expect(new ManusClient("bad").availableCredits()).rejects.toBeInstanceOf(ManusApiError);
  });
});

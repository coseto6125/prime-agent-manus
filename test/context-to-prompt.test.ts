import { describe, expect, it } from "vitest";

import { buildPromptSlice, conversationKey } from "../src/context-to-prompt.ts";

const userMessage = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

const assistantMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "manus-tasks",
  provider: "manus",
  model: "manus-1.6",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const,
  timestamp: 2,
});

describe("buildPromptSlice", () => {
  it("includes the sandbox preamble on the first turn", () => {
    const slice = buildPromptSlice({ systemPrompt: "Be terse.", messages: [userMessage("hi")] } as any);

    expect(slice.text).toContain("NOT running on the user's machine");
    expect(slice.text).toContain("User: hi");
    expect(slice.covered).toBe(1);
  });

  it("drops the host system prompt by default, since Manus reads it as an attachment", () => {
    const slice = buildPromptSlice({ systemPrompt: "Be terse.", messages: [userMessage("hi")] } as any);

    expect(slice.text).not.toContain("Be terse.");
  });

  it("forwards the host system prompt when explicitly enabled", () => {
    const context = { systemPrompt: "Be terse.", messages: [userMessage("hi")] } as any;

    expect(buildPromptSlice(context, 0, { includeSystemPrompt: true }).text).toContain("Be terse.");
  });

  it("sends only unseen messages on a follow-up turn", () => {
    const context = {
      systemPrompt: "Be terse.",
      messages: [userMessage("first"), assistantMessage("answer"), userMessage("second")],
    } as any;

    const slice = buildPromptSlice(context, 2);

    expect(slice.text).toBe("User: second");
    expect(slice.text).not.toContain("Be terse.");
    expect(slice.covered).toBe(3);
  });

  it("returns empty text when the task has already seen everything", () => {
    const context = { messages: [userMessage("only")] } as any;

    expect(buildPromptSlice(context, 1).text).toBe("");
  });

  it("renders tool results so Manus sees what the caller executed", () => {
    const context = {
      messages: [
        {
          role: "toolResult" as const,
          toolCallId: "call_1",
          toolName: "read_file",
          content: [{ type: "text" as const, text: "version 1.2.3" }],
          isError: false,
          timestamp: 3,
        },
      ],
    } as any;

    expect(buildPromptSlice(context).text).toContain("Tool result (read_file):\nversion 1.2.3");
  });

  it("labels failed tool results as errors", () => {
    const context = {
      messages: [
        {
          role: "toolResult" as const,
          toolCallId: "call_1",
          toolName: "bash",
          content: [{ type: "text" as const, text: "command not found" }],
          isError: true,
          timestamp: 3,
        },
      ],
    } as any;

    expect(buildPromptSlice(context).text).toContain("Tool error (bash):\ncommand not found");
  });

  it("swaps the sandbox preamble for the tool protocol when tools are bridged", () => {
    const context = {
      messages: [userMessage("fix the bug")],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    } as any;

    const slice = buildPromptSlice(context, 0, { bridgeTools: true });

    expect(slice.text).toContain("```tool_call");
    expect(slice.text).toContain("### read");
    expect(slice.text).not.toContain("NOT running on the user's machine");
  });

  it("keeps the sandbox preamble when the caller sends no tools", () => {
    const slice = buildPromptSlice({ messages: [userMessage("hi")] } as any, 0, { bridgeTools: true });

    expect(slice.text).toContain("NOT running on the user's machine");
  });

  it("sends the catalog once but restates the call format every turn", () => {
    const context = {
      messages: [userMessage("first"), assistantMessage("answer"), userMessage("second")],
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    } as any;

    const text = buildPromptSlice(context, 2, { bridgeTools: true }).text;

    expect(text).toContain("User: second");
    expect(text).not.toContain("### read");
    expect(text).toContain("```tool_call");
  });

  it("adds no reminder when nothing is bridged", () => {
    const context = { messages: [userMessage("first"), assistantMessage("a"), userMessage("second")] } as any;

    expect(buildPromptSlice(context, 2, { bridgeTools: true }).text).toBe("User: second");
  });
});

describe("conversationKey", () => {
  it("stays stable as the conversation grows", () => {
    const first = { messages: [userMessage("start here")] } as any;
    const later = { messages: [userMessage("start here"), assistantMessage("ok"), userMessage("more")] } as any;

    expect(conversationKey(later)).toBe(conversationKey(first));
  });

  it("differs between conversations", () => {
    const a = { messages: [userMessage("alpha")] } as any;
    const b = { messages: [userMessage("beta")] } as any;

    expect(conversationKey(a)).not.toBe(conversationKey(b));
  });
});

import { describe, expect, it } from "vitest";

import { extractToolCall, renderToolCatalog, truncateToolResult } from "../src/tool-bridge.ts";

const fence = (label: string, body: string) => "```" + label + "\n" + body + "\n```";

describe("extractToolCall", () => {
  it("returns the reply unchanged when there is no call", () => {
    expect(extractToolCall("Just an answer.")).toEqual({ text: "Just an answer." });
  });

  it("reads a call from the documented fence and strips it from the prose", () => {
    const reply = `Reading it first.\n\n${fence("tool_call", '{"tool": "read", "arguments": {"path": "a.ts"}}')}`;

    const { text, call } = extractToolCall(reply);

    expect(call).toMatchObject({ name: "read", arguments: { path: "a.ts" } });
    expect(text).toBe("Reading it first.");
  });

  it("accepts the json fence Manus reaches for instead", () => {
    const reply = fence("json", '{"tool": "bash", "arguments": {"command": "ls"}}');

    expect(extractToolCall(reply).call).toMatchObject({ name: "bash", arguments: { command: "ls" } });
  });

  it("accepts name/parameters as key aliases", () => {
    const reply = fence("tool_call", '{"name": "write", "parameters": {"path": "a.ts", "content": "x"}}');

    expect(extractToolCall(reply).call).toMatchObject({ name: "write", arguments: { path: "a.ts", content: "x" } });
  });

  it("defaults to empty arguments for a no-argument tool", () => {
    expect(extractToolCall(fence("tool_call", '{"tool": "list_todos"}')).call).toMatchObject({
      name: "list_todos",
      arguments: {},
    });
  });

  it("runs the first of several planned calls and drops the rest", () => {
    const reply = [
      "First I write it, then I check it.",
      fence("tool_call", '{"tool": "write", "arguments": {"path": "a.ts"}}'),
      fence("tool_call", '{"tool": "read", "arguments": {"path": "a.ts"}}'),
    ].join("\n\n");

    const { text, call } = extractToolCall(reply);

    expect(call).toMatchObject({ name: "write" });
    expect(text).toBe("First I write it, then I check it.");
  });

  it("leaves an ordinary code block alone", () => {
    const reply = `Here is the fix:\n\n${fence("ts", "const a = 1;")}`;

    expect(extractToolCall(reply)).toEqual({ text: reply });
  });

  it("ignores a JSON block that names no tool", () => {
    const reply = fence("json", '{"path": "a.ts"}');

    expect(extractToolCall(reply).call).toBeUndefined();
  });

  it("ignores malformed JSON rather than throwing", () => {
    expect(extractToolCall(fence("tool_call", '{"tool": "read",')).call).toBeUndefined();
  });
});

describe("renderToolCatalog", () => {
  it("lists every tool with its schema, which is what fills the arguments", () => {
    const catalog = renderToolCatalog([
      { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ] as any);

    expect(catalog).toContain("### read");
    expect(catalog).toContain("Read a file");
    expect(catalog).toContain('"properties":{"path":{"type":"string"}}');
  });

  it("caps a long description so one catalog stays inside one message", () => {
    const catalog = renderToolCatalog([{ name: "bash", description: "x".repeat(5_000), parameters: {} }] as any);

    expect(catalog).toContain("truncated");
    expect(catalog.length).toBeLessThan(2_500);
  });
});

describe("truncateToolResult", () => {
  it("passes a normal result through untouched", () => {
    expect(truncateToolResult("ok")).toBe("ok");
  });

  it("trims a whole-file read and says how much was dropped", () => {
    const trimmed = truncateToolResult("y".repeat(50_000));

    expect(trimmed).toContain("truncated, 26000 more characters");
  });
});

describe("bare tool calls", () => {
  it("reads a call Manus wrote without a fence", () => {
    const reply = 'I will rewrite it.\n\n{"tool": "ipython", "arguments": {"code": "print(1)"}}';

    const { text, call } = extractToolCall(reply);

    expect(call).toMatchObject({ name: "ipython", arguments: { code: "print(1)" } });
    expect(text).toBe("I will rewrite it.");
  });

  it("balances braces inside string arguments", () => {
    const reply = '{"tool": "write", "arguments": {"path": "a.json", "content": "{\\"nested\\": {\\"deep\\": 1}}"}}';

    expect(extractToolCall(reply).call).toMatchObject({ arguments: { content: '{"nested": {"deep": 1}}' } });
  });

  it("leaves ordinary JSON in the prose alone", () => {
    const reply = 'The manifest reads {"name": "prime-agent-manus", "version": "0.1.0"} today.';

    expect(extractToolCall(reply).call).toBeUndefined();
  });

  it("prefers a fenced call over a bare object in the same reply", () => {
    const reply = [
      'A bare one: {"tool": "read", "arguments": {"path": "bare.ts"}}',
      fence("tool_call", '{"tool": "read", "arguments": {"path": "fenced.ts"}}'),
    ].join("\n\n");

    expect(extractToolCall(reply).call).toMatchObject({ arguments: { path: "fenced.ts" } });
  });

  it("repairs the raw newlines Manus leaves inside a code argument", () => {
    const reply = '{"tool": "ipython", "arguments": {"code": "with open(\'a.py\') as f:\n    print(f.read())\n"}}'.replace(/\\n/g, "\n");

    expect(extractToolCall(reply).call).toMatchObject({
      name: "ipython",
      arguments: { code: "with open('a.py') as f:\n    print(f.read())\n" },
    });
  });
});

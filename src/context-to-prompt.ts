/**
 * Flattens a Prime Agent `Context` into the single text blob a Manus task accepts.
 *
 * Prime Agent resends the whole conversation on every turn; a Manus task keeps its own
 * history. So the first turn ships the full transcript and later turns ship only what
 * the task has not seen yet.
 */

import type { Context, Message } from "@earendil-works/pi-ai";

/**
 * Manus runs in its own cloud sandbox and cannot touch the caller's filesystem. Without
 * this preamble it accepts local-file requests and then narrates work it cannot do.
 */
const ENVIRONMENT_PREAMBLE = [
  "You are answering inside a developer's terminal coding agent (Prime Agent).",
  "You are NOT running on the user's machine. You cannot read, write, or execute anything in their repository,",
  "and any file path they mention does not exist in your sandbox.",
  "Answer from the conversation text alone. When you need file contents you do not have, say so and ask for them.",
  "Skip progress narration; reply with the answer itself.",
].join(" ");

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "thinking":
          return "";
        case "toolCall":
          return `[requested tool ${block.name} with ${JSON.stringify(block.arguments)}]`;
        case "image":
          return "[image omitted: Manus tasks take text only through this provider]";
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function renderMessage(message: Message): string {
  switch (message.role) {
    case "user":
      return `User: ${textOf(message.content)}`;
    case "assistant": {
      const text = textOf(message.content);
      return text ? `Assistant: ${text}` : "";
    }
    case "toolResult": {
      const label = message.isError ? "Tool error" : "Tool result";
      return `${label} (${message.toolName}): ${textOf(message.content)}`;
    }
    default:
      return "";
  }
}

export interface PromptSlice {
  /** Text to send to Manus for this turn. */
  text: string;
  /** How many of `context.messages` are now covered, to pass back as `alreadySent` next turn. */
  covered: number;
}

export interface PromptOptions {
  /**
   * Forward the host's system prompt. Off by default: Prime Agent's system prompt describes
   * its own tool environment, and Manus reads that as an attachment it should open.
   */
  includeSystemPrompt?: boolean;
}

/**
 * Builds the text for one turn.
 *
 * @param alreadySent number of leading messages a live Manus task has already been told about;
 *                    0 starts a fresh task and includes the preamble.
 */
export function buildPromptSlice(context: Context, alreadySent = 0, options: PromptOptions = {}): PromptSlice {
  const messages = context.messages ?? [];
  const isFirstTurn = alreadySent === 0;
  // A live task already holds its own replies; echoing them back would double the transcript.
  const pending = isFirstTurn
    ? messages
    : messages.slice(alreadySent).filter((message) => message.role !== "assistant");

  const sections: string[] = [];
  if (isFirstTurn) {
    sections.push(ENVIRONMENT_PREAMBLE);
    if (options.includeSystemPrompt && context.systemPrompt) {
      sections.push(`System instructions from the caller:\n${context.systemPrompt}`);
    }
  }

  const transcript = pending.map(renderMessage).filter(Boolean).join("\n\n");
  if (transcript) sections.push(transcript);

  return { text: sections.join("\n\n---\n\n"), covered: messages.length };
}

/**
 * Identifies a conversation so follow-up turns reuse the same Manus task.
 * The first user message is stable for the life of a conversation.
 */
export function conversationKey(context: Context): string {
  const first = (context.messages ?? []).find((message) => message.role === "user");
  return first ? textOf(first.content).slice(0, 500) : "";
}

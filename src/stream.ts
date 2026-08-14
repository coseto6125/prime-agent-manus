/**
 * `streamSimple` implementation that presents an asynchronous Manus task as a
 * Prime Agent assistant stream.
 *
 * Manus has no streaming endpoint, so this polls `task.listMessages` and forwards each
 * new assistant message as a text delta. That turns Manus's own progress narration into
 * something the TUI renders while the task is still running.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import { buildPromptSlice, conversationKey } from "./context-to-prompt.ts";
import { latestAgentStatus, ManusApiError, ManusClient, type ManusMessage } from "./manus-client.ts";

export interface ManusStreamSettings {
  /** Fallback key. Prime Agent resolves the provider's configured `apiKey` and passes it per call. */
  apiKey?: string;
  baseUrl?: string;
  /** Poll interval floor and ceiling, in milliseconds. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Give up on a task that never leaves `running`. */
  taskTimeoutMs?: number;
  /** Manus project to file tasks under, so they do not clutter the personal task list. */
  projectId?: string;
  /** Forward the host's system prompt to Manus. See PromptOptions for why this is off by default. */
  includeSystemPrompt?: boolean;
  /** How long a new task may stay unreadable before it is reported as never created. */
  ghostTaskGraceMs?: number;
  /** How long network errors and 5xx are ridden out before the turn fails. */
  transientGraceMs?: number;
}

interface TaskSession {
  taskId: string;
  /** How many Prime Agent messages this task has already been told about. */
  covered: number;
}

/** Conversation key to live Manus task. Lets a multi-turn chat stay inside one task. */
const sessions = new Map<string, TaskSession>();

/**
 * Cap on remembered conversations. Prime Agent can run as a long-lived daemon, where an
 * unbounded map would keep every conversation it ever saw. Map preserves insertion order,
 * so re-inserting on each use makes the first key the least recently used one.
 */
const MAX_SESSIONS = 100;

function rememberSession(key: string, session: TaskSession): void {
  sessions.delete(key);
  sessions.set(key, session);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/** Exposed for tests; a fresh process starts empty anyway. */
export function resetSessions(): void {
  sessions.clear();
}

/** Exposed for tests that need to observe eviction. */
export function sessionCount(): number {
  return sessions.size;
}

const DEFAULTS = {
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 6_000,
  taskTimeoutMs: 30 * 60_000,
};

/** Default window a freshly created task may stay unreadable before it counts as never created. */
const GHOST_TASK_GRACE_MS = 15_000;

/** Default window of network errors and 5xx to ride out before failing the turn. */
const TRANSIENT_GRACE_MS = 60_000;

/**
 * `task.create` can answer with a task id for a task it never creates. Observed for every
 * `agent_profile` except `manus-1.6-lite`, including the `manus-1.6` default: the id comes back
 * with ok:true and then stays unknown to `task.detail` and `task.listMessages` indefinitely.
 * Whether that is specific to some account tiers is unknown, so the message reports the symptom.
 */
function ghostTaskError(taskId: string, profile: string): ManusApiError {
  const hint =
    profile === "manus-1.6-lite"
      ? "Check the task at manus.im and the account's credit balance."
      : `Manus does this for every profile except manus-1.6-lite, "${profile}" included. Switch to manus-1.6-lite.`;
  return new ManusApiError(`Manus accepted task ${taskId} but never created it. ${hint}`, 404, "not_found");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Renders one assistant message, including any files Manus built.
 *
 * Attachments arrive as signed CDN links that expire, and the text usually just says
 * "see the attachment", so dropping them loses the actual deliverable.
 */
function renderAssistant(message: ManusMessage): string {
  const body = message.assistant_message;
  // Markdown links, because the TUI renders them (it themes mdLink/mdLinkUrl) and a raw
  // signed CDN URL runs to several hundred characters that would swamp the reply.
  const links = (body?.attachments ?? [])
    .filter((attachment) => attachment.url)
    .map((attachment) => `[${attachment.filename ?? "attachment"}](${attachment.url})`);
  return [body?.content ?? "", links.join("\n")].filter(Boolean).join("\n\n");
}

/** Assistant messages newer than `afterTimestamp`, oldest first. */
export function newAssistantText(messages: ManusMessage[], afterTimestamp: number): { text: string; timestamp: number }[] {
  return messages
    .filter((message) => message.type === "assistant_message" && Number(message.timestamp) > afterTimestamp)
    .map((message) => ({ text: renderAssistant(message), timestamp: Number(message.timestamp) }))
    .filter((entry) => entry.text.length > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function createManusStream(settings: ManusStreamSettings = {}) {
  const pollIntervalMs = settings.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const maxPollIntervalMs = settings.maxPollIntervalMs ?? DEFAULTS.maxPollIntervalMs;
  const taskTimeoutMs = settings.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs;
  const ghostTaskGraceMs = settings.ghostTaskGraceMs ?? GHOST_TASK_GRACE_MS;
  const transientGraceMs = settings.transientGraceMs ?? TRANSIENT_GRACE_MS;

  return function streamManus(
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;
    const apiKey = options?.apiKey ?? settings.apiKey ?? process.env.MANUS_API_KEY;
    const client = new ManusClient(apiKey ?? "", settings.baseUrl);

    void (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };

      let activeTaskId: string | undefined;

      try {
        stream.push({ type: "start", partial: output });

        if (!apiKey) {
          throw new ManusApiError(
            "No Manus API key. Set MANUS_API_KEY, or set apiKey for the manus provider in ~/.prime/agent/models.json.",
            401,
          );
        }

        // A Manus task's agent_profile is fixed when it is created, so switching model must start
        // a new task. Without the model in the key, the switch silently keeps talking to the old one.
        const key = `${model.id}::${options?.sessionId ?? conversationKey(context)}`;
        const existing = sessions.get(key);
        const slice = buildPromptSlice(context, existing?.covered ?? 0, {
          includeSystemPrompt: settings.includeSystemPrompt,
        });

        // A follow-up with nothing new to say would leave the task idle forever.
        if (existing && !slice.text) {
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
          return;
        }

        const sentAt = Date.now();
        if (existing) {
          activeTaskId = existing.taskId;
          try {
            await client.sendMessage(existing.taskId, slice.text, signal);
          } catch (error) {
            // The task went away (deleted, or it never really existed). Forget it so the next
            // attempt starts a fresh one instead of retrying against the same dead id.
            if (error instanceof ManusApiError && error.code === "not_found") {
              sessions.delete(key);
              throw new ManusApiError(
                `The Manus task for this conversation (${existing.taskId}) no longer exists. Send the message again to start a new one.`,
                404,
                "not_found",
              );
            }
            throw error;
          }
        } else {
          const created = await client.createTask({
            content: slice.text,
            agentProfile: model.id,
            title: "Prime Agent",
            projectId: settings.projectId,
            hideInTaskList: true,
            signal,
          });
          activeTaskId = created.task_id;
        }
        // Deliberately not cached yet: a task that never becomes readable must not be remembered,
        // or the next turn sends follow-ups to an id that does not exist.
        let sessionCached = false;

        let contentIndex = -1;
        let lastSeenTimestamp = sentAt - 1;
        let interval = pollIntervalMs;
        let unreadableSinceMs = 0;
        let failingSinceMs = 0;
        const deadline = Date.now() + taskTimeoutMs;

        while (true) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          if (Date.now() > deadline) {
            throw new ManusApiError(`Manus task ${activeTaskId} still running after ${taskTimeoutMs}ms`, 504);
          }

          await sleep(interval, signal);
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

          let messages: ManusMessage[];
          try {
            messages = await client.listMessages(activeTaskId, signal);
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;

            // A brand new task can lag by a poll or two; one that never appears was never created.
            if (error instanceof ManusApiError && error.code === "not_found") {
              unreadableSinceMs ||= Date.now();
              if (Date.now() - unreadableSinceMs >= ghostTaskGraceMs) throw ghostTaskError(activeTaskId, model.id);
              continue;
            }

            // A task can run for minutes. Dropping the answer over one blip wastes the whole run,
            // so ride out network errors and 5xx, while 4xx (bad key, bad request) fails now.
            const transient = !(error instanceof ManusApiError) || error.status >= 500;
            if (!transient) throw error;
            failingSinceMs ||= Date.now();
            if (Date.now() - failingSinceMs >= transientGraceMs) throw error;
            continue;
          }
          unreadableSinceMs = 0;
          failingSinceMs = 0;
          if (!sessionCached) {
            rememberSession(key, { taskId: activeTaskId, covered: slice.covered });
            sessionCached = true;
          }
          const fresh = newAssistantText(messages, lastSeenTimestamp);

          for (const entry of fresh) {
            if (contentIndex === -1) {
              output.content.push({ type: "text", text: "" });
              contentIndex = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex, partial: output });
            }
            const block = output.content[contentIndex];
            const delta = block.type === "text" && block.text ? `\n\n${entry.text}` : entry.text;
            if (block.type === "text") block.text += delta;
            stream.push({ type: "text_delta", contentIndex, delta, partial: output });
            lastSeenTimestamp = Math.max(lastSeenTimestamp, entry.timestamp);
          }

          // Manus stays responsive right after a burst, so back off only while it is quiet.
          interval = fresh.length > 0 ? pollIntervalMs : Math.min(interval + 1_000, maxPollIntervalMs);

          const status = latestAgentStatus(messages);
          if (status && status !== "running" && status !== "pending") {
            if (status === "error") {
              output.stopReason = "error";
              output.errorMessage = "Manus reported an error status for this task";
            }
            break;
          }
        }

        if (contentIndex >= 0) {
          const block = output.content[contentIndex];
          stream.push({
            type: "text_end",
            contentIndex,
            content: block.type === "text" ? block.text : "",
            partial: output,
          });
        }

        if (output.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
      } catch (error) {
        const aborted = signal?.aborted || (error instanceof Error && error.name === "AbortError");
        // Leaving a Manus task running after the user hit escape keeps burning credits.
        if (aborted && activeTaskId) await client.stopTask(activeTaskId);
        output.stopReason = aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}

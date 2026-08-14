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
}

interface TaskSession {
  taskId: string;
  /** How many Prime Agent messages this task has already been told about. */
  covered: number;
}

/** Conversation key to live Manus task. Lets a multi-turn chat stay inside one task. */
const sessions = new Map<string, TaskSession>();

/** Exposed for tests; a fresh process starts empty anyway. */
export function resetSessions(): void {
  sessions.clear();
}

const DEFAULTS = {
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 6_000,
  taskTimeoutMs: 30 * 60_000,
};

/** Default window a freshly created task may stay unreadable before it counts as never created. */
const GHOST_TASK_GRACE_MS = 15_000;

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

/** Assistant messages newer than `afterTimestamp`, oldest first. */
export function newAssistantText(messages: ManusMessage[], afterTimestamp: number): { text: string; timestamp: number }[] {
  return messages
    .filter((message) => message.type === "assistant_message" && Number(message.timestamp) > afterTimestamp)
    .map((message) => ({ text: message.assistant_message?.content ?? "", timestamp: Number(message.timestamp) }))
    .filter((entry) => entry.text.length > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function createManusStream(settings: ManusStreamSettings = {}) {
  const pollIntervalMs = settings.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const maxPollIntervalMs = settings.maxPollIntervalMs ?? DEFAULTS.maxPollIntervalMs;
  const taskTimeoutMs = settings.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs;
  const ghostTaskGraceMs = settings.ghostTaskGraceMs ?? GHOST_TASK_GRACE_MS;

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
          await client.sendMessage(existing.taskId, slice.text, signal);
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
        sessions.set(key, { taskId: activeTaskId, covered: slice.covered });

        let contentIndex = -1;
        let lastSeenTimestamp = sentAt - 1;
        let interval = pollIntervalMs;
        let unreadableSinceMs = 0;
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
            // A brand new task can lag by a poll or two; one that never appears was never created.
            if (error instanceof ManusApiError && error.code === "not_found") {
              unreadableSinceMs ||= Date.now();
              if (Date.now() - unreadableSinceMs >= ghostTaskGraceMs) throw ghostTaskError(activeTaskId, model.id);
              continue;
            }
            throw error;
          }
          unreadableSinceMs = 0;
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

import { join } from "node:path";
import {
  getAgentDir,
  estimateTokens,
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Client,
  digest,
  loadConfig,
  mutates,
  recallOwners,
  type Config,
  type Reply,
} from "./client.ts";
import { SPECS, GUIDE, parametersFor, prepareArguments } from "./tools.ts";
import {
  GUIDE_TYPE,
  fitRecall,
  applyRecall,
  beforeRecall,
  cleanMessages,
  emptyState,
  plainText,
  projectRecall,
  recallRequest,
  restoreState,
  scopeOf,
  anchorOf,
  type Message,
  type RecallState,
} from "./recall.ts";

const STATE = "pi-songya:recall-state";
const PREFERENCES = "pi-songya:preferences";
interface Preferences {
  user?: string;
  recallEnabled?: boolean;
}
interface Cache {
  scope: string;
  session: string;
  config: Config;
  state: RecallState;
  instructions: string;
  kinds?: Record<string, { id: string; description?: string }[]>;
}
export interface Dependencies {
  agentDir?: string;
  client?: Client;
}
export function preferences(ctx: ExtensionContext): Preferences {
  let result: Preferences = {};
  for (const entry of ctx.sessionManager.getBranch())
    if (entry.type === "custom" && entry.customType === PREFERENCES) {
      const value = entry.data as Preferences & { reset?: boolean };
      if (value?.reset) result = {};
      else if (value && typeof value === "object")
        result = {
          ...result,
          ...(typeof value.user === "string" ? { user: value.user } : {}),
          ...(typeof value.recallEnabled === "boolean"
            ? { recallEnabled: value.recallEnabled }
            : {}),
        };
    }
  return result;
}
export function toolResult(reply: Reply) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          reply.error
            ? { ...reply.data, error: reply.error }
            : (reply.data ?? {}),
        ),
      },
      ...(reply.images ?? []).map((image) => ({
        type: "image" as const,
        ...image,
      })),
    ],
    details: reply,
    structuredContent: reply.error
      ? { ...reply.data, error: reply.error }
      : (reply.data ?? {}),
    isError: !!reply.error,
  };
}
export function createExtension(deps: Dependencies = {}) {
  return function songya(pi: ExtensionAPI) {
    const agentDir = deps.agentDir ?? getAgentDir();
    const client = deps.client ?? new Client(agentDir);
    async function configuration(ctx: ExtensionContext) {
      const config = await loadConfig(agentDir, ctx.cwd, pi.getSettings());
      return config;
    }
    let cache: Cache | undefined;
    let lastMessages: Message[] = [];
    let warming:
      | { key: string; promise: Promise<Reply>; controller: AbortController }
      | undefined;
    let recovering: Promise<string[]> | undefined;
    let recoveryScope = "";
    const warn = (ctx: ExtensionContext, error: unknown) =>
      ctx.ui.setStatus(
        "songya",
        `Songya: ${(error as Error).message ?? String(error)}`,
      );
    const stopWarm = () => {
      warming?.controller.abort();
      warming = undefined;
    };
    async function current(ctx: ExtensionContext): Promise<Cache> {
      const global = await configuration(ctx);
      const pref = preferences(ctx);
      const config = { ...global, ...pref };
      const scope = scopeOf(config, ctx.sessionManager.getSessionId());
      const session = ctx.sessionManager.getSessionId();
      if (cache?.scope !== scope || cache.session !== session) {
        stopWarm();
        lastMessages = [];
        let state = emptyState(scope);
        for (const entry of ctx.sessionManager.getBranch())
          if (
            entry.type === "custom" &&
            entry.customType === STATE &&
            (entry.data as RecallState)?.scope === scope
          )
            state = restoreState(entry.data, scope);
        cache = { scope, session, config, state, instructions: "" };
      } else {
        cache.config = config;
        let state = emptyState(scope);
        for (const entry of ctx.sessionManager.getBranch())
          if (
            entry.type === "custom" &&
            entry.customType === STATE &&
            (entry.data as RecallState)?.scope === scope
          )
            state = restoreState(entry.data, scope);
        cache.state = state;
      }
      return cache;
    }
    function persist(
      ctx: ExtensionContext,
      binding: Cache,
      state: RecallState,
      session: string,
    ) {
      if (ctx.sessionManager.getSessionId() !== session || cache !== binding)
        return false;
      if (digest(binding.state) !== digest(state)) {
        pi.appendEntry(STATE, state);
        binding.state = state;
      }
      return true;
    }
    async function recover(ctx: ExtensionContext, binding: Cache) {
      const scope = digest([binding.config.store, binding.config.user]);
      if (!recovering || recoveryScope !== scope) {
        recoveryScope = scope;
        recovering = client.recover(binding.config);
      }
      const errors = await recovering;
      if (errors.length) recovering = undefined;
      if (errors.length)
        warn(
          ctx,
          new Error(
            `${errors.length} retained write(s) need attention; /songya recover retries them.`,
          ),
        );
    }
    function registerTools(binding?: Cache) {
      for (const tool of SPECS)
        pi.registerTool({
          name: tool.name,
          label: tool.name.replaceAll("_", " "),
          description: tool.description,
          parameters: parametersFor(tool, binding?.kinds),
          prepareArguments,
          ...(tool.name === "type_configuration"
            ? {
                promptSnippet:
                  "Search, read and maintain lasting memories in Songya",
                promptGuidelines: [GUIDE],
              }
            : {}),
          executionMode: mutates(tool.name, { action: "apply" })
            ? "sequential"
            : "parallel",
          async execute(callId, args, signal, _onUpdate, ctx) {
            const selected = await current(ctx);
            const key =
              "pi_" +
              digest([
                ctx.sessionManager.getSessionId(),
                callId,
                selected.config.store,
                selected.config.user,
              ]);
            const reply = await client.call(
              selected.config,
              tool.name,
              args as Record<string, unknown>,
              key,
              signal,
            );
            if (mutates(tool.name, args as Record<string, unknown>)) stopWarm();
            return toolResult(reply);
          },
        });
    }
    registerTools();
    pi.on("session_start", async (_event, ctx) => {
      stopWarm();
      cache = undefined;
      recovering = undefined;
      try {
        const selected = await current(ctx);
        await recover(ctx, selected);
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.on("session_shutdown", async () => {
      stopWarm();
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      try {
        const selected = await current(ctx);
        await recover(ctx, selected);
        const reply = await client.call(
          selected.config,
          "type_configuration",
          {},
          undefined,
          ctx.signal,
        );
        if (cache !== selected) return;
        if (reply.error) {
          selected.kinds = undefined;
          selected.instructions =
            "Type settings could not be read. Omit type, preserve existing classifications, and report the issue: " +
            reply.error;
        } else {
          selected.kinds = reply.data?.kinds;
          selected.instructions = reply.data?.instructions ?? "";
        }
        registerTools(selected);
        ctx.ui.setStatus(
          "songya",
          `Songya · ${selected.config.user}${selected.config.recallEnabled ? "" : " · recall off"}`,
        );
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.on("context", async (event, ctx) => {
      const messages = cleanMessages(event.messages as unknown as Message[]);
      const session = ctx.sessionManager.getSessionId();
      try {
        const selected = await current(ctx);
        let state = selected.state;
        // Projected entries reflect Pi edits/tree navigation; old compaction sources
        // still exist in the branch even when absent from the active model window.
        const sources = ctx.sessionManager
          .buildContextEntries()
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message as unknown as Message);
        if (selected.config.recallEnabled) {
          state = beforeRecall(state, messages, sources);
          if (!persist(ctx, selected, state, session)) return;
          const request = recallRequest(selected.config, messages, state);
          if (request.eligible.length) {
            const key = digest([selected.scope, request.args]);
            let reply: Reply;
            const leaf = ctx.sessionManager.getLeafId();
            try {
              const pending = warming?.key === key ? warming : undefined;
              if (pending) {
                reply = await pending.promise;
                if (warming === pending) warming = undefined;
              } else {
                stopWarm();
                reply = await client.call(
                  selected.config,
                  "automatic_recall",
                  request.args,
                  undefined,
                  ctx.signal,
                );
              }
            } catch (error) {
              if (ctx.signal?.aborted) return;
              reply = { error: (error as Error).message };
            }
            if (ctx.sessionManager.getLeafId() !== leaf)
              return { messages: messages as unknown as typeof event.messages };
            state = applyRecall(state, messages, request.eligible, reply);
            if (!persist(ctx, selected, state, session)) return;
          }
        }
        if (ctx.sessionManager.getSessionId() !== session || cache !== selected)
          return;
        lastMessages = messages;
        const guide: Message = {
          role: "custom",
          customType: GUIDE_TYPE,
          display: false,
          timestamp: 0,
          content: `Songya user: ${selected.config.user}. Agent owner (agentUser): ${selected.config.agentUser ?? "agent"}.\n${GUIDE}\n${selected.instructions}`,
        };
        let projected = messages;
        if (selected.config.recallEnabled) {
          const window =
            ctx.model?.contextWindow ?? ctx.getContextUsage?.()?.contextWindow;
          let visible = state;
          if (window) {
            const cost = (message: Message) =>
              estimateTokens(message as Parameters<typeof estimateTokens>[0]);
            const active = new Set(pi.getActiveTools());
            const tools = pi
              .getAllTools()
              .filter((tool) => active.has(tool.name));
            const prompt = {
              role: "system",
              content: ctx.getSystemPrompt(),
              toolsAdded: tools,
            } as unknown as Message;
            const base = messages.reduce(
              (sum, message) => sum + cost(message),
              cost(prompt) + cost(guide),
            );
            const reserve =
              pi.getSettings().compaction?.reserveTokens ??
              DEFAULT_COMPACTION_SETTINGS.reserveTokens;
            visible = fitRecall(state, window - reserve - base, cost).state;
          }
          projected = projectRecall(messages, visible);
        }
        return {
          messages: [guide, ...projected] as unknown as typeof event.messages,
        };
      } catch (error) {
        warn(ctx, error);
        return { messages: messages as unknown as typeof event.messages };
      }
    });
    pi.on("agent_end", async (event, ctx) => {
      try {
        const selected = await current(ctx);
        if (!selected.config.recallEnabled || ctx.signal?.aborted) return;
        const byId = new Map(
          lastMessages.map((message) => [anchorOf(message), message]),
        );
        for (const message of cleanMessages(
          event.messages as unknown as Message[],
        ))
          byId.set(anchorOf(message), message);
        const messages = [...byId.values()];
        const state = beforeRecall(selected.state, messages, messages);
        const request = recallRequest(selected.config, messages, state);
        if (!request.eligible.length) return;
        stopWarm();
        const controller = new AbortController();
        const key = digest([selected.scope, request.args]);
        const promise = client
          .call(
            selected.config,
            "automatic_recall",
            request.args,
            undefined,
            controller.signal,
          )
          .catch((error) => ({ error: (error as Error).message }));
        warming = { key, promise, controller };
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.registerCommand("songya", {
      description:
        "Songya status, on/off, user <id>, reset, recover, preview <text>, or admin",
      handler: async (input, ctx) => {
        try {
          let selected = await current(ctx);
          const [command, ...rest] = input.trim().split(/\s+/);
          if (
            command === "on" ||
            command === "off" ||
            command === "reset" ||
            command === "user"
          ) {
            if (command === "user" && (!rest[0] || rest[0] === "all"))
              throw new Error("Use /songya user <one-user-id>.");
            pi.appendEntry(
              PREFERENCES,
              command === "reset"
                ? { reset: true }
                : command === "user"
                  ? { user: rest[0] }
                  : { recallEnabled: command === "on" },
            );
            stopWarm();
            selected = await current(ctx);
          } else if (command === "recover") {
            recovering = undefined;
            await recover(ctx, selected);
            const reply = await client.call(
              selected.config,
              "memory_maintenance",
              { action: "recover" },
            );
            if (reply.error) throw new Error(reply.error);
          } else if (command === "preview") {
            const text = rest.join(" ");
            if (!text) throw new Error("Use /songya preview <message text>.");
            const reply = await client.call(
              selected.config,
              "automatic_recall",
              {
                messages: [text],
                owners: recallOwners(selected.config),
              },
            );
            if (reply.error) throw new Error(reply.error);
            ctx.ui.notify(JSON.stringify(reply.data, null, 2), "info");
            return;
          } else if (command === "admin") {
            ctx.ui.notify(selected.config.adminUrl, "info");
            return;
          } else if (command && command !== "status")
            throw new Error(
              "Use /songya [status|on|off|user <id>|reset|recover|preview <text>|admin].",
            );
          ctx.ui.notify(
            `Songya user: ${selected.config.user}\nStore: ${selected.config.store}\nAutomatic recall: ${selected.config.recallEnabled ? "on" : "off"}\nConfiguration: ${join(ctx.cwd, ".pi", "settings.json")}\nAdministration: ${selected.config.adminUrl}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
      },
    });
  };
}
export default createExtension();

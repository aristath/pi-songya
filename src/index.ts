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
  recallEnabled?: boolean;
}
interface Cache {
  scope: string;
  session: string;
  config: Config;
  state: RecallState;
  instructions: string;
}
export interface Dependencies {
  agentDir?: string;
  client?: Client;
}
export function preferences(ctx: ExtensionContext): Preferences {
  let result: Preferences = {};
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== PREFERENCES) continue;
    const value = entry.data as Preferences & { reset?: boolean };
    if (value?.reset) result = {};
    else if (typeof value?.recallEnabled === "boolean")
      result.recallEnabled = value.recallEnabled;
  }
  return result;
}
export function toolResult(reply: Reply) {
  const value = reply.error
    ? { ...reply.data, error: reply.error }
    : (reply.data ?? {});
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value) },
      ...(reply.images ?? []).map((image) => ({
        type: "image" as const,
        ...image,
      })),
    ],
    details: reply,
    structuredContent: value,
    isError: !!reply.error,
  };
}
export function createExtension(deps: Dependencies = {}) {
  return function songya(pi: ExtensionAPI) {
    const agentDir = deps.agentDir ?? getAgentDir(),
      client = deps.client ?? new Client(agentDir);
    const caches = new Map<string, Cache>(),
      recovered = new Set<string>();
    const warming = new Map<
      string,
      { key: string; promise: Promise<Reply>; controller: AbortController }
    >();
    let lastMessages: Message[] = [];
    const warn = (ctx: ExtensionContext, error: unknown) =>
      ctx.ui.setStatus(
        "songya",
        `Songya: ${(error as Error).message ?? String(error)}`,
      );
    const stopWarm = () => {
      for (const work of warming.values()) work.controller.abort();
      warming.clear();
    };
    async function current(ctx: ExtensionContext) {
      const configs = await loadConfig(agentDir, ctx.cwd, pi.getSettings()),
        pref = preferences(ctx);
      const session = ctx.sessionManager.getSessionId();
      const result: Cache[] = [];
      for (const configured of configs) {
        const config = {
          ...configured,
          recallEnabled:
            configured.recallEnabled && pref.recallEnabled !== false,
        };
        const scope = scopeOf(config, session);
        let binding = caches.get(config.user);
        if (
          !binding ||
          binding.scope !== scope ||
          binding.session !== session
        ) {
          warming.get(config.user)?.controller.abort();
          warming.delete(config.user);
          binding = {
            scope,
            session,
            config,
            state: emptyState(scope),
            instructions: "",
          };
          caches.set(config.user, binding);
        }
        binding.config = config;
        let state = emptyState(scope);
        for (const entry of ctx.sessionManager.getBranch())
          if (
            entry.type === "custom" &&
            entry.customType === STATE &&
            (entry.data as RecallState)?.scope === scope
          )
            state = restoreState(entry.data, scope);
        binding.state = state;
        result.push(binding);
      }
      for (const name of caches.keys())
        if (!configs.some((c) => c.user === name)) {
          warming.get(name)?.controller.abort();
          warming.delete(name);
          caches.delete(name);
        }
      return result;
    }
    function persist(
      ctx: ExtensionContext,
      binding: Cache,
      state: RecallState,
    ) {
      if (
        ctx.sessionManager.getSessionId() !== binding.session ||
        caches.get(binding.config.user) !== binding
      )
        return false;
      if (digest(binding.state) !== digest(state)) {
        pi.appendEntry(STATE, state);
        binding.state = state;
      }
      return true;
    }
    async function recover(ctx: ExtensionContext, binding: Cache) {
      const scope = digest([binding.config.store, binding.config.user]);
      if (recovered.has(scope)) return;
      const errors = await client.recover(binding.config);
      if (errors.length)
        warn(
          ctx,
          new Error(
            `${binding.config.user}: retained writes need attention; /songya recover retries them.`,
          ),
        );
      else recovered.add(scope);
    }
    function registerTools(names: string[] = []) {
      for (const tool of SPECS)
        pi.registerTool({
          name: tool.name,
          label: tool.name.replaceAll("_", " "),
          description: tool.description,
          parameters: parametersFor(tool, names),
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
            const input = args as Record<string, unknown>;
            const selected = (await current(ctx)).find(
              (binding) => binding.config.user === input.store,
            );
            if (!selected)
              return toolResult({
                error: "Choose a configured store by name.",
              });
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
              input,
              key,
              signal,
            );
            if (mutates(tool.name, input)) stopWarm();
            return toolResult({
              ...reply,
              data: { ...reply.data, store: selected.config.user },
            });
          },
        });
    }
    registerTools();
    pi.on("session_start", async (_event, ctx) => {
      stopWarm();
      caches.clear();
      recovered.clear();
      lastMessages = [];
      try {
        const selected = await current(ctx);
        registerTools(selected.map((b) => b.config.user));
        for (const binding of selected) await recover(ctx, binding);
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.on("session_shutdown", async () => stopWarm());
    pi.on("before_agent_start", async (_event, ctx) => {
      try {
        const selected = await current(ctx);
        for (const binding of selected) {
          await recover(ctx, binding);
          const reply = await client.call(
            binding.config,
            "type_configuration",
            {},
            undefined,
            ctx.signal,
          );
          binding.instructions = reply.error
            ? "Type settings unavailable; omit classifications and report: " +
              reply.error
            : (reply.data?.instructions ?? "");
        }
        registerTools(selected.map((b) => b.config.user));
        ctx.ui.setStatus(
          "songya",
          `Songya · ${selected.map((b) => b.config.user + (b.config.recallEnabled ? "" : " (recall off)")).join(", ")}`,
        );
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.on("context", async (event, ctx) => {
      const messages = cleanMessages(event.messages as unknown as Message[]);
      try {
        const selected = await current(ctx);
        const sources = ctx.sessionManager
          .buildContextEntries()
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message as unknown as Message);
        for (const binding of selected) {
          if (!binding.config.recallEnabled) continue;
          let state = beforeRecall(binding.state, messages, sources);
          if (!persist(ctx, binding, state)) return;
          const request = recallRequest(binding.config, messages, state);
          if (!request.eligible.length) continue;
          const key = digest([binding.scope, request.args]),
            pending = warming.get(binding.config.user);
          const leaf = ctx.sessionManager.getLeafId();
          let reply: Reply;
          try {
            if (pending?.key === key) {
              reply = await pending.promise;
              warming.delete(binding.config.user);
            } else {
              pending?.controller.abort();
              warming.delete(binding.config.user);
              reply = await client.call(
                binding.config,
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
          if (!persist(ctx, binding, state)) return;
        }
        lastMessages = messages;
        const guide: Message = {
          role: "custom",
          customType: GUIDE_TYPE,
          display: false,
          timestamp: 0,
          content: `Configured Songya stores: ${selected.map((b) => b.config.user).join(", ")}.\n${GUIDE}\n${selected.map((b) => `Store ${b.config.user}:\n${b.instructions}`).join("\n\n")}`,
        };
        const cost = (message: Message) =>
          estimateTokens(message as Parameters<typeof estimateTokens>[0]);
        const active = new Set(pi.getActiveTools());
        const prompt = {
          role: "system",
          content: ctx.getSystemPrompt(),
          toolsAdded: pi.getAllTools().filter((t) => active.has(t.name)),
        } as unknown as Message;
        const window =
          ctx.model?.contextWindow ?? ctx.getContextUsage?.()?.contextWindow;
        let budget = window
          ? window -
            (pi.getSettings().compaction?.reserveTokens ??
              DEFAULT_COMPACTION_SETTINGS.reserveTokens) -
            messages.reduce((n, m) => n + cost(m), cost(prompt) + cost(guide))
          : Infinity;
        let projected = messages;
        // Fit all stores against one shared budget, retaining each store's own IDs.
        for (const binding of selected)
          if (binding.config.recallEnabled) {
            const visible = fitRecall(
              binding.state,
              budget,
              cost,
              binding.config.user,
            ).state;
            const next = projectRecall(projected, visible, binding.config.user);
            budget -=
              next.reduce((n, m) => n + cost(m), 0) -
              projected.reduce((n, m) => n + cost(m), 0);
            projected = next;
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
        if (ctx.signal?.aborted) return;
        const byId = new Map(lastMessages.map((m) => [anchorOf(m), m]));
        for (const message of cleanMessages(
          event.messages as unknown as Message[],
        ))
          byId.set(anchorOf(message), message);
        const messages = [...byId.values()];
        stopWarm();
        for (const binding of await current(ctx)) {
          if (!binding.config.recallEnabled) continue;
          const state = beforeRecall(binding.state, messages, messages),
            request = recallRequest(binding.config, messages, state);
          if (!request.eligible.length) continue;
          const controller = new AbortController(),
            key = digest([binding.scope, request.args]);
          const promise = client
            .call(
              binding.config,
              "automatic_recall",
              request.args,
              undefined,
              controller.signal,
            )
            .catch((error) => ({ error: (error as Error).message }));
          warming.set(binding.config.user, { key, promise, controller });
        }
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.registerCommand("songya", {
      description:
        "Songya status, on/off, reset, recover, preview <text>, or admin",
      handler: async (input, ctx) => {
        try {
          let selected = await current(ctx);
          const [command, ...rest] = input.trim().split(/\s+/);
          if (["on", "off", "reset"].includes(command)) {
            pi.appendEntry(
              PREFERENCES,
              command === "reset"
                ? { reset: true }
                : { recallEnabled: command === "on" },
            );
            stopWarm();
            selected = await current(ctx);
          } else if (command === "recover") {
            recovered.clear();
            for (const binding of selected) {
              await recover(ctx, binding);
              const reply = await client.call(
                binding.config,
                "memory_maintenance",
                { action: "recover" },
              );
              if (reply.error) throw Error(reply.error);
            }
          } else if (command === "preview") {
            const text = rest.join(" ");
            if (!text) throw Error("Use /songya preview <message text>.");
            for (const binding of selected) {
              const reply = await client.call(
                binding.config,
                "automatic_recall",
                { messages: [text] },
              );
              if (reply.error) throw Error(reply.error);
              ctx.ui.notify(
                JSON.stringify(
                  { store: binding.config.user, ...reply.data },
                  null,
                  2,
                ),
                "info",
              );
            }
            return;
          } else if (command === "admin") {
            ctx.ui.notify(
              [...new Set(selected.map((b) => b.config.adminUrl))].join("\n"),
              "info",
            );
            return;
          } else if (command && command !== "status")
            throw Error(
              "Use /songya [status|on|off|reset|recover|preview <text>|admin].",
            );
          ctx.ui.notify(
            selected
              .map(
                (b) =>
                  `Store: ${b.config.user}\nDirectory: ${b.config.store}\nAutomatic recall: ${b.config.recallEnabled ? "on" : "off"}`,
              )
              .join("\n\n") +
              `\nConfiguration: ${join(ctx.cwd, ".pi/settings.json")}`,
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

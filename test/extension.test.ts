import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, digest, type Invoke, type Request } from "../src/client.ts";
import { createExtension, toolResult } from "../src/index.ts";
import { GUIDE_TYPE, RECALL_TYPE, type Message } from "../src/recall.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

async function fixture(invoke?: Invoke) {
  const dir = await mkdtemp(join(tmpdir(), "pi-songya-extension-"));
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({ songya: [{ store: join(dir, "store"), user: "user-1" }] }),
  );
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const calls: Request[] = [];
  const branch: any[] = [];
  const state = {
    session: "session-A",
    leaf: "leaf-A",
    branch,
    signal: undefined as AbortSignal | undefined,
  };
  const client = new Client(dir, async (request, signal) => {
    calls.push(request);
    if (invoke) return invoke(request, signal);
    if (request.operation === "type_configuration")
      return {
        data: {
          user: request.user,
          kinds: { memories: [{ id: "fact", description: "A fact" }] },
          instructions: "Selected-user classifications",
        },
      };
    if (request.operation === "automatic_recall")
      return {
        data: {
          results: (request.args.messages as string[]).map((text) => ({
            mode: "semantic",
            status: "ready",
            incomplete: false,
            items: [
              {
                id: "m_" + digest([request.user, text]).slice(0, 12),
                content: `Remembered for ${request.user}: ${text}`,
              },
            ],
          })),
          known: [],
        },
      };
    return { data: { status: "committed", id: "m_saved" } };
  });
  const pi = {
    getActiveTools: () => [...tools.keys()],
    getAllTools: () => [...tools.values()],
    getSettings: () =>
      JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")),
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => {
      state.branch.push({
        type: "custom",
        customType,
        data: structuredClone(data),
      });
      state.leaf = "entry-" + state.branch.length;
    },
  };
  const ctx = {
    cwd: dir,
    getSystemPrompt: () => "",
    mode: "tui",
    hasUI: true,
    get signal() {
      return state.signal;
    },
    ui: {
      setStatus: () => {},
      notify: (message: string) => notifications.push(message),
    },
    sessionManager: {
      getSessionId: () => state.session,
      getBranch: () => state.branch,
      getLeafId: () => state.leaf,
      buildContextEntries: () => state.branch,
    },
  } as unknown as ExtensionContext;
  createExtension({ agentDir: dir, client })(pi as unknown as ExtensionAPI);
  const add = (message: Message) => {
    state.branch.push({ type: "message", message });
    state.leaf = "message-" + state.branch.length;
  };
  const event = (name: string, value: any = {}) =>
    handlers.get(name)(value, ctx);
  return {
    pi,
    tools,
    handlers,
    commands,
    ctx,
    state,
    calls,
    notifications,
    dir,
    add,
    event,
  };
}
const question = (text: string, timestamp = 1): Message => ({
  role: "user",
  content: text,
  timestamp,
});
const recalled = (messages: Message[]) =>
  messages
    .filter((m) => m.customType === RECALL_TYPE)
    .map((m) => String(m.content))
    .join("\n");

test("Pi receives direct tools and native typed/image/error results", async () => {
  const f = await fixture();
  assert.equal(f.tools.size, 22);
  assert.ok(f.tools.has("save_memory"));
  assert.equal(f.tools.has("mcp__songya__save_memory"), false);
  await f.event("session_start");
  await f.event("before_agent_start");
  const result = await f.tools
    .get("save_memory")
    .execute(
      "call-1",
      { store: "user-1", title: "Fact", text: "Exact words" },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, "committed");
  const write = f.calls.find((call) => call.operation === "save_memory");
  assert.equal(write?.args.user, undefined);
  assert.ok(write?.key?.startsWith("pi_"));
  const failure = toolResult({
    error: "still pending",
    data: { status: "pending", operation_id: "stable" },
  });
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.operation_id, "stable");
  assert.equal(
    toolResult({
      data: {},
      images: [{ data: "pixels", mimeType: "image/png" }],
    }).content[1].type,
    "image",
  );
});
test("recall is hidden context, never a conversation utterance, and off leaves tools available", async () => {
  const f = await fixture();
  const message = question("Tell me about the garden");
  f.add(message);
  await f.event("session_start");
  await f.event("before_agent_start");
  const output = await f.event("context", { messages: [message] });
  assert.match(recalled(output.messages), /garden/);
  assert.equal(
    f.state.branch.filter((entry) => entry.type === "message").length,
    1,
  );
  assert.ok(
    f.state.branch.some(
      (entry) => entry.customType === "pi-songya:recall-state",
    ),
  );
  await f.commands.get("songya").handler("off", f.ctx);
  const before = f.calls.filter(
    (c) => c.operation === "automatic_recall",
  ).length;
  const disabled = await f.event("context", { messages: output.messages });
  assert.equal(recalled(disabled.messages), "");
  assert.equal(
    f.calls.filter((c) => c.operation === "automatic_recall").length,
    before,
  );
  assert.ok(f.tools.has("search_memory"));
});

test("tree navigation restores its own branch state rather than the last visited branch", async () => {
  const f = await fixture();
  const first = question("first branch", 1);
  f.add(first);
  const a = await f.event("context", { messages: [first] });
  assert.match(recalled(a.messages), /first branch/);
  const original = structuredClone(f.state.branch);
  const other = question("other branch", 5);
  f.state.branch = [{ type: "message", message: other }];
  f.state.leaf = "other-leaf";
  const b = await f.event("context", { messages: [other] });
  assert.match(recalled(b.messages), /other branch/);
  assert.doesNotMatch(recalled(b.messages), /first branch/);
  f.state.branch = original;
  f.state.leaf = "restored-leaf";
  const restored = await f.event("context", { messages: [first] });
  assert.match(recalled(restored.messages), /first branch/);
  assert.doesNotMatch(recalled(restored.messages), /other branch/);
});

test("late recall cannot write into a switched session", async () => {
  let finish!: (value: any) => void;
  let requested!: (value?: unknown) => void;
  const ready = new Promise((resolve) => {
    requested = resolve;
  });
  const f = await fixture(async (request) => {
    if (request.operation === "automatic_recall") {
      requested();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { data: {} };
  });
  const old = question("private old session");
  f.add(old);
  const pending = f.event("context", { messages: [old] });
  await ready;
  f.state.session = "session-B";
  f.state.branch = [{ type: "message", message: question("new session", 5) }];
  f.state.leaf = "new-session-leaf";
  finish({
    data: {
      results: [
        {
          mode: "semantic",
          status: "ready",
          incomplete: false,
          items: [{ id: "m_old", content: "old private evidence" }],
        },
      ],
      known: [],
    },
  });
  const result = await pending;
  assert.equal(
    f.state.branch.some(
      (entry) => entry.customType === "pi-songya:recall-state",
    ),
    false,
  );
  if (result)
    assert.doesNotMatch(recalled(result.messages), /old private evidence/);
});
test("an outage keeps previously emitted context available", async () => {
  let offline = false;
  const f = await fixture(async (request) => {
    if (request.operation === "automatic_recall")
      return offline
        ? { error: "offline" }
        : {
            data: {
              results: [
                {
                  mode: "semantic",
                  status: "ready",
                  incomplete: false,
                  items: [{ id: "m_kept", content: "keep this fact" }],
                },
              ],
              known: [],
            },
          };
    return { data: {} };
  });
  const message = question("subject");
  f.add(message);
  await f.event("context", { messages: [message] });
  offline = true;
  const result = await f.event("context", { messages: [message] });
  assert.match(recalled(result.messages), /keep this fact/);
  assert.match(recalled(result.messages), /retained/);
});
test("Pi SDK loads the standalone extension without a session or provider request", async () => {
  const { DefaultResourceLoader, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const agent = await mkdtemp(join(tmpdir(), "pi-songya-loader-"));
  const loader = new DefaultResourceLoader({
    cwd: agent,
    agentDir: agent,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    additionalExtensionPaths: [join(import.meta.dirname, "..")],
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings ?? [], []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0].tools.size, 22);
  assert.ok([...result.extensions[0].tools.values()].every((tool) => tool.definition.exposure === "hidden"));
});

test("completed assistant text is prefetched and reused on the following request", async () => {
  const f = await fixture();
  const message = question("garden");
  f.add(message);
  await f.event("context", { messages: [message] });
  const answer: Message = {
    role: "assistant",
    timestamp: 2,
    content: [{ type: "text", text: "We planted a tree." }],
  };
  f.add(answer);
  await f.event("agent_end", { messages: [message, answer] });
  const prefetched = f.calls.filter(
    (call) => call.operation === "automatic_recall",
  ).length;
  const output = await f.event("context", { messages: [message, answer] });
  assert.equal(
    f.calls.filter((call) => call.operation === "automatic_recall").length,
    prefetched,
  );
  assert.match(recalled(output.messages), /planted a tree/);
  await f.event("session_shutdown");
});

test("configured stores keep identical record IDs distinct and route explicit tool choices", async () => {
  const f = await fixture(async (request) =>
    request.operation === "automatic_recall"
      ? {
          data: {
            results: (request.args.messages as string[]).map(() => ({
              mode: "semantic",
              status: "ready",
              incomplete: false,
              items: [{ id: "m_same", content: `Memory in ${request.user}` }],
            })),
            known: [],
          },
        }
      : { data: { status: "committed", id: "m_same" } },
  );
  await writeFile(
    join(f.dir, "settings.json"),
    JSON.stringify({
      songya: [
        { store: join(f.dir, "first"), user: "first" },
        { store: join(f.dir, "second"), user: "second" },
      ],
    }),
  );
  const message = question("Remember both stores");
  f.add(message);
  await f.event("session_start");
  const projected = await f.event("context", { messages: [message] });
  assert.match(recalled(projected.messages), /"store":"first"/);
  assert.match(recalled(projected.messages), /"store":"second"/);
  assert.match(recalled(projected.messages), /Memory in first/);
  assert.match(recalled(projected.messages), /Memory in second/);
  const result = await f.tools
    .get("save_memory")
    .execute(
      "second-call",
      { store: "second", text: "A saved fact" },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(result.isError, false);
  const write = f.calls.findLast((call) => call.operation === "save_memory");
  assert.equal(write?.store, join(f.dir, "second"));
  assert.equal(write?.args.user, undefined);
  assert.equal(write?.args.store, undefined);
  const calls = f.calls.length;
  const denied = await f.tools
    .get("read_memory")
    .execute(
      "unknown-call",
      { store: "unknown", id: "m_same" },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(denied.isError, true);
  assert.equal(f.calls.length, calls);
});

test("recall-only stores reject tools, omit tool guidance, and allow task settings to enable tools", async () => {
  const f = await fixture();
  const path = join(f.dir, "settings.json");
  await writeFile(path, JSON.stringify({ songya: [
    { store: join(f.dir, "person"), user: "person" },
    { store: join(f.dir, "agent"), user: "agent", exposeTools: false },
  ] }));
  const saved = readFileSync(path, "utf8");
  const message = question("Remember the garden");
  f.add(message);
  await f.event("session_start");
  await f.event("before_agent_start");
  for (const tool of f.tools.values()) {
    assert.deepEqual(tool.parameters.properties.store.enum, ["person"]);
    assert.equal(tool.exposure, "direct");
  }
  assert.equal(f.calls.some((r) => r.user === "agent" && r.operation === "type_configuration"), false);
  for (const name of ["read_memory", "save_memory"]) {
    const before = f.calls.length;
    const denied = await f.tools.get(name).execute("hidden-" + name,
      { store: "agent", id: "m_example", text: "A fact" }, undefined, undefined, f.ctx);
    assert.equal(denied.isError, true);
    assert.equal(f.calls.length, before);
  }
  const output = await f.event("context", { messages: [message] });
  assert.match(recalled(output.messages), /Remembered for agent/);
  assert.match(recalled(output.messages), /Remembered for person/);
  const guide = output.messages.find((m: Message) => m.customType === GUIDE_TYPE);
  assert.match(guide.content, /Store person:/);
  assert.doesNotMatch(guide.content, /Store agent:/);

  // Task overrides supply effective Pi settings without editing the profile.
  const config = f.pi.getSettings();
  config.songya[1].exposeTools = true;
  f.pi.getSettings = () => config;
  await f.event("before_agent_start");
  assert.deepEqual(f.tools.get("read_memory").parameters.properties.store.enum, ["person", "agent"]);
  const allowed = await f.tools.get("read_memory").execute("task-read",
    { store: "agent", id: "m_example" }, undefined, undefined, f.ctx);
  assert.equal(allowed.isError, false);
  assert.equal(f.calls.at(-1)?.user, "agent");
  assert.equal(readFileSync(path, "utf8"), saved);

  for (const store of config.songya) store.exposeTools = false;
  await f.event("before_agent_start");
  assert.ok([...f.tools.values()].every((tool) => tool.exposure === "hidden"));
  const recallOnly = await f.event("context", { messages: [message] });
  assert.equal(recallOnly.messages.some((m: Message) => m.customType === GUIDE_TYPE), false);
  assert.match(recalled(recallOnly.messages), /Remembered for agent/);
  assert.match(recalled(recallOnly.messages), /Remembered for person/);
});

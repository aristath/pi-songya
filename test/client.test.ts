import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  stat,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  finished,
  loadConfig,
  normalizeArguments,
  type Config,
  type Request,
} from "../src/client.ts";
const config: Config = {
  store: "/controlled/store",
  user: "user-1",
  recallEnabled: true,
  adminUrl: "http://127.0.0.1:8664",
  roots: {},
};
const temporary = () => mkdtemp(join(tmpdir(), "pi-songya-client-"));

test("configuration and forgiving number normalization do not alter source wording", async () => {
  const dir = await temporary();
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      songya: [
        {
          store: "./memory",
          user: "user-1",
          roots: { letters: "./letters" },
          recallEnabled: false,
        },
      ],
    }),
  );
  const [loaded] = await loadConfig(dir, dir);
  assert.equal(loaded.store, join(dir, "memory"));
  assert.equal(loaded.roots.letters, join(dir, "letters"));
  assert.equal(loaded.recallEnabled, false);
  assert.deepEqual(
    normalizeArguments({
      offset: "3",
      limit: "0",
      text: "  exact words  ",
      parts: [{ start: "1", end: "10" }],
    }),
    {
      offset: 3,
      limit: 0,
      text: "  exact words  ",
      parts: [{ start: 1, end: 10 }],
    },
  );
});
test("an uncertain write remains private and retries its exact original request", async () => {
  const dir = await temporary();
  let calls = 0;
  const seen: Request[] = [];
  const first = new Client(dir, async (request) => {
    seen.push(request);
    throw new Error("connection lost after acceptance");
  });
  await assert.rejects(
    first.call(
      config,
      "save_memory",
      { text: "Original words", title: "Original" },
      "stable-key",
    ),
    /connection lost/,
  );
  const pending = first.pendingDir(config);
  const names = await readdir(pending);
  assert.equal(names.length, 1);
  assert.equal((await stat(join(pending, names[0]))).mode & 0o777, 0o600);
  const recovering = new Client(dir, async (request) => {
    calls++;
    seen.push(request);
    return { data: { status: "committed", id: "m_existing" } };
  });
  assert.deepEqual(
    await recovering.recover({ ...config, config: "/a/new/config.json" }),
    [],
  );
  assert.equal(calls, 1);
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(await readdir(pending), []);
});
test("one damaged retained record does not block healthy write recovery", async () => {
  const dir = await temporary();
  const client = new Client(dir, async () => ({
    data: { status: "pending" },
    error: "temporarily unavailable",
  }));
  await client.call(
    config,
    "save_memory",
    { text: "retained" },
    "original-key",
  );
  const pending = client.pendingDir(config);
  await writeFile(join(pending, "damaged.json"), "{incomplete");
  const recovered = new Client(dir, async () => ({
    data: { status: "committed" },
  }));
  const warnings = await recovered.recover(config);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await readdir(pending), ["damaged.json"]);
});
test("pending status without a thrown error is retained and reused keys cannot change intent", async () => {
  assert.equal(finished({ data: { status: "pending" } }), false);
  const dir = await temporary();
  const client = new Client(dir, async () => ({ data: { status: "pending" } }));
  await client.call(config, "save_memory", { text: "first" }, "same-key");
  await assert.rejects(
    client.call(config, "save_memory", { text: "different" }, "same-key"),
    /different arguments/,
  );
  const files = await readdir(client.pendingDir(config));
  const saved = JSON.parse(
    await readFile(join(client.pendingDir(config), files[0]), "utf8"),
  );
  assert.equal(saved.args.text, "first");
});
test("concurrent claims cannot replace the first retained write", async () => {
  const dir = await temporary();
  const client = new Client(dir, async () => ({ data: { status: "pending" } }));
  const results = await Promise.allSettled([
    client.call(config, "save_memory", { text: "A" }, "same-key"),
    client.call(config, "save_memory", { text: "B" }, "same-key"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const files = await readdir(client.pendingDir(config));
  assert.equal(files.filter((f) => f.endsWith(".json")).length, 1);
});
test("a cancelled request starts no provider work and creates no pending write", async () => {
  let called = false;
  const dir = await temporary();
  const client = new Client(dir, async () => {
    called = true;
    return { data: { status: "committed" } };
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.call(
      config,
      "save_memory",
      { text: "cancelled" },
      "cancelled",
      controller.signal,
    ),
  );
  assert.equal(called, false);
  await assert.rejects(readdir(client.pendingDir(config)), { code: "ENOENT" });
});
test("recovery stays within the selected store and user", async () => {
  const dir = await temporary();
  const client = new Client(dir, async () => {
    throw new Error("offline");
  });
  await assert.rejects(
    client.call(
      config,
      "save_memory",
      { text: "user-1 account" },
      "user-1-key",
    ),
  );
  const other = { ...config, user: "user-2" };
  await assert.rejects(
    client.call(other, "save_memory", { text: "user-2 account" }, "user-2-key"),
  );
  const requests: Request[] = [];
  await new Client(dir, async (r) => {
    requests.push(r);
    return { data: { status: "committed" } };
  }).recover(config);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].user, "user-1");
  assert.equal((await readdir(client.pendingDir(other))).length, 1);
});

test("a queue cleanup failure preserves an already committed result", async (t) => {
  const dir = await temporary();
  let client: Client;
  client = new Client(dir, async () => {
    await chmod(client.pendingDir(config), 0o500);
    return { data: { status: "committed", id: "m_completed" } };
  });
  t.after(async () => {
    await chmod(client.pendingDir(config), 0o700);
  });
  const result = await client.call(
    config,
    "save_memory",
    { text: "Already committed" },
    "cleanup-key",
  );
  assert.equal(result.data?.status, "committed");
  assert.equal(result.data?.id, "m_completed");
  assert.equal(result.error, undefined);
  assert.match(
    JSON.stringify(result.data?.diagnostics),
    /cleanup needs repair/,
  );
  assert.equal((await readdir(client.pendingDir(config))).length, 1);
});

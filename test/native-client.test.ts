import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, invokeNative, type Config } from "../src/client.ts";

test("a lost native save reply is recovered with the same ID, not a duplicate", async () => {
  const store = await mkdtemp(join(tmpdir(), "pi-songya-native-store-"));
  const agent = await mkdtemp(join(tmpdir(), "pi-songya-native-agent-"));
  // No test operation uses semantic lookup, but any accidental provider request
  // is directed at an unused loopback port rather than a live inference host.
  await writeFile(
    join(store, "config.json"),
    JSON.stringify({
      embeddings: {
        model: "controlled-unused",
        base_url: "http://127.0.0.1:1/v1",
      },
    }),
  );
  const config: Config = {
    store,
    user: "user-1",
    recallEnabled: true,
    exposeTools: true,
    adminUrl: "",
    roots: {},
  };
  let acceptedId: string | undefined;
  const interrupted = new Client(agent, async (request, signal) => {
    const result = await invokeNative(request, signal);
    assert.equal(result.error, undefined);
    acceptedId = result.data?.id;
    throw new Error("simulated reply loss after committed save");
  });
  await assert.rejects(
    interrupted.call(
      config,
      "save_memory",
      { title: "Preserved account", text: "Exact original account: α😀." },
      "same-native-key",
    ),
    /reply loss/,
  );
  assert.ok(acceptedId);
  const recovered = new Client(agent);
  assert.deepEqual(await recovered.recover(config), []);
  const listing = await recovered.call(config, "search_memory", {
    user: "user-1",
    kind: "memories",
    mode: "lexical",
    limit: 20,
  });
  assert.equal(listing.error, undefined);
  assert.equal(listing.data?.matches.length, 1);
  assert.equal(listing.data?.matches[0].id, acceptedId);
  const read = await recovered.call(config, "read_memory", { id: acceptedId });
  assert.equal(read.error, undefined);
  assert.equal(read.data?.text, "Exact original account: α😀.");
  assert.deepEqual(await readdir(recovered.pendingDir(config)), []);
});

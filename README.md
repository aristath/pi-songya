# pi-songya

A standalone Pi extension for Songya: direct memory tools, automatic recall,
isolated stores and classifications, and durable writes. It runs within Pi's existing agent.
The Go helper calls the Songya library directly; no MCP connection or running
Songya web service is required.

## Install

Requires Node 22.18+, Pi 1.5.2+, and Go 1.27.3+ to build the helper.

```sh
npm install
npm run build
pi install /absolute/path/to/pi-songya
```

Add `songya` to the project’s `.pi/settings.json` (or Pi’s global `settings.json` for shared defaults):

```json
{
  "songya": [
    {"store":"/absolute/path/to/person/store","user":"person","recallEnabled":true,"adminUrl":"http://127.0.0.1:8664"},
    {"store":"/absolute/path/to/agent/store","user":"agent","recallEnabled":true,"exposeTools":false,"adminUrl":"http://127.0.0.1:8664"}
  ]
}
```

Each entry is one accessible store. `user` names that store for the tools; it is
not record metadata. Every tool call requires `store` naming a tool-enabled entry.
Only configured directories are accessible. Each has independent records,
entities, topics, stories, attachments, types, indexes and recall state.
There are no shared identities or links across stores. Songya's admin UI has a
separate configuration; it does not read Pi settings.

`exposeTools` defaults to `true`. Set it to `false` for a recall-only store:
its name is excluded from tool choices and saving guidance, and tool calls to
it are rejected. `recallEnabled` independently controls automatic recall.
When all stores have tools disabled, Songya's tools are hidden.

With the optional `pi-subconscious` task runner and a host supporting task-specific
Pi settings, a task can enable tools through a settings override. The runner and
host apply this override; `pi-songya` does not interpret task exports itself.
For example, when the second configured store is the task's memory store:

```js
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile('.pi/settings.json', 'utf8'));
config.songya[1].exposeTools = true;
export const settings = { songya: config.songya };
export default 'Carry out this task using the configured memory stores.';
```

Keep the task's usual scheduling header. Pi replaces arrays when merging
settings, so this example retains the full store list. The override applies to
the task session; it does not rewrite the user's settings.

Optional `config` selects Songya's embedding and retrieval settings; otherwise
Songya uses `<store>/config.json`. Optional `roots` maps import names to permitted
source directories. Relative paths resolve against the session working directory; `~`
expands to the home directory. Pi must run where the store is accessible,
including when connecting over SSH. Configuration does not use environment variables.

The helper builds on first use if missing. Package archives include its source
so installation can build for the current OS and CPU. Neither building nor
package loading calls an inference service. Semantic recall and embedding
maintenance use Songya's configured embedding provider during actual use.

## Direct tools

- `type_configuration`: selected store's classifications and guidance.
- `prepare_memory`, `search_memory`, `read_memory`, `recall_memory`:
  match, search, inspect, and retrieve records.
- `save_memory`, `save_entity`, `save_topic`, `save_story`: create and edit records.
- `delete_memory`: delete one record and its attachments. Read it first and send
  its `id`, `revision`, and `store`. Incoming links block deletion; `blocked_by`
  lists their source IDs. Links are never removed automatically.
- `explore_memory`, `memory_timeline`, `compose_story`: connections and chronology.
- `list_files`, `read_file`, `upload_file`, `attach_file`, `replace_file`,
  `remove_file`, `file_status`: attachments and image/text previews.
- `organize_memory`, `import_memories`, `memory_maintenance`: organization,
  reviewed imports, receipt inspection, and recovery.

Read every source page before editing. `text` replaces wording; `append` adds
wording. Omitted relationships are preserved; supplied relationships replace the
list. Check `status`, `outcome`, and `changed_fields`: `unchanged` is not a change,
and `pending` is not confirmation that a write completed.

## Automatic recall

Before model requests, the extension sends user text and visible assistant text
to Songya. Tool output, hidden thinking, and injected context are excluded. It
queries each enabled store independently and labels injected evidence with its
store name. Ranking,
counts, thresholds, and linked context are configured in Songya.

Recollections are hidden context messages placed beside their source messages.
They are historical data, not instructions or conversation utterances. Recall
state follows resume, branch navigation, forks, and compaction. Updated or
withdrawn records append corrections during a turn. A new user message removes
superseded versions. An outage or ranked omission does not imply deletion.
Recollections from edited or deleted source messages are discarded; compaction
does not discard valid recollections. Context limits keep a record and its
corrections together, so an obsolete version is not kept without its correction.
Omitted records remain in recall state and are available through the tools.

After a run, recall is prefetched for the next request. Prefetch does not start a
model turn or save a record. Disabling recall leaves direct tools available.
Saving uses explicit tool calls; the extension does not copy transcripts into memory.

## Interrupted writes

Before a mutating call, its arguments and stable Pi call key are retained under
`<agentDir>/pi-songya/pending/` with owner-only permissions. Retries use the same
key. Completed or rejected writes leave the queue; uncertain outcomes remain.
Startup and `/songya recover` retry requests for the selected store/user with
their original configuration. Damaged requests remain available for repair
while other work continues. Songya owns accepted receipts and recovery journals.

## Commands

- `/songya`: show configured stores, directories, configuration, and recall status.
- `/songya on` or `/songya off`: session-specific recall preference.
- `/songya reset`: follow configuration defaults again.
- `/songya recover`: retry retained requests and recover Songya operations.
- `/songya preview <text>`: inspect recall without starting an LLM turn.
- `/songya admin`: show the configured administration URL.

Configuration changes apply on the next request. The extension leaves Pi's
system prompt, compaction settings, model configuration, and other extensions unchanged.

## Development

```sh
npm run build
npm run check
npm pack --dry-run
```

Tests use temporary stores, generic fixtures, and controlled providers. They do
not read deployment data, call live inference, or start active Pi sessions.

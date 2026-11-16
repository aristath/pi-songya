# pi-songya

A standalone Pi extension for Songya: direct memory tools, automatic recall,
per-user classifications, and durable writes. It runs within Pi's existing agent.
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
  "songya": {
    "store": "/absolute/path/to/songya/store",
    "user": "user-1",
    "agentUser": "agent",
    "recallEnabled": true,
    "adminUrl": "http://127.0.0.1:8664"
  }
}
```

The store must already exist. `user` selects the record owner for queries and new
records. Optional `agentUser` identifies the agent's record owner and defaults to
`agent`. Set it to an existing owner ID to use that owner's records without
renaming or moving data. Configuration is local and is not included in this package.

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

- `type_configuration`: selected user's classifications and guidance.
- `prepare_memory`, `search_memory`, `read_memory`, `recall_memory`:
  match, search, inspect, and retrieve records.
- `save_memory`, `save_entity`, `save_topic`, `save_story`: create and edit records.
- `explore_memory`, `memory_timeline`, `compose_story`: connections and chronology.
- `list_files`, `read_file`, `upload_file`, `attach_file`, `replace_file`,
  `remove_file`, `file_status`: attachments and image/text previews.
- `organize_memory`, `import_memories`, `memory_maintenance`: organization,
  reviewed imports, receipt inspection, and recovery.

Read every source page before editing. `text` replaces wording; `append` adds
wording. Omitted relationships are preserved; supplied relationships replace the
list. Check `status`, `outcome`, and `changed_fields`: `unchanged` is not a change,
and `pending` is not confirmation that a write completed.

Queries and new memories/stories default to the selected user. Updates preserve
ownership unless explicitly changed. Classification belongs to the selected
user independently of record ownership. Explicit cross-owner queries remain
possible. User selection is not authentication; host permissions and Pi control access.

## Automatic recall

Before model requests, the extension sends user text and visible assistant text
to Songya. Tool output, hidden thinking, and injected context are excluded. It
recalls records owned by the selected user and `agentUser`, without duplicating
an owner. Shared entities and topics follow Songya's owner policy. Ranking,
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

- `/songya`: show the selected user, store, configuration, and recall status.
- `/songya on` or `/songya off`: session-specific recall preference.
- `/songya user user-1`: session-specific user binding, persisted in Pi's branch.
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

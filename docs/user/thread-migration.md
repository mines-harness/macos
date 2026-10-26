<a id="threads-from-older-t3-code-versions"></a>

# Older histories and recovery copies

A fresh mines installation uses its own data directory. It does not automatically
copy mines's database, browser profile, credentials, cookies, or drafts. Use the
explicit history import flow for supported Codex, Claude Code, OpenCode, and
Antigravity sources; the import report explains whether each mine can resume
natively or is a transcript only.

## Existing legacy databases

The inherited V1-to-V2 database converter applies only when a legacy database is
already present in the mines server's explicitly chosen data directory. It is not
an automatic importer for another app's live installation. Work from a stopped,
backed-up copy and retain the original until you have checked the result.

The migrated mine keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. mines also brings over user and assistant messages, their timestamps, and
supported attachments. Large histories may appear in stages while the server imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

<a id="continuing-a-migrated-thread"></a>

## Continuing a migrated mine

The first new message starts a fresh provider session. mines selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the mine and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important mine, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new mine and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Keeping a recovery copy

mines does not currently have a whole-mine export command. Before a major server update, stop
the server and copy its `userdata` directory to a safe location. The default is
`~/.mines/userdata`; a server started with `--home-dir <path>` uses `<path>/userdata`.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy mines:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.

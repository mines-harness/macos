# Welcome wizard

mines shows a resumable setup flow on a new desktop installation. You can leave
setup to start work, then return to `/welcome`. Direct links to Settings remain
available before setup is complete.

## Your devices and agents

Start with the computer running mines. Your mines account is separate from your
provider accounts; sign-in connects to the dedicated identity service configured
for this build. Local work remains available when that service is not configured.
Provider credentials stay on the computer that runs the provider.

Select connected computers, then check Codex and Claude Code installation and
sign-in. Setup opens the selected computer's terminal for supported vendor
installation or sign-in commands. Other providers can be enabled in Settings.

## Your phone

Open **Settings → Connections → Direct device access** on the desktop. Sign in to mines,
configure your signaling service, and compare the phone's device key before
approving it. Scan the desktop's one-time pairing code with the companion app.
The phone tests the actual direct connection before saving the computer.

Signaling readiness does not mean the phone is connected. Keep the computer awake
and mines running. Some networks prevent direct WebRTC connections; mines reports
that failure without sending conversations through a relay. Approval can be
revoked in the same settings panel.

## Import your projects

mines scans selected computers for Codex, Claude Code, OpenCode, and supported
Antigravity exports. All discovered projects are selected initially. Review the
checkboxes before importing. Histories stay on the computer hosting them; the
importer does not read or copy sign-in credentials.

Codex profiles include `sessions` and `archived_sessions`. Claude Code profiles
include retained project transcripts. Configured profiles are included even when
the provider is disabled. There is no conversation age or 200-message cutoff.
Home, scratch, and worktree histories are included. If an original workspace is
missing, mines creates a separate history project in its own data directory and
imports transcripts there without recreating the original workspace.

OpenCode's known v1 SQLite schema is read-only, including archived sessions. mines
never launches an OpenCode database conversion. Other formats can be imported
from JSON exports produced by the installed version (`opencode export SESSION`
or `opencode session export SESSION`, depending on the version). Select **Add
exported history** and enter absolute JSON file paths on the selected computer.
Each OpenCode export must include `info.id`, `info.directory`, and `messages`.

Antigravity native IDE/CLI stores and ACP replay availability differ by release;
mines explicitly reports unsupported or unavailable sources. It does not claim
that every Antigravity conversation was imported. An explicit transcript export
can use this format:

```json
{
  "provider": "antigravity",
  "sessionId": "original-session-id",
  "cwd": "/absolute/original/workspace",
  "title": "Conversation title",
  "messages": [
    { "role": "user", "text": "The original request" },
    { "role": "assistant", "text": "The original response" }
  ]
}
```

An Antigravity export can instead contain a `replay` array of ACP session updates:
`user_message_chunk` and `agent_message_chunk` with `content.type = "text"` and
`content.text`. Adjacent chunks from the same speaker are joined. Tool updates
remain in the original source archive. mines does not invoke `session/load` or
assume a zero-message replay represents a complete history.

The import report distinguishes native continuation, transcript-only history,
partial projection, unavailable sources, and failed imports. Native continuation
means a retained provider session reference is attached; the provider must still
accept it. An export or missing-workspace history is a transcript, not a restored
native session.

Original records are copied into authenticated downloadable source archives in
each imported mine, with a provenance manifest. Files are split into 16 MiB parts;
concatenate numbered source parts to reconstruct the original bytes. OpenCode
SQLite archives contain a session-specific JSONL export rather than the whole
database. Recognized Codex and Claude tool calls, results, and attachment
references also have a normalized JSONL index. Embedded payloads remain in the
raw archive; referenced files are not fetched or executed.

Projected text is imported in order. Large native histories spill to disk in
bounded pages and resume from committed messages after interruption. A single
record that cannot be safely projected, or an oversized external export, remains
available through the complete source archive and is labeled partial. No source
file is rewritten. Provider-specific hidden state is not translated into tool
execution in mines.

Select **Import in background** to queue the chosen projects and continue setup
immediately. **Imports** in the sidebar shows each computer's progress, source
coverage, and failures. You can pause a project or all imports; the current batch
finishes before pausing. Removing a paused job only removes it from the queue.
Already imported conversations remain in the workspace.

Keep mines running while importing. After quitting, queued work is paused until
you select **Resume**. The saved project command and batch cursor make interrupted
requests safe to retry without duplicating source conversations. Losing access or
the connection also pauses affected jobs. Import results distinguish newly added
conversations from ones already present, including writes committed before an
interrupted connection.

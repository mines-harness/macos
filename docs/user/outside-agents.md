# Outside agents

Agents that mines did not start can work with an environment through its MCP
server. They can read projects and mines, start and message mines, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

Use an HTTP endpoint the agent can reach. A direct WebRTC device connection does
not provide a public MCP URL, and the mines device service does not proxy MCP.

- **An agent on your own computers** can use `localhost` on the host or an
  explicitly configured `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Configure an HTTPS endpoint you operate;
  mines does not provide an automatic public tunnel. A Tailscale address only
  works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `mines auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and mines and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  mines in every project. A mine it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http mines https://<environment-address>/mcp
claude mcp login mines
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `mines` as connected
once you approve.

## Codex

```sh
codex mcp add mines --url https://<environment-address>/mcp
codex mcp login mines
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `mines` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using your own
   reachable HTTPS endpoint.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `mines thread` uses the same tools
without a sign-in:

```sh
id=$(mines thread start . "Find why the tests are slow")
mines thread send "$id" "Now fix it" --wait
mines thread show "$id"
mines thread list
```

`.` means the project that contains the current folder; a project id also
works. A new mine uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy mine gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the mine id.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.

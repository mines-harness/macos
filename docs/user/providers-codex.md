# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in mines.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. mines handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

On mobile, open **Settings → Provider accounts** to connect or reconnect a
ChatGPT connection already configured on the selected environment.

Manage shared usage and credits in ChatGPT through **Manage usage** in mines.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in mines and on OpenAI's sign-in
page. Disconnecting stops running mines but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

mines can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the mine's model picker. Compatible accounts can continue the same mine.
Connecting accounts through mines leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same mines. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. mines prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue mines
from the other home.

<a id="switch-accounts-in-an-existing-thread"></a>

## Switch accounts in an existing mine

Choose the other account from the mine's model picker. mines offers compatible
Codex instances that share the mine's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the mine's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the mine on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the mine names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex mine, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned Codex thread ID can be shared
with OpenAI support.

## Switching accounts after a usage limit

Mines keeps each provider account in its own configured CLI home. Sign in through the provider's own login flow, and select an account in the model picker to continue manually. When the provider reports a reset time, a stopped mine can also use **Resume at reset**.

Automatic subscription switching is disabled unless the provider adapter explicitly confirms support. Adding accounts or changing local settings cannot override that requirement. The current Codex and Claude adapters do not confirm it, so they remain manual.

For an adapter that supports automatic switching, **Settings → Providers → Account switching** lets you opt accounts in and set their order. Mines requires fresh quota readings, separate authenticated account homes, and the same provider and model. It continues through the existing mine handoff and tries each account at most once, with a limit of eight accounts. If no eligible account remains, the mine stays stopped and its reset recovery remains available.

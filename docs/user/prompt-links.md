# Prompt links

A prompt link opens mines with a prompt ready to send. Use one to share a prompt on social
media, or to put a one-click fix in a pull request comment.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode, branch, or worktree. Your own defaults apply.

## Make a link

Open the command palette and choose **Copy prompt link**. It copies the draft in the composer.
When the project is on GitHub, **Copy prompt link with repo and model** also adds the repository
and the model you picked. Sent messages have a **Copy prompt link** button too.

Public links require your build's own hosted mines origin (`MINES_HOSTED_APP_URL`).
There is no default mines hosted service. Use the configured origin in copied
links; replace `mines.example.com` below with the one your distributor operates:

```
https://mines.example.com/new?prompt=Review%20this%20change
https://mines.example.com/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
https://mines.example.com/new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on pull request links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                              |
| `provider` | A provider such as `codex` or `claude`.                                       |
| `model`    | A model of that provider, by its id or name.                                  |
| `pr`       | A GitHub pull request, as `owner/name/123` or its URL.                        |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

On your configured hosted app, the link asks where to open it: an installed mines
app or this browser when connected to a machine. **Remember my choice** skips
this step next time. App downloads require your distributor's own release setup.

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and mines tells you.
- **`pr`**: opens the mine linked to that pull request on any connected machine, with the prompt
  in its composer. When no mine is linked, the draft goes on the pull request branch in a new
  worktree. mines checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A mine link with a prompt, such as `https://mines.example.com/<environment>/<thread>?prompt=…`,
puts the prompt in that mine's composer. If you already typed a draft there, mines asks
before it replaces it.

mines removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, mines warns you that it may be
malicious.

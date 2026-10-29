# Guest links

A guest link lets someone join one conversation in their browser with only a nickname.
They see the recent conversation and live replies without creating an account. The host
machine must stay awake and online.

Public links use your distributor's guest endpoint, such as **mines.gemstud.io**. That
endpoint must support guest sharing, and the host must be signed in to its device service.
A compatible managed tunnel can also serve guest links.

<a id="share-a-thread"></a>

## Share a mine

Enable **Settings → Beta → Guest links** on the machine hosting the conversation. Choose
**Share link** in the conversation header, its menu, or the command palette.

Set the number of people, duration, and permissions, then create and copy the link.
The defaults are **1 person**, **6 hours**, and **Viewer**. The people limit counts successful
joins over the lifetime of the link. Returning in the same browser does not use another place.

- **Viewer:** follow the conversation without writing messages.
- **Write with confirmation:** propose messages for the owner to send or dismiss.
- **Write and send:** send messages directly to the agent.

Guests enter a nickname when they join. Their nickname appears in the guest list and beside
their messages. Messages awaiting confirmation appear at the end of the conversation;
choose **Send** or **Dismiss**. The same controls are available on mobile.

Manage guests directly from the conversation's **Users** panel. The paper-plane control
switches an individual guest between viewing and writing with your confirmation.

Guests can use the pencil beside a waiting message to edit it, or press **↑** in an empty
composer to recall their latest waiting message and **Enter** to save. Approved messages
cannot be edited. Deleting a sent message hides it from the conversation; work the agent
has already performed is retained.

Creating another link ends the previous one. **Stop sharing** ends it immediately. Expiry,
archiving the mine, or disabling Guest links also stops access. Turning Guest links back on
restores links that have not otherwise ended.

## Remove a guest

Open the guest list to manage participants. The red **×** kicks a guest and revokes that
browser's access. The red **hammer** removes everyone using that guest's IP address and blocks
that address from rejoining this conversation. Kicking or banning does not restore a used place.

IP bans apply only to this conversation and remain when its link is replaced. Remove a ban
from the same guest controls to allow that address again. People sharing a public IP address
are affected together.

## What guests can see

Guests see messages and files, the agent's replies and reasoning, plans, questions, and work,
including expanded command output. They cannot change the model, inspect diffs, open other
conversations, browse the host's files, or answer the agent's permission requests.

Anything the agent read or printed can appear in the conversation. Share conversations you
are comfortable showing.

## Guest attachments

Guests with writing permission can attach files using the paperclip, paste, or drop.
A message can contain up to 4 files and 10 MB in total. Images must be PNG, JPEG, GIF, or WebP.
Files awaiting confirmation can total 20 MB per link.

Dismissing a message or ending its link deletes files still awaiting confirmation. Files in
sent messages remain in the conversation. Approved and directly sent messages run with the
mine's current agent permission mode.

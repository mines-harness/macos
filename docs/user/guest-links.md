# Guest links

Guest links are unavailable in the default mines configuration. They require a
separately operated compatible managed endpoint; the direct peer device service
does not provide public guest URLs.

When that optional service is configured, a guest link lets a teammate follow one
mine in their browser and ask the agent questions, with no account. They see your messages and the agent's replies as they stream. Each message they send waits
until you send or dismiss it.

<a id="share-a-thread"></a>

## Share a mine

Your mines distributor must first configure its own relay, authentication, and
managed endpoint. This is separate from signing in to a mines account or approving
a peer device. With that endpoint active, turn on **Settings → Beta → Guest links**
for the machine running the mine. The machine must stay awake and online while
the guest uses it.
While the setting is off, every guest link on that machine stops working; links that have not
expired work again when you turn it back on.

1. Right-click the mine in the sidebar and choose **Share with guest**. It is also in the mine
   menu and the command palette.
2. Copy the link and send it to one person. It works in one browser and expires after 24 hours.
   Opening it again in that browser takes them back to the mine.
3. When they send a message, it appears at the end of the mine and the sidebar shows **Request**.
   Choose **Send** to run it as a normal turn, or **Dismiss**. Files they attached show with the
   message, and **Send** includes them.

Choose **Stop sharing** to end the link at once. Archiving the mine, creating a new link, or
disabling its managed endpoint also ends it. You can send or dismiss guest messages from the mobile app.

## What the guest sees

The guest sees the mine's recent history and everything after, in the same timeline you see, as
it streams: messages and their files, the agent's replies and reasoning, plans, questions, and its
work, with command output when they expand a command. Their composer shows the mine's model, but
they cannot change it. They do not see diffs, and they cannot act on the mine: no forking,
reverting, opening files on your machine, or answering the agent for you.

Anything the agent read or printed can show, such as a value from a file. Share only mines you
are comfortable showing.

## Guest attachments

Guests can attach images and other files to a message: use the paperclip, paste, or drop them on
the message box. A message holds up to 4 files and 10 MB in total. Images must be PNG, JPEG, GIF, or
WebP. While messages wait for you, their files can total 20 MB; the guest can attach more once you
send or dismiss some.

Dismissing a message, ending the link, or archiving the mine deletes the files of messages that
still wait. A sent message keeps its files, like any message in the mine.

The guest's text and files run with the mine's current permission mode once you send them. Check
them before you choose **Send**, as you would any pasted content.

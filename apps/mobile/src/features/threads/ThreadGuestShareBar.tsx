import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  guestShareGuests,
  type ChatAttachment,
  type ScopedThreadRef,
  type ThreadGuestMessage,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { openGuestShareDialog } from "../../state/guest-sharing";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { GUEST_PENDING_BUBBLE_CLASS_NAME, GuestMessageName } from "./guestMessageStyle";
import {
  useGuestShareExpired,
  useThreadGuestBannedIps,
  useThreadGuestShare,
} from "./useThreadGuestShare";

function alertOnFailure(failureTitle: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
  }
}

export function ThreadGuestShareBar(props: { readonly threadRef: ScopedThreadRef | null }) {
  const { threadRef } = props;
  const share = useThreadGuestShare(threadRef);
  const bannedIps = useThreadGuestBannedIps(threadRef);
  const expired = useGuestShareExpired(share);
  if (threadRef === null || (share === null && bannedIps.length === 0)) return null;
  const guestNames = share === null ? [] : guestShareGuests(share).map((guest) => guest.name);

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="person.2" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {share === null
          ? `${bannedIps.length} banned ${bannedIps.length === 1 ? "IP" : "IPs"} in this chat`
          : expired
            ? "Guest link expired"
            : guestNames.length > 0
              ? guestNames.join(", ")
              : share.guests === undefined
                ? (share.guestName ?? "Guest link active")
                : "Guest link active"}
      </Text>
      <Button label="Guests" tone="text" onPress={() => openGuestShareDialog(threadRef)} />
    </View>
  );
}

export function ThreadGuestPendingMessage(props: {
  readonly threadRef: ScopedThreadRef;
  readonly guestName: string;
  readonly message: ThreadGuestMessage;
  readonly bubbleMaxWidth: number | `${number}%`;
  /** The feed's own attachment rendering, so the owner sees the files before Send. */
  readonly renderAttachments: (attachments: ReadonlyArray<ChatAttachment>) => ReactNode;
}) {
  const { threadRef, guestName, message } = props;
  const canOperate = useAtomValue(
    threadEnvironment.resolveGuestMessage.permissionAtom(threadRef.environmentId),
  );
  const resolveGuestMessage = useAtomCommand(
    threadEnvironment.resolveGuestMessage,
    "resolve guest message",
  );
  // One request at a time: a second tap while the first is in flight would double-send.
  const [busy, setBusy] = useState(false);

  const resolve = async (decision: "send" | "dismiss") => {
    if (busy || !canOperate) return;
    setBusy(true);
    const result = await resolveGuestMessage({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        guestMessageId: message.id,
        decision,
        creationSource: "mobile",
      },
    });
    setBusy(false);
    alertOnFailure(
      decision === "send" ? "Could not send guest message" : "Could not dismiss guest message",
      result,
    );
  };

  return (
    <View className="items-end pb-5">
      <GuestMessageName name={guestName} />
      <View className={GUEST_PENDING_BUBBLE_CLASS_NAME} style={{ maxWidth: props.bubbleMaxWidth }}>
        {message.text ? (
          <Text selectable className="text-base text-foreground">
            {message.text}
          </Text>
        ) : null}
        {props.renderAttachments(message.attachments ?? [])}
      </View>
      {message.direct ? (
        <Text className="mt-1.5 text-xs text-foreground-muted">Waiting to send</Text>
      ) : null}
      {canOperate ? (
        <View className="mt-1.5 flex-row gap-2">
          <Button
            label="Dismiss"
            tone="secondary"
            accessibilityLabel={`Dismiss message from ${guestName}`}
            disabled={busy}
            onPress={() => void resolve("dismiss")}
          />
          <Button
            label="Send"
            tone="primary"
            accessibilityLabel={`Send message from ${guestName}`}
            disabled={busy}
            onPress={() => void resolve("send")}
          />
        </View>
      ) : null}
    </View>
  );
}

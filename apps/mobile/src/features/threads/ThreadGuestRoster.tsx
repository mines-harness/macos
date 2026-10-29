import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  guestShareGuests,
  guestSessionPermission,
  type GuestSessionId,
  type ScopedThreadRef,
  type ThreadGuestShare,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadGuestBannedIps } from "./useThreadGuestShare";

export function ThreadGuestRoster(props: {
  readonly threadRef: ScopedThreadRef;
  readonly share: ThreadGuestShare | null;
}) {
  const { threadRef } = props;
  const guests = props.share === null ? [] : guestShareGuests(props.share);
  const bannedIps = useThreadGuestBannedIps(threadRef);
  const canKick = useAtomValue(threadEnvironment.kickGuest.permissionAtom(threadRef.environmentId));
  const canBan = useAtomValue(threadEnvironment.banGuest.permissionAtom(threadRef.environmentId));
  const canUnban = useAtomValue(
    threadEnvironment.unbanGuest.permissionAtom(threadRef.environmentId),
  );
  const canSetPermission = useAtomValue(
    threadEnvironment.setGuestPermission.permissionAtom(threadRef.environmentId),
  );
  const setPermission = useAtomCommand(threadEnvironment.setGuestPermission, {
    reportFailure: false,
  });
  const kick = useAtomCommand(threadEnvironment.kickGuest, { reportFailure: false });
  const ban = useAtomCommand(threadEnvironment.banGuest, { reportFailure: false });
  const unban = useAtomCommand(threadEnvironment.unbanGuest, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [shownGuests, setShownGuests] = useState(5);
  const [shownBans, setShownBans] = useState(10);
  const busyRef = useRef(false);
  const moderate = async (
    action:
      | { readonly type: "kick" | "ban"; readonly guestId: GuestSessionId }
      | {
          readonly type: "permission";
          readonly guestId: GuestSessionId;
          readonly permission: "viewer" | "confirm";
        }
      | {
          readonly type: "unban";
          readonly ipAddress: string;
        },
  ) => {
    if (busyRef.current) return;
    if (
      action.type === "kick"
        ? !canKick
        : action.type === "ban"
          ? !canBan
          : action.type === "permission"
            ? !canSetPermission
            : !canUnban
    )
      return;
    busyRef.current = true;
    setBusy(true);
    const result =
      action.type === "permission"
        ? await setPermission({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              guestId: action.guestId,
              permission: action.permission,
            },
          })
        : action.type === "unban"
          ? await unban({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, ipAddress: action.ipAddress },
            })
          : await (action.type === "kick" ? kick : ban)({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, guestId: action.guestId },
            });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not update guest access",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };
  return (
    <View className="gap-2">
      {guests.slice(0, shownGuests).map((guest) => (
        <View key={guest.id} className="flex-row items-center gap-2">
          <View className="size-8 items-center justify-center rounded-full bg-subtle-strong">
            <Text className="text-xs text-foreground-muted">
              {guest.name.slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-sm font-mines-medium" numberOfLines={1}>
              {guest.name}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {guestSessionPermission(props.share, guest.id) === "viewer"
                ? "View only"
                : guestSessionPermission(props.share, guest.id) === "send"
                  ? "Can send directly"
                  : "Can suggest messages"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${guestSessionPermission(props.share, guest.id) === "viewer" ? "Allow" : "Disable"} messages from ${guest.name}`}
            accessibilityState={{
              disabled: busy || !canSetPermission,
              selected: guestSessionPermission(props.share, guest.id) !== "viewer",
            }}
            disabled={busy || !canSetPermission}
            className="size-11 items-center justify-center"
            onPress={() =>
              void moderate({
                type: "permission",
                guestId: guest.id,
                permission:
                  guestSessionPermission(props.share, guest.id) === "viewer" ? "confirm" : "viewer",
              })
            }
          >
            <SymbolView
              name="paperplane"
              size={22}
              tintColorClassName={
                busy || !canSetPermission ? "accent-icon-subtle" : "accent-foreground-muted"
              }
            />
            <View className="absolute bottom-1 right-1 rounded-full bg-screen">
              <SymbolView
                name={
                  guestSessionPermission(props.share, guest.id) === "viewer" ? "xmark" : "checkmark"
                }
                size={11}
                tintColorClassName="accent-foreground-muted"
              />
            </View>
          </Pressable>
          <IconButton
            icon="xmark"
            tintColorClassName="accent-danger-foreground"
            accessibilityLabel={`Kick ${guest.name} from this chat`}
            disabled={busy || !canKick}
            onPress={() => void moderate({ type: "kick", guestId: guest.id })}
          />
          <IconButton
            icon="hammer"
            tintColorClassName="accent-danger-foreground"
            accessibilityLabel={`Ban ${guest.name}'s IP from this chat`}
            disabled={busy || !canBan || !guest.ipAddress}
            onPress={() =>
              Dialog.confirm({
                title: `Ban ${guest.name}'s IP?`,
                message:
                  "Guests using this IP will lose access to this chat. Other chats are unaffected.",
                confirmText: "Ban IP",
                destructive: true,
                onConfirm: () => void moderate({ type: "ban", guestId: guest.id }),
              })
            }
          />
        </View>
      ))}
      {guests.length > shownGuests ? (
        <Button
          label={`Show more guests (${guests.length - shownGuests})`}
          tone="text"
          onPress={() => setShownGuests((count) => count + 10)}
        />
      ) : null}
      {bannedIps.length > 0 ? (
        <View className="gap-2">
          <Text className="font-mines-bold">Banned IPs in this chat</Text>
          {bannedIps.slice(0, shownBans).map((ipAddress) => (
            <View key={ipAddress} className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-sm" selectable>
                {ipAddress}
              </Text>
              <Button
                label="Unban"
                tone="text"
                disabled={busy || !canUnban}
                accessibilityLabel={`Unban ${ipAddress} from this chat`}
                onPress={() => void moderate({ type: "unban", ipAddress })}
              />
            </View>
          ))}
          {bannedIps.length > shownBans ? (
            <Button
              label={`Show more (${bannedIps.length - shownBans})`}
              tone="text"
              onPress={() => setShownBans((count) => count + 10)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { guestShareGuests, guestSharePermission, type ScopedThreadRef } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Modal, Platform, Pressable, Share, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { serverEnvironment } from "../../state/server";
import { closeGuestShareDialog, guestShareDialogThreadAtom } from "../../state/guest-sharing";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadGuestRoster } from "./ThreadGuestRoster";
import { guestShareOwnerView, type GuestShareCreation } from "./guestShareOwnerState";
import {
  useGuestShareExpired,
  useGuestSharingEnabled,
  useThreadGuestShareSnapshot,
} from "./useThreadGuestShare";

const PERMISSIONS = [
  { value: "viewer", label: "Viewer", description: "Read the chat." },
  { value: "confirm", label: "Confirm", description: "Messages wait for your approval." },
  { value: "send", label: "Send", description: "Messages go straight to the agent." },
] as const;

export function ThreadGuestShareDialogHost() {
  const threadRef = useAtomValue(guestShareDialogThreadAtom);
  return threadRef ? (
    <ThreadGuestShareModal
      key={JSON.stringify(threadRef)}
      threadRef={threadRef}
      onClose={closeGuestShareDialog}
    />
  ) : null;
}

function ThreadGuestShareModal(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { threadRef } = props;
  const snapshot = useThreadGuestShareSnapshot(threadRef);
  const [created, setCreated] = useState<GuestShareCreation | null>(null);
  const view = guestShareOwnerView(snapshot, created);
  if (view.creation !== created) setCreated(view.creation);
  const share = view.share;
  const expired = useGuestShareExpired(share);
  const enabled = useGuestSharingEnabled(threadRef.environmentId);
  const canCreate = useAtomValue(
    serverEnvironment.createGuestShare.permissionAtom(threadRef.environmentId),
  );
  const createGuestShare = useAtomCommand(serverEnvironment.createGuestShare, {
    reportFailure: false,
  });
  const canEnable = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(threadRef.environmentId),
  );
  const enableGuestSharing = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const canClose = useAtomValue(
    threadEnvironment.closeGuestShare.permissionAtom(threadRef.environmentId),
  );
  const closeGuestShare = useAtomCommand(threadEnvironment.closeGuestShare, {
    reportFailure: false,
  });
  const [maxGuestsText, setMaxGuestsText] = useState("1");
  const [durationText, setDurationText] = useState("6");
  const maxGuests = Number(maxGuestsText);
  const durationHours = Number(durationText.replace(",", "."));
  const validOptions =
    Number.isInteger(maxGuests) &&
    maxGuests >= 1 &&
    maxGuests <= 100 &&
    Number.isFinite(durationHours) &&
    durationHours >= 0.25 &&
    durationHours <= 168;
  const [permission, setPermission] = useState<(typeof PERMISSIONS)[number]["value"]>("viewer");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdUrl = enabled && !expired ? view.url : null;
  const canCreateLink = snapshot.loaded && (view.canCreate || expired);
  const dismiss = () => {
    if (!busyRef.current) props.onClose();
  };
  const create = async () => {
    if (busyRef.current || !enabled || !canCreate || !canCreateLink || !validOptions) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await createGuestShare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, maxGuests, durationHours, permission },
    });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Success") {
      setCreated({
        result: result.value,
        previousShareId: snapshot.share?.id ?? null,
        synchronized: false,
      });
      setCopied(false);
    } else if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not create a share link.");
    }
  };
  const enable = async () => {
    if (busyRef.current || !canEnable) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await enableGuestSharing({
      environmentId: threadRef.environmentId,
      input: { patch: { guestSharingEnabled: true } },
    });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setError(error instanceof Error ? error.message : "Could not enable guest links.");
    }
  };
  const stopSharing = () =>
    Dialog.confirm({
      title: "Stop sharing?",
      message: "All guests lose access and the link stops working.",
      confirmText: "Stop sharing",
      destructive: true,
      onConfirm: () => {
        if (busyRef.current || !canClose) return;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        void closeGuestShare({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }).then((result) => {
          busyRef.current = false;
          setBusy(false);
          if (result._tag === "Success") setCreated(null);
          else if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setError(error instanceof Error ? error.message : "Could not stop sharing.");
          }
        });
      },
    });
  const exportLink = async (action: "copy" | "share") => {
    if (createdUrl === null || busyRef.current) return;
    setError(null);
    try {
      if (action === "copy") {
        await Clipboard.setStringAsync(createdUrl);
        setCopied(true);
      } else {
        await Share.share(Platform.OS === "ios" ? { url: createdUrl } : { message: createdUrl });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not share the link.");
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={dismiss}>
      <SafeAreaView className="flex-1 bg-screen">
        <SheetHeader
          presentation="inline"
          title="Share link"
          onClose={dismiss}
          dismissDisabled={busy}
        />
        <ScreenScrollView
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 20 }}
        >
          <Text className="text-sm leading-5 text-foreground-muted">
            Guests can read this chat, including command output and the agent’s reasoning.
          </Text>
          {!snapshot.loaded ? (
            <Text className="text-sm text-foreground-muted">
              {snapshot.error ?? "Loading current guest access…"}
            </Text>
          ) : null}
          {!enabled ? (
            <View className="gap-3">
              <Text className="text-sm text-foreground-muted">
                Enable guest links on this chat’s device to create a link.
              </Text>
              <Button
                label="Enable guest links"
                disabled={busy || !canEnable}
                onPress={() => void enable()}
              />
              {!canEnable ? (
                <Text className="text-sm text-foreground-muted">
                  Settings access is required to enable guest links.
                </Text>
              ) : null}
            </View>
          ) : null}
          {share ? (
            <View className="gap-3 rounded-2xl bg-grouped-card p-4">
              <Text className="font-mines-bold">
                Guests ·{" "}
                {PERMISSIONS.find((choice) => choice.value === guestSharePermission(share))?.label}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {expired
                  ? "Link expired"
                  : `Link expires ${new Date(share.expiresAt).toLocaleString()}`}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {share.useCount ?? share.guests?.length ?? (share.guestName === null ? 0 : 1)} /{" "}
                {share.maxGuests ?? 1} link uses
              </Text>
              {view.exhausted ? (
                <Text className="text-sm text-foreground-muted">
                  All link uses have been consumed. Create a new link to invite more people.
                </Text>
              ) : null}
              {guestShareGuests(share).length === 0 ? (
                <Text className="text-sm text-foreground-muted">
                  {share.guests === undefined && share.guestName !== null
                    ? share.guestName
                    : "No active guests."}
                </Text>
              ) : null}
              <ThreadGuestRoster threadRef={threadRef} share={share} />
              <Button
                label="Stop sharing"
                tone="danger"
                disabled={busy || !canClose}
                onPress={stopSharing}
              />
            </View>
          ) : (
            <ThreadGuestRoster threadRef={threadRef} share={null} />
          )}
          {createdUrl ? (
            <View className="gap-3 rounded-2xl bg-grouped-card p-4">
              <Text className="font-mines-bold">Link ready</Text>
              <Text selectable accessibilityLabel="Share link" className="text-sm">
                {createdUrl}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={copied ? "Copied" : "Copy link"}
                  icon={copied ? "checkmark" : "doc.on.doc"}
                  onPress={() => void exportLink("copy")}
                />
                <Button
                  label="Share link"
                  icon="square.and.arrow.up"
                  tone="primary"
                  onPress={() => void exportLink("share")}
                />
              </View>
            </View>
          ) : (
            <>
              <View className="gap-4 rounded-2xl bg-grouped-card p-4">
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="font-mines-medium">Max people</Text>
                    <Text className="text-sm text-foreground-muted">1–100 link uses</Text>
                  </View>
                  <View className="w-24">
                    <AppTextInput
                      accessibilityLabel="Max people"
                      keyboardType="number-pad"
                      value={maxGuestsText}
                      onChangeText={setMaxGuestsText}
                      editable={!busy}
                      selectTextOnFocus
                    />
                  </View>
                </View>
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1 gap-1">
                    <Text className="font-mines-medium">Duration</Text>
                    <Text className="text-sm text-foreground-muted">Hours · 0.25–168</Text>
                  </View>
                  <View className="w-24">
                    <AppTextInput
                      accessibilityLabel="Duration in hours"
                      keyboardType="decimal-pad"
                      value={durationText}
                      onChangeText={setDurationText}
                      editable={!busy}
                      selectTextOnFocus
                    />
                  </View>
                </View>
              </View>
              <View className="gap-2">
                <Text className="font-mines-bold">Permission</Text>
                <View className="overflow-hidden rounded-2xl">
                  {PERMISSIONS.map((choice) => (
                    <Pressable
                      key={choice.value}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: permission === choice.value, disabled: busy }}
                      disabled={busy}
                      onPress={() => setPermission(choice.value)}
                      className="min-h-16 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:opacity-70"
                    >
                      <View className="min-w-0 flex-1 gap-1">
                        <Text className="font-mines-medium">{choice.label}</Text>
                        <Text className="text-sm text-foreground-muted">{choice.description}</Text>
                      </View>
                      {permission === choice.value ? (
                        <SymbolView
                          name="checkmark"
                          size={18}
                          tintColorClassName="accent-primary-text"
                        />
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              </View>
              {share ? (
                <Text className="text-sm text-foreground-muted">
                  A new link ends the current link and removes its guests.
                </Text>
              ) : null}
              <Button
                label={
                  !snapshot.loaded ? "Loading sharing…" : share ? "Create new link" : "Create link"
                }
                tone="primary"
                fullWidth
                disabled={!enabled || !canCreate || !canCreateLink || !validOptions}
                loading={busy}
                onPress={() => void create()}
              />
            </>
          )}
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </ScreenScrollView>
      </SafeAreaView>
    </Modal>
  );
}

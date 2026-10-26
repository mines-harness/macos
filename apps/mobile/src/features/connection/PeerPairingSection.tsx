import { useMinesAccount } from "../cloud/MinesAccountProvider";
import { useNavigation } from "@react-navigation/native";
import { decodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
  minesCatalogIdentityAtom,
} from "@t3tools/client-runtime/catalog";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Clipboard from "expo-clipboard";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Share, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ListRow } from "../../components/ui/ListRow";
import {
  connectPeerPairing,
  phoneApprovalCode,
  restorePeerRoutes,
} from "../../connection/peerOnboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { hasMinesIdentityConfig } from "../cloud/publicConfig";
import { appAtomRegistry } from "../../state/atom-registry";

export function PeerAccountBridge({ children }: { readonly children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken } = useMinesAccount();
  const restore = useAtomCommand(restorePeerRoutes, { reportFailure: false });
  const accountId = isLoaded && isSignedIn ? (userId ?? null) : null;
  useLayoutEffect(() => {
    let active = true;
    appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set());
    appAtomRegistry.set(minesAccountIdAtom, null);
    appAtomRegistry.set(minesCatalogIdentityAtom, {
      ready: false,
      accountId: null,
      readToken: null,
    });
    // Restore clears prior account sessions before registering this account's routes.
    if (isLoaded)
      void restore(accountId).then((result) => {
        if (active && AsyncResult.isSuccess(result)) {
          appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set(result.value));
          appAtomRegistry.set(minesAccountIdAtom, accountId);
          appAtomRegistry.set(minesCatalogIdentityAtom, {
            ready: true,
            accountId,
            readToken: accountId ? () => getToken() : null,
          });
        }
      });
    return () => {
      active = false;
      appAtomRegistry.set(minesAccountEnvironmentIdsAtom, new Set());
      appAtomRegistry.set(minesAccountIdAtom, null);
      appAtomRegistry.set(minesCatalogIdentityAtom, {
        ready: false,
        accountId: null,
        readToken: null,
      });
      void restore(null);
    };
  }, [accountId, getToken, isLoaded, restore]);
  return children;
}

export function PeerPairingSection({ scannedCode }: { readonly scannedCode: string }) {
  if (!hasMinesIdentityConfig()) {
    return (
      <Text className="px-4 text-sm text-foreground-muted">
        Direct phone pairing requires the mines account service configured in this app build.
      </Text>
    );
  }
  return <ConfiguredPeerPairingSection scannedCode={scannedCode} />;
}

function ConfiguredPeerPairingSection({ scannedCode }: { readonly scannedCode: string }) {
  const { userId } = useMinesAccount();
  return <PeerPairingAccount key={userId ?? "signed-out"} scannedCode={scannedCode} />;
}

function PeerPairingAccount({ scannedCode }: { readonly scannedCode: string }) {
  const { isSignedIn, isLoaded, userId, getToken } = useMinesAccount();
  const navigation = useNavigation();
  const loadCode = useAtomCommand(phoneApprovalCode, { reportFailure: false });
  const pair = useAtomCommand(connectPeerPairing, { reportFailure: false });
  const [approval, setApproval] = useState<{ code: string; deviceId: string } | null>(null);
  const [pairingUrl, setPairingUrl] = useState(scannedCode);
  const [previewAt] = useState(() => Date.now() / 1000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!isSignedIn || !userId) return;
    void loadCode(userId).then((result) => {
      if (!active) return;
      if (AsyncResult.isSuccess(result))
        setApproval({ code: result.value.code, deviceId: result.value.device.deviceId });
      else if (AsyncResult.isFailure(result))
        setMessage(
          "Could not load this phone's secure identity. Unlock the phone and reopen this screen.",
        );
    });
    return () => {
      active = false;
    };
  }, [loadCode, isSignedIn, userId]);
  let target: ReturnType<typeof decodePeerPairing> | null = null;
  let invalid: string | null = null;
  if (pairingUrl.trim()) {
    try {
      target = decodePeerPairing(pairingUrl, previewAt);
    } catch (error) {
      invalid = error instanceof Error ? error.message : "Invalid pairing code.";
    }
  }
  const connect = async () => {
    if (!isSignedIn || !userId || !target || busy) return;
    setBusy(true);
    setMessage("Verifying the computer and connecting directly…");
    const result = await pair({
      pairingUrl,
      accountId: userId,
      getToken,
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      setPairingUrl("");
      setMessage("Computer paired. Its mines are available in your devices.");
    } else if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not pair. Check desktop approval and try again.",
      );
    }
  };
  return (
    <View className="gap-3">
      <Text className="px-4 text-lg font-mines-semibold text-foreground">Connect directly</Text>
      <Text className="px-4 text-sm text-foreground-muted">
        Copy this phone's device code into mines on your computer, approve its fingerprint, then
        scan the computer's pairing QR above.
      </Text>
      {approval ? (
        <>
          <Text selectable className="px-4 text-xs text-foreground-muted">
            Phone fingerprint: {approval.deviceId}
          </Text>
          <ListRow
            label="Copy phone approval code"
            onPress={() => {
              void Clipboard.setStringAsync(approval.code);
              setMessage("Approval code copied. Paste it in desktop Settings → Connections.");
            }}
          />
          <ListRow
            label="Share phone approval code"
            onPress={() => {
              void Share.share({ message: approval.code });
            }}
          />
        </>
      ) : null}
      {!isSignedIn ? (
        <ListRow
          label="Sign in to mines"
          description="Use the same account as your computer."
          disabled={!isLoaded}
          onPress={() => navigation.navigate("SettingsAuth")}
        />
      ) : null}
      <AppTextInput
        accessibilityLabel="Computer pairing link"
        multiline
        autoCorrect={false}
        autoCapitalize="none"
        placeholder="Or paste mines://peer…"
        value={pairingUrl}
        onChangeText={(value) => {
          setPairingUrl(value);
          setMessage(null);
        }}
        className="min-h-14 rounded-2xl bg-grouped-card px-4 py-3 text-sm text-foreground"
      />
      {target ? (
        <View className="gap-1 px-4">
          <Text className="font-mines-medium text-foreground">{target.host.label}</Text>
          <Text selectable className="text-xs text-foreground-muted">
            Computer fingerprint: {target.host.deviceId}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            Account server: {target.controlUrl}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Connect only if this is the account server you configured. A sign-in token will be sent
            there to register this phone. Mine content stays on the peer connection.
          </Text>
        </View>
      ) : null}
      <ListRow
        label={busy ? "Connecting…" : "Trust computer and connect"}
        disabled={busy || !isSignedIn || target === null}
        onPress={() => {
          void connect();
        }}
      />
      {(message ?? invalid) ? (
        <Text accessibilityLiveRegion="polite" className="px-4 text-sm text-foreground-muted">
          {message ?? invalid}
        </Text>
      ) : null}
      <Text className="px-4 text-xs text-foreground-muted">
        If this network blocks a direct connection, switch networks. Your cached mines remain
        available; mines never relays the conversation.
      </Text>
    </View>
  );
}

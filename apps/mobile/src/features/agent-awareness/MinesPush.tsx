import { useMinesAccount } from "../cloud/MinesAccountProvider";
import {
  minesPushCapability,
  sendMinesPushRequest,
  signMinesPushRequest,
  type MinesPushPayload,
} from "@t3tools/shared/minesPush";
import { registerPeerDevice } from "@t3tools/shared/minesPeerSignaling";
import type { PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { loadPeerIdentity } from "../../connection/peerPairing";
import { runtime } from "../../lib/runtime";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import { hasMinesIdentityConfig } from "../cloud/publicConfig";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";

const Config = Schema.Struct({ controlUrl: Schema.String });
const decodeConfig = Schema.decodeUnknownOption(Config);
function configuration() {
  const value = decodeConfig(Constants.expoConfig?.extra?.minesPush);
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (value._tag === "None" || typeof projectId !== "string" || !projectId) return null;
  return { controlUrl: value.value.controlUrl, projectId };
}
const prefKey = (account: string) => `mines.push.enabled.${account}`;
const readEnabled = (account: string) =>
  runtime
    .runPromise(Effect.flatMap(MobileSecureStorage, (store) => store.getItem(prefKey(account))))
    .then((value) => value === "1");
const writeEnabled = (account: string, enabled: boolean) =>
  runtime.runPromise(
    Effect.flatMap(MobileSecureStorage, (store) =>
      store.setItem(prefKey(account), enabled ? "1" : "0"),
    ),
  );
const nowSeconds = () => Math.floor(Date.now() / 1000);
const PendingRemovals = Schema.Array(
  Schema.Struct({ account: Schema.String, controlUrl: Schema.String }),
).check(Schema.isMaxLength(20));
const pendingKey = "mines.push.pending-removal.v1";
const decodePending = Schema.decodeUnknownEffect(Schema.fromJsonString(PendingRemovals));
const encodePending = Schema.encodeEffect(Schema.fromJsonString(PendingRemovals));
const readPending = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* MobileSecureStorage;
      const value = yield* storage.getItem(pendingKey);
      return value === null ? [] : yield* decodePending(value);
    }),
  );
const savePending = (value: typeof PendingRemovals.Type) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* MobileSecureStorage;
      yield* storage.setItem(pendingKey, yield* encodePending(value));
    }),
  );
async function drainPendingRemovals() {
  for (const pending of await readPending()) {
    const identity = await runtime.runPromise(loadPeerIdentity(pending.account));
    await sendMinesPushRequest({
      controlUrl: pending.controlUrl,
      request: signMinesPushRequest(
        identity,
        { action: "remove" },
        Crypto.randomUUID(),
        nowSeconds(),
      ),
    });
    await savePending(
      (await readPending()).filter(
        (value) => value.account !== pending.account || value.controlUrl !== pending.controlUrl,
      ),
    );
  }
}

type Status = "disabled" | "enabled" | "working" | "unconfigured" | "signed-out" | "error";
const PushContext = createContext<{
  status: Status;
  error: string | null;
  enable: () => void;
  disable: () => void;
} | null>(null);

// Serializes account changes, token rotation and explicit opt-out, so an old registration cannot win a race.
let operations: Promise<unknown> = Promise.resolve();
function enqueue(operation: () => Promise<void>) {
  operations = operations.then(operation, operation);
  return operations;
}

const send = async (
  identity: PeerIdentity,
  controlUrl: string,
  payload: MinesPushPayload,
  bearer?: string,
) => {
  await sendMinesPushRequest({
    controlUrl,
    request: signMinesPushRequest(identity, payload, Crypto.randomUUID(), nowSeconds()),
    ...(bearer ? { bearer } : {}),
  });
};

export function MinesPushBridge({ children }: { children: ReactNode }) {
  const { userId, isLoaded, isSignedIn, getToken } = useMinesAccount();
  const account = isLoaded && isSignedIn ? (userId ?? null) : null;
  const current = useRef(account);
  useLayoutEffect(() => {
    current.current = account;
  }, [account]);
  const registered = useRef<{ account: string; identity: PeerIdentity; controlUrl: string } | null>(
    null,
  );
  const [status, setStatus] = useState<Status>(configuration() ? "disabled" : "unconfigured");
  const [error, setError] = useState<string | null>(null);
  const remove = useCallback(async (previousAccount?: string | null, force = false) => {
    const config = configuration();
    const previous = registered.current;
    const accountToRemove = previous?.account ?? previousAccount;
    const controlUrl = previous?.controlUrl ?? config?.controlUrl;
    if (
      !accountToRemove ||
      !controlUrl ||
      (!previous && !force && !(await readEnabled(accountToRemove)))
    )
      return;
    const pending = await readPending();
    await savePending([
      ...pending.filter(
        (value) => value.account !== accountToRemove || value.controlUrl !== controlUrl,
      ),
      { account: accountToRemove, controlUrl },
    ]);
    await drainPendingRemovals();
    if (registered.current === previous) registered.current = null;
  }, []);
  const refresh = useCallback(
    (prompt: boolean) =>
      enqueue(async () => {
        const config = configuration();
        if (!account || current.current !== account) return;
        if (!config) {
          setStatus("unconfigured");
          return;
        }
        setStatus("working");
        setError(null);
        try {
          await drainPendingRemovals();
          if (!prompt && !(await readEnabled(account))) {
            setStatus("disabled");
            return;
          }
          const bearer = await getToken();
          if (!bearer) throw new Error("Sign in to your mines account first.");
          const capability = await minesPushCapability(config.controlUrl, bearer);
          if (!capability.enabled) {
            setStatus("unconfigured");
            return;
          }
          if (Platform.OS === "android")
            await Notifications.setNotificationChannelAsync("mines-agents", {
              name: "Agent updates",
              importance: Notifications.AndroidImportance.DEFAULT,
            });
          let permission = await Notifications.getPermissionsAsync();
          if (!permission.granted && prompt)
            permission = await Notifications.requestPermissionsAsync();
          if (!permission.granted) {
            await writeEnabled(account, false);
            await remove(account, true);
            setStatus("disabled");
            return;
          }
          const identity = await runtime.runPromise(loadPeerIdentity(account));
          const token = (await Notifications.getExpoPushTokenAsync({ projectId: config.projectId }))
            .data;
          if (current.current !== account) return;
          await registerPeerDevice({
            controlUrl: config.controlUrl,
            identity,
            bearerToken: async () => bearer,
            randomId: Crypto.randomUUID,
            nowSeconds,
          });
          if (current.current !== account) return;
          await send(identity, config.controlUrl, { action: "register", token }, bearer);
          registered.current = { account, identity, controlUrl: config.controlUrl };
          await writeEnabled(account, true);
          if (current.current === account) setStatus("enabled");
        } catch {
          if (current.current === account) {
            setStatus("error");
            setError(
              "Notification setup did not finish. Check your connection and this mines build's push configuration, then retry.",
            );
          }
        }
      }),
    [account, getToken, remove],
  );
  useEffect(() => {
    if (!account) {
      void enqueue(() => remove(account).then(drainPendingRemovals)).catch(() => {});
      return;
    }
    void refresh(false).catch(() => {});
    const tokens = Notifications.addPushTokenListener(() => {
      void refresh(false).catch(() => {});
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh(false).catch(() => {});
    });
    return () => {
      tokens.remove();
      foreground.remove();
      void enqueue(() => remove(account).then(drainPendingRemovals)).catch(() => {});
    };
  }, [account, refresh, remove]);
  const disable = useCallback(() => {
    void enqueue(async () => {
      if (!account) return;
      setStatus("working");
      setError(null);
      await writeEnabled(account, false);
      try {
        await remove(account, true);
        setStatus("disabled");
      } catch {
        setStatus("error");
        setError(
          "Remote opt-out could not be confirmed. Retry when online or revoke this device from your account.",
        );
      }
    }).catch(() => {
      setStatus("error");
    });
  }, [account, remove]);
  const enable = useCallback(() => {
    void refresh(true).catch(() => {});
  }, [refresh]);
  const context = useMemo(
    () => ({ status: account ? status : ("signed-out" as const), error, enable, disable }),
    [account, status, error, enable, disable],
  );
  return <PushContext value={context}>{children}</PushContext>;
}

export function MinesPushSettings() {
  const push = use(PushContext);
  return (
    <SettingsScreen title="Notifications">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 pt-4 gap-4"
      >
        <SettingsSection
          title="Agent updates"
          footer="Alerts contain a generic update and an opaque event ID. Conversation titles and text stay on your computers. Delivery depends on the phone's notification settings and network."
        >
          {push && hasMinesIdentityConfig() ? (
            <>
              <SettingsRow
                icon="bell.badge"
                label={push.status === "enabled" ? "Notifications enabled" : "Enable notifications"}
                value={
                  push.status === "unconfigured"
                    ? "This build or the device service needs mines push credentials."
                    : push.status === "signed-out"
                      ? "Sign in to your mines account."
                      : push.status === "working"
                        ? "Updating…"
                        : undefined
                }
                disabled={["working", "unconfigured", "signed-out"].includes(push.status)}
                onPress={push.enable}
              />
              <SettingsRow
                icon="bell.badge"
                label="Disable on this phone"
                disabled={push.status === "working" || push.status === "signed-out"}
                onPress={push.disable}
              />
            </>
          ) : (
            <Text className="text-foreground-muted">
              Configure your mines identity and device service to enable notifications.
            </Text>
          )}
        </SettingsSection>
        {push?.error ? <Text className="text-danger-foreground">{push.error}</Text> : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

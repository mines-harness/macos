import { use, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ContactsClient } from "@t3tools/shared/minesContacts";
import type { ContactsSnapshot } from "@t3tools/contracts/contacts";
import { useMinesAccount } from "../cloud/MinesAccountProvider";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { createMobileContactsState, type MobileContactsSnapshot } from "./contactsState";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";

const empty: MobileContactsSnapshot = { data: null, pending: false, error: null };
const noSubscribe = () => () => {};
const emptySnapshot = () => empty;
const unavailable = async () => false;
const unavailableCommand = async (
  _operation: (client: ContactsClient) => Promise<ContactsSnapshot>,
) => false;

export function useContacts(tab: "contacts" | "threads" = "contacts") {
  const { userId, isLoaded, isSignedIn, getToken } = useMinesAccount();
  const controlUrl = resolveCloudPublicConfig().identity.controlUrl;
  const workspace = useWorkspaceTabs();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const active = tabActive && (!workspace || workspace.state.selectedTab === tab);
  const state = useMemo(
    () =>
      isSignedIn && userId && controlUrl
        ? createMobileContactsState({ controlUrl, getToken })
        : null,
    [controlUrl, getToken, isSignedIn, userId],
  );
  useEffect(() => {
    if (!state) return;
    state.activate();
    return () => state.dispose();
  }, [state]);
  useEffect(() => {
    if (active && state) void state.refresh();
  }, [active, state]);
  const snapshot = useSyncExternalStore(
    state?.subscribe ?? noSubscribe,
    state?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return {
    ...snapshot,
    accountId: userId,
    isLoaded,
    isSignedIn,
    configured: controlUrl !== null,
    refresh: state?.refresh ?? unavailable,
    run: state?.run ?? unavailableCommand,
  };
}

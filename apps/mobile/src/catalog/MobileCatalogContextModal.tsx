import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  catalogContextFor,
  minesAccountEnvironmentIdsAtom,
  MAX_CATALOG_CONTEXT_SOURCES,
  normalizeCatalogSourcePath,
  resolveCatalogContext,
  type MinesCatalog,
  type MinesCatalogContextSource,
  type MinesCatalogSnapshot,
} from "@t3tools/client-runtime/catalog";
import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
} from "@t3tools/client-runtime/state/projects";
import { AppText as Text, AppTextInput } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { Menu } from "../components/ui/Menu";
import { FolderBrowser } from "../features/projects/AddProjectScreen";
import { appAtomRegistry } from "../state/atom-registry";
import { useServerConfigs } from "../state/entities";
import { filesystemEnvironment } from "../state/filesystem";
import { readEnvironmentScope } from "../state/session";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useMinesCatalog } from "./useMinesCatalog";
import { uuidv4 } from "../lib/uuid";

export function MobileCatalogContextModal({
  entityId,
  onClose,
}: {
  entityId: string;
  onClose: () => void;
}) {
  const { catalog, snapshot, accountId, error } = useMinesCatalog();
  if (!catalog)
    return (
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <SafeAreaView className="flex-1 gap-4 bg-background p-4">
          <Pressable accessibilityRole="button" onPress={onClose} className="self-start p-2">
            <Text>Cancel</Text>
          </Pressable>
          <Text accessibilityRole={error ? "alert" : "text"}>
            {error ?? "Opening context settings…"}
          </Text>
        </SafeAreaView>
      </Modal>
    );
  return (
    <MobileCatalogContextEditor
      key={`${accountId}:${entityId}`}
      {...{ catalog, snapshot, accountId, entityId, onClose }}
      persistenceError={error}
    />
  );
}

function MobileCatalogContextEditor({
  catalog,
  snapshot,
  accountId,
  entityId,
  onClose,
  persistenceError,
}: {
  catalog: MinesCatalog;
  snapshot: MinesCatalogSnapshot;
  accountId: string;
  entityId: string;
  onClose: () => void;
  persistenceError: string | null;
}) {
  const entity = snapshot.entities.find((item) => item.id === entityId);
  const context = catalogContextFor(snapshot, entityId);
  const [initial, setInitial] = useState(() => ({ accountId, instructions: context.instructions }));
  const [draftInstructions, setDraftInstructions] = useState(initial.instructions);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<readonly MinesCatalogContextSource[]>([]);
  const ownedEnvironmentIds = useAtomValue(minesAccountEnvironmentIdsAtom);
  const configs = useServerConfigs();
  const getMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const selectionGeneration = useRef(0);
  useEffect(
    () => () => {
      selectionGeneration.current += 1;
    },
    [],
  );
  const devices = new Map<string, string>();
  for (const item of snapshot.entities) {
    if (item.kind === "device" && item.hostRef && !item.hostRef.entityId.startsWith("cloud:"))
      devices.set(item.hostRef.environmentId, item.title);
  }
  if (entity?.hostRef && !devices.has(entity.hostRef.environmentId))
    devices.set(entity.hostRef.environmentId, "Project computer");
  for (const source of context.sources)
    if (!devices.has(source.environmentId)) devices.set(source.environmentId, "Saved computer");
  const availableDevices = new Map([...devices].filter(([id]) => ownedEnvironmentIds.has(id)));
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    entity?.hostRef && availableDevices.has(entity.hostRef.environmentId)
      ? entity.hostRef.environmentId
      : (availableDevices.keys().next().value ?? ""),
  );
  const [pickerDeviceId, setPickerDeviceId] = useState<string | null>(null);
  const [checkingFolder, setCheckingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    initial.accountId === accountId &&
    !!catalog &&
    (entity?.kind === "project" || entity?.kind === "section");
  const dirtyInstructions = draftInstructions !== initial.instructions;
  const instructions = dirtyInstructions ? draftInstructions : context.instructions;
  const sources = [...context.sources.filter((source) => !removed.has(source.id)), ...added];
  const effective = resolveCatalogContext(
    {
      ...snapshot,
      contexts: [
        ...(snapshot.contexts ?? []).filter((item) => item.entityId !== entityId),
        { entityId, instructions, sources },
      ],
    },
    { entityId, environmentId: selectedDeviceId },
  );
  const inherited = effective.layers.filter((layer) => layer.entityId !== entityId);
  const addFolder = async (environmentId: string, path: string) => {
    const generation = ++selectionGeneration.current;
    const assertDestination = () => {
      const owner = catalog.getSnapshot().entities.find((item) => item.id === entityId);
      if (!valid || (owner?.kind !== "project" && owner?.kind !== "section"))
        throw new Error("This library item is no longer available.");
      if (
        !devices.has(environmentId) ||
        !appAtomRegistry.get(minesAccountEnvironmentIdsAtom).has(environmentId)
      )
        throw new Error("This computer is no longer connected to this account.");
      if (!readEnvironmentScope(EnvironmentId.make(environmentId), AuthFilesystemReadScope))
        throw new Error("This connection cannot read folders on that computer.");
    };
    try {
      assertDestination();
      const normalized = normalizeCatalogSourcePath(path);
      setCheckingFolder(true);
      const metadata = await getMetadata({
        environmentId: EnvironmentId.make(environmentId),
        input: { paths: [normalized] },
      });
      if (generation !== selectionGeneration.current) return;
      assertDestination();
      if (metadata._tag !== "Success")
        throw new Error("This folder could not be read on the selected computer.");
      if (metadata.value.entries[0]?.kind !== "directory")
        throw new Error("Choose a folder that exists on this computer.");
      if (
        !sources.some(
          (source) =>
            source.environmentId === environmentId &&
            source.kind === "directory" &&
            source.path === normalized,
        )
      )
        setAdded((current) => [
          ...current,
          { id: `draft:${uuidv4()}`, environmentId, kind: "directory", path: normalized },
        ]);
      setPickerDeviceId(null);
      setError(null);
    } catch (cause) {
      if (generation === selectionGeneration.current)
        setError(cause instanceof Error ? cause.message : "Could not add this folder.");
    } finally {
      if (generation === selectionGeneration.current) setCheckingFolder(false);
    }
  };
  const save = () => {
    if (!valid || !catalog) return;
    try {
      const uniqueSources = new Set(
        sources.map((source) => JSON.stringify([source.environmentId, source.kind, source.path])),
      );
      if (added.length && uniqueSources.size > MAX_CATALOG_CONTEXT_SOURCES)
        throw new Error(`Keep context sources within ${MAX_CATALOG_CONTEXT_SOURCES} per item.`);
      catalog.transaction(() => {
        if (dirtyInstructions) catalog.setContextInstructions(entityId, instructions);
        for (const id of removed) catalog.removeContextSource(entityId, id);
        for (const source of added)
          catalog.addContextSource(entityId, {
            environmentId: source.environmentId,
            kind: source.kind,
            path: source.path,
          });
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save context settings.");
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background">
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
            <Pressable accessibilityRole="button" onPress={onClose} className="p-2">
              <Text>Cancel</Text>
            </Pressable>
            <Text accessibilityRole="header" className="flex-1 font-semibold">
              Instructions & sources
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !valid }}
              disabled={!valid}
              onPress={save}
              className="p-2"
            >
              <Text>Save</Text>
            </Pressable>
          </View>
          {!valid ? (
            <Text accessibilityRole="alert" className="p-4 text-muted-foreground">
              This library item is no longer available. Close this editor to continue.
            </Text>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 p-4">
              <Text className="text-lg font-semibold">{entity.title}</Text>
              <Text className="text-sm text-muted-foreground">
                Mines inherit section instructions first, then project instructions. Changes apply
                to new runs after this library reaches the executing computer.
              </Text>
              {inherited.map((layer) => (
                <View key={layer.entityId} className="gap-2 rounded-xl bg-muted p-3">
                  <Text className="text-sm font-medium">Inherited from {layer.title}</Text>
                  <Text className="text-sm text-muted-foreground">
                    {layer.instructions || "No custom instructions."}
                  </Text>
                </View>
              ))}
              <View className="gap-2">
                <Text className="font-medium">Custom instructions</Text>
                <AppTextInput
                  accessibilityLabel="Custom instructions"
                  multiline
                  textAlignVertical="top"
                  value={instructions}
                  onChangeText={(value) => {
                    if (!dirtyInstructions)
                      setInitial({ ...initial, instructions: context.instructions });
                    setDraftInstructions(value);
                  }}
                  maxLength={32_768}
                  placeholder={`How should the AI work on mines in this ${entity.kind}?`}
                  className="min-h-40"
                />
                {dirtyInstructions &&
                context.instructions !== initial.instructions &&
                context.instructions !== draftInstructions ? (
                  <View className="gap-2 rounded-xl bg-muted p-3">
                    <Text className="text-sm">
                      Instructions changed on another device. Saving will keep your edit.
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      className="self-start py-2"
                      onPress={() => {
                        setDraftInstructions(context.instructions);
                        setInitial({ ...initial, instructions: context.instructions });
                      }}
                    >
                      <Text className="text-sm font-medium">Use latest instructions</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
              <View className="gap-3">
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="font-medium">Context sources</Text>
                  <Menu
                    actions={[...availableDevices].map(([id, title]) => ({
                      id,
                      title,
                      image: "desktopcomputer",
                      state: selectedDeviceId === id ? "on" : "off",
                    }))}
                    onPressAction={({ nativeEvent }) => {
                      if (!availableDevices.has(nativeEvent.event)) return;
                      selectionGeneration.current += 1;
                      setSelectedDeviceId(nativeEvent.event);
                      setPickerDeviceId(null);
                      setCheckingFolder(false);
                      setError(null);
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Choose source computer"
                      className="flex-row items-center gap-1.5 py-2"
                    >
                      <SymbolView
                        name="desktopcomputer"
                        size={14}
                        tintColorClassName="accent-icon-muted"
                      />
                      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                        {availableDevices.get(selectedDeviceId) ?? "Choose computer"} ▾
                      </Text>
                    </Pressable>
                  </Menu>
                </View>
                <Text className="text-sm text-muted-foreground">
                  Add folders from the computer that will read them. The mine keeps its workspace
                  and existing permissions.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add folder"
                  accessibilityState={{ disabled: !availableDevices.has(selectedDeviceId) }}
                  disabled={!availableDevices.has(selectedDeviceId)}
                  onPress={() => {
                    setError(null);
                    setPickerDeviceId(selectedDeviceId);
                  }}
                  className="min-h-20 flex-row items-center justify-center gap-3 rounded-xl border border-dashed border-border p-4"
                >
                  <SymbolView
                    name="folder.badge.plus"
                    size={24}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text className="font-medium">Add folder</Text>
                </Pressable>
                {!availableDevices.size ? (
                  <Text className="text-sm text-muted-foreground">
                    Pair a computer to choose its folders.
                  </Text>
                ) : null}
                {sources.map((source) => (
                  <View key={source.id} className="gap-2 rounded-xl border border-border p-3">
                    <Text className="text-xs text-muted-foreground">
                      {devices.get(source.environmentId) ?? "Saved computer"} ·{" "}
                      {source.kind === "directory" ? "Folder" : "File"}
                    </Text>
                    <Text selectable className="text-sm">
                      {source.path}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove context source ${source.path}`}
                      className="self-start py-2"
                      onPress={() => {
                        setAdded((current) => current.filter((item) => item.id !== source.id));
                        setRemoved((current) => new Set([...current, source.id]));
                      }}
                    >
                      <Text className="text-sm text-destructive">Remove</Text>
                    </Pressable>
                  </View>
                ))}
                {effective.sources
                  .filter((source) => source.ownerEntityId !== entityId)
                  .map((source) => (
                    <Text key={source.id} className="text-sm text-muted-foreground">
                      From {source.ownerTitle}: {source.path}
                    </Text>
                  ))}
                {effective.unavailableSources.length ? (
                  <Text className="text-sm text-muted-foreground">
                    {effective.unavailableSources.length} saved source
                    {effective.unavailableSources.length === 1 ? " belongs" : "s belong"} to other
                    computers and will not be used on this device.
                  </Text>
                ) : null}
              </View>
              {error ? (
                <Text accessibilityRole="alert" className="text-destructive">
                  {error}
                </Text>
              ) : null}
              {persistenceError ? (
                <Text accessibilityRole="alert" className="text-destructive">
                  {persistenceError}
                </Text>
              ) : null}
            </ScrollView>
          )}
        </KeyboardAvoidingView>
        {pickerDeviceId !== null ? (
          <CatalogFolderPicker
            key={pickerDeviceId}
            environmentId={pickerDeviceId}
            platform={
              configs.get(EnvironmentId.make(pickerDeviceId))?.environment.platform.os === "windows"
                ? "Win32"
                : ""
            }
            initialPath={getAddProjectInitialQuery(
              configs.get(EnvironmentId.make(pickerDeviceId))?.settings.addProjectBaseDirectory,
            )}
            error={error}
            busy={checkingFolder}
            onSelectDirectory={(path) => addFolder(pickerDeviceId, path)}
            onClose={() => {
              selectionGeneration.current += 1;
              setCheckingFolder(false);
              setPickerDeviceId(null);
            }}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

function CatalogFolderPicker({
  environmentId,
  platform,
  initialPath,
  error,
  busy,
  onSelectDirectory,
  onClose,
}: {
  environmentId: string;
  platform: string;
  initialPath: string;
  error: string | null;
  busy: boolean;
  onSelectDirectory: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pathInput, setPathInput] = useState(initialPath);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <Text accessibilityRole="header" className="flex-1 font-semibold">
            Choose folder
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose} className="p-2">
            <Text>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="gap-4 p-4">
          {error ? (
            <Text accessibilityRole="alert" className="text-destructive">
              {error}
            </Text>
          ) : null}
          <FolderBrowser
            environment={{ environmentId: EnvironmentId.make(environmentId), platform }}
            pathInput={pathInput}
            setPathInput={setPathInput}
            navigateToBrowsePath={async ({ browseDirectoryPath, selectedDirectoryName }) => {
              setPathInput(
                selectedDirectoryName
                  ? appendBrowsePathSegment(browseDirectoryPath, selectedDirectoryName)
                  : ensureBrowseDirectoryPath(browseDirectoryPath),
              );
              return true;
            }}
            onSelectDirectory={onSelectDirectory}
            isSelectingDirectory={busy}
          />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

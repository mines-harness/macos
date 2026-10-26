import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { rankModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

function hasConnectedAccount(entry: ProviderInstanceEntry): boolean {
  return entry.snapshot.auth.status === "authenticated";
}

function providerSectionKey(instanceId: ProviderInstanceId): string {
  return `provider-section:${instanceId}`;
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      !hasConnectedAccount(entry) ||
      !options.some((option) => !option.isUnavailable))
  );
}

function adjacentModelPickerProvider(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selectedInstanceId: ProviderInstanceId | "favorites";
  direction: 1 | -1;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
}) {
  const providers: Array<ProviderInstanceId | "favorites"> = [
    "favorites",
    ...input.entries
      .filter(
        (entry) =>
          !input.disabledInstanceIds?.has(entry.instanceId) &&
          (isProviderInstancePickerReady(entry) ||
            input.selectableUnavailableInstanceIds?.has(entry.instanceId)),
      )
      .map((entry) => entry.instanceId),
  ];
  const index = providers.indexOf(input.selectedInstanceId);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 52;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

function modelJumpLabelsByKey(
  modelKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
): ReadonlyMap<string, string> {
  const shortcutLabelOptions = {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
  };
  const mapping = new Map<string, string>();
  for (const [index, modelKey] of modelKeys.entries()) {
    const command = modelPickerJumpCommandForIndex(index);
    const label = command && shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(modelKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
}

function ModelPickerProviderNotices({
  setupEntries,
  updateRequiredNotices,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  updateRequiredNotices: ReadonlyArray<{ instanceId: ProviderInstanceId; notice: string }>;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const navigate = useNavigate();
  return (
    <>
      {setupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {setupEntries.map((entry) => (
            <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
              <p className="line-clamp-3 text-muted-foreground">
                {getProviderStatusMessage(entry.snapshot)}
              </p>
              <InlineButton
                className="mt-1"
                onClick={() => {
                  onRequestClose?.();
                  onOpenProviderSetup?.(entry.instanceId);
                }}
              >
                {setupEntries.length > 1 ? `Set up ${entry.displayName}` : "Open provider setup"}
              </InlineButton>
            </div>
          ))}
        </div>
      ) : (
        <ComboboxEmpty className="empty:h-0">No models found</ComboboxEmpty>
      )}
      {updateRequiredNotices.map(({ instanceId, notice }) => (
        <p
          key={instanceId}
          className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
        >
          {notice}{" "}
          <InlineButton
            onClick={() => {
              onRequestClose?.();
              void navigate({ to: "/settings/providers" });
            }}
          >
            Provider settings
          </InlineButton>
        </p>
      ))}
    </>
  );
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const [contentSize, setContentSize] = useState(
    () => itemKeys.length * MODEL_LIST_ESTIMATED_ITEM_SIZE,
  );
  useLayoutEffect(() => listRef.current?.getState().listen("totalSize", setContentSize), [listRef]);
  const updateScrollFades = () => {
    const scrollElement = listRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  };

  // Disabled-reason closures rebuild identical key arrays; compare contents.
  const itemListKey = JSON.stringify(itemKeys);
  const [fadesResetFor, setFadesResetFor] = useState(itemListKey);
  if (fadesResetFor !== itemListKey) {
    setFadesResetFor(itemListKey);
    setShowTopScrollFade(false);
    setShowBottomScrollFade(itemKeys.length > 5);
  }
  const measureScrollFades = useEffectEvent(updateScrollFades);
  useLayoutEffect(() => {
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      measureScrollFades();
      nestedFrame = window.requestAnimationFrame(() => measureScrollFades());
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new list re-measures its scroll fades once it has laid out.
  }, [itemListKey]);

  return (
    <div
      className="relative min-h-0 overflow-hidden pr-px"
      style={{
        height: itemKeys.length === 0 ? 0 : `calc(${contentSize}px + var(--spacing) * 5)`,
      }}
    >
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={listRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(modelKey) => modelKey}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({
              top: showTopScrollFade,
              bottom: showBottomScrollFade,
            }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = props.selectedModels?.map((selection) => {
    const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
  });
  const selectedModelKeySet = new Set(
    selectedModelKeys ?? (activeModelKey ? [activeModelKey] : []),
  );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    props.activeInstanceId,
  );
  const [expandedDisconnectedInstances, setExpandedDisconnectedInstances] = useState(
    () => new Set<ProviderInstanceId>(),
  );
  const [collapsedConnectedInstances, setCollapsedConnectedInstances] = useState(
    () => new Set<ProviderInstanceId>(),
  );
  const favoritesSet = new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        activeModel?.isLegacy &&
          !favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
          ? [props.activeInstanceId]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const [searchHeight, setSearchHeight] = useState(0);
  const toggleFavorite = useToggleEnvironmentModelFavorite(props.environmentId);

  const focusSearchInput = () => {
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const handleSelectInstance = (instanceId: ProviderInstanceId | "favorites") => {
    setSelectedInstanceId(instanceId);
    if (instanceId !== "favorites") {
      setExpandedDisconnectedInstances((expanded) => new Set([...expanded, instanceId]));
      setCollapsedConnectedInstances((collapsed) => {
        const next = new Set(collapsed);
        next.delete(instanceId);
        return next;
      });
    }
    window.requestAnimationFrame(() => {
      const key =
        instanceId === "favorites"
          ? filteredItemKeys.find((key) => {
              const model = parseModelPickerModelKey(key);
              return model && favoritesSet.has(providerModelKey(model.instanceId, model.slug));
            })
          : providerSectionKey(instanceId);
      const index = key ? filteredItemKeys.indexOf(key) : -1;
      if (index >= 0) void modelListRef.current?.scrollToIndex({ index, animated: false });
      focusSearchInput();
    });
  };

  const toggleProviderSection = (entry: ProviderInstanceEntry) => {
    setSelectedInstanceId(entry.instanceId);
    const update = hasConnectedAccount(entry)
      ? setCollapsedConnectedInstances
      : setExpandedDisconnectedInstances;
    update((instances) => {
      const next = new Set(instances);
      if (next.has(entry.instanceId)) next.delete(entry.instanceId);
      else next.add(entry.instanceId);
      return next;
    });
  };

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  const toggleLegacySection = (instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  const handleModelSelect = (
    modelSlug: string,
    instanceId: ProviderInstanceId,
    additive = false,
  ): string | null => {
    if (modelDisabledReason(instanceId, modelSlug)) {
      return null;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return null;
    }
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) {
      return null;
    }
    const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
    if (!resolvedModel) return null;
    if (additive && onToggleModel) {
      onToggleModel(instanceId, resolvedModel);
    } else {
      onInstanceModelChange(instanceId, resolvedModel);
    }
    return resolvedModel;
  };

  const modelJumpShortcutContext = {
    terminalFocus: false,
    terminalOpen: props.terminalOpen,
    modelPickerOpen: true,
  } as const;
  const lockedProvider = props.lockedProvider;
  const lockedContinuationGroupKey = props.lockedContinuationGroupKey;
  const canOpenProviderSetup = onOpenProviderSetup !== undefined;

  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const matchesLockedProvider = (
    entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  ): boolean => {
    if (lockedProvider === null) return true;
    if (entry.driverKind !== lockedProvider) return false;
    if (!lockedContinuationGroupKey) return true;
    return entry.continuationGroupKey === lockedContinuationGroupKey;
  };

  const selectableUnavailableInstanceIds = new Set(
    instanceEntries.map((entry) => entry.instanceId),
  );
  const orderedEntries = [...instanceEntries].sort(
    (left, right) => Number(hasConnectedAccount(right)) - Number(hasConnectedAccount(left)),
  );
  const modelDisabledReason = (instanceId: ProviderInstanceId, model: string): string | null => {
    const entry = entryByInstanceId.get(instanceId);
    if (!entry || !hasConnectedAccount(entry)) return "Connect this account to use its models.";
    if (!isProviderInstancePickerReady(entry)) return getProviderStatusMessage(entry.snapshot);
    if (!matchesLockedProvider(entry)) return "Start a new mine to switch providers.";
    return getModelDisabledReason?.(instanceId, model) ?? null;
  };

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        continue;
      }
      for (const model of models) {
        if (entry.driverKind === "antigravity" && model.slug === ANTIGRAVITY_DEFAULT_MODEL)
          continue;
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.acpRegistryAgentId ? { acpRegistryAgentId: entry.acpRegistryAgentId } : {}),
          ...(entry.acpRegistryIconUrl ? { acpRegistryIconUrl: entry.acpRegistryIconUrl } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  })();

  const isLocked = lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const lockedDisabledInstanceIds = (() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  })();
  const sidebarInstanceEntries = orderedEntries;
  const showSidebar = !isSearching && sidebarInstanceEntries.length > 1;
  const filteredModels = isSearching
    ? rankModelPickerSearch(flatModels, searchQuery, (model) => ({
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      }))
    : sortProviderModelItems(flatModels, {
        favoriteModelKeys: favoritesSet,
        groupFavorites: true,
        instanceOrder: orderedEntries.map((entry) => entry.instanceId),
      });
  const providerSections = orderedEntries.flatMap((entry) => {
    const models = filteredModels.filter((model) => model.instanceId === entry.instanceId);
    if (isSearching && models.length === 0) return [];
    const isExpanded =
      isSearching ||
      (hasConnectedAccount(entry)
        ? !collapsedConnectedInstances.has(entry.instanceId)
        : expandedDisconnectedInstances.has(entry.instanceId));
    const currentModels: ModelPickerItem[] = [];
    const legacyModels: ModelPickerItem[] = [];
    for (const model of models) {
      const legacy =
        model.isLegacy && !favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      (legacy ? legacyModels : currentModels).push(model);
    }
    return [
      {
        entry,
        key: providerSectionKey(entry.instanceId),
        isExpanded,
        currentModels,
        legacyModels,
        legacyExpanded: isSearching || expandedLegacyInstances.has(entry.instanceId),
      },
    ];
  });
  const visibleModels = providerSections.flatMap((section) =>
    section.isExpanded
      ? [...section.currentModels, ...(section.legacyExpanded ? section.legacyModels : [])]
      : [],
  );
  const providerSectionByKey = new Map(providerSections.map((section) => [section.key, section]));
  const legacySectionByKey = new Map(
    providerSections.map((section) => [
      modelPickerLegacySectionKey(section.entry.instanceId),
      section,
    ]),
  );

  const selectedEntry =
    selectedInstanceId === "favorites" ? undefined : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && canOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            entry.instanceId === selectedEntry?.instanceId &&
            providerSections.some(
              (section) => section.entry.instanceId === entry.instanceId && section.isExpanded,
            ),
        )
      : [];

  const updateRequiredNotices = instanceEntries.flatMap((entry) => {
    const shown = isSearching
      ? matchesLockedProvider(entry)
      : entry.instanceId === selectedEntry?.instanceId;
    const notice = shown ? formatProviderUpdateRequiredNotice(entry.snapshot, searchQuery) : null;
    return notice ? [{ instanceId: entry.instanceId, notice }] : [];
  });

  const modelJumpModelKeys = visibleModels
    .filter((model) => !modelDisabledReason(model.instanceId, model.slug))
    .slice(0, MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.length)
    .map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const allItemKeys = [
    ...orderedEntries.map((entry) => providerSectionKey(entry.instanceId)),
    ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    ...orderedEntries.map((entry) => modelPickerLegacySectionKey(entry.instanceId)),
  ];
  const filteredItemKeys = providerSections.flatMap((section) => [
    section.key,
    ...(section.isExpanded
      ? [
          ...section.currentModels.map((model) =>
            modelPickerModelKey(model.instanceId, model.slug),
          ),
          ...(section.legacyModels.length > 0
            ? [modelPickerLegacySectionKey(section.entry.instanceId)]
            : []),
          ...(section.legacyExpanded
            ? section.legacyModels.map((model) => modelPickerModelKey(model.instanceId, model.slug))
            : []),
        ]
      : []),
  ]);
  const filteredModelByKey = ((): ReadonlyMap<string, ModelPickerItem> =>
    new Map(
      visibleModels.map(
        (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
      ),
    ))();

  const modelJumpLabelByKey = modelJumpLabelsByKey(
    modelJumpModelKeys,
    keybindings,
    props.terminalOpen,
  );
  const modelListExtraData = {
    favoritesSet,
    modelJumpLabelByKey,
    activeModelKey,
    selectedModelKeySet,
    providerSections,
  };

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    });
    if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
      event.preventDefault();
      event.stopPropagation();
      const next = adjacentModelPickerProvider({
        entries: sidebarInstanceEntries,
        selectedInstanceId,
        direction: command === "modelPicker.nextProvider" ? 1 : -1,
        disabledInstanceIds: lockedDisabledInstanceIds,
        selectableUnavailableInstanceIds,
      });
      setSearchQuery("");
      handleSelectInstance(next);
      announce(
        next === "favorites" ? "Favorites" : (entryByInstanceId.get(next)?.displayName ?? next),
        "model-picker",
      );
      return;
    }
    const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const targetModelKey = modelJumpModelKeys[jumpIndex];
    if (!targetModelKey) {
      return;
    }
    const model = parseModelPickerModelKey(targetModelKey);
    if (!model) {
      return;
    }
    const selectedSlug = handleModelSelect(model.slug, model.instanceId);
    if (selectedSlug === null) return;
    const name = flatModels.find(
      (item) => item.slug === selectedSlug && item.instanceId === model.instanceId,
    )?.name;
    announce(`Model: ${name ?? selectedSlug}`, "model-picker");
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className="relative flex min-h-0 max-h-86.5 w-screen max-w-90 flex-row overflow-hidden"
        style={isSearching ? { height: searchHeight } : undefined}
        data-model-picker-content="true"
      >
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusSearch={focusSearchInput}
            instanceEntries={sidebarInstanceEntries}
            showFavorites={favorites.length > 0}
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    `${entry.displayName} is unavailable in this mine. Start a new mine to switch providers.`,
                }
              : {})}
          />
        )}

        <Combobox<string, boolean>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            const providerSection = providerSectionByKey.get(modelKey);
            if (providerSection) {
              toggleProviderSection(providerSection.entry);
              return;
            }
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            <ComboboxSearchInput
              ref={searchInputRef}
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => {
                if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                setSearchQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (
                  showSidebar &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                    (e.key === "Tab" && e.shiftKey))
                ) {
                  const sidebar = e.currentTarget
                    .closest("[data-model-picker-content]")
                    ?.querySelector("[data-model-picker-sidebar]");
                  const button =
                    sidebar?.querySelector<HTMLButtonElement>(
                      'button[aria-pressed="true"]:not(:disabled)',
                    ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                  if (button) {
                    e.preventDefault();
                    e.stopPropagation();
                    button.focus();
                    return;
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose?.();
                  return;
                }
                if (e.key === "Enter" && highlightedModelKeyRef.current) {
                  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  e.preventDefault();
                  e.stopPropagation();
                  const providerSection = providerSectionByKey.get(highlightedModelKeyRef.current);
                  if (providerSection) {
                    toggleProviderSection(providerSection.entry);
                    return;
                  }
                  const legacyInstanceId = parseModelPickerLegacySectionKey(
                    highlightedModelKeyRef.current,
                  );
                  if (legacyInstanceId) {
                    toggleLegacySection(legacyInstanceId);
                    return;
                  }
                  const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                  if (model) {
                    handleModelSelect(model.slug, model.instanceId, e.shiftKey);
                  }
                  return;
                }
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />

            <ModelPickerList
              listRef={modelListRef}
              itemKeys={filteredItemKeys}
              extraData={modelListExtraData}
              renderItem={({ item: modelKey, index }) => {
                const providerSection = providerSectionByKey.get(modelKey);
                if (providerSection) {
                  const { entry, isExpanded } = providerSection;
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={modelKey}
                      aria-label={`${entry.displayName} models`}
                      aria-expanded={isExpanded}
                      className="group w-full cursor-pointer"
                    >
                      <ProviderInstanceIcon
                        driverKind={entry.driverKind}
                        displayName={entry.displayName}
                        className="size-4"
                        iconClassName="size-4"
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {entry.displayName}
                      </span>
                      {!hasConnectedAccount(entry) ? (
                        <span className="text-xs text-muted-foreground">Not connected</span>
                      ) : null}
                      <ChevronRightIcon
                        className={cn(
                          "size-3.5 transition-transform motion-reduce:transition-none",
                          isExpanded && "rotate-90",
                        )}
                      />
                    </ComboboxItem>
                  );
                }
                const legacySection = legacySectionByKey.get(modelKey);
                if (legacySection) {
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={modelKey}
                      aria-expanded={legacySection.legacyExpanded}
                      className="group w-full cursor-pointer"
                    >
                      <div className="min-w-0 flex-1 text-left">
                        <div className="text-xs font-medium leading-snug">Legacy models</div>
                        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
                          {legacySection.legacyModels.length} models
                        </div>
                      </div>
                      <ChevronRightIcon
                        className={cn(
                          "size-4 transition-transform",
                          legacySection.legacyExpanded && "rotate-90",
                        )}
                      />
                    </ComboboxItem>
                  );
                }
                const model = filteredModelByKey.get(modelKey);
                if (!model) {
                  return null;
                }
                const disabledReason = modelDisabledReason(model.instanceId, model.slug);
                return (
                  <ModelListRow
                    key={modelKey}
                    index={index}
                    slug={model.slug}
                    name={model.name}
                    shortName={model.shortName}
                    subProvider={model.subProvider}
                    instanceId={model.instanceId}
                    driverKind={model.driverKind}
                    providerDisplayName={model.instanceDisplayName}
                    providerAccentColor={model.instanceAccentColor}
                    acpRegistryAgentId={model.acpRegistryAgentId}
                    acpRegistryIconUrl={model.acpRegistryIconUrl}
                    isFavorite={favoritesSet.has(providerModelKey(model.instanceId, model.slug))}
                    isSelected={
                      selectedModelKeys !== undefined
                        ? selectedModelKeySet.has(modelKey)
                        : modelKey === activeModelKey
                    }
                    showSelection={selectedModelKeys !== undefined}
                    showProvider
                    preferShortName={!isLocked}
                    useTriggerLabel={false}
                    showNewBadge={model.badge === "new"}
                    unavailable={model.isUnavailable === true}
                    jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                    disabledReason={disabledReason}
                    onToggleModel={
                      onToggleModel
                        ? (instanceId, slug) => {
                            handleModelSelect(slug, instanceId, true);
                          }
                        : undefined
                    }
                    onToggleFavorite={toggleFavorite}
                  />
                );
              }}
            />
            <ModelPickerProviderNotices
              setupEntries={providerSetupEntries}
              updateRequiredNotices={updateRequiredNotices}
              onRequestClose={onRequestClose}
              onOpenProviderSetup={onOpenProviderSetup}
            />
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});

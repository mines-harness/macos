import { useAtomValue } from "@effect/atom-react";
import {
  catalogContextFor,
  MAX_CATALOG_CONTEXT_SOURCES,
  minesAccountEnvironmentIdsAtom,
  resolveCatalogContext,
  type MinesCatalog,
  type MinesCatalogContextSource,
  type MinesCatalogEntity,
  type MinesCatalogSnapshot,
} from "@t3tools/client-runtime/catalog";
import { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, FileIcon, FolderIcon, FolderPlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useMinesCatalog } from "../../catalog/useMinesCatalog";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { readLocalApi } from "../../localApi";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import {
  createCatalogFolderSource,
  catalogNativeFolderPickerTarget,
} from "./catalogFolderSelection.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export function CatalogContextDialog({
  entityId,
  onClose,
}: {
  readonly entityId: string;
  readonly onClose: () => void;
}) {
  const { catalog, snapshot, accountId, error } = useMinesCatalog();
  const entity = snapshot.entities.find((item) => item.id === entityId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        {catalog && entity && (entity.kind === "section" || entity.kind === "project") ? (
          <ContextEditor
            key={`${accountId}:${entityId}`}
            catalog={catalog}
            snapshot={snapshot}
            entity={entity}
            onClose={onClose}
            persistenceError={error}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Instructions &amp; sources</DialogTitle>
              <DialogDescription>
                {error ?? "This project or section is no longer available in this account."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={onClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ContextEditor({
  catalog,
  snapshot,
  entity,
  onClose,
  persistenceError,
}: {
  readonly catalog: MinesCatalog;
  readonly snapshot: MinesCatalogSnapshot;
  readonly entity: MinesCatalogEntity;
  readonly onClose: () => void;
  readonly persistenceError: string | null;
}) {
  const current = catalogContextFor(snapshot, entity.id);
  const [baseInstructions, setBaseInstructions] = useState(current.instructions);
  const [draftInstructions, setDraftInstructions] = useState(current.instructions);
  const [added, setAdded] = useState<readonly MinesCatalogContextSource[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const primaryId = usePrimaryEnvironmentId();
  const ownedEnvironments = useAtomValue(minesAccountEnvironmentIdsAtom);
  const { environments } = useEnvironments();
  const choices = environments.filter(
    (environment) =>
      environment.environmentId === primaryId || ownedEnvironments.has(environment.environmentId),
  );
  const desktopBootstraps = (() => {
    try {
      return window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
    } catch {
      return [];
    }
  })();
  const nativePickerTargets = new Map(
    choices.map((environment) => [
      environment.environmentId,
      catalogNativeFolderPickerTarget(environment.entry.target, desktopBootstraps),
    ]),
  );
  const [selectedEnvironment, setSelectedEnvironment] = useState(
    choices.find((environment) => nativePickerTargets.get(environment.environmentId) != null)
      ?.environmentId ??
      primaryId ??
      entity.hostRef?.environmentId ??
      choices[0]?.environmentId ??
      "",
  );
  const environmentId = choices.some(
    (environment) => environment.environmentId === selectedEnvironment,
  )
    ? EnvironmentId.make(selectedEnvironment)
    : null;
  const deviceName = (id: string) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const dirtyInstructions = draftInstructions !== baseInstructions;
  const instructions = dirtyInstructions ? draftInstructions : current.instructions;
  const conflict =
    dirtyInstructions &&
    current.instructions !== baseInstructions &&
    current.instructions !== draftInstructions;
  const sources = [...current.sources.filter((source) => !removed.has(source.id)), ...added];
  const preview = resolveCatalogContext(
    {
      ...snapshot,
      contexts: [
        ...(snapshot.contexts ?? []).filter((context) => context.entityId !== entity.id),
        { entityId: entity.id, instructions, sources },
      ],
    },
    { entityId: entity.id, environmentId: selectedEnvironment },
  );
  const inherited = preview.layers.filter((layer) => layer.entityId !== entity.id);
  const inheritedSources = [...preview.sources, ...preview.unavailableSources].filter(
    (source) => source.ownerEntityId !== entity.id,
  );
  const save = () => {
    if (conflict) return;
    try {
      if (added.length > 0 && sources.length > MAX_CATALOG_CONTEXT_SOURCES)
        throw new Error(`You can add up to ${MAX_CATALOG_CONTEXT_SOURCES} context sources.`);
      catalog.transaction(() => {
        if (dirtyInstructions) catalog.setContextInstructions(entity.id, instructions);
        for (const id of removed) catalog.removeContextSource(entity.id, id);
        for (const source of added) catalog.addContextSource(entity.id, source);
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save context.");
    }
  };
  const remove = (sourceId: string) => {
    if (added.some((source) => source.id === sourceId))
      setAdded(added.filter((source) => source.id !== sourceId));
    else setRemoved(new Set([...removed, sourceId]));
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Instructions &amp; sources</DialogTitle>
        <DialogDescription>
          {entity.title} · {entity.kind === "section" ? "Section" : "Project"}. These settings apply
          to mines inside it.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {inherited.length > 0 ? (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Inherited first</p>
            {inherited.map((layer) => (
              <details key={layer.entityId} className="mt-2">
                <summary className="cursor-pointer text-muted-foreground">{layer.title}</summary>
                <p className="mt-2 whitespace-pre-wrap">
                  {layer.instructions || "No custom instructions."}
                </p>
              </details>
            ))}
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="catalog-context-instructions">Custom instructions</Label>
          <Textarea
            id="catalog-context-instructions"
            rows={7}
            maxLength={32_768}
            value={instructions}
            placeholder={`How should AI work on mines in this ${entity.kind === "section" ? "section" : "project"}?`}
            onChange={(event) => {
              if (!dirtyInstructions) setBaseInstructions(current.instructions);
              setDraftInstructions(event.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Section instructions apply first, followed by project instructions. Changes apply to the
            next message.
          </p>
        </div>
        {conflict ? (
          <div role="status" className="space-y-2 rounded-lg border border-border p-3 text-sm">
            <p>Instructions changed on another device while you were editing.</p>
            <details>
              <summary className="cursor-pointer">Review the latest version</summary>
              <p className="mt-2 whitespace-pre-wrap">
                {current.instructions || "No custom instructions."}
              </p>
            </details>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBaseInstructions(current.instructions);
                  setDraftInstructions(current.instructions);
                }}
              >
                Use latest
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBaseInstructions(current.instructions)}
              >
                Keep my edit
              </Button>
            </div>
          </div>
        ) : null}
        <div className="space-y-2">
          <Label>Source folders</Label>
          <p className="text-xs text-muted-foreground">
            Folders stay on their computer and are read by the AI as needed.
          </p>
          <div className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border border-border px-4 py-5">
            <div className="flex max-w-full flex-wrap items-center justify-center gap-1 text-sm">
              <span className="text-muted-foreground">Add a folder on</span>
              <div className="max-w-full">
                <Select
                  value={environmentId ?? ""}
                  items={choices.map((environment) => ({
                    value: environment.environmentId,
                    label: environment.label,
                  }))}
                  onValueChange={(value) => setSelectedEnvironment(value ?? "")}
                >
                  <SelectTrigger size="sm" variant="ghost" aria-label="Source computer">
                    <SelectValue placeholder="Choose a computer" />
                  </SelectTrigger>
                  <SelectPopup>
                    {choices.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            {environmentId ? (
              <AddContextSource
                key={environmentId}
                environmentId={environmentId}
                computerName={deviceName(environmentId)}
                nativePickerTarget={nativePickerTargets.get(environmentId) ?? null}
                onAdd={(source) => {
                  if (
                    sources.some(
                      (existing) =>
                        existing.environmentId === source.environmentId &&
                        existing.kind === source.kind &&
                        existing.path === source.path,
                    )
                  )
                    return;
                  if (sources.length >= MAX_CATALOG_CONTEXT_SOURCES) {
                    setError(`You can add up to ${MAX_CATALOG_CONTEXT_SOURCES} context sources.`);
                    return;
                  }
                  setAdded([...added, { ...source, id: `draft:${randomUUID()}` }]);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect a computer belonging to this account to add folders.
              </p>
            )}
          </div>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No folders added yet.</p>
          ) : (
            sources.map((source) => (
              <div
                key={source.id}
                className="flex items-center gap-2 rounded-lg border border-border p-2 text-sm"
              >
                {source.kind === "directory" ? (
                  <FolderIcon className="size-4 shrink-0" />
                ) : (
                  <FileIcon className="size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="break-all">{source.path}</p>
                  <p className="text-xs text-muted-foreground">
                    {deviceName(source.environmentId)}
                    {source.environmentId !== selectedEnvironment
                      ? " · Available on that computer only"
                      : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${source.path}`}
                  onClick={() => remove(source.id)}
                >
                  <XIcon />
                </Button>
              </div>
            ))
          )}
        </div>
        {inheritedSources.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer">
              Inherited sources ({inheritedSources.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {inheritedSources.map((source) => (
                <li key={source.id} className="break-all">
                  {source.path}
                  <span className="block text-xs text-muted-foreground">
                    From {source.ownerTitle} · {deviceName(source.environmentId)}
                    {source.environmentId !== selectedEnvironment ? " · Other computer" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <details className="text-sm">
          <summary className="cursor-pointer">
            Preview for {deviceName(selectedEnvironment) || "this computer"}
          </summary>
          <div className="mt-2 space-y-3">
            {preview.layers.map((layer) => (
              <div key={layer.entityId}>
                <p className="font-medium">{layer.title}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {layer.instructions || "No custom instructions."}
                </p>
              </div>
            ))}
            <p>
              {preview.sources.length} source{preview.sources.length === 1 ? "" : "s"} available
              here.
              {preview.unavailableSources.length
                ? ` ${preview.unavailableSources.length} on other computers will not be applied here.`
                : ""}
            </p>
          </div>
        </details>
        {error || persistenceError ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? persistenceError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={conflict} onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

function AddContextSource({
  environmentId,
  computerName,
  nativePickerTarget,
  onAdd,
}: {
  readonly environmentId: EnvironmentId;
  readonly computerName: string;
  readonly nativePickerTarget: string | null;
  readonly onAdd: (source: Omit<MinesCatalogContextSource, "id">) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = useFilesystemReadAccess(environmentId);
  const current = useRef({ active: true, canReadFiles: access.canReadFiles });
  useEffect(() => {
    current.current.canReadFiles = access.canReadFiles;
  }, [access.canReadFiles]);
  useEffect(() => {
    current.current.active = true;
    return () => {
      current.current.active = false;
    };
  }, []);
  const readMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const add = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const source = await createCatalogFolderSource(
        { environmentId, path },
        {
          isCurrent: () => current.current.active && current.current.canReadFiles,
          readMetadata: async (selectedEnvironment, selectedPath) => {
            const result = await readMetadata({
              environmentId: selectedEnvironment,
              input: { paths: [selectedPath] },
            });
            if (result._tag === "Failure")
              throw new Error(formatEnvironmentQueryError(result.cause));
            return result.value.entries[0] ?? null;
          },
        },
      );
      if (!current.current.active) return;
      onAdd(source);
      setBrowsing(false);
    } catch (cause) {
      if (current.current.active)
        setError(cause instanceof Error ? cause.message : "Could not add this folder.");
    } finally {
      if (current.current.active) setBusy(false);
    }
  };
  const choose = async () => {
    setError(null);
    if (
      nativePickerTarget !== null &&
      !nativePickerTarget.startsWith("wsl:") &&
      window.desktopBridge
    ) {
      setBusy(true);
      try {
        const path = await readLocalApi()?.dialogs.pickFolder({
          targetEnvironmentId: nativePickerTarget,
        });
        if (!current.current.active) return;
        setBusy(false);
        if (path) await add(path);
      } catch (cause) {
        if (current.current.active) {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : "Could not open the folder picker.");
        }
      }
    } else setBrowsing(true);
  };
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || !access.canReadFiles}
        onClick={() => void choose()}
      >
        <FolderPlusIcon />
        {busy ? "Checking folder…" : "Add folder"}
      </Button>
      {error || access.error || (!access.isPending && !access.canReadFiles) ? (
        <p role="status" className="text-xs text-muted-foreground">
          {error ?? access.error ?? "This connection cannot read folders."}
        </p>
      ) : null}
      {browsing ? (
        <CatalogFolderBrowser
          environmentId={environmentId}
          computerName={computerName}
          canReadFiles={access.canReadFiles}
          busy={busy}
          error={error}
          onClose={() => setBrowsing(false)}
          onChoose={(path) => void add(path)}
        />
      ) : null}
    </>
  );
}

function CatalogFolderBrowser({
  environmentId,
  computerName,
  canReadFiles,
  busy,
  error,
  onClose,
  onChoose,
}: {
  readonly environmentId: EnvironmentId;
  readonly computerName: string;
  readonly canReadFiles: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onChoose: (path: string) => void;
}) {
  const [path, setPath] = useState("~/");
  const directory = useEnvironmentQuery(
    canReadFiles
      ? filesystemEnvironment.browse({ environmentId, input: { partialPath: path } })
      : null,
  );
  const selectedPath = directory.data?.parentPath;
  const parent = selectedPath ? getBrowseParentPath(selectedPath) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>{computerName}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Parent folder"
              disabled={!parent || busy}
              onClick={() => {
                if (parent) setPath(ensureBrowseDirectoryPath(parent));
              }}
            >
              <ArrowLeftIcon />
            </Button>
            <p className="min-w-0 break-all text-xs text-muted-foreground">
              {selectedPath ?? "Home folder"}
            </p>
          </div>
          {directory.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading folders…
            </p>
          ) : null}
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {!directory.isPending &&
              directory.data?.entries.map((entry) => (
                <div key={entry.fullPath}>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setPath(ensureBrowseDirectoryPath(entry.fullPath))}
                  >
                    <FolderIcon />
                    {entry.name}
                  </Button>
                </div>
              ))}
          </div>
          {!directory.isPending && directory.data?.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No folders inside this folder.</p>
          ) : null}
          {error || directory.error ? (
            <p role="alert" className="text-sm text-destructive">
              {error ?? directory.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || directory.isPending || !canReadFiles || !selectedPath}
            onClick={() => {
              if (selectedPath) onChoose(selectedPath);
            }}
          >
            <FolderPlusIcon />
            Add this folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

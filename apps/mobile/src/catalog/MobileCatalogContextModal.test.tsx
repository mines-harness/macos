import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { MinesCatalog, catalogContextFor } from "@t3tools/client-runtime/catalog";
import type { useMinesCatalog } from "./useMinesCatalog";

type FolderPickerProps = {
  environment: { environmentId: string };
  onSelectDirectory: (path: string) => void;
};

type InputProps = {
  accessibilityLabel: string;
  value: string;
  onChangeText: (text: string) => void;
};
const state = vi.hoisted(() => ({
  value: null as ReturnType<typeof useMinesCatalog> | null,
  inputs: new Map<string, InputProps>(),
  picker: null as FolderPickerProps | null,
  owned: new Set(["computer", "other-computer"]),
  canRead: true,
  metadata: vi.fn(async () => ({
    _tag: "Success" as const,
    value: { entries: [{ kind: "directory" as "directory" | "file" }] },
  })),
}));

vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    KeyboardAvoidingView: Container,
    Modal: Container,
    ScrollView: Container,
    View: Container,
    Platform: { OS: "ios" },
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
    }: {
      children: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
    }) => (
      <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
        {children}
      </button>
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.owned }));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: { get: () => state.owned } }));
vi.mock("../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../state/session", () => ({ readEnvironmentScope: () => state.canRead }));
vi.mock("../state/filesystem", () => ({ filesystemEnvironment: { getMetadata: {} } }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.metadata }));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../features/projects/AddProjectScreen", () => ({
  FolderBrowser: (props: FolderPickerProps) => {
    state.picker = props;
    return <span>Folder browser</span>;
  },
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "draft-source" }));
vi.mock("./useMinesCatalog", () => ({ useMinesCatalog: () => state.value }));

import { MobileCatalogContextModal } from "./MobileCatalogContextModal";

function setup() {
  state.inputs.clear();
  state.picker = null;
  state.owned = new Set(["computer", "other-computer"]);
  state.canRead = true;
  state.metadata
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { entries: [{ kind: "directory" }] } });
  let nextId = 0;
  const catalog = new MinesCatalog({ createId: () => `id-${++nextId}` });
  catalog.upsert({
    id: "project",
    kind: "project",
    title: "Project",
    hostRef: { environmentId: "computer", entityId: "project" },
  });
  catalog.setContextInstructions("project", "Initial instructions");
  const container = document.createElement("div");
  const root = createRoot(container);
  const onClose = vi.fn();
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const render = (source = catalog, accountId = "account-a", error: string | null = null) => {
    state.value = { catalog: source, snapshot: source.getSnapshot(), accountId, error };
    act(() => root.render(<MobileCatalogContextModal entityId="project" onClose={onClose} />));
  };
  const input = (label: string) => {
    const value = state.inputs.get(label);
    if (!value) throw new Error(`Missing input ${label}`);
    return value;
  };
  const press = (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    );
    if (!button) throw new Error(`Missing button ${label}`);
    act(() => button.click());
  };
  return {
    catalog,
    container,
    render,
    input,
    press,
    onClose,
    [Symbol.dispose]() {
      act(() => root.unmount());
      catalog.destroy();
      state.value = null;
      state.inputs.clear();
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

it("shows remote instructions until editing starts and preserves the local edit afterward", () => {
  using ui = setup();
  ui.render();
  ui.catalog.setContextInstructions("project", "Changed on desktop");
  ui.render();
  expect(ui.input("Custom instructions").value).toBe("Changed on desktop");
  act(() => ui.input("Custom instructions").onChangeText("Local edit"));
  ui.catalog.setContextInstructions("project", "Newer remote edit");
  ui.render();
  expect(ui.input("Custom instructions").value).toBe("Local edit");
  expect(ui.container.textContent).toContain("Instructions changed on another device");
  ui.press("Use latest instructions");
  expect(ui.input("Custom instructions").value).toBe("Newer remote edit");
});

it("shows persistence failures while the editor is open", () => {
  using ui = setup();
  ui.render(ui.catalog, "account-a", "Device storage is full");
  expect(ui.container.textContent).toContain("Device storage is full");
});

it("previews staged removals and preserves independent sources received before saving", () => {
  using ui = setup();
  ui.catalog.addContextSource("project", {
    environmentId: "other-computer",
    kind: "directory",
    path: "/old",
  });
  ui.render();
  expect(ui.container.textContent).toContain("1 saved source belongs to other computers");
  ui.press("Remove context source /old");
  expect(ui.container.textContent).not.toContain("1 saved source belongs to other computers");
  ui.catalog.document.getMap("context-sources").set("legacy-file", {
    id: "legacy-file",
    entityId: "project",
    environmentId: "computer",
    kind: "file",
    path: "/new",
  });
  ui.catalog.setContextInstructions("project", "Keep remote instructions");
  ui.render();
  ui.press("Save");
  const saved = catalogContextFor(ui.catalog.getSnapshot(), "project");
  expect(saved.instructions).toBe("Keep remote instructions");
  expect(saved.sources.map((source) => source.path)).toEqual(["/new"]);
});

it("drops the previous account draft and disables saving a deleted owner", () => {
  using ui = setup();
  ui.render();
  act(() => ui.input("Custom instructions").onChangeText("Private account-a draft"));
  ui.render(ui.catalog, "account-b");
  expect(ui.input("Custom instructions").value).toBe("Initial instructions");
  ui.catalog.removeContainer("project");
  ui.render(ui.catalog, "account-b");
  ui.press("Save");
  expect(ui.onClose).not.toHaveBeenCalled();
  expect(ui.container.textContent).toContain("This library item is no longer available");
});

it("adds a picked folder with its literal computer path", async () => {
  using ui = setup();
  ui.render();
  ui.press("Add folder");
  const path = "/Users/me/Research [draft] & notes";
  await act(async () => state.picker!.onSelectDirectory(path));
  ui.press("Save");
  expect(catalogContextFor(ui.catalog.getSnapshot(), "project").sources).toMatchObject([
    { environmentId: "computer", kind: "directory", path },
  ]);
});

it("rejects a picked file and a folder whose computer loses ownership during validation", async () => {
  using ui = setup();
  ui.render();
  ui.press("Add folder");
  state.metadata.mockResolvedValueOnce({ _tag: "Success", value: { entries: [{ kind: "file" }] } });
  await act(async () => state.picker!.onSelectDirectory("/Users/me/note.txt"));
  expect(ui.container.textContent).toContain("Choose a folder");
  let finish: (value: Awaited<ReturnType<typeof state.metadata>>) => void = () => {};
  state.metadata.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let validation: void | Promise<void>;
  act(() => {
    validation = state.picker!.onSelectDirectory("/Users/me/folder");
  });
  state.owned = new Set();
  await act(async () => {
    finish({ _tag: "Success", value: { entries: [{ kind: "directory" }] } });
    await validation;
  });
  ui.press("Save");
  expect(catalogContextFor(ui.catalog.getSnapshot(), "project").sources).toEqual([]);
});

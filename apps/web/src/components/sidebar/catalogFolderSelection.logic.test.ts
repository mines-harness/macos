import { EnvironmentId, type FilesystemEntryMetadata } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  createCatalogFolderSource,
  catalogNativeFolderPickerTarget,
} from "./catalogFolderSelection.logic";
import {
  PrimaryConnectionTarget,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";

const environmentId = EnvironmentId.make("chosen-computer");
it("accepts only a verified folder on the selected computer and preserves its literal path", async () => {
  const path = "C:\\Users\\apple\\Folder with spaces";
  const readMetadata = vi.fn(async () => ({ kind: "directory" as const }));
  await expect(
    createCatalogFolderSource(
      { environmentId, path },
      {
        isCurrent: () => true,
        readMetadata,
      },
    ),
  ).resolves.toEqual({ environmentId, path, kind: "directory" });
  expect(readMetadata).toHaveBeenCalledExactlyOnceWith(environmentId, path);
});

it("rejects file selections and missing or unreadable folders", async () => {
  for (const metadata of [{ kind: "file" as const }, null])
    await expect(
      createCatalogFolderSource(
        { environmentId, path: "/Users/apple/context" },
        {
          isCurrent: () => true,
          readMetadata: async () => metadata,
        },
      ),
    ).rejects.toThrow(/folder/i);
});

it("does not stage a folder after computer access changes during validation", async () => {
  let current = true;
  let complete!: (value: FilesystemEntryMetadata) => void;
  const pending = createCatalogFolderSource(
    { environmentId, path: "/Users/apple/context" },
    {
      isCurrent: () => current,
      readMetadata: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  );
  current = false;
  complete({ kind: "directory" });
  await expect(pending).rejects.toThrow("Computer access changed");
});

it("routes a confirmed packaged primary host to the native primary pool picker", () => {
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "This Mac",
    httpBaseUrl: "http://127.0.0.1:4100/",
    wsBaseUrl: "ws://127.0.0.1:4100/",
  });
  const bootstrap = {
    id: "primary",
    label: "This Mac",
    httpBaseUrl: "http://127.0.0.1:4100",
    wsBaseUrl: "ws://127.0.0.1:4100",
  };
  expect(catalogNativeFolderPickerTarget(target, [bootstrap])).toBe("primary");
  expect(catalogNativeFolderPickerTarget(target, [])).toBeNull();
  expect(
    catalogNativeFolderPickerTarget(target, [{ ...bootstrap, runningDistro: "Ubuntu" }]),
  ).toBeNull();
  expect(
    catalogNativeFolderPickerTarget(
      new PrimaryConnectionTarget({
        ...target,
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
      }),
      [bootstrap],
    ),
  ).toBeNull();
});

it("retains native secondary pool routing and uses the browser for WSL", () => {
  const target = new BearerConnectionTarget({
    environmentId,
    label: "Local",
    connectionId: "local:secondary",
  });
  expect(catalogNativeFolderPickerTarget(target, [])).toBe("secondary");
  expect(
    catalogNativeFolderPickerTarget(
      new BearerConnectionTarget({ ...target, connectionId: "local:wsl:Ubuntu" }),
      [],
    ),
  ).toBeNull();
});

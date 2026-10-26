import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  trayListeners: new Map<string, () => void>(),
  appListeners: new Map<string, () => void>(),
  windowListeners: new Map<string, () => void>(),
  input: vi.fn(),
  create: vi.fn(),
  ensureMain: vi.fn(),
  activate: vi.fn(),
  show: vi.fn(),
  showInactive: vi.fn(),
  focus: vi.fn(),
  destroyed: false,
  destroy: vi.fn(),
  load: vi.fn<() => Promise<void>>(),
}));
vi.mock("electron", () => {
  const image = {
    resize: () => image,
    setTemplateImage: () => {},
    toBitmap: () => Buffer.alloc(22 * 22 * 4),
  };
  return {
    app: {
      on: (name: string, listener: () => void) => native.appListeners.set(name, listener),
      removeListener: (name: string) => native.appListeners.delete(name),
    },
    nativeImage: { createFromBuffer: () => image, createFromBitmap: () => image },
    Menu: { buildFromTemplate: () => ({}) },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1280, height: 900 } }) },
    BrowserWindow: vi.fn(function (options: import("electron").BrowserWindowConstructorOptions) {
      native.create(options);
      return {
        webContents: {
          id: 100,
          on: (name: string, listener: () => void) => {
            if (name === "before-input-event") native.input.mockImplementation(listener);
          },
          setWindowOpenHandler: () => {},
        },
        once: (name: string, listener: () => void) => native.windowListeners.set(name, listener),
        on: (name: string, listener: () => void) => native.windowListeners.set(name, listener),
        isDestroyed: () => native.destroyed,
        destroy: () => {
          native.destroyed = true;
          native.destroy();
          native.windowListeners.get("closed")?.();
        },
        show: native.show,
        showInactive: native.showInactive,
        focus: native.focus,
        loadFile: native.load,
      };
    }),
    Tray: vi.fn(function () {
      return {
        on: (name: string, listener: () => void) => native.trayListeners.set(name, listener),
        setToolTip: () => {},
        setTitle: () => {},
        getBounds: () => ({ x: 50, y: 0, width: 24, height: 24 }),
        destroy: () => {},
      };
    }),
  };
});

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SHOW_MENU_BAR_EVENT } from "../channels.ts";
import { installMenuBar } from "./menuBar.ts";

it.effect.each(["tray", "app menu"] as const)(
  "opens the %s panel without creating or raising the main window",
  (entry) =>
    Effect.gen(function* () {
      vi.clearAllMocks();
      native.trayListeners.clear();
      native.appListeners.clear();
      native.windowListeners.clear();
      native.destroyed = false;
      const loaded = Promise.withResolvers<void>();
      native.load.mockImplementation(() => {
        native.windowListeners.get("ready-to-show")?.();
        loaded.resolve();
        return Promise.resolve();
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installMenuBar();
          (entry === "tray"
            ? native.trayListeners.get("click")
            : native.appListeners.get(SHOW_MENU_BAR_EVENT))!();
          yield* Effect.promise(() => loaded.promise);
          expect(native.ensureMain).not.toHaveBeenCalled();
          expect(native.activate).not.toHaveBeenCalled();
          expect(native.create.mock.calls[0]?.[0]).toMatchObject({ type: "panel" });
          expect(native.create.mock.calls[0]?.[0].parent).toBeUndefined();
          if (entry === "tray") {
            expect(native.showInactive).toHaveBeenCalledOnce();
            expect(native.show).not.toHaveBeenCalled();
            expect(native.focus).not.toHaveBeenCalled();
          } else {
            expect(native.show).toHaveBeenCalledOnce();
            expect(native.focus).toHaveBeenCalledOnce();
          }
          const preventDefault = vi.fn();
          native.input({ preventDefault }, { type: "keyDown", key: "Escape" });
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(native.destroy).toHaveBeenCalledOnce();
        }),
      ).pipe(
        Effect.provide([
          ElectronWindow.layer,
          Layer.mock(DesktopIpc.DesktopIpc)({ handle: () => Effect.void }),
          Layer.mock(DesktopWindow.DesktopWindow)({
            ensureMain: Effect.sync(() => {
              native.ensureMain();
              return { isDestroyed: () => false } as import("electron").BrowserWindow;
            }),
            activate: Effect.sync(() => {
              native.activate();
            }),
          }),
          Layer.mock(DesktopAssets.DesktopAssets)({
            resolveResourcePath: () => Effect.succeedSome("/resources/menu-bar/index.html"),
          }),
          DesktopEnvironment.layer({
            dirname: "/desktop",
            homeDirectory: "/Users/alice",
            platform: "darwin",
            processArch: "arm64",
            appVersion: "1.2.3",
            appPath: "/repo",
            isPackaged: false,
            resourcesPath: "/resources",
            runningUnderArm64Translation: false,
          }).pipe(Layer.provide(DesktopConfig.layerTest({}))),
        ]),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
    }).pipe(Effect.provide(Path.layer)),
);

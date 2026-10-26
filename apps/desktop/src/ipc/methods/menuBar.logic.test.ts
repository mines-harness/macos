import { describe, expect, it } from "vite-plus/test";
import type { DesktopMenuBarState } from "@t3tools/contracts";
import { isMenuBarActionAllowed, menuBarPanelBounds, menuBarTitle } from "./menuBar.logic.ts";

const state = {
  running: 2,
  attention: 0,
  connectedDevices: 1,
  totalDevices: 1,
  threads: [],
  limits: [],
} satisfies DesktopMenuBarState;

describe("menu bar summary", () => {
  it("shows only a running count regardless of account usage", () => {
    expect(
      menuBarTitle({
        ...state,
        limits: [
          { label: "Other", driver: "claude", remainingPercent: 10, checkedAt: "" },
          { label: "Codex", driver: "codex", remainingPercent: 76.4, checkedAt: "" },
        ],
      }),
    ).toBe("2");
  });

  it("prioritizes the attention count regardless of account usage", () => {
    const limit = { label: "Codex", driver: "codex", checkedAt: "" };
    expect(menuBarTitle({ ...state, limits: [{ ...limit, remainingPercent: null }] })).toBe("2");
    expect(
      menuBarTitle({ ...state, attention: 1, limits: [{ ...limit, remainingPercent: 0 }] }),
    ).toBe("!1");
  });

  it("keeps the panel within its display and above a bottom taskbar", () => {
    expect(
      menuBarPanelBounds(
        { x: 1960, y: 0, width: 100, height: 24 },
        { x: 1920, y: 24, width: 1280, height: 720 },
      ),
    ).toEqual({ x: 1928, y: 30, width: 392, height: 620 });
    const bounds = menuBarPanelBounds(
      { x: 1850, y: 1040, width: 30, height: 40 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    );
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1912);
    expect(bounds.y + bounds.height).toBeLessThan(1040);
  });

  it("fits a small display with a negative origin", () => {
    expect(
      menuBarPanelBounds(
        { x: -20, y: 0, width: 20, height: 24 },
        { x: -320, y: 24, width: 320, height: 480 },
      ),
    ).toEqual({ x: -312, y: 30, width: 304, height: 468 });
  });

  it("keeps the status bar icon alone when idle", () => {
    expect(menuBarTitle(null)).toBe("");
    expect(
      menuBarTitle({
        ...state,
        running: 0,
        limits: [{ label: "Claude", driver: "claudeAgent", remainingPercent: 82, checkedAt: "" }],
      }),
    ).toBe("");
  });

  it("accepts only fixed actions or an exact current mine route", () => {
    const current = {
      ...state,
      threads: [
        { environmentId: "mac/one", threadId: "mine:1", title: "Mine", status: "working" as const },
      ],
    };
    expect(isMenuBarActionAllowed("mines:thread:mac%2Fone/mine%3A1", current)).toBe(true);
    expect(isMenuBarActionAllowed("mines:thread:mac%2Fone/mine%3A2", current)).toBe(false);
    expect(isMenuBarActionAllowed("mines:thread:mac/one/mine:1", current)).toBe(false);
    expect(isMenuBarActionAllowed("mines:thread:mac%2Fone/mine%3A1", null)).toBe(false);
    expect(isMenuBarActionAllowed("devices", null)).toBe(true);
    expect(isMenuBarActionAllowed("new", null)).toBe(true);
    expect(isMenuBarActionAllowed("unknown", current)).toBe(false);
  });
});

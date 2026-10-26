import type { DesktopMenuBarState } from "@t3tools/contracts";
import type { Rectangle } from "electron";

export function menuBarTitle(state: DesktopMenuBarState | null): string {
  return state?.attention ? `!${state.attention}` : state?.running ? String(state.running) : "";
}

export function menuBarPanelBounds(tray: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(392, Math.max(1, workArea.width - 16));
  const height = Math.min(620, Math.max(1, workArea.height - 12));
  const below = tray.y + tray.height + 6;
  const y = below + height <= workArea.y + workArea.height - 6 ? below : tray.y - height - 6;
  return {
    x: Math.round(
      Math.max(
        workArea.x + 8,
        Math.min(tray.x + tray.width / 2 - width / 2, workArea.x + workArea.width - width - 8),
      ),
    ),
    y: Math.round(Math.max(workArea.y + 6, Math.min(y, workArea.y + workArea.height - height - 6))),
    width,
    height,
  };
}

export function isMenuBarActionAllowed(action: string, state: DesktopMenuBarState | null): boolean {
  return (
    ["open", "new", "accounts", "devices", "quit", "close"].includes(action) ||
    (state?.threads.some(
      (thread) =>
        action ===
        `mines:thread:${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
    ) ??
      false)
  );
}

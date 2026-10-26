import { CommandId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type {
  BackgroundImportJob,
  ImportQueueSnapshot,
} from "../../onboarding/backgroundImports.logic";
import { SidebarProvider } from "../ui/sidebar";
import { BackgroundImportStatus } from "./BackgroundImportStatus";

const state = vi.hoisted(() => ({ snapshot: null as ImportQueueSnapshot | null }));
vi.mock(import("../../state/backgroundImports"), () => ({
  backgroundImports: {} as never,
  useBackgroundImports: () => state.snapshot!,
}));

function job(status: BackgroundImportJob["status"]): BackgroundImportJob {
  return {
    id: "history",
    environmentId: EnvironmentId.make("computer"),
    environmentLabel: "Computer",
    projectId: ProjectId.make("project"),
    commandId: CommandId.make("import:history"),
    title: "Work",
    workspaceRoot: "/work",
    createWorkspaceRootIfMissing: false,
    projectReady: true,
    options: {},
    status,
    error: null,
    sourceReports: [],
    totals: {
      imported: 1,
      existing: 0,
      skipped: 0,
      native: 0,
      transcripts: 1,
      partial: 0,
      failed: 0,
      unavailable: 0,
    },
  };
}

it("hides completed imports while keeping unfinished imports visible", async () => {
  state.snapshot = { jobs: [job("running")], storageError: null };
  await using screen = await render(
    <SidebarProvider>
      <BackgroundImportStatus />
    </SidebarProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "View background imports" }))
    .toBeVisible();
  state.snapshot = { jobs: [job("failed")], storageError: null };
  await screen.rerender(
    <SidebarProvider>
      <BackgroundImportStatus />
    </SidebarProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "View background imports" }))
    .toBeVisible();
  state.snapshot = { jobs: [job("complete")], storageError: null };
  await screen.rerender(
    <SidebarProvider>
      <BackgroundImportStatus />
    </SidebarProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "View background imports" }))
    .not.toBeInTheDocument();
});

it("keeps completed history accessible from settings without a sidebar banner", async () => {
  state.snapshot = { jobs: [job("complete")], storageError: null };
  await using screen = await render(<BackgroundImportStatus surface="settings" />);
  await screen.getByRole("button", { name: "Import history", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Refresh imported history" }))
    .toBeVisible();
});

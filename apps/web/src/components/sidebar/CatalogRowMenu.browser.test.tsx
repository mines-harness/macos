import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { MinesCatalog } from "@t3tools/client-runtime/catalog";
import "~/index.css";
import { act, render } from "../../../test/render";
import { MenuItem, MenuTrigger } from "../ui/menu";
import { CatalogRowMenu } from "./CatalogRowMenu";

function Row({ catalog }: { catalog: MinesCatalog }) {
  return (
    <CatalogRowMenu
      title="My mine"
      menu={<MenuItem onClick={() => catalog.pin("mine")}>Pin</MenuItem>}
    >
      <div className="flex gap-2">
        <button type="button">My mine</button>
        <MenuTrigger>Arrange mine</MenuTrigger>
      </div>
    </CatalogRowMenu>
  );
}

it("replaces the native text menu with actions for the clicked row", async () => {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "mine", kind: "thread", title: "My mine" });
  await using screen = await render(<Row catalog={catalog} />, {
    router: false, // Catalog actions do not navigate.
  });
  const row = screen.container.querySelector<HTMLButtonElement>("button")!;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
  });
  await act(() => row.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  await expect.element(screen.getByRole("menu")).toBeVisible();
  await userEvent.click(screen.getByRole("menuitem", { name: "Pin", exact: true }));
  expect(catalog.getSnapshot().pins[0]?.entity.id).toBe("mine");
});

it("opens row actions from the keyboard and restores row focus on Escape", async () => {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "mine", kind: "thread", title: "My mine" });
  await using screen = await render(<Row catalog={catalog} />, {
    router: false, // Catalog actions do not navigate.
  });
  const row = screen.container.querySelector<HTMLButtonElement>("button")!;
  await userEvent.click(row);
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await expect.element(screen.getByRole("menuitem", { name: "Pin", exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(row).toHaveFocus();
});

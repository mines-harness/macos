import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MinesPhoneSetupPanel } from "./MinesPhoneSetupPanel";

vi.mock("../settings/MinesPeerSettings", async () => {
  const { useState } = await import("react");
  return {
    MinesPeerSettings: function DeviceSetup() {
      const [code, setCode] = useState("");
      return (
        <input
          aria-label="Device approval code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      );
    },
  };
});

it("introduces phone access without starting setup, and preserves explicitly opened setup", async () => {
  const finish = vi.fn();
  await using screen = await render(<MinesPhoneSetupPanel onDone={finish} />);

  await expect.element(screen.getByRole("button", { name: "Set up now" })).toBeVisible();
  await expect.element(screen.getByLabelText("Device approval code")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Start using mines" }));
  expect(finish).toHaveBeenCalledOnce();
  await expect.element(screen.getByLabelText("Device approval code")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Set up now" }));
  await userEvent.type(screen.getByLabelText("Device approval code"), "phone-code");
  await userEvent.click(screen.getByRole("button", { name: "Hide setup" }));
  await userEvent.click(screen.getByRole("button", { name: "Set up now" }));
  await expect.element(screen.getByLabelText("Device approval code")).toHaveValue("phone-code");
  expect(finish).toHaveBeenCalledOnce();
});

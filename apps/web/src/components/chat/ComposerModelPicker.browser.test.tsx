import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerModelPicker } from "./ComposerFooterControls";
import { TraitsPicker } from "./TraitsPicker";
import { UltraReasoningFeedback, useUltraReasoningFeedbackState } from "./UltraReasoningFeedback";

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({ favorites: [], providerModelPreferences: {} }),
  useToggleEnvironmentModelFavorite: () => async () => {},
}));
vi.mock(import("../../lib/windowControlsOverlay"), () => ({
  useNativeTitlebarHeight: () => 52,
  windowControlsOverlayHeight: () => 52,
  onWindowControlsOverlayGeometryChange: () => () => {},
}));

const account = ProviderInstanceId.make("codex-work");
const models = ["Alpha", "Beta", "Gamma"].map((name) => ({
  slug: name.toLowerCase(),
  name,
  isCustom: false,
  capabilities: {},
}));
const provider: ServerProvider = {
  instanceId: account,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Work account",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
};
const defaultProviders = [provider];

function Picker({
  providers = defaultProviders,
  showSettings = false,
}: {
  providers?: ReadonlyArray<ServerProvider>;
  showSettings?: boolean;
}) {
  const [selected, setSelected] = useState<ModelSelection>({ instanceId: account, model: "alpha" });
  const [multiple, setMultiple] = useState<ReadonlyArray<ModelSelection> | null>(null);
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>();
  const selectedProvider = providers.find((entry) => entry.instanceId === selected.instanceId);
  const ultraReasoningFeedback = useUltraReasoningFeedbackState(
    `${selected.instanceId}:${selected.model}`,
  );
  return (
    <>
      <section aria-label="Prompt field" className="relative">
        {ultraReasoningFeedback.feedback}
      </section>
      <UltraReasoningFeedback onActivate={ultraReasoningFeedback.activate}>
        <ComposerModelPicker
          environmentId={null}
          activeInstanceId={selected.instanceId}
          model={selected.model}
          selectedModelSelection={selected}
          multipleModelsEnabled
          multipleModelSelections={multiple}
          onMultipleModelSelectionsChange={setMultiple}
          onProviderModelSelect={(instanceId, model) => setSelected({ instanceId, model })}
          lockedProvider={null}
          instanceEntries={deriveProviderInstanceEntries(providers)}
          modelOptionsByInstance={
            new Map(providers.map((entry) => [entry.instanceId, entry.models]))
          }
          triggerAriaLabel="Choose models"
          modelSettings={
            showSettings && selectedProvider ? (
              <TraitsPicker
                provider={selectedProvider.driver}
                instanceId={selected.instanceId}
                model={selected.model}
                models={selectedProvider.models}
                modelOptions={options}
                onModelOptionsChange={setOptions}
                planModeEnabled={false}
              />
            ) : null
          }
        />
      </UltraReasoningFeedback>
      <output aria-label="Selection">
        {multiple
          ? `Multiple: ${multiple.map((item) => item.model).join(", ")}`
          : `Single: ${selected.model}`}
      </output>
      <output aria-label="Accounts">
        {multiple ? multiple.map((item) => item.instanceId).join(", ") : selected.instanceId}
      </output>
      <output aria-label="Model options">{JSON.stringify(options)}</output>
    </>
  );
}

it("selects a single model on ordinary click and adds models only with checkboxes or Shift-click", async () => {
  await using screen = await render(<Picker />);
  await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
  await userEvent.click(page.getByRole("option", { name: /Beta/ }));
  await expect.element(screen.getByLabelText("Selection")).toHaveTextContent("Single: beta");
  await expect
    .element(page.getByRole("checkbox", { name: "Include Alpha in multi-model selection" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
  await userEvent.click(
    page.getByRole("checkbox", { name: "Include Alpha in multi-model selection" }),
  );
  await expect
    .element(screen.getByLabelText("Selection"))
    .toHaveTextContent("Multiple: beta, alpha");
  await expect
    .element(page.getByRole("checkbox", { name: "Include Alpha in multi-model selection" }))
    .toBeChecked();
  await expect
    .element(page.getByRole("checkbox", { name: "Include Beta in multi-model selection" }))
    .toBeChecked();
  await userEvent.keyboard("{Shift>}");
  await userEvent.click(page.getByRole("option", { name: /Gamma/ }));
  await userEvent.keyboard("{/Shift}");
  await expect
    .element(screen.getByLabelText("Selection"))
    .toHaveTextContent("Multiple: beta, alpha, gamma");
  await userEvent.click(page.getByRole("option", { name: /Alpha/ }));
  await expect.element(screen.getByLabelText("Selection")).toHaveTextContent("Single: alpha");
});

it("shows models from connected accounts together and retains account identity on selection", async () => {
  const second = {
    ...provider,
    instanceId: ProviderInstanceId.make("claude-work"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Second account",
    models: [{ ...models[0]!, slug: "sonnet", name: "Sonnet" }],
  };
  await using screen = await render(<Picker providers={[provider, second]} />);
  await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
  await expect.element(page.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: /Sonnet/ })).toBeInTheDocument();
  await userEvent.click(
    page.getByRole("checkbox", { name: "Include Sonnet in multi-model selection" }),
  );
  await expect
    .element(screen.getByLabelText("Selection"))
    .toHaveTextContent("Multiple: alpha, sonnet");
  await expect
    .element(screen.getByLabelText("Accounts"))
    .toHaveTextContent("codex-work, claude-work");
  await userEvent.click(page.getByRole("option", { name: /Sonnet/ }));
  await expect.element(screen.getByLabelText("Selection")).toHaveTextContent("Single: sonnet");
  await expect.element(screen.getByLabelText("Accounts")).toHaveTextContent("claude-work");
});

it("keeps reasoning below the native titlebar and clickable in a short model picker", async () => {
  const configured = {
    ...provider,
    models: [
      {
        ...models[0]!,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select" as const,
              currentValue: "high",
              options: [
                { id: "high", label: "High" },
                { id: "low", label: "Low" },
              ],
            },
          ],
        },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        ...models[0]!,
        slug: `other-${index}`,
        name: `Other model ${index}`,
      })),
    ],
  };
  await using screen = await render(
    <div className="fixed right-2 bottom-2 left-2">
      <Picker providers={[configured]} showSettings />
    </div>,
  );
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  try {
    await page.viewport(420, 300);
    await expect
      .element(page.getByRole("button", { name: "High", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
    const effort = page.getByRole("button", { name: "High", exact: true });
    await vi.waitFor(() =>
      expect(effort.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(52),
    );
    await userEvent.click(effort);
    await userEvent.click(page.getByRole("menuitemradio", { name: "Low", exact: true }));
    await expect
      .element(screen.getByLabelText("Model options"))
      .toHaveTextContent('[{"id":"reasoningEffort","value":"low"}]');
  } finally {
    await page.viewport(viewport.width, viewport.height);
  }
});

it("lights the prompt field for a new Ultra pick while restoring Ultra quietly", async () => {
  const configured = {
    ...provider,
    models: [
      {
        ...models[0]!,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select" as const,
              currentValue: "ultra",
              options: [
                { id: "high", label: "High" },
                { id: "ultra", label: "Ultra" },
              ],
            },
          ],
        },
      },
    ],
  };
  await using screen = await render(<Picker providers={[configured]} showSettings />);
  const feedback = page
    .getByRole("region", { name: "Prompt field" })
    .getByTestId("ultra-reasoning-feedback");
  await expect.element(feedback).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
  await userEvent.click(page.getByRole("button", { name: "Ultra", exact: true }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "High", exact: true }));
  await expect.element(feedback).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "High", exact: true }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Ultra", exact: true }));
  await expect
    .element(screen.getByLabelText("Model options"))
    .toHaveTextContent('[{"id":"reasoningEffort","value":"ultra"}]');
  await expect.element(feedback).toBeInTheDocument();
  await expect.element(page.getByText("ULTRA", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Ultra", exact: true }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "High", exact: true }));
  await expect.element(feedback).not.toBeInTheDocument();
});

it("keeps Ultrafast speed separate from Ultra reasoning when changing model options", async () => {
  const configured = {
    ...provider,
    models: [
      {
        ...models[0]!,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select" as const,
              currentValue: "high",
              options: [
                { id: "high", label: "High" },
                { id: "ultra", label: "Ultra" },
              ],
            },
            {
              id: "serviceTier",
              label: "Speed",
              type: "select" as const,
              currentValue: "priority",
              options: [
                { id: "default", label: "Normal" },
                { id: "priority", label: "Fast" },
                { id: "ultrafast", label: "Ultrafast" },
              ],
            },
          ],
        },
      },
    ],
  };
  await using screen = await render(<Picker providers={[configured]} showSettings />);
  const feedback = page
    .getByRole("region", { name: "Prompt field" })
    .getByTestId("ultra-reasoning-feedback");
  await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
  await userEvent.click(page.getByRole("button", { name: "High Fast", exact: true }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Ultrafast", exact: true }));
  await expect
    .element(screen.getByLabelText("Model options"))
    .toHaveTextContent(
      '[{"id":"reasoningEffort","value":"high"},{"id":"serviceTier","value":"ultrafast"}]',
    );
  await expect.element(feedback).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "High Ultrafast", exact: true }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Ultra", exact: true }));
  await expect
    .element(screen.getByLabelText("Model options"))
    .toHaveTextContent(
      '[{"id":"reasoningEffort","value":"ultra"},{"id":"serviceTier","value":"ultrafast"}]',
    );
  await expect.element(feedback).toBeInTheDocument();
});

it("keeps connected providers in one scroll and unbound accounts collapsed and unselectable", async () => {
  const claude = {
    ...provider,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    auth: { status: "unauthenticated" as const },
    models: [{ ...models[0]!, slug: "sonnet", name: "Sonnet" }],
  };
  const gemini = {
    ...provider,
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Gemini",
    models: [{ ...models[0]!, slug: "gemini-pro", name: "Gemini Pro" }],
  };
  const codex = { ...provider, auth: { status: "unknown" as const } };
  await using screen = await render(<Picker providers={[codex, claude, gemini]} />);
  await userEvent.click(screen.getByRole("button", { name: "Choose models" }));
  await expect.element(page.getByRole("option", { name: /Gemini Pro/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Sonnet/ })).not.toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: "Claude models" }));
  await expect
    .element(page.getByRole("option", { name: /Sonnet/ }))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByRole("option", { name: /Gemini Pro/ })).toBeInTheDocument();
  await expect
    .element(page.getByRole("checkbox", { name: "Include Sonnet in multi-model selection" }))
    .toBeDisabled();
  await expect.element(screen.getByLabelText("Selection")).toHaveTextContent("Single: alpha");
});

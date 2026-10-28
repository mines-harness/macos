import { describe } from "@effect/vitest";

import {
  materializeMuseReplayWorkspace,
  materializeMuseReplayProtocol,
  MuseOrchestratorReplayHarness,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Muse replay fixtures", () => {
  itRunsReplayFixtures("muse", (input) =>
    runReplayFixture({
      ...input,
      harness: MuseOrchestratorReplayHarness,
      transformTranscript: (transcript) =>
        materializeMuseReplayProtocol(
          input.transformTranscript?.(transcript) ?? transcript,
          input.driver.modelSelection.model,
        ),
      materializeWorkspace: materializeMuseReplayWorkspace,
    }),
  );
});

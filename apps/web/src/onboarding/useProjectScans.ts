import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AgentSessionScanInput, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { agentSessionScan } from "../state/agentSessions";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { formatEnvironmentQueryError } from "../state/query";

const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(AgentSessionScanInput));
const projectScansAtom = Atom.family((key: string) => {
  const input = decodeInput(key);
  return environmentAtomList("web-project-scans", (environmentId) =>
    agentSessionScan({ environmentId, input }),
  );
});

export function useProjectScans(
  environmentIds: readonly EnvironmentId[],
  input: AgentSessionScanInput = {},
) {
  const registry = useContext(RegistryContext);
  const results = useAtomValue(
    projectScansAtom(JSON.stringify(input))(environmentIdsKey(environmentIds)),
  );
  return environmentIds.map((environmentId, index) => {
    const result = results[index]!;
    return {
      environmentId,
      data: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isPending: result.waiting || result._tag === "Initial",
      refresh: () => registry.refresh(agentSessionScan({ environmentId, input })),
    };
  });
}

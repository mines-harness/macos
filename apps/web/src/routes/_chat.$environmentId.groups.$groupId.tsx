import { createFileRoute } from "@tanstack/react-router";
import { GroupWorkspace } from "../components/groups/GroupWorkspace";
export const Route = createFileRoute("/_chat/$environmentId/groups/$groupId")({
  component: GroupRoute,
});
function GroupRoute() {
  const params = Route.useParams();
  return <GroupWorkspace key={`${params.environmentId}:${params.groupId}`} {...params} />;
}

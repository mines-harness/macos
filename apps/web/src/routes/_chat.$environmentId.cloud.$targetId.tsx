import { createFileRoute } from "@tanstack/react-router";

import { CloudWorkspace } from "../components/cloud/CloudWorkspace";

export const Route = createFileRoute("/_chat/$environmentId/cloud/$targetId")({
  component: CloudRoute,
});

function CloudRoute() {
  const params = Route.useParams();
  return <CloudWorkspace key={`${params.environmentId}:${params.targetId}`} {...params} />;
}

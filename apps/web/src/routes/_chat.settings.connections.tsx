import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsConnectionsRoute() {
  return <ConnectionsSettings />;
}

export const Route = createFileRoute("/_chat/settings/connections")({
  component: SettingsConnectionsRoute,
});

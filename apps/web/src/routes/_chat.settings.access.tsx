import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsAccessRoute() {
  return <ConnectionsSettings />;
}

export const Route = createFileRoute("/_chat/settings/access")({
  component: SettingsAccessRoute,
});

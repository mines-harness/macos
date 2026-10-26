import { createFileRoute, redirect } from "@tanstack/react-router";
import { ContactsPage } from "../components/contacts/ContactsPage";
export const Route = createFileRoute("/contacts")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: ContactsPage,
});

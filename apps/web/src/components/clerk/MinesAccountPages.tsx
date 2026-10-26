import { ServerIcon, SmartphoneIcon } from "lucide-react";

import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { MinesConnectUserProfilePage } from "./MinesConnectUserProfilePage";

export const MINES_ACCOUNT_PAGES = [
  {
    label: "Mobile clients",
    url: "mobile-clients",
    icon: <SmartphoneIcon className="size-4" />,
    content: <MobileClientsUserProfilePage />,
  },
  {
    label: "T3 Connect",
    url: "mines-connect",
    icon: <ServerIcon className="size-4" />,
    content: <MinesConnectUserProfilePage />,
  },
] as const;

import { serverEnvironment } from "~/state/server";

/** Keep Share link available so owners can enable Guest links from its dialog. */
export const canShareWithGuestAtom = serverEnvironment.createGuestShare.permissionAtom;

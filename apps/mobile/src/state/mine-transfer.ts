import { createMineTransferCommands } from "@t3tools/client-runtime/state/mine-transfer";
import { connectionAtomRuntime } from "../connection/runtime";

export const mineTransferCommands = createMineTransferCommands(connectionAtomRuntime);

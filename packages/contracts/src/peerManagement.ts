import * as Schema from "effect/Schema";
import { PeerDevice, PeerFailureCode } from "./minesPeer.ts";
export const PeerState = Schema.Struct({
  device: PeerDevice,
  approvedDevices: Schema.Array(PeerDevice),
});
export const PeerApproveInput = Schema.Struct({ device: PeerDevice });
export const PeerRevokeInput = Schema.Struct({
  deviceId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/)),
});
export const PeerCheckDeviceInput = PeerRevokeInput;
export const PeerReachability = Schema.Literals([
  "connected",
  "reachable",
  "unavailable",
  "approval-required",
  "not-tested",
]);
const CheckedStatus = {
  status: PeerReachability,
  checkedAt: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(PeerFailureCode),
};
export const PeerDeviceStatus = Schema.Struct({
  deviceId: PeerRevokeInput.fields.deviceId,
  ...CheckedStatus,
});
export type PeerDeviceStatus = typeof PeerDeviceStatus.Type;
export const PeerStatus = Schema.Struct({
  device: PeerDevice,
  devices: Schema.Array(Schema.Struct({ device: PeerDevice, ...CheckedStatus })),
});
export type PeerStatus = typeof PeerStatus.Type;
export class PeerManagementError extends Schema.TaggedError<PeerManagementError>()(
  "PeerManagementError",
  { message: Schema.String },
) {}

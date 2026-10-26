import { expect, it, vi } from "vite-plus/test";
import { getPeerDevices } from "./minesPeerSignaling.ts";
import { createPeerIdentity } from "./minesPeerTrust.ts";

const device = createPeerIdentity(new Uint8Array(32).fill(7), "Computer").device;

it("reads account-scoped signaling presence without treating it as direct reachability", async () => {
  const fetchAccount = vi.fn<typeof fetch>(async () =>
    Response.json({
      devices: [device],
      presence: [{ deviceId: device.deviceId, online: true }],
    }),
  );
  expect(
    await getPeerDevices({
      controlUrl: "https://devices.example.com",
      bearerToken: async () => "signed-account-session",
      fetch: fetchAccount,
    }),
  ).toEqual({ devices: [device], presence: [{ deviceId: device.deviceId, online: true }] });
  const [url, options] = fetchAccount.mock.calls[0]!;
  expect(String(url)).toBe("https://devices.example.com/v1/devices");
  expect(options).toMatchObject({
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { authorization: "Bearer signed-account-session" },
  });
});

it("keeps older device services readable with unknown presence", async () => {
  expect(
    await getPeerDevices({
      controlUrl: "https://devices.example.com",
      fetch: async () => Response.json({ devices: [device] }),
    }),
  ).toEqual({ devices: [device], presence: [] });
});

it("rejects a failed or malformed directory response", async () => {
  await expect(
    getPeerDevices({
      controlUrl: "https://devices.example.com",
      fetch: async () => new Response(null, { status: 401 }),
    }),
  ).rejects.toMatchObject({ code: "unapproved-device" });
  await expect(
    getPeerDevices({
      controlUrl: "https://devices.example.com",
      fetch: async () =>
        Response.json({
          devices: [device],
          presence: [{ deviceId: device.deviceId, online: "reachable" }],
        }),
    }),
  ).rejects.toThrow();
});

it("accepts a full bounded directory while refusing oversized service responses", async () => {
  const devices = Array.from({ length: 100 }, (_, index) => ({
    ...device,
    deviceId: `device_${String(index).padStart(121, "0")}`,
    label: "Computer".repeat(10),
  }));
  const directory = {
    devices,
    presence: devices.map(({ deviceId }) => ({ deviceId, online: false })),
  };
  expect(JSON.stringify(directory).length).toBeGreaterThan(32_768);
  expect(
    (
      await getPeerDevices({
        controlUrl: "https://devices.example.com",
        fetch: async () => Response.json(directory),
      })
    ).devices,
  ).toHaveLength(100);
  await expect(
    getPeerDevices({
      controlUrl: "https://devices.example.com",
      fetch: async () => Response.json({ devices: [], padding: "x".repeat(65_536) }),
    }),
  ).rejects.toMatchObject({ code: "frame-too-large" });
});

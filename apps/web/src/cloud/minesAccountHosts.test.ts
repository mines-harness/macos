import { describe, expect, it } from "vite-plus/test";

import { isLocalMinesAccountHost } from "./minesAccountHosts";

describe("Mines account host boundary", () => {
  it.each(["http://localhost:3773", "http://127.0.0.1:3773", "http://[::1]:3773"])(
    "allows the local host at %s to receive account binding changes",
    (httpBaseUrl) => expect(isLocalMinesAccountHost({ httpBaseUrl })).toBe(true),
  );
  it.each([
    { httpBaseUrl: "https://remote.example.com" },
    { httpBaseUrl: "https://localhost.example.com" },
    { httpBaseUrl: "not a URL" },
    { httpBaseUrl: "http://localhost:3773", peerSession: {} },
    null,
  ])("keeps account sign-out and registration away from remote or peer hosts: %j", (connection) => {
    expect(isLocalMinesAccountHost(connection)).toBe(false);
  });
});

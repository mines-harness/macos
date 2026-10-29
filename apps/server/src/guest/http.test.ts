import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest } from "effect/http";

import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as GuestShareService from "./GuestShareService.ts";

import { guestProxyHeaders } from "./guestProxyTrust.ts";
import { guestRequestIp } from "./guestRequestIp.ts";

import { layer, readSubmission } from "./http.ts";

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("guest request IP", () => {
  it("uses authenticated public bridge IPs and rejects their headers from a remote socket", () => {
    const headers = {
      ...guestProxyHeaders("198.51.100.42"),
      "x-forwarded-for": "192.0.2.1",
      "cf-connecting-ip": "192.0.2.2",
    };
    assert.equal(
      guestRequestIp({ ipAddress: "127.0.0.1", headers, relayHostname: null }),
      "198.51.100.42",
    );
    assert.equal(
      guestRequestIp({ ipAddress: "203.0.113.1", headers, relayHostname: null }),
      "203.0.113.1",
    );
  });
  it("ignores forwarded addresses from untrusted direct peers", () => {
    assert.equal(
      guestRequestIp({
        ipAddress: "203.0.113.10",
        headers: {
          "x-forwarded-for": "198.51.100.1",
          "cf-connecting-ip": "198.51.100.2",
          host: "env.t3.test",
        },
        relayHostname: "env.t3.test",
      }),
      "203.0.113.10",
    );
  });
  it("uses Cloudflare's single client address only on the active local connector host", () => {
    assert.equal(
      guestRequestIp({
        ipAddress: "::ffff:127.0.0.1",
        headers: { "cf-connecting-ip": "198.51.100.2", host: "env.t3.test" },
        relayHostname: "env.t3.test",
      }),
      "198.51.100.2",
    );
    assert.equal(
      guestRequestIp({
        ipAddress: "127.0.0.1",
        headers: { "cf-connecting-ip": "198.51.100.2", host: "localhost" },
        relayHostname: "env.t3.test",
      }),
      "127.0.0.1",
    );
    assert.equal(
      guestRequestIp({
        ipAddress: "127.0.0.1",
        headers: { "cf-connecting-ip": "198.51.100.2", host: "env.t3.test" },
        relayHostname: null,
      }),
      "127.0.0.1",
    );
  });
  it("normalizes equivalent IP representations before binding a session or applying a ban", () => {
    for (const ipAddress of ["192.0.2.1", "::ffff:192.0.2.1", "::FFFF:C000:201"]) {
      assert.equal(guestRequestIp({ ipAddress, headers: {}, relayHostname: null }), "192.0.2.1");
    }
    assert.equal(
      guestRequestIp({ ipAddress: "fe80::1%eth0", headers: {}, relayHostname: null }),
      null,
    );
  });
  it("refuses missing IPs and malformed trusted relay addresses", () => {
    assert.equal(guestRequestIp({ headers: {}, relayHostname: null }), null);
    assert.equal(
      guestRequestIp({
        ipAddress: "127.0.0.1",
        headers: { "cf-connecting-ip": "198.51.100.2, 198.51.100.3", host: "env.t3.test" },
        relayHostname: "env.t3.test",
      }),
      null,
    );
  });
});

it("refuses every guest HTTP endpoint without an authoritative request IP", async () => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    layer.pipe(
      Layer.provideMerge(Layer.mock(GuestShareService.GuestShareService)({})),
      Layer.provideMerge(
        Layer.mock(CloudManagedEndpointRuntime)({ inspectConnector: Effect.succeed(null) }),
      ),
      Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
      Layer.provideMerge(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  try {
    for (const path of [
      "session",
      "stream",
      "render",
      "item",
      "command-output",
      "attachment",
      "messages",
      "activity",
      "redeem",
    ]) {
      const response = await handler(
        new Request(
          `http://localhost/api/guest/${path}?share=share&item=item&id=file`,
          path === "messages" || path === "redeem" || path === "activity"
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  credential: "invite",
                  name: "Sam",
                  shareId: "share",
                  text: "Hello",
                  kind: "typing",
                }),
              }
            : undefined,
        ),
      );
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), {
        reason: "invalid",
        message: "This guest link is not valid.",
      });
    }
    for (const method of ["PATCH", "DELETE"]) {
      const response = await handler(
        new Request("http://localhost/api/guest/messages?share=share", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            shareId: "share",
            guestMessageId: "message",
            text: "Revised",
            expectedRevision: 0,
            requestId: method,
          }),
        }),
      );
      assert.equal(response.status, 403, method);
    }
  } finally {
    await dispose();
  }
});

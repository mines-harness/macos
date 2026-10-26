# Troubleshoot device connections

mines does not use the upstream T3 Connect managed tunnel. Its device service
handles account registration and signaling; conversation content travels over an
approved direct connection. See [remote access](./remote-access.md) for setup.

- **Sign-in or device registration is unavailable:** check that this build uses
  your mines Clerk application and that your HTTPS device service is configured.
- **A device is listed but will not connect:** keep the host awake and running,
  approve the device key on the host, and check that both devices use the same
  mines account. Compare the fingerprint before approving.
- **The connection works on Wi-Fi but fails on another network:** try a different
  network. Restrictive NAT, cellular, and corporate networks can prevent direct
  connectivity. mines does not silently send content through a relay.
- **An existing connection stopped working:** check device revocation and account
  changes, then pair again if access was intentionally removed.
- **History is visible but actions are unavailable:** you may be viewing cached
  content. Reconnect to the computer that owns the mine to continue execution.

The device service cannot wake an offline computer, serve its conversation
history, or queue webhook request bodies. Generic push alerts also need your own
push-delivery configuration and the phone's notification permission.

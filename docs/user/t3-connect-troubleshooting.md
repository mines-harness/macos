# Troubleshoot device connections

The Mines device service handles account registration and signaling; conversation
content travels over an approved direct connection. Direct connections do not fall
back to managed tunnels or a relay. See [remote access](./remote-access.md) for setup.

<a id="sign-in-account-or-link-problems"></a>

## Sign-in and device approval

Check that both devices use the same Mines account and that the configured sign-in
and device services are available. A listed device still needs approval on its
host. Compare its fingerprint before approving. If an existing connection stopped
working, check revocation and account changes; pair again if access was intentionally
removed.

<a id="the-hosts-tunnel-is-offline"></a>

## The host is unavailable

Keep the host awake, online, and running mines. Account presence alone does not
confirm a working direct connection. The device service cannot wake the host or
serve its conversation history. On mobile, bring the app back to the foreground if
the operating system suspended it.

<a id="the-tunnel-works-but-t3-code-does-not-answer"></a>

## The host is reachable but mines does not answer

Working SSH or a reachable network address does not confirm that the Mines server
is running. Check mines on the host, then retry the saved connection. For a
desktop-managed SSH connection, see [SSH access](./remote-access.md#desktop-managed-ssh).

<a id="the-t3-connect-address-does-not-resolve-or-answer"></a>

## The host address does not resolve or answer

Check the saved host address, port, and HTTP or HTTPS scheme. A private or tailnet
address must be reachable from the connecting device. If DNS or a VPN blocks the
address, correct that network configuration or try another network.

<a id="this-device-cant-reach-t3-connect"></a>

## This device cannot reach the service

Check this device's internet connection and its access to the configured Mines
service. A VPN, proxy, or firewall can block sign-in or connection negotiation even
while the host is online. Try another network before changing device approvals.

<a id="port-7844-is-blocked-on-the-host"></a>

## A network blocks the connection

Restrictive NAT, cellular, and corporate networks can prevent direct connectivity.
Try a different network. Mines does not silently relay conversation content.

Port 7844 applies only to an explicitly configured legacy Cloudflare tunnel, not to
direct peer connections. For such an endpoint, ask its operator to check outbound
TCP and UDP access on that port. See [optional legacy managed endpoints](./remote-access.md#optional-legacy-managed-endpoints).

<a id="the-clock-is-off"></a>

## The device clock is wrong

Turn on automatic date and time on both devices, then retry. An incorrect clock can
prevent authentication or a secure connection.

<a id="the-host-runs-an-older-t3-code"></a>

## The host runs an older version

Update mines on the host and reconnect. Updating the connecting app alone does not
update a remote host. For a desktop-managed SSH computer, use **Update CLI** beside
that computer in **Settings → Devices** when an update is available.

<a id="t3-connect-returned-an-error"></a>

## The configured service returned an error

Retry later. If the error continues, copy the connection diagnostics for the
service operator, leaving out pairing URLs and authorization codes. A configured
legacy managed endpoint uses its own service; the Mines device service does not
replace it.

## Cached history is visible but actions are unavailable

Reconnect to the computer that owns the mine to continue execution. Uncached
content and live actions require that host to be reachable.

The device service cannot wake an offline computer, serve its conversation
history, or queue webhook request bodies. Generic push alerts also need your own
push-delivery configuration and the phone's notification permission.

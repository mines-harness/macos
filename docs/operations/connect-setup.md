# Mines account and device setup

Mines uses the self-hosted account and device service described in the
[deployment guide](../../infra/mines-control/README.md). The app does not require a
Clerk account or an upstream T3 relay.

Set the same public service origins before building web, desktop, or mobile:

```dotenv
MINES_HOSTED_APP_URL=https://mines.example.com
MINES_CONTROL_URL=https://mines.example.com
MINES_STUN_URL=stun:mines.example.com:3478
```

Put these public settings in the repository-root `.env.local` or the build
environment. Process variables take precedence over `.env.local`, then `.env`.
Database, authentication, and SMTP secrets belong only on the account service.
Rebuild installed clients after changing public service origins.

Configure the service's allowed origins for the clients you operate. Packaged
desktop uses `mines://app`; development desktop uses `mines-dev://app`. Include
hosted web origins explicitly. A private web origin also needs to be allowed by
the service before its account requests will succeed.

With email delivery configured, users create an account, verify their email, then
sign in on each device. Settings > Connections shows device sync and approval
status. Account membership and host approval are separate: the host must approve
each connecting device's public key. Device connections use direct WebRTC; some
networks require changing networks before they can connect.

The inherited relay-oriented `mines connect` CLI OAuth flow is unavailable unless
an operator separately provides its own compatible OAuth endpoints. The account
service's email/password endpoints do not provide an OAuth device grant.

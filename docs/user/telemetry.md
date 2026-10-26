# Product usage data

Product telemetry is off by default in mines. No upstream T3 Code analytics or
relay tracing endpoint is configured. Turning on product telemetry requires
`MINES_TELEMETRY_ENABLED=true` and your own `MINES_POSTHOG_HOST` and
`MINES_POSTHOG_KEY` on the server.

When explicitly enabled, events can include provider and model choices, turn
outcomes, timing, token totals, and hashed installation/account identifiers. They
do not include prompts, replies, files, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Set `MINES_TELEMETRY_ENABLED=false`
and restart the server to disable these events.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`MINES_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `MINES_OTLP_*_URL`, set `MINES_OTLP_HEADERS` for
receivers that need authentication and `MINES_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.

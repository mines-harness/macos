# Mobile notifications

mines can send a generic alert when an agent turn finishes or needs attention.
Alerts contain no mine title, conversation text, or mine ID. Opening an alert
opens the app; reconnect to the computer to inspect the work.

Notifications need a native mines phone build, your mines account and device
service, and your distributor’s own Expo project with APNs/FCM credentials. They
are disabled when that configuration is missing. Signing in or pairing a direct
connection alone does not enable push delivery. Deployment details are in the
[device-service guide](../../infra/mines-control/README.md#generic-phone-notifications).

On the phone, sign in and open **Settings → Notifications → Agent updates**.
Choose **Enable notifications** and allow notifications in system Settings. The
host must also have agent updates enabled by its operator. It must be running to
publish new events, but the phone does not need to keep a live connection to it.
Delivery depends on the notification provider, the phone’s network, and its
system settings; missed host events are not replayed after a restart.

Choose **Disable on this phone** to opt out. If the phone is offline, remote
removal waits until it can reconnect. Revoking that device from another signed-in
client stops new alerts at the device service immediately.

Live Activities and detailed ongoing-status notifications from the inherited
managed-relay integration are not part of the default mines push configuration.

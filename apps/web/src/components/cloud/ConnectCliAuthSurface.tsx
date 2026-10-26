import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-3xs font-semibold tracking-widest text-primary uppercase">{eyebrow}</p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

export function ConnectCliAuthorizeSurface() {
  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Device connection"
        title="Connect from the Mines app"
        description="Sign in to your Mines account, then open Settings → Connections to approve and connect your devices."
      />
    </AuthSurfaceShell>
  );
}

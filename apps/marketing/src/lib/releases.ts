export type ReleaseChannel = "stable" | "nightly";

export function releasePageUrl(channel: ReleaseChannel = "stable"): string | null {
  const configured =
    channel === "nightly"
      ? import.meta.env.PUBLIC_MINES_NIGHTLY_RELEASES_URL
      : import.meta.env.PUBLIC_MINES_RELEASES_URL;
  try {
    const url = new URL(configured ?? "");
    if (url.protocol !== "https:" || url.hostname === "t3.codes") return null;
    if (url.hostname === "github.com" && url.pathname.startsWith("/pingdotgg/t3code/")) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export const RELEASES_URL = releasePageUrl();
export const NIGHTLY_RELEASES_URL = releasePageUrl("nightly");

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const configured = releasePageUrl(channel);
  if (!configured) throw new Error("Release not available yet");
  const url = new URL(configured);
  const repository = /^\/([^/]+\/[^/]+)\/releases(?:\/|$)/.exec(url.pathname)?.[1];
  if (url.hostname !== "github.com" || !repository) {
    throw new Error("Release metadata is unavailable for this download source");
  }
  const key = `mines-${channel}-release:${configured}`;
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const endpoint = `https://api.github.com/repos/${repository}/releases`;
  const response = await fetch(
    channel === "nightly" ? `${endpoint}?per_page=10` : `${endpoint}/latest`,
  );
  if (!response.ok) throw new Error("Could not read mines releases");
  const result: Release | Release[] = await response.json();
  const data = Array.isArray(result)
    ? result.find((release) => release.tag_name?.includes("-nightly."))
    : result;
  if (!data?.assets) throw new Error("No matching mines release");
  sessionStorage.setItem(key, JSON.stringify(data));
  return data;
}

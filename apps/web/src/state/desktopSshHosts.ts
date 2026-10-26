import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";

export function filterDiscoveredSshHosts(
  hosts: ReadonlyArray<DesktopDiscoveredSshHost>,
  query: string,
): ReadonlyArray<DesktopDiscoveredSshHost> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return hosts;

  const prefixMatches: Array<DesktopDiscoveredSshHost> = [];
  const substringMatches: Array<DesktopDiscoveredSshHost> = [];
  for (const host of hosts) {
    const alias = host.alias.toLowerCase();
    if (alias.startsWith(normalizedQuery)) {
      prefixMatches.push(host);
    } else if (
      alias.includes(normalizedQuery) ||
      host.hostname.toLowerCase().includes(normalizedQuery)
    ) {
      substringMatches.push(host);
    }
  }

  return [...prefixMatches, ...substringMatches];
}

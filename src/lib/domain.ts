/**
 * Canonical PortalAccount.domain: lowercase host with no scheme, port, path or
 * leading "www.". An account covers its domain and every subdomain. The agent
 * (agent/apply.py) normalizes and matches the same way.
 */
export function normalizeDomain(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return /^(localhost|([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/.test(host) ? host : null;
}

/**
 * LinkedIn shows its apply link only after a login, so the agent looks these
 * jobs up on the company's own site first (agent/resolve.py matches the same hosts).
 */
export function isLinkedInUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ["linkedin.com", "lnkd.in"].some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

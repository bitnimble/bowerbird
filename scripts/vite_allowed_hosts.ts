/**
 * Vite refuses any Host header that is not an IP or localhost, a DNS-rebinding guard that a
 * reverse proxy forwarding a real hostname trips. Name the hosts, or `all` where the server is
 * already reachable only from a network you trust.
 */
export function viteAllowedHosts(): true | string[] | undefined {
  const hosts = process.env.VITE_ALLOWED_HOSTS?.split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  return hosts?.includes('all') ? true : hosts;
}

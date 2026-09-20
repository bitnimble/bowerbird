import { networkInterfaces } from 'node:os';
import type { ReachableAddress } from '../../schemas/replication';

// Where another device should be told to dial this one (docs/replication.md §9.1).
//
// **The address that matters is the web one, not this server's.** The usual
// deployment publishes only the web port and keeps the API on loopback inside a
// container, so a peer that dialled the API's own address would be dialling a
// port nothing exposes. The port therefore comes from the request the reader's
// browser made - it reached the UI somehow, and that is by construction an
// address that works.

/**
 * @param origin what the browser used, from the request. Kept verbatim and first
 * - it is the only candidate that carries a real hostname, a scheme and whatever
 * a reverse proxy in front of this did to the port.
 */
export function reachableAddresses(origin: string | null): ReachableAddress[] {
  const offered: ReachableAddress[] = [];
  const seen = new Set<string>();
  const add = (url: string, kind: ReachableAddress['kind']): void => {
    if (seen.has(url)) return;
    seen.add(url);
    offered.push({ url, kind });
  };

  if (origin != null && origin !== '') add(origin.replace(/\/+$/, ''), 'browser');

  // Only meaningful when the port the browser used is also the port these
  // interfaces answer on, which is why they are marked as guesses: in bridged
  // Docker these are the container's own addresses and reach nothing.
  const port = portOf(origin);
  if (port == null) return offered;
  const scheme = origin!.startsWith('https:') ? 'https' : 'http';
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      // Link-local: needs a zone index to be dialable at all, and the one this
      // side knows is not the one the other side would use.
      if (address.address.startsWith('fe80:') || address.address.startsWith('169.254.')) continue;
      add(`${scheme}://${host}${port}`, 'interface');
    }
  }
  return offered;
}

// Kept as ":1234" or "" so it can be concatenated: a proxied origin on the
// scheme's default port names no port, and inventing one breaks the URL.
function portOf(origin: string | null): string | null {
  if (origin == null || origin === '') return null;
  try {
    const parsed = new URL(origin);
    return parsed.port === '' ? '' : `:${parsed.port}`;
  } catch {
    return null;
  }
}

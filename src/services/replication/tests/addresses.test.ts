// What a pairing dialog offers to read out (docs/replication.md §9.1). The one
// address this server can be sure of is the one the browser is already on; the
// rest are assembled from local interfaces and are guesses.
import { describe, expect, it } from 'bun:test';
import { reachableAddresses } from '../addresses';

describe('addresses to pair on (§9.1)', () => {
  it('offers the browser\'s own origin first, because it is the one known to work', () => {
    const offered = reachableAddresses('http://192.168.1.5:5173');

    expect(offered[0]).toEqual({ url: 'http://192.168.1.5:5173', kind: 'browser' });
    expect(offered.slice(1).every((a) => a.kind === 'interface')).toBe(true);
  });

  // A reverse proxy in front of this is the case interface enumeration cannot
  // help with at all: the name and the scheme are the proxy's, and no local NIC
  // knows either.
  it('keeps a proxied origin verbatim, port and all', () => {
    const offered = reachableAddresses('https://photos.example.com');

    expect(offered[0]).toEqual({ url: 'https://photos.example.com', kind: 'browser' });
    expect(offered.every((a) => a.url.startsWith('https://'))).toBe(true);
    // No invented ":443": the default port is exactly what the origin omitted.
    expect(offered.some((a) => a.url.includes(':443'))).toBe(false);
  });

  it('drops a trailing slash, which would double up on every path appended to it', () => {
    expect(reachableAddresses('http://host:3000/')[0]?.url).toBe('http://host:3000');
  });

  // Link-local needs a zone index to dial, and the index this side knows is not
  // the one the other side would use.
  it('offers no link-local address', () => {
    const offered = reachableAddresses('http://192.168.1.5:5173');

    expect(offered.some((a) => a.url.includes('fe80:') || a.url.includes('169.254.'))).toBe(false);
  });

  it('says nothing rather than guessing when there is no origin to take a port from', () => {
    expect(reachableAddresses(null)).toEqual([]);
    expect(reachableAddresses('')).toEqual([]);
  });

  it('never offers the same address twice', () => {
    const offered = reachableAddresses('http://127.0.0.1:5173');
    expect(new Set(offered.map((a) => a.url)).size).toBe(offered.length);
  });
});

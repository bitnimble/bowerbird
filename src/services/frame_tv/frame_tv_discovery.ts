import { createSocket } from 'node:dgram';
import { z } from 'zod';
import type { FrameTv } from '../../schemas/frame_tv';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
// DIAL as well as Samsung's own: some firmware answers only one of the two.
const SEARCH_TARGETS = ['urn:samsung.com:device:RemoteControlReceiver:1', 'urn:dial-multiscreen-org:service:dial:1'];
const SEARCH_MS = 2000;
const DESCRIBE_TIMEOUT_MS = 2000;

const DeviceInfoSchema = z.object({
  name: z.string().optional(),
  device: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    FrameTVSupport: z.string().optional(),
  }),
});

/** Every Samsung Frame TV that answers on the local network. */
export async function discoverFrameTvs(): Promise<FrameTv[]> {
  const described = await Promise.all((await searchHosts()).map(describe));
  return described.filter((tv) => tv != null);
}

/** A TV's REST description, or null where it is not a Frame. */
export function frameTvFrom(host: string, info: unknown): FrameTv | null {
  const parsed = DeviceInfoSchema.safeParse(info);
  if (!parsed.success || parsed.data.device.FrameTVSupport !== 'true') return null;
  const { name, device } = parsed.data;
  return { id: device.id ?? host, name: name ?? device.name ?? host, host };
}

function searchHosts(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const hosts = new Set<string>();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (_message, remote) => hosts.add(remote.address));
    socket.on('error', (error) => {
      socket.close();
      reject(error);
    });
    socket.bind(0, () => {
      for (const target of SEARCH_TARGETS) {
        const search = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${target}\r\n\r\n`;
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
      }
      setTimeout(() => {
        socket.close();
        resolve([...hosts]);
      }, SEARCH_MS);
    });
  });
}

async function describe(host: string): Promise<FrameTv | null> {
  try {
    const response = await fetch(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS) });
    return frameTvFrom(host, await response.json());
  } catch {
    return null;
  }
}

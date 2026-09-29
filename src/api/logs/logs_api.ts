import { Hono } from 'hono';
import { logOutput } from '../../logger';
import { PathSegment, route } from '../../schemas/route';
import { PeerLogsSchema, ServerLogsSchema, type PeerLogs } from '../../schemas/server_logs';
import { peerUrl, type AddressedPeer } from '../../services/replication/peer_transport';
import { respond } from '../respond';

const PEER_LOGS_TIMEOUT_MS = 10_000;

export class LogsApi {
  readonly routes: Hono;

  constructor(
    private readonly deviceName: () => string,
    private readonly peers: () => AddressedPeer[],
  ) {
    const app = new Hono();

    app.get(route(), (c) =>
      c.json(
        respond(ServerLogsSchema, { name: this.deviceName(), lines: [...logOutput.recent()] }),
      ),
    );

    app.get(route(PathSegment.peers()), async (c) =>
      c.json(respond(PeerLogsSchema, await this.peerLogs())),
    );

    this.routes = app;
  }

  private async peerLogs(): Promise<PeerLogs> {
    const peers = await Promise.all(
      this.peers().map(async ({ peer_id, name, address }) => ({
        peer_id,
        name,
        lines: await fetchLines(address),
      })),
    );
    return { peers };
  }
}

async function fetchLines(address: string): Promise<string[] | null> {
  try {
    const response = await fetch(peerUrl(address, route(PathSegment.api(), PathSegment.logs())), {
      signal: AbortSignal.timeout(PEER_LOGS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return ServerLogsSchema.parse(await response.json()).lines;
  } catch {
    return null;
  }
}

import { PathSegment, route } from '../../../src/schemas/route';
import {
  PeerLogsSchema,
  ServerLogsSchema,
  type PeerLogs,
  type ServerLogs,
} from '../../../src/schemas/server_logs';
import { request } from './request';

export const logsApi = {
  server: (): Promise<ServerLogs> =>
    request(ServerLogsSchema, 'GET', route(PathSegment.api(), PathSegment.logs())),
  peers: (): Promise<PeerLogs> =>
    request(
      PeerLogsSchema,
      'GET',
      route(PathSegment.api(), PathSegment.logs(), PathSegment.peers()),
    ),
};

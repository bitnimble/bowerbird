import { z } from 'zod';

export const ServerLogsSchema = z.object({
  name: z.string(),
  lines: z.array(z.string()),
});
export type ServerLogs = z.infer<typeof ServerLogsSchema>;

export const PeerLogsSchema = z.object({
  peers: z.array(
    z.object({
      peer_id: z.string(),
      name: z.string(),
      /** Null when the peer did not answer. */
      lines: z.array(z.string()).nullable(),
    }),
  ),
});
export type PeerLogs = z.infer<typeof PeerLogsSchema>;

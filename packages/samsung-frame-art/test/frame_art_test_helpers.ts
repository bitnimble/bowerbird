// SPDX-License-Identifier: LGPL-3.0-only

import { createServer, type Socket } from 'node:net';
import type { ServerWebSocket } from 'bun';
import type { Json } from '../src/json.ts';

export class FakeTv {
  handshake: Json[] = [
    { event: 'ms.channel.connect', data: {} },
    { event: 'ms.channel.ready', data: {} },
  ];
  answer: (request: Json, tv: FakeTv) => void = () => {};
  onTransfer: (socket: Socket) => void = () => {};
  readonly requests: Json[] = [];
  clientClosed: Promise<void> = Promise.resolve();
  private client: ServerWebSocket<undefined> | undefined;
  private resolveClientClosed: () => void = () => {};

  readonly server = Bun.serve({
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      open: (ws) => {
        this.client = ws;
        this.clientClosed = new Promise((resolve) => {
          this.resolveClientClosed = resolve;
        });
        for (const message of this.handshake) ws.send(JSON.stringify(message));
      },
      message: (_ws, raw) => {
        const request = JSON.parse(JSON.parse(String(raw)).params.data) as Json;
        this.requests.push(request);
        this.answer(request, this);
      },
      close: (ws) => {
        if (ws === this.client) this.resolveClientClosed();
      },
    },
  });

  readonly transfers = createServer((socket) => this.onTransfer(socket)).listen(0, '127.0.0.1');

  get transferPort(): number {
    const address = this.transfers.address();
    if (address == null || typeof address === 'string')
      throw new Error('transfer server is not listening');
    return address.port;
  }

  emit(data: Json): void {
    this.client?.send(JSON.stringify({ event: 'd2d_service_message', data: JSON.stringify(data) }));
  }

  connInfo(): string {
    return JSON.stringify({
      ip: '127.0.0.1',
      port: String(this.transferPort),
      key: 'sec-key',
      secured: false,
    });
  }

  stop(): void {
    void this.server.stop(true);
    this.transfers.close();
  }
}

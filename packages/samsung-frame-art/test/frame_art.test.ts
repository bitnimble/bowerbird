// SPDX-License-Identifier: LGPL-3.0-only

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import type { ServerWebSocket } from 'bun';
import { FrameArt } from '../src/frame_art.ts';
import { ResponseError, UnauthorizedError } from '../src/errors.ts';
import type { Json } from '../src/json.ts';

class FakeTv {
  handshake: Json[] = [{ event: 'ms.channel.connect', data: {} }, { event: 'ms.channel.ready', data: {} }];
  answer: (request: Json, tv: FakeTv) => void = () => {};
  onTransfer: (socket: Socket) => void = () => {};
  readonly requests: Json[] = [];
  clientClosed: Promise<void> = Promise.resolve();
  private client: ServerWebSocket<undefined> | undefined;
  private resolveClientClosed: () => void = () => {};

  readonly server = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response(null, { status: 400 })),
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
    if (address == null || typeof address === 'string') throw new Error('transfer server is not listening');
    return address.port;
  }

  emit(data: Json): void {
    this.client?.send(JSON.stringify({ event: 'd2d_service_message', data: JSON.stringify(data) }));
  }

  connInfo(): string {
    return JSON.stringify({ ip: '127.0.0.1', port: String(this.transferPort), key: 'sec-key', secured: false });
  }

  stop(): void {
    void this.server.stop(true);
    this.transfers.close();
  }
}

function frame(header: Json, body: Uint8Array): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([length, headerBytes, body]);
}

const tv = new FakeTv();
let art: FrameArt;

function connect(): FrameArt {
  art = new FrameArt({ host: '127.0.0.1', port: tv.server.port, responseTimeoutMs: 500 });
  return art;
}

afterEach(() => art.close());
afterAll(() => tv.stop());

describe('FrameArt', () => {
  test('uploads an image over the transfer socket and resolves to its content id', async () => {
    const image = new Uint8Array(200_000).map((_, index) => index % 251);
    const received: Buffer[] = [];
    tv.answer = (request, fake) => {
      if (request.request !== 'send_image') return;
      fake.emit({ event: 'ready_to_use', request_id: request.request_id, conn_info: fake.connInfo() });
    };
    tv.onTransfer = (socket) => {
      socket.on('data', (chunk) => received.push(chunk));
      socket.on('end', () => {
        socket.end();
        tv.emit({ event: 'image_added', content_id: 'MY_F0042' });
      });
    };

    const contentId = await connect().upload(image, { fileType: 'jpg', date: new Date(2026, 8, 3, 7, 5, 9) });

    expect(contentId).toBe('MY_F0042');
    expect(tv.requests.find((request) => request.request === 'send_image')).toMatchObject({
      request: 'send_image',
      file_type: 'jpg',
      file_size: 200_000,
      image_date: '2026:09:03 07:05:09',
      matte_id: 'shadowbox_polar',
      portrait_matte_id: 'shadowbox_polar',
    });
    const sent = Buffer.concat(received);
    const headerLength = sent.readUInt32BE(0);
    expect(JSON.parse(sent.subarray(4, 4 + headerLength).toString())).toEqual({
      num: 0,
      total: 1,
      fileLength: 200_000,
      fileName: 'dummy',
      fileType: 'jpg',
      secKey: 'sec-key',
      version: '0.0.1',
    });
    expect(new Uint8Array(sent.subarray(4 + headerLength))).toEqual(image);
  });

  test('receives every thumbnail in a list, keyed by file', async () => {
    tv.answer = (request, fake) => {
      if (request.request !== 'get_thumbnail_list') return;
      fake.emit({ event: 'ready_to_use', request_id: request.request_id, conn_info: fake.connInfo() });
    };
    tv.onTransfer = (socket) => {
      socket.write(frame({ num: 0, total: 2, fileLength: 3, fileID: 'MY_F0001', fileType: 'jpg' }, Buffer.from('abc')));
      socket.end(frame({ num: 1, total: 2, fileLength: 2, fileID: 'MY_F0002', fileType: 'png' }, Buffer.from('de')));
    };

    const thumbnails = await connect().getThumbnailList(['MY_F0001', 'MY_F0002']);

    expect([...thumbnails].map(([file, data]) => [file, Buffer.from(data).toString()])).toEqual([
      ['MY_F0001.jpg', 'abc'],
      ['MY_F0002.png', 'de'],
    ]);
  });

  test('receives a single thumbnail', async () => {
    tv.answer = (request, fake) => {
      if (request.request !== 'get_thumbnail') return;
      fake.emit({ event: 'ready_to_use', request_id: request.request_id, conn_info: fake.connInfo() });
    };
    tv.onTransfer = (socket) => {
      socket.end(frame({ num: 0, total: 1, fileLength: 3, fileID: 'MY_F0001', fileType: 'jpg' }, Buffer.from('xyz')));
    };

    expect(Buffer.from(await connect().getThumbnail('MY_F0001')).toString()).toBe('xyz');
  });

  test('rejects an upload the TV never confirms', async () => {
    tv.answer = (request, fake) => {
      if (request.request !== 'send_image') return;
      fake.emit({ event: 'ready_to_use', request_id: request.request_id, conn_info: fake.connInfo() });
    };
    tv.onTransfer = (socket) => socket.on('end', () => socket.end());

    await expect(
      connect().upload(new Uint8Array([1, 2, 3]), { fileType: 'png', timeoutMs: 100 }),
    ).rejects.toThrow(new ResponseError('TV did not confirm the upload'));
  });

  test('passes unsolicited events to their listener', async () => {
    tv.answer = () => {};
    const heard = new Promise<Json>((resolve) => {
      connect().setListener('art_mode_changed', resolve);
    });
    await art.open();

    tv.emit({ event: 'art_mode_changed', status: 'on' });

    expect(await heard).toEqual({ event: 'art_mode_changed', status: 'on' });
  });

  test('close during an open leaves the connection closed', async () => {
    const opening = connect().open();
    art.close();
    await opening;

    expect(await Promise.race([tv.clientClosed.then(() => 'closed'), Bun.sleep(1000).then(() => 'open')])).toBe(
      'closed',
    );
  });

  test('rejects with the failing request when the TV answers an error', async () => {
    tv.answer = (request, fake) =>
      fake.emit({
        event: 'error',
        request_id: request.request_id,
        request_data: JSON.stringify({ request: request.request }),
        error_code: '-7',
      });

    await expect(connect().getCurrent()).rejects.toThrow(
      new ResponseError('get_current_artwork request failed with error number -7'),
    );
  });

  test('falls back to the old request name when the new one goes unanswered', async () => {
    tv.answer = (request, fake) => {
      if (request.request === 'api_version') fake.emit({ request_id: request.request_id, version: '2.03' });
    };

    expect(await connect().getApiVersion()).toBe('2.03');
  });

  test('refuses to open when the TV rejects the pairing', async () => {
    tv.handshake = [{ event: 'ms.channel.unauthorized', data: {} }];
    try {
      await expect(connect().open()).rejects.toBeInstanceOf(UnauthorizedError);
    } finally {
      tv.handshake = [{ event: 'ms.channel.connect', data: {} }, { event: 'ms.channel.ready', data: {} }];
    }
  });
});

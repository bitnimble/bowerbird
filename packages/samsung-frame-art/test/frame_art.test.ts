// SPDX-License-Identifier: LGPL-3.0-only

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { FrameArt } from '../src/frame_art.ts';
import { ResponseError, UnauthorizedError } from '../src/errors.ts';
import type { Json } from '../src/json.ts';
import { FakeTv } from './frame_art_test_helpers.ts';

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

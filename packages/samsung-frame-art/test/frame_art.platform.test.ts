// SPDX-License-Identifier: LGPL-3.0-only

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { FrameArt } from '../src/frame_art.ts';
import { FakeTv } from './frame_art_test_helpers.ts';

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
      fake.emit({
        event: 'ready_to_use',
        request_id: request.request_id,
        conn_info: fake.connInfo(),
      });
    };
    tv.onTransfer = (socket) => {
      socket.on('data', (chunk) => received.push(Buffer.from(chunk)));
      socket.on('end', () => {
        socket.end();
        tv.emit({ event: 'image_added', content_id: 'MY_F0042' });
      });
    };

    const contentId = await connect().upload(image, {
      fileType: 'jpg',
      date: new Date(2026, 8, 3, 7, 5, 9),
    });

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

  test('close during an open leaves the connection closed', async () => {
    const opening = connect().open();
    art.close();
    await opening;

    expect(
      await Promise.race([
        tv.clientClosed.then(() => 'closed'),
        Bun.sleep(1000).then(() => 'open'),
      ]),
    ).toBe('closed');
  });
});

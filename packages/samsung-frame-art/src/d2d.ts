// TypeScript port of samsungtvws (https://github.com/NickWaterton/samsung-tv-ws-api).
// Copyright (C) 2021 Matthew Garrett <mjg59@srcf.ucam.org>
// Copyright (C) 2024,2025 Nick Waterton <n.waterton@outlook.com>
// Copyright (C) 2026 bitnimble
// SPDX-License-Identifier: LGPL-3.0-only

import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { ResponseError } from './errors.ts';
import { asJson, parseJson, stringField, type Json } from './json.ts';

export type ConnInfo = {
  ip: string;
  port: number;
  key: string | undefined;
  secured: boolean;
};

export function parseConnInfo(value: unknown): ConnInfo {
  const info = asJson(value);
  if (info == null) throw new ResponseError('TV sent no connection details');
  return {
    ip: stringField(info, 'ip'),
    port: Number(info.port),
    key: typeof info.key === 'string' ? info.key : undefined,
    secured: info.secured === true,
  };
}

export function randomConnectionId(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

export async function sendFile(info: ConnInfo, header: Json, data: Uint8Array): Promise<void> {
  const socket = await openSocket(info);
  const headerBytes = Buffer.from(JSON.stringify(header));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length);
  socket.write(headerLength);
  socket.write(headerBytes);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.end(data, resolve);
  });
}

/** Files keyed `<fileID>.<fileType>`. */
export async function receiveFiles(info: ConnInfo): Promise<Map<string, Uint8Array>> {
  const socket = await openSocket(info);
  try {
    const reader = new SocketReader(socket);
    const files = new Map<string, Uint8Array>();
    let received = 0;
    let total = 1;
    while (received < total) {
      const headerLength = (await reader.read(4)).readUInt32BE(0);
      const header = asJson(parseJson((await reader.read(headerLength)).toString()));
      if (header == null) throw new ResponseError('TV sent a file with no header');
      received = Number(header.num) + 1;
      total = Number(header.total);
      files.set(`${String(header.fileID)}.${String(header.fileType)}`, await reader.read(Number(header.fileLength)));
    }
    return files;
  } finally {
    socket.destroy();
  }
}

function openSocket(info: ConnInfo): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = info.secured
      ? connectTls({ host: info.ip, port: info.port, rejectUnauthorized: false }, () => resolve(socket))
      : connectTcp({ host: info.ip, port: info.port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

class SocketReader {
  private readonly chunks: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);

  constructor(socket: Socket) {
    this.chunks = socket[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Buffer> {
    while (this.pending.length < length) {
      const next = await this.chunks.next();
      if (next.done === true) throw new ResponseError('TV closed the transfer early');
      this.pending = Buffer.concat([this.pending, next.value]);
    }
    const bytes = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return bytes;
  }
}

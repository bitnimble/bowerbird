// TypeScript port of samsungtvws (https://github.com/NickWaterton/samsung-tv-ws-api).
// Copyright (C) 2019 DSR! <xchwarze@gmail.com>
// Copyright (C) 2026 bitnimble
// SPDX-License-Identifier: LGPL-3.0-only

export class ConnectionFailure extends Error {
  override name = 'ConnectionFailure';
}

/** The TV refused the pairing request, or the token it was given. */
export class UnauthorizedError extends ConnectionFailure {
  override name = 'UnauthorizedError';
}

export class ResponseError extends Error {
  override name = 'ResponseError';
}

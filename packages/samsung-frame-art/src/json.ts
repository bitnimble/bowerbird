// TypeScript port of samsungtvws (https://github.com/NickWaterton/samsung-tv-ws-api).
// Copyright (C) 2019 DSR! <xchwarze@gmail.com>
// Copyright (C) 2026 bitnimble
// SPDX-License-Identifier: LGPL-3.0-only

import { ResponseError } from './errors.ts';

export type Json = Record<string, unknown>;

export function asJson(value: unknown): Json | undefined {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return undefined;
  return value as Json;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ResponseError('Failed to parse response from TV. Maybe feature not supported on this model');
  }
}

export function stringField(data: Json, key: string): string {
  const value = data[key];
  if (typeof value !== 'string') throw new ResponseError(`TV response has no string ${key}`);
  return value;
}

export function jsonField(data: Json, key: string): unknown {
  return parseJson(stringField(data, key));
}

export function jsonListField(data: Json, key: string): Json[] {
  const value = jsonField(data, key);
  if (!Array.isArray(value)) throw new ResponseError(`TV response ${key} is not a list`);
  return value.map((item) => {
    const entry = asJson(item);
    if (entry == null) throw new ResponseError(`TV response ${key} holds a non-object`);
    return entry;
  });
}

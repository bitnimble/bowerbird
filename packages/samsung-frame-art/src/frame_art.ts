// TypeScript port of samsungtvws (https://github.com/NickWaterton/samsung-tv-ws-api).
// Copyright (C) 2019 DSR! <xchwarze@gmail.com>
// Copyright (C) 2021 Matthew Garrett <mjg59@srcf.ucam.org>
// Copyright (C) 2024,2025 Nick Waterton <n.waterton@outlook.com>
// Copyright (C) 2026 bitnimble
// SPDX-License-Identifier: LGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { parseConnInfo, randomConnectionId, receiveFiles, sendFile } from './d2d.ts';
import { ConnectionFailure, ResponseError, UnauthorizedError } from './errors.ts';
import { asJson, jsonField, jsonListField, stringField, type Json } from './json.ts';

export const ArtCategory = {
  MyPictures: 'MY-C0002',
  Favourites: 'MY-C0004',
  Store: 'MY-C0008',
} as const;
export type ArtCategory = (typeof ArtCategory)[keyof typeof ArtCategory];

export type FrameArtOptions = {
  host: string;
  /** 8002 is TLS and paired by token; 8001 is plain and unpaired. */
  port?: number;
  token?: string;
  /** Called with each token the TV issues, to persist for the next session. */
  onToken?: (token: string) => void;
  /** Shown on the TV's pairing prompt. */
  name?: string;
  responseTimeoutMs?: number;
};

export type UploadOptions = {
  fileType: 'jpg' | 'png';
  matte?: string;
  portraitMatte?: string;
  date?: Date;
  timeoutMs?: number;
};

export type MotionTimer = 'off' | '5' | '15' | '30' | '60' | '120' | '240';

const ART_ENDPOINT = 'com.samsung.art-app';
const REMOTE_ENDPOINT = 'samsung.remote.control';
const IGNORED_AT_STARTUP = new Set(['ed.edenTV.update', 'ms.voiceApp.hide']);

type Waiter = (data: Json) => void;

export class FrameArt {
  private readonly host: string;
  private readonly port: number;
  private readonly name: string;
  private readonly responseTimeoutMs: number;
  private readonly onToken: ((token: string) => void) | undefined;
  private token: string | undefined;
  private socket: WebSocket | undefined;
  private opening: Promise<WebSocket> | undefined;
  private readonly pending = new Map<string, Waiter>();
  private readonly listeners = new Map<string, (data: Json) => void>();

  constructor(options: FrameArtOptions) {
    this.host = options.host;
    this.port = options.port ?? 8002;
    this.name = options.name ?? 'SamsungTvRemote';
    this.responseTimeoutMs = options.responseTimeoutMs ?? 2000;
    this.onToken = options.onToken;
    this.token = options.token;
  }

  async open(): Promise<void> {
    await this.connection();
  }

  close(): void {
    void this.opening?.then(
      (socket) => socket.close(),
      () => undefined,
    );
    this.socket?.close();
    this.socket = undefined;
  }

  /** Called with every art-app event named `event`, e.g. `art_mode_changed` or `image_added`. */
  setListener(event: string, listener: ((data: Json) => void) | undefined): void {
    if (listener == null) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.set(event, listener);
  }

  async supported(): Promise<boolean> {
    return (await this.restDevice()).FrameTVSupport === 'true';
  }

  /** False when the TV is off or unreachable, rather than throwing. */
  async isOn(): Promise<boolean> {
    return (await this.restDevice()).PowerState === 'on';
  }

  async inArtMode(): Promise<boolean> {
    return (await this.isOn()) && (await this.getArtMode()) === 'on';
  }

  async getApiVersion(): Promise<string> {
    const data =
      (await this.request({ request: 'get_api_version' })) ?? (await this.query({ request: 'api_version' }));
    return stringField(data, 'version');
  }

  getDeviceInfo(): Promise<Json> {
    return this.query({ request: 'get_device_info' });
  }

  async available(category?: ArtCategory): Promise<Json[]> {
    const data = await this.query({ request: 'get_content_list', category: category ?? null }, { timeoutMs: 4000 });
    const content = jsonListField(data, 'content_list');
    return category == null ? content : content.filter((item) => item.category_id === category);
  }

  getCurrent(): Promise<Json> {
    return this.query({ request: 'get_current_artwork' });
  }

  setFavourite(contentId: string, favourite: boolean): Promise<Json> {
    return this.query(
      { request: 'change_favorite', content_id: contentId, status: onOff(favourite) },
      { waitForEvent: 'favorite_changed' },
    );
  }

  /** Items named `brightness`, `color_temperature`, `motion_sensitivity`, `motion_timer`, `brightness_sensor_setting`. */
  async getArtModeSettings(): Promise<Json[]> {
    return jsonListField(await this.query({ request: 'get_artmode_settings' }), 'data');
  }

  getAutoRotationStatus(): Promise<Json> {
    return this.query({ request: 'get_auto_rotation_status' });
  }

  /** `minutes` of 0 turns rotation off. */
  setAutoRotationStatus(minutes: number, shuffle = true, category: ArtCategory = ArtCategory.MyPictures): Promise<Json> {
    return this.query({ request: 'set_auto_rotation_status', ...rotation(minutes, shuffle, category) });
  }

  getSlideshowStatus(): Promise<Json> {
    return this.query({ request: 'get_slideshow_status' });
  }

  /** `minutes` of 0 turns the slideshow off. */
  setSlideshowStatus(minutes: number, shuffle = true, category: ArtCategory = ArtCategory.MyPictures): Promise<Json> {
    return this.query({ request: 'set_slideshow_status', ...rotation(minutes, shuffle, category) });
  }

  getBrightness(): Promise<Json> {
    return this.settingWithFallback('get_brightness', 'brightness');
  }

  /** `"0"` to `"10"`. */
  setBrightness(value: string): Promise<Json> {
    return this.query({ request: 'set_brightness', value });
  }

  getColorTemperature(): Promise<Json> {
    return this.settingWithFallback('get_color_temperature', 'color_temperature');
  }

  /** `"-5"` to `"5"`. */
  setColorTemperature(value: string): Promise<Json> {
    return this.query({ request: 'set_color_temperature', value });
  }

  setBrightnessSensor(on: boolean): Promise<Json> {
    return this.query({ request: 'set_brightness_sensor_setting', value: onOff(on) });
  }

  setMotionTimer(value: MotionTimer): Promise<Json> {
    return this.query({ request: 'set_motion_timer', value });
  }

  /** `"1"` to `"3"`. */
  setMotionSensitivity(value: string): Promise<Json> {
    return this.query({ request: 'set_motion_sensitivity', value });
  }

  /** Thumbnails keyed `<contentId>.<fileType>`. Older firmware lacks this; use `getThumbnail`. */
  async getThumbnailList(contentIds: string[]): Promise<Map<string, Uint8Array>> {
    const data = await this.query({
      request: 'get_thumbnail_list',
      content_id_list: contentIds.map((contentId) => ({ content_id: contentId })),
      conn_info: { d2d_mode: 'socket', connection_id: randomConnectionId(), id: randomUUID() },
    });
    return receiveFiles(parseConnInfo(jsonField(data, 'conn_info')));
  }

  async getThumbnail(contentId: string): Promise<Uint8Array> {
    const data = await this.query({
      request: 'get_thumbnail',
      content_id: contentId,
      conn_info: { d2d_mode: 'socket', connection_id: randomConnectionId(), id: randomUUID() },
    });
    const [thumbnail] = (await receiveFiles(parseConnInfo(jsonField(data, 'conn_info')))).values();
    if (thumbnail == null) throw new ResponseError(`TV sent no thumbnail for ${contentId}`);
    return thumbnail;
  }

  /** Resolves to the new artwork's content id. */
  async upload(image: Uint8Array, options: UploadOptions): Promise<string> {
    const id = randomUUID();
    const data = await this.query({
      request: 'send_image',
      id,
      file_type: options.fileType,
      conn_info: { d2d_mode: 'socket', connection_id: randomConnectionId(), id },
      image_date: formatImageDate(options.date ?? new Date()),
      matte_id: options.matte ?? 'shadowbox_polar',
      portrait_matte_id: options.portraitMatte ?? 'shadowbox_polar',
      file_size: image.length,
    });
    const connInfo = parseConnInfo(jsonField(data, 'conn_info'));
    const added = this.waitFor('image_added', options.timeoutMs ?? 10_000);
    const header = {
      num: 0,
      total: 1,
      fileLength: image.length,
      fileName: 'dummy',
      fileType: options.fileType,
      secKey: connInfo.key,
      version: '0.0.1',
    };
    try {
      await sendFile(connInfo, header, image);
    } catch (error) {
      void added.catch(() => undefined);
      throw error;
    }
    const result = await added;
    if (result == null) throw new ResponseError('TV did not confirm the upload');
    return stringField(result, 'content_id');
  }

  async delete(contentIds: string[]): Promise<void> {
    await this.request({
      request: 'delete_image_list',
      content_id_list: contentIds.map((contentId) => ({ content_id: contentId })),
    });
  }

  async selectImage(contentId: string, options: { category?: ArtCategory; show?: boolean } = {}): Promise<void> {
    await this.request({
      request: 'select_image',
      category_id: options.category ?? null,
      content_id: contentId,
      show: options.show ?? true,
    });
  }

  async getArtMode(): Promise<string> {
    return stringField(await this.query({ request: 'get_artmode_status' }), 'value');
  }

  async setArtMode(on: boolean): Promise<void> {
    await this.request({ request: 'set_artmode_status', value: onOff(on) });
  }

  async getRotation(): Promise<number> {
    return Number((await this.query({ request: 'get_current_rotation' })).current_rotation_status ?? 0);
  }

  async getPhotoFilterList(): Promise<Json[]> {
    return jsonListField(await this.query({ request: 'get_photo_filter_list' }), 'filter_list');
  }

  async setPhotoFilter(contentId: string, filterId: string): Promise<void> {
    await this.request({ request: 'set_photo_filter', content_id: contentId, filter_id: filterId });
  }

  async getMatteList(): Promise<{ types: Json[]; colours: Json[] }> {
    const data = await this.query({ request: 'get_matte_list' });
    return {
      types: jsonListField(data, 'matte_type_list'),
      colours: data.matte_color_list == null ? [] : jsonListField(data, 'matte_color_list'),
    };
  }

  /** `matteId` is `<style>_<colour>`, e.g. `flexible_polar`, or `none`. Not every matte fits every image size. */
  async changeMatte(contentId: string, matteId?: string, portraitMatteId?: string): Promise<void> {
    await this.request({
      request: 'change_matte',
      content_id: contentId,
      matte_id: matteId ?? 'none',
      ...(portraitMatteId == null ? {} : { portrait_matte_id: portraitMatteId }),
    });
  }

  private async settingWithFallback(request: string, setting: string): Promise<Json> {
    const data = await this.request({ request });
    if (data != null) return data;
    const item = (await this.getArtModeSettings()).find((entry) => entry.item === setting);
    if (item == null) throw new ResponseError(`TV reported no ${setting}`);
    return item;
  }

  private async query(request: Json, options?: { waitForEvent?: string; timeoutMs?: number }): Promise<Json> {
    const data = await this.request(request, options);
    if (data == null) throw new ResponseError(`TV did not answer ${String(request.request)}`);
    return data;
  }

  /** Resolves undefined when the TV does not answer in time, which older firmware does for requests it lacks. */
  private async request(
    request: Json,
    options: { waitForEvent?: string; timeoutMs?: number } = {},
  ): Promise<Json | undefined> {
    const id = typeof request.id === 'string' ? request.id : randomUUID();
    const socket = await this.connection();
    const response = this.waitFor(options.waitForEvent ?? id, options.timeoutMs ?? this.responseTimeoutMs);
    socket.send(
      JSON.stringify({
        method: 'ms.channel.emit',
        params: {
          event: 'art_app_request',
          to: 'host',
          data: JSON.stringify({ ...request, id, request_id: id }),
        },
      }),
    );
    return response;
  }

  private waitFor(key: string, timeoutMs: number): Promise<Json | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(key, (data) => {
        clearTimeout(timer);
        this.pending.delete(key);
        if (data.event === 'error') reject(requestError(data));
        else resolve(data);
      });
    });
  }

  private dispatch(message: Json | undefined): void {
    if (message?.event !== 'd2d_service_message' || typeof message.data !== 'string') return;
    const data = parseObject(message.data);
    if (data == null) return;
    const event = typeof data.event === 'string' ? data.event : '*';
    const requestId = String(data.request_id ?? data.id);
    (this.pending.get(requestId) ?? this.pending.get(event))?.(data);
    this.listeners.get(event)?.(data);
  }

  private connection(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    this.opening ??= this.connect().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async connect(): Promise<WebSocket> {
    // 2024+ firmware issues a token only on the remote-control channel.
    if (this.token == null && this.secure) (await this.handshake(REMOTE_ENDPOINT, false)).close();
    const socket = await this.handshake(ART_ENDPOINT, true);
    socket.onmessage = (message) => this.dispatch(parseObject(message.data));
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
    };
    this.socket = socket;
    return socket;
  }

  private handshake(endpoint: string, awaitReady: boolean): Promise<WebSocket> {
    const url = this.url(endpoint);
    const socket = this.secure ? new WebSocket(url, { tls: { rejectUnauthorized: false } }) : new WebSocket(url);
    return new Promise((resolve, reject) => {
      let connected = false;
      const fail = (error: Error): void => {
        // Before close: Bun fires onclose synchronously, whose rejection would otherwise win.
        reject(error);
        socket.close();
      };
      socket.onerror = () => fail(new ConnectionFailure(`Could not connect to ${this.host}:${this.port}`));
      socket.onclose = () => reject(new ConnectionFailure(`${this.host} closed ${endpoint} during the handshake`));
      socket.onmessage = (message) => {
        const response = parseObject(message.data);
        const event = typeof response?.event === 'string' ? response.event : '*';
        if (!connected) {
          if (IGNORED_AT_STARTUP.has(event)) return;
          if (event === 'ms.channel.unauthorized') return fail(new UnauthorizedError(JSON.stringify(response)));
          if (event !== 'ms.channel.connect') return fail(new ConnectionFailure(JSON.stringify(response)));
          this.acceptToken(asJson(response?.data)?.token);
          connected = true;
          if (!awaitReady) resolve(socket);
          return;
        }
        if (event !== 'ms.channel.ready') return fail(new ConnectionFailure(JSON.stringify(response)));
        resolve(socket);
      };
    });
  }

  private acceptToken(token: unknown): void {
    if (typeof token !== 'string' || token === this.token) return;
    this.token = token;
    this.onToken?.(token);
  }

  private url(endpoint: string): string {
    const name = Buffer.from(this.name).toString('base64');
    if (!this.secure) return `ws://${this.host}:${this.port}/api/v2/channels/${endpoint}?name=${name}`;
    const token = this.token == null ? '' : `&token=${this.token}`;
    return `wss://${this.host}:${this.port}/api/v2/channels/${endpoint}?name=${name}${token}`;
  }

  private async restDevice(): Promise<Json> {
    const protocol = this.secure ? 'https' : 'http';
    try {
      const response = await fetch(`${protocol}://${this.host}:${this.port}/api/v2/`, {
        tls: { rejectUnauthorized: false },
        signal: AbortSignal.timeout(this.responseTimeoutMs),
      });
      return asJson(asJson(await response.json())?.device) ?? {};
    } catch {
      return {};
    }
  }

  private get secure(): boolean {
    return this.port === 8002;
  }
}

function parseObject(text: unknown): Json | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    return asJson(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function requestError(data: Json): ResponseError {
  const request = String(parseObject(data.request_data)?.request ?? 'Art');
  return new ResponseError(`${request} request failed with error number ${String(data.error_code)}`);
}

function rotation(minutes: number, shuffle: boolean, category: ArtCategory): Json {
  return {
    value: minutes > 0 ? String(minutes) : 'off',
    category_id: category,
    type: shuffle ? 'shuffleslideshow' : 'slideshow',
  };
}

function onOff(on: boolean): 'on' | 'off' {
  return on ? 'on' : 'off';
}

function formatImageDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

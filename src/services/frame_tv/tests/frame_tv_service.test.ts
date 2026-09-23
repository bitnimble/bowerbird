import { describe, expect, it } from 'bun:test';
import type { FrameArtOptions, UploadOptions } from 'samsung-frame-art';
import { ConnectionFailure } from 'samsung-frame-art/errors';
import { AppError } from '../../../errors';
import type { FrameTv, SendToFrameTvRequest } from '../../../schemas/frame_tv';
import type { ViewerRendition } from '../../../schemas/settings';
import { frameTvFrom } from '../frame_tv_discovery';
import { FrameTvService, type FrameArtClient } from '../frame_tv_service';

const LIVING_ROOM: FrameTv = { id: 'uuid:living', name: 'Living room', host: '10.0.0.5' };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

class Fixture {
  readonly jpegsAsked: ViewerRendition[] = [];
  readonly connected: FrameArtOptions[] = [];
  readonly uploads: { image: Uint8Array; options: UploadOptions }[] = [];
  readonly selected: string[] = [];
  readonly tokens = new Map<string, string>();
  failure: Error | null = null;

  service(enabled = true): FrameTvService {
    return new FrameTvService(
      { get: () => ({ frame_tv_enabled: enabled }) },
      {
        built: () => Promise.resolve('full'),
        jpeg: (_photoId, rendition) => {
          this.jpegsAsked.push(rendition);
          return Promise.resolve(JPEG);
        },
      },
      { get: (tvId) => this.tokens.get(tvId), set: (tvId, token) => void this.tokens.set(tvId, token) },
      () => Promise.resolve([LIVING_ROOM]),
      (options) => {
        this.connected.push(options);
        return this.client();
      },
    );
  }

  private client(): FrameArtClient {
    return {
      upload: (image, options) => {
        if (this.failure != null) return Promise.reject(this.failure);
        this.uploads.push({ image, options });
        return Promise.resolve('MY_F0001');
      },
      selectImage: (contentId) => {
        this.selected.push(contentId);
        return Promise.resolve();
      },
      close: () => undefined,
    };
  }
}

function request(overrides: Partial<SendToFrameTvRequest> = {}): SendToFrameTvRequest {
  return { tv_id: LIVING_ROOM.id, photo_id: 'aaaaaaaa', rendition: 'max', show: true, ...overrides };
}

describe('FrameTvService', () => {
  it('uploads the shared JPEG without a matte and shows it', async () => {
    const fixture = new Fixture();

    await fixture.service().send(request());

    expect(fixture.jpegsAsked).toEqual(['max']);
    expect(fixture.uploads).toEqual([
      { image: JPEG, options: { fileType: 'jpg', matte: 'none', portraitMatte: 'none', timeoutMs: 30_000 } },
    ]);
    expect(fixture.selected).toEqual(['MY_F0001']);
  });

  it('leaves the TV on its current photo when asked not to show this one', async () => {
    const fixture = new Fixture();

    await fixture.service().send(request({ show: false }));

    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.selected).toEqual([]);
  });

  it('sends the built rendition where none is named', async () => {
    const fixture = new Fixture();

    await fixture.service().send(request({ rendition: null }));

    expect(fixture.jpegsAsked).toEqual(['full']);
  });

  it('pairs with the token it kept, and keeps the one the TV issues', async () => {
    const fixture = new Fixture();
    fixture.tokens.set(LIVING_ROOM.id, 'old-token');
    const frameTvs = fixture.service();

    await frameTvs.send(request());
    await frameTvs.send(request());
    fixture.connected[0]?.onToken?.('new-token');

    expect(fixture.connected.map(({ host, token }) => ({ host, token }))).toEqual([{ host: '10.0.0.5', token: 'old-token' }]);
    expect(fixture.tokens.get(LIVING_ROOM.id)).toBe('new-token');
  });

  it('names the TV that does not answer', async () => {
    const fixture = new Fixture();
    fixture.failure = new ConnectionFailure('Could not connect to 10.0.0.5:8002');

    await expect(fixture.service().send(request())).rejects.toThrow(
      new AppError('UNAVAILABLE', 'Living room: Could not connect to 10.0.0.5:8002'),
    );
  });

  it('keeps sending after one send fails', async () => {
    const fixture = new Fixture();
    const frameTvs = fixture.service();
    fixture.failure = new ConnectionFailure('closed');
    await frameTvs.send(request()).catch(() => undefined);
    fixture.failure = null;

    await frameTvs.send(request());

    expect(fixture.uploads).toHaveLength(1);
  });

  it('refuses to search while the integration is off', async () => {
    await expect(new Fixture().service(false).list()).rejects.toThrow(
      new AppError('CONFLICT', 'Samsung Frame TV integration is turned off'),
    );
  });

  it('refuses to send while the integration is off', async () => {
    await expect(new Fixture().service(false).send(request())).rejects.toThrow(
      new AppError('CONFLICT', 'Samsung Frame TV integration is turned off'),
    );
  });

  it('refuses a TV that did not answer the search', async () => {
    await expect(new Fixture().service().send(request({ tv_id: 'uuid:gone' }))).rejects.toThrow(
      new AppError('NOT_FOUND', 'no Samsung Frame TV uuid:gone answered on the network'),
    );
  });
});

describe('frameTvFrom', () => {
  it('reads a Frame out of its REST description', () => {
    const info = { name: '[TV] Samsung Frame (55)', device: { id: 'uuid:abc', name: 'Frame', FrameTVSupport: 'true' } };
    expect(frameTvFrom('10.0.0.5', info)).toEqual({ id: 'uuid:abc', name: '[TV] Samsung Frame (55)', host: '10.0.0.5' });
  });

  it('passes over a TV that is not a Frame', () => {
    expect(frameTvFrom('10.0.0.6', { name: 'TV', device: { id: 'uuid:def', FrameTVSupport: 'false' } })).toBeNull();
  });

  it('passes over anything that is not a Samsung description', () => {
    expect(frameTvFrom('10.0.0.7', { friendlyName: 'Chromecast' })).toBeNull();
  });

  it('falls back to the address where the TV names nothing', () => {
    expect(frameTvFrom('10.0.0.8', { device: { FrameTVSupport: 'true' } })).toEqual({
      id: '10.0.0.8',
      name: '10.0.0.8',
      host: '10.0.0.8',
    });
  });
});

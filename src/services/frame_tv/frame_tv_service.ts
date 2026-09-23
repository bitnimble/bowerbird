import type { FrameArt, FrameArtOptions } from 'samsung-frame-art';
import { ConnectionFailure, ResponseError } from 'samsung-frame-art/errors';
import { AppError } from '../../errors';
import type { FrameTv, SendToFrameTvRequest } from '../../schemas/frame_tv';
import type { Settings } from '../../schemas/settings';
import type { ShareService } from '../processing/exports/share_service';
import type { FrameTvTokens } from './frame_tv_tokens';

const UPLOAD_TIMEOUT_MS = 30_000;

export type FrameArtClient = Pick<FrameArt, 'upload' | 'selectImage' | 'close'>;

/** Sends photos to the Samsung Frame TVs on the server's local network, as Share would hand them over. */
export class FrameTvService {
  private tvs: FrameTv[] = [];
  private readonly clients = new Map<string, FrameArtClient>();
  // ponytail: one send at a time across every TV; a queue per TV if two TVs are ever fed at once.
  private sending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: { get(): Pick<Settings, 'frame_tv_enabled'> },
    private readonly shares: Pick<ShareService, 'jpeg' | 'built'>,
    private readonly tokens: Pick<FrameTvTokens, 'get' | 'set'>,
    private readonly discover: () => Promise<FrameTv[]>,
    private readonly connect: (options: FrameArtOptions) => FrameArtClient,
  ) {}

  async list(): Promise<FrameTv[]> {
    this.requireEnabled();
    this.tvs = await this.discover();
    return this.tvs;
  }

  async send(request: SendToFrameTvRequest): Promise<void> {
    this.requireEnabled();
    const sent = this.sending.then(() => this.sendNow(request));
    this.sending = sent.catch(() => undefined);
    await sent;
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private async sendNow(request: SendToFrameTvRequest): Promise<void> {
    const tv = this.tvs.find((each) => each.id === request.tv_id) ?? (await this.list()).find((each) => each.id === request.tv_id);
    if (tv == null) throw new AppError('NOT_FOUND', `no Samsung Frame TV ${request.tv_id} answered on the network`);
    const rendition = request.rendition ?? (await this.shares.built(request.photo_id));
    const jpeg = await this.shares.jpeg(request.photo_id, rendition);
    const client = this.client(tv);
    try {
      const contentId = await client.upload(jpeg, {
        fileType: 'jpg',
        matte: 'none',
        portraitMatte: 'none',
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
      if (request.show) await client.selectImage(contentId);
    } catch (error) {
      if (error instanceof ConnectionFailure || error instanceof ResponseError) {
        throw new AppError('UNAVAILABLE', `${tv.name}: ${error.message}`);
      }
      throw error;
    }
  }

  private client(tv: FrameTv): FrameArtClient {
    const existing = this.clients.get(tv.host);
    if (existing != null) return existing;
    const client = this.connect({
      host: tv.host,
      name: 'Bowerbird',
      token: this.tokens.get(tv.id),
      onToken: (token) => this.tokens.set(tv.id, token),
    });
    this.clients.set(tv.host, client);
    return client;
  }

  private requireEnabled(): void {
    if (!this.settings.get().frame_tv_enabled) throw new AppError('CONFLICT', 'Samsung Frame TV integration is turned off');
  }
}

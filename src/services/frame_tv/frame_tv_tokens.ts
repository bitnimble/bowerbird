import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const TokensSchema = z.record(z.string(), z.string());

/** The pairing token each TV issued, by TV id, so the TV asks to pair only once. */
export class FrameTvTokens {
  constructor(private readonly filePath: string) {}

  get(tvId: string): string | undefined {
    return this.read()[tvId];
  }

  set(tvId: string, token: string): void {
    writeFileSync(this.filePath, JSON.stringify({ ...this.read(), [tvId]: token }));
  }

  private read(): Record<string, string> {
    try {
      return TokensSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return {};
    }
  }
}

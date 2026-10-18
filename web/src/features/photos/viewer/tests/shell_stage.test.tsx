import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, render } = await import('@testing-library/react');
const { forgetFrames, wasDecoded } = await import('./stage_frames');
const { paints } = await import('./stage_canvases');
const { PhotoStage } = await import('../photo_stage');
const { shellStage } = await import('../../../../api/transport');
const { ZoomControlStrings } = await import('../zoom_control.strings');

const SOURCE = '/renditions/full.avif';
const URL_OF_SOURCE = new URL(SOURCE, window.location.href).href;
const BEHIND = { draws: (): boolean => true, headroom: 2, white: 6 };

const global = globalThis as {
  __TAURI__?: { core?: { invoke?: (command: string, args: unknown) => Promise<unknown> } };
};

interface Asked {
  command: string;
  stage: Record<string, unknown>;
}

let asked: Asked[] = [];
let answers: Record<string, unknown> = {};
let paintedAtHide = 0;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  paints.length = 0;
  paintedAtHide = 0;
  asked = [];
  answers = {
    stage_prepare: { state: 'ready', width: 4000, height: 3000 },
    stage_show: true,
  };
  global.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        asked.push({ command, stage: (args as { stage: Record<string, unknown> }).stage });
        if (command === 'stage_hide') paintedAtHide = paints.length;
        return answers[command] ?? null;
      },
    },
  };
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 1600, height: 900 }) as DOMRect;
});

afterEach(() => {
  cleanup();
  forgetFrames();
  paints.length = 0;
  delete global.__TAURI__;
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

const commands = (): string[] => asked.map((ask) => ask.command);

function stage(
  onImageLoad: (source: string, width: number, height: number, hdr: boolean) => void = () => {},
  { source = SOURCE, behind = BEHIND }: { source?: string; behind?: typeof BEHIND } = {},
): JSX.Element {
  return (
    <PhotoStage
      photoKey={source}
      pictures={[{ key: source, sources: [source] }]}
      alt="photo"
      filename=""
      devicePeakNits={1000}
      behind={behind}
      onImageLoad={onImageLoad}
    />
  );
}

test('the shell prepares and shows an HDR frame the page never decodes', async () => {
  const loaded: [string, number, number, boolean][] = [];
  const { unmount } = render(stage((...arrived) => loaded.push(arrived)));
  await settle();

  expect(wasDecoded(SOURCE)).toBe(false);
  expect(paints).toHaveLength(0);
  expect(asked[0]).toMatchObject({
    command: 'stage_prepare',
    stage: { url: URL_OF_SOURCE, urgent: true },
  });
  expect(loaded).toEqual([[SOURCE, 4000, 3000, true]]);
  expect(shellStage.holds(SOURCE)).toBe(true);
  const shown = asked.find((ask) => ask.command === 'stage_show')?.stage;
  expect(shown).toMatchObject({
    url: URL_OF_SOURCE,
    left: 10,
    top: 20,
    width: 1600,
    height: 900,
    headroom: 2,
    white: 6,
  });

  unmount();
  await settle();
  expect(commands()).toContain('stage_release');
  expect(commands()).toContain('stage_hide');
  expect(shellStage.holds(SOURCE)).toBe(false);
});

test('a frame the shell will not prepare is decoded by the page, and never shown behind it', async () => {
  answers.stage_prepare = { state: 'refused' };
  render(stage());
  await settle();

  expect(wasDecoded(SOURCE)).toBe(true);
  expect(commands()).not.toContain('stage_show');
});

test('a frame the server does not have is reported missing, and never decoded or shown', async () => {
  answers.stage_prepare = { state: 'missing' };
  const loaded: string[] = [];
  render(stage((source) => loaded.push(source)));
  await settle();

  expect(loaded).toEqual([]);
  expect(wasDecoded(SOURCE)).toBe(false);
  expect(commands()).not.toContain('stage_show');
});

test('a frame the shell does not draw is left to the page', async () => {
  render(stage(undefined, { behind: { ...BEHIND, draws: () => false } }));
  await settle();

  expect(commands()).not.toContain('stage_prepare');
  expect(wasDecoded(SOURCE)).toBe(true);
});

test('stepping to the next photo shows it in the window without hiding it between', async () => {
  const NEXT = '/renditions/next.avif';
  const { rerender } = render(stage());
  await settle();
  asked = [];

  rerender(stage(undefined, { source: NEXT }));
  await settle();

  expect(commands()).not.toContain('stage_hide');
  expect(asked.find((ask) => ask.command === 'stage_show')?.stage).toMatchObject({
    url: new URL(NEXT, window.location.href).href,
  });
});

test('zooming in hands the photo to the page, and the window goes once the page has drawn it', async () => {
  const { getByRole } = render(stage());
  await settle();
  expect(wasDecoded(SOURCE)).toBe(false);

  act(() => getByRole('button', { name: ZoomControlStrings.zoomIn() }).click());
  await settle();

  expect(wasDecoded(SOURCE)).toBe(true);
  expect(commands().at(-1)).toBe('stage_hide');
  expect(paintedAtHide).toBeGreaterThan(0);
});

test('a photo released and prepared again in one go is never released to the shell', async () => {
  await shellStage.prepare(SOURCE, false);
  void shellStage.release(SOURCE);
  const again = shellStage.prepare(SOURCE, true);
  await again;
  await settle();

  expect(commands()).not.toContain('stage_release');
  expect(shellStage.holds(SOURCE)).toBe(true);
  await shellStage.release(SOURCE);
  expect(commands()).toContain('stage_release');
  expect(shellStage.holds(SOURCE)).toBe(false);
});

test('a window that will not draw leaves every frame to the page', async () => {
  answers.stage_show = false;
  render(stage());
  await settle();

  expect(commands()).toContain('stage_show');
  expect(wasDecoded(SOURCE)).toBe(true);
});

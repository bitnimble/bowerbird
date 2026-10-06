// The pill in the corner of the photograph: silent unless there is something to say, and
// pinned to the viewport rather than drawn inside the picture, so a pan slides the frame
// under it instead of carrying it off the screen. Where it sits is `letterboxOf`.
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { arriveAt, arriveDetailAt, failDecodeOf, fileOf, forgetFrames, holdDecodeOf, holdDetailOf } =
  await import('./stage_frames');
const { PhotoStage } = await import('../photo_stage');
const { PhotoStageStrings } = await import('../photo_stage.strings');

afterEach(() => {
  cleanup();
  forgetFrames();
});

async function arrive(source: string): Promise<void> {
  await act(async () => {
    arriveAt(source);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const RAW = 'raw.avif';
const JPEG = 'jpeg.jpg';

function stage(
  status: { label: string; busy: boolean } | null,
  sources: string[] = [RAW],
  frame: string = RAW,
): JSX.Element {
  return (
    <PhotoStage
      photoKey="p1"
      pictures={[{ key: 'p1', sources, frame }]}
      status={status}
      alt=""
      filename=""
      devicePeakNits={1000}
      onImageLoad={() => {}}
    />
  );
}

test('a frame still arriving is a wait, and then nothing to say', async () => {
  holdDecodeOf(RAW);
  render(stage(null));
  const pill = screen.getByRole('status');
  expect(pill.textContent).toBe(PhotoStageStrings.loading());
  expect(pill.getAttribute('aria-busy')).toBe('true');

  await arrive(RAW);
  expect(screen.queryByRole('status')).toBeNull();
});

test('a frame that cannot be drawn says so, and is not a wait', async () => {
  failDecodeOf(RAW);
  render(stage(null));
  await act(async () => {});
  const pill = screen.getByRole('status');
  expect(pill.textContent).toBe(PhotoStageStrings.frameUnreadable());
  expect(pill.getAttribute('aria-busy')).toBe('false');
});

test('flipping between renditions already decoded never says loading', async () => {
  const { container, rerender } = render(stage(null, [RAW, JPEG], RAW));
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();

  const added: string[] = [];
  const note = (records: MutationRecord[]): void => {
    for (const record of records) {
      for (const node of record.addedNodes) added.push(node.textContent ?? '');
    }
  };
  const observer = new MutationObserver(note);
  observer.observe(container, { childList: true, subtree: true });
  rerender(stage(null, [RAW, JPEG], JPEG));
  await act(async () => {});
  note(observer.takeRecords());
  observer.disconnect();

  expect(added).not.toContain(PhotoStageStrings.loading());
});

// The stub stage is 200x20, so a file this shape leaves a zoom everything to add.
const LARGE = { width: 4000, height: 400 };

test('zoomed in, a rendition waiting on its detail is a wait', async () => {
  fileOf(RAW, LARGE);
  fileOf(JPEG, LARGE);
  holdDetailOf(JPEG);
  const { rerender } = render(stage(null, [RAW, JPEG], RAW));
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('region', { name: PhotoStageStrings.stage() }));
  });

  rerender(stage(null, [RAW, JPEG], JPEG));
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toBe(PhotoStageStrings.loading());

  await act(async () => arriveDetailAt(JPEG));
  expect(screen.queryByRole('status')).toBeNull();
});

test('a build says so over a frame still arriving', () => {
  holdDecodeOf(RAW);
  render(stage({ label: 'Rendering', busy: true }));
  const pill = screen.getByRole('status');
  expect(pill.textContent).toBe('Rendering');
  expect(pill.getAttribute('aria-busy')).toBe('true');
});

test('a rendition names itself over a frame still arriving, and is not a wait', () => {
  holdDecodeOf(RAW);
  render(stage({ label: 'Rendered RAW', busy: false }));
  const pill = screen.getByRole('status');
  expect(pill.textContent).toBe('Rendered RAW');
  expect(pill.getAttribute('aria-busy')).toBe('false');
});

// Not inside a picture, which is what carries the zoom and pan transform: inside one the pill
// would slide off the screen with the photograph.
test('the pill is pinned to the viewport, not to the picture', () => {
  holdDecodeOf(RAW);
  render(stage({ label: 'Rendering', busy: true }));
  const pill = screen.getByRole('status');
  expect(pill.parentElement).toBe(screen.getByRole('region', { name: PhotoStageStrings.stage() }));
});

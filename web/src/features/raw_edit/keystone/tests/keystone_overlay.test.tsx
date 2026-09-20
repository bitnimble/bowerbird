// Drawing a guide on the picture, against a presenter that writes what it is told.
//
// The presenter here is not a recorder: the overlay writes the line it is drawing into the store
// on every move, and what it decides at the release is read back off that list - so a stub that
// only remembers its calls cannot see the rule this pins.
import { afterEach, describe, expect, test } from 'bun:test';
import { action } from 'mobx';
import { neutralEdits } from '../../../../../../src/schemas/photo_edits';
import { registerDom } from '../../../../test_dom';
import { CropStore } from '../../crop/crop_store';
import { EditStore } from '../../edit/edit_store';
import { StageStore } from '../../stage/stage_store';
import type { KeystoneGuide } from '../keystone';
import type { RawEditPresenter } from '../../stage/raw_edit_presenter';
import { KeystoneStore } from '../keystone_store';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { KeystoneOverlay } = await import('../keystone_overlay');

afterEach(cleanup);

/** jsdom has no `PointerEvent`, and a `MouseEvent` of the same name is all the handlers read. */
function pointer(type: string, clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'isPrimary', { value: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function open(guides: KeystoneGuide[]): KeystoneStore {
  const edit = new EditStore();
  const stage = new StageStore(edit);
  const crop = new CropStore(stage, edit);
  const store = new KeystoneStore(stage, edit, crop);
  edit.doc = { ...neutralEdits(), keystoneGuides: guides };
  stage.width = 4000;
  stage.height = 3000;
  store.keystoning = true;
  const presenter = {
    setGuides: action((next: readonly KeystoneGuide[]) => {
      edit.doc = { ...edit.doc!, keystoneGuides: [...next] };
    }),
  } as unknown as RawEditPresenter;
  render(<KeystoneOverlay store={store} presenter={presenter} viewport={{ width: 400, height: 300 }} />);
  return store;
}

function guides(): HTMLElement {
  return screen.getByRole('group', { name: 'Perspective guides' });
}

/** A vertical drag on bare picture, which is how every guide is laid down. */
function draw(): void {
  const surface = guides();
  act(() => {
    surface.dispatchEvent(pointer('pointerdown', 0, 0));
    surface.dispatchEvent(pointer('pointermove', 0, 200));
    surface.dispatchEvent(pointer('pointerup', 0, 200));
  });
}

describe('drawing a keystone guide', () => {
  test('lays the first line down', () => {
    const store = open([]);
    draw();
    expect(store.guides).toHaveLength(1);
  });

  test('lays a second line down beside it', () => {
    const store = open([{ x1: 0.8, y1: 0.1, x2: 0.8, y2: 0.9 }]);
    draw();
    expect(store.guidePairs.vertical).toHaveLength(2);
  });

  test('will not start a third line of the pair being drawn', () => {
    const store = open([
      { x1: 0.6, y1: 0.1, x2: 0.6, y2: 0.9 },
      { x1: 0.8, y1: 0.1, x2: 0.8, y2: 0.9 },
    ]);
    draw();
    expect(store.guidePairs.vertical).toHaveLength(2);
  });

  // The drag decides its own pair, so this one is refused at the release rather than at the
  // press: the picker says vertical and the line came out level, into a pair that is full.
  test('drops a line that came out into a full pair', () => {
    const store = open([
      { x1: 0.1, y1: 0.6, x2: 0.9, y2: 0.6 },
      { x1: 0.1, y1: 0.8, x2: 0.9, y2: 0.8 },
    ]);
    const surface = guides();
    act(() => {
      surface.dispatchEvent(pointer('pointerdown', 0, 0));
      surface.dispatchEvent(pointer('pointermove', 200, 0));
      surface.dispatchEvent(pointer('pointerup', 200, 0));
    });
    expect(store.guides).toHaveLength(2);
  });
});

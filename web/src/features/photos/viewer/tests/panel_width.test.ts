import { beforeEach, expect, test } from 'bun:test';
import { MemoryStorage } from '../../../../test_storage';
import { ListingStore } from '../../grid/listing_store';
import { StacksStore } from '../../grid/stacks_store';
import { ViewerPresenter } from '../viewer_presenter';
import { ViewerStore } from '../viewer_store';

let store: ViewerStore;
let presenter: ViewerPresenter;

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
  const stacks = new StacksStore();
  store = new ViewerStore(new ListingStore(stacks), stacks);
  presenter = new ViewerPresenter(store);
});

test('a panel is drawn at half the frame at most', () => {
  presenter.setPanelWidth('edit', 700);
  presenter.setDetailBox(1000, 800);
  expect(store.shownPanelWidth('edit')).toBe(500);
  presenter.setDetailBox(2000, 800);
  expect(store.shownPanelWidth('edit')).toBe(700);
});

test('a keyboard step moves the width on screen, not the stored one past the cap', () => {
  presenter.setPanelWidth('edit', 700);
  presenter.setDetailBox(1000, 800);

  presenter.nudgePanelWidth('edit', -1);

  expect(store.shownPanelWidth('edit')).toBe(484);
});

test('a width survives a new presenter, per column', () => {
  presenter.setPanelWidth('view', 400);
  presenter.setPanelWidth('edit', 600);

  const stacks = new StacksStore();
  const next = new ViewerStore(new ListingStore(stacks), stacks);
  new ViewerPresenter(next);

  expect(next.panelWidths).toEqual({ view: 400, edit: 600 });
});

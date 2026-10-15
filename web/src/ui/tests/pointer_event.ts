/** A pointer event jsdom can dispatch: it has no `PointerEvent`, so a mouse event wearing its fields. */
export function pointerEvent(
  type: string,
  options: {
    id?: number;
    primary?: boolean;
    button?: number;
    touch?: boolean;
    x?: number;
    y?: number;
  } = {},
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: options.button ?? 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    clientX: options.x ?? 0,
    clientY: options.y ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.id ?? 7 },
    isPrimary: { value: options.primary ?? true },
    pointerType: { value: options.touch === true ? 'touch' : 'mouse' },
  });
  return event;
}

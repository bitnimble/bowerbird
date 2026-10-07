const TICK_MS = 10;

export function hapticTick(): void {
  if ('vibrate' in navigator) navigator.vibrate(TICK_MS);
}

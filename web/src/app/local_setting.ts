// Every preference this device keeps for itself goes through here. Private
// browsing and a full quota both throw on write and on read, and losing a
// preference is never worth taking the page down with it, so the guard lives in
// one place rather than at each call site that forgets it.
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* nothing to do: the preference simply does not survive the reload */
  }
}

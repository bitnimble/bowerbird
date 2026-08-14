// No A-Z: an id is also a rendition's filename, and macOS and Windows fold two
// ids differing only in case into one file.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

import { customAlphabet } from 'nanoid';

// No A-Z: an id is also a rendition's filename, and macOS and Windows fold two
// ids differing only in case into one file.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// Wide enough that peers minting offline into one id space never collide. Eight
// characters is ~41 bits, which one writer never exhausts but several do: at a
// million rows the chance of some pair colliding is around one in six, and a
// collision is two unrelated photographs claiming one primary key the first time
// their catalogues meet. Sixteen is ~82 bits, where that number is nil.
//
// Ids minted before this are shorter and stay valid: they were all minted by one
// machine, so they are already unique, and a clone copies them verbatim because
// the same id has to mean the same photograph everywhere.
const ID_LENGTH = 16;

const generate = customAlphabet(ID_ALPHABET, ID_LENGTH);

export function newId(): string {
  return generate();
}

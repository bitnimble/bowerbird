// The scene-linear decode skips `dcraw_make_mem_image` and reads `imgdata.image`
// itself, interleaving, orienting and cropping in one pass (DESIGN §10.4). That is
// only safe because the output curve on this path is a constant we set rather than one
// LibRaw derives: `no_auto_bright` pins dcraw's `t_white`, `bright` is 1 and `gamm` is
// {1,1}, which makes the curve the identity.
//
// So it is pinned rather than reasoned about. `BOWERBIRD_REFERENCE_COPY=1` puts the
// decode back on LibRaw's own path, and the two must agree to the byte - on both
// orientations of the flip, on a body that declares a crop and one that does not, and
// at half size as well as full, since the half-size decision changes the insets too.
//
// It is a subprocess per case because the choice is read from the environment inside
// the library, and this process has already loaded it.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';

const FIXTURES = ['DSC02981.ARW', 'IMG_5360.CR3'];

// Both decodes in one child, so a case costs one process rather than two, and the
// digests being compared cannot come from different builds of the library.
const PROBE = `
import { decodeRawImage, freeImage, pixels } from '${import.meta.dir}/../../src/services/processing/rawshim_ops';
// The tail, not an offset: \`bun -e\` does not put its own arguments where a script
// file's would be, so counting from the front picks up the wrong one.
const [file, depth, space, edge] = process.argv.slice(-4);
const image = decodeRawImage(file, Number(depth), space, Number(edge));
console.log(JSON.stringify({
  shape: \`\${image.width}x\${image.height}\`,
  halved: image.halved,
  direct: image.direct,
  digest: Bun.SHA1.hash(pixels(image), 'hex'),
}));
freeImage(image);
`;

interface Decoded {
  shape: string;
  halved: boolean;
  direct: boolean;
  digest: string;
}

async function decode(file: string, edge: number, reference: boolean): Promise<Decoded> {
  const child = Bun.spawn(['bun', '-e', PROBE, '--', file, '16', 'rec2020-linear', String(edge)], {
    env: { ...process.env, ...(reference ? { BOWERBIRD_REFERENCE_COPY: '1' } : {}), LOG_LEVEL: 'warn' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`decode failed: ${await new Response(child.stderr).text()}`);
  return JSON.parse(out) as Decoded;
}

for (const name of FIXTURES) {
  const file = `${import.meta.dir}/../fixtures/${name}`;
  for (const [size, edge] of [
    ['whole frame', 0],
    ['half size', 640],
  ] as const) {
    test(
      `the scene-linear decode matches LibRaw's own copy, ${name} at ${size}`,
      async () => {
        const [direct, reference] = await Promise.all([decode(file, edge, false), decode(file, edge, true)]);

        // Guards on the fixture rather than the code: a half-size case that stopped
        // halving would pass the comparison while testing the same thing twice.
        expect(direct.halved).toBe(edge > 0);
        expect(direct.shape).toBe(reference.shape);
        expect(direct.digest).toBe(reference.digest);

        // And a guard on the fork itself. `copy_processed` declines - falling back to
        // the very path this is comparing against - on any of five conditions, one of
        // which is a curve parameter it does not set itself. If it ever starts
        // declining, every assertion above passes with both arms on the reference
        // path, and the thing under test is dead with nothing to say so.
        expect(direct.direct).toBe(true);
        expect(reference.direct).toBe(false);
      },
      180_000,
    );
  }
}

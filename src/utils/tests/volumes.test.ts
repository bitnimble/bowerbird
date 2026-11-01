import { expect, test } from 'bun:test';
import { linuxVolumes } from '../volumes';

test('keeps removable mounts, decodes their names and drops the system', () => {
  const mounts = [
    '/dev/nvme0n1p2 / ext4 rw 0 0',
    'proc /proc proc rw 0 0',
    '/dev/sdb1 /media/me/EOS\\040R5 exfat rw 0 0',
    '/dev/sdc1 /run/media/me/SONY_A7 vfat rw 0 0',
    'nas:/photos /mnt/nas nfs rw 0 0',
    '',
  ].join('\n');

  expect(linuxVolumes(mounts)).toEqual([
    { name: 'EOS R5', path: '/media/me/EOS R5' },
    { name: 'SONY_A7', path: '/run/media/me/SONY_A7' },
    { name: 'nas', path: '/mnt/nas' },
  ]);
});

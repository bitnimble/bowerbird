import { describe, expect, it } from 'bun:test';
import { fsTypeIn, reportsFileEvents } from '../fstype';

// Lines as /proc/self/mountinfo writes them: the optional fields before ' - ' vary
// in number, which is what the parse has to survive.
const MOUNTINFO = [
  '25 30 0:24 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
  '30 25 0:26 / /tmp rw,nosuid,nodev shared:2 - tmpfs tmpfs rw',
  '1916 1866 0:58 / /photos rw,relatime - nfs4 example.invalid:/srv/library rw,vers=4.2',
  '1920 1916 0:59 / /photos/local\\040copies rw,relatime shared:9 - ext4 /dev/sdb1 rw',
].join('\n');

describe('fsTypeIn', () => {
  it('takes the longest mount point containing the path, not the first that matches', () => {
    expect(fsTypeIn(MOUNTINFO, '/photos/collection/photo.raw')).toBe('nfs4');
    expect(fsTypeIn(MOUNTINFO, '/home/someone')).toBe('ext4');
  });

  it('matches the mount point itself as well as what is under it', () => {
    expect(fsTypeIn(MOUNTINFO, '/photos')).toBe('nfs4');
  });

  it('does not take a mount point that is only a string prefix', () => {
    expect(fsTypeIn(MOUNTINFO, '/photosynthesis')).toBe('ext4');
  });

  it('decodes an escaped mount point, which a path arrives at unescaped', () => {
    expect(fsTypeIn(MOUNTINFO, '/photos/local copies/2025')).toBe('ext4');
  });

  it('prefers the last of two mounts at one point, which is what an overmount resolves through', () => {
    const overmounted = `${MOUNTINFO}\n2000 25 0:60 / /photos rw,relatime - ext4 /dev/sdc1 rw`;
    expect(fsTypeIn(overmounted, '/photos/2025')).toBe('ext4');
  });

  it('answers nothing when no mount contains the path', () => {
    expect(fsTypeIn('30 25 0:26 / /tmp rw - tmpfs tmpfs rw', '/photos')).toBeNull();
  });
});

describe('reportsFileEvents', () => {
  it('is false for every version of NFS, whoever wrote the file', () => {
    for (const fs of ['nfs', 'nfs3', 'nfs4']) expect(reportsFileEvents(fs)).toBe(false);
  });

  it('is false for the other mounts with writers of their own', () => {
    for (const fs of ['cifs', 'smb3', '9p', 'virtiofs', 'fuse.sshfs', 'fuse.rclone']) {
      expect(reportsFileEvents(fs)).toBe(false);
    }
  });

  it('is true for a local filesystem, including a container overlay', () => {
    for (const fs of ['ext4', 'btrfs', 'xfs', 'zfs', 'tmpfs', 'overlay']) expect(reportsFileEvents(fs)).toBe(true);
  });
});

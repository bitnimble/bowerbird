import { describe, it, expect, jest } from 'bun:test';
import { AppError } from '../../../errors';
import type { Album } from '../../../schemas/albums';
import type { BasicPhoto, PhotosRepository } from '../../photos/photos_repository';
import type { AlbumsRepository } from '../albums_repository';
import { AlbumsService } from '../albums_service';

function mockRepo(over: Partial<AlbumsRepository> = {}): AlbumsRepository {
  return {
    insert: jest.fn(),
    getById: jest.fn(() => null),
    list: jest.fn(() => []),
    updateFields: jest.fn(),
    delete: jest.fn(() => false),
    addPhotos: jest.fn(),
    removePhotos: jest.fn(),
    setBanner: jest.fn(),
    getAlbumIdsForPhoto: jest.fn(() => []),
    ...over,
  } as unknown as AlbumsRepository;
}

function mockPhotos(over: Partial<PhotosRepository> = {}): PhotosRepository {
  return { getBasicByIds: jest.fn(() => [] as BasicPhoto[]), ...over } as unknown as PhotosRepository;
}

const album: Album = { id: 'a1', name: 'Faves', ordering: 'taken_desc', banner_photo_id: null, photo_count: 0 };
const photo: BasicPhoto = { id: 'p1', library_id: 'lib', file_path: 'p1.arw', shoot_id: null };

describe('AlbumsService', () => {
  it('create inserts and returns the new album', () => {
    const insert = jest.fn();
    const created = new AlbumsService(mockRepo({ insert }), mockPhotos()).create({ name: 'Faves', ordering: 'taken_desc' });
    expect(created.name).toBe('Faves');
    expect(created.banner_photo_id).toBeNull();
    expect(insert).toHaveBeenCalled();
  });

  it('get / delete throw NOT_FOUND when absent', () => {
    expect(() => new AlbumsService(mockRepo(), mockPhotos()).get('x')).toThrow(AppError);
    expect(() => new AlbumsService(mockRepo({ delete: jest.fn(() => false) }), mockPhotos()).delete('x')).toThrow(/not found/);
  });

  it('update sets the banner when the photo exists and clears it on null', () => {
    const setBanner = jest.fn();
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [photo]) });
    const service = new AlbumsService(mockRepo({ getById: jest.fn(() => album), setBanner }), photos);
    service.update('a1', { banner_photo_id: 'p1' });
    expect(setBanner).toHaveBeenCalledWith('a1', 'p1');
    service.update('a1', { banner_photo_id: null });
    expect(setBanner).toHaveBeenCalledWith('a1', null);
  });

  it('update rejects a banner photo that does not exist (400, not a raw 500)', () => {
    const setBanner = jest.fn();
    const service = new AlbumsService(mockRepo({ getById: jest.fn(() => album), setBanner }), mockPhotos());
    expect(() => service.update('a1', { banner_photo_id: 'ghost' })).toThrow(/banner photo not found/);
    expect(setBanner).not.toHaveBeenCalled();
  });

  it('update leaves the banner untouched when the key is absent', () => {
    const setBanner = jest.fn();
    new AlbumsService(mockRepo({ getById: jest.fn(() => album), setBanner }), mockPhotos()).update('a1', { name: 'Renamed' });
    expect(setBanner).not.toHaveBeenCalled();
  });

  it('addPhotos requires the album to exist, then delegates', () => {
    expect(() => new AlbumsService(mockRepo(), mockPhotos()).addPhotos('a1', ['p'])).toThrow(/not found/);
    const addPhotos = jest.fn();
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [photo]) });
    new AlbumsService(mockRepo({ getById: jest.fn(() => album), addPhotos }), photos).addPhotos('a1', ['p1']);
    expect(addPhotos).toHaveBeenCalledWith('a1', ['p1'], expect.any(String));
  });

  it('addPhotos rejects a nonexistent photo id (400, not a raw FK 500)', () => {
    const addPhotos = jest.fn();
    // getBasicByIds returns only p1; ghost is absent -> reject before insert.
    const photos = mockPhotos({ getBasicByIds: jest.fn(() => [photo]) });
    const service = new AlbumsService(mockRepo({ getById: jest.fn(() => album), addPhotos }), photos);
    expect(() => service.addPhotos('a1', ['p1', 'ghost'])).toThrow(/photos not found/);
    expect(addPhotos).not.toHaveBeenCalled();
  });
});

import { jest } from '@jest/globals';
import { AppError } from '../../../errors';
import type { Album } from '../../../schemas/albums';
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

const album: Album = { id: 'a1', name: 'Faves', ordering: 'taken_desc', banner_photo_id: null };

describe('AlbumsService', () => {
  it('create inserts and returns the new album', () => {
    const insert = jest.fn();
    const created = new AlbumsService(mockRepo({ insert })).create({ name: 'Faves', ordering: 'taken_desc' });
    expect(created.name).toBe('Faves');
    expect(created.banner_photo_id).toBeNull();
    expect(insert).toHaveBeenCalled();
  });

  it('get / delete throw NOT_FOUND when absent', () => {
    expect(() => new AlbumsService(mockRepo()).get('x')).toThrow(AppError);
    expect(() => new AlbumsService(mockRepo({ delete: jest.fn(() => false) })).delete('x')).toThrow(/not found/);
  });

  it('update sets the banner when provided and clears it on null', () => {
    const setBanner = jest.fn();
    const service = new AlbumsService(mockRepo({ getById: jest.fn(() => album), setBanner }));
    service.update('a1', { banner_photo_id: 'p1' });
    expect(setBanner).toHaveBeenCalledWith('a1', 'p1');
    service.update('a1', { banner_photo_id: null });
    expect(setBanner).toHaveBeenCalledWith('a1', null);
  });

  it('update leaves the banner untouched when the key is absent', () => {
    const setBanner = jest.fn();
    new AlbumsService(mockRepo({ getById: jest.fn(() => album), setBanner })).update('a1', { name: 'Renamed' });
    expect(setBanner).not.toHaveBeenCalled();
  });

  it('addPhotos requires the album to exist, then delegates', () => {
    expect(() => new AlbumsService(mockRepo()).addPhotos('a1', ['p'])).toThrow(/not found/);
    const addPhotos = jest.fn();
    new AlbumsService(mockRepo({ getById: jest.fn(() => album), addPhotos })).addPhotos('a1', ['p1']);
    expect(addPhotos).toHaveBeenCalledWith('a1', ['p1'], expect.any(String));
  });
});

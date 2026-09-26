import { unusedId } from '../../db/constraints';
import { AppError } from '../../errors';
import type { CreateLabelRequest, Label, SaveLabelsRequest } from '../../schemas/labels';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LabelsRepository } from './labels_repository';

export class LabelsService {
  constructor(
    private readonly repo: LabelsRepository,
    private readonly libraries: LibrariesRepository,
  ) {}

  list(): Label[] {
    return this.repo.list();
  }

  create(request: CreateLabelRequest): Label {
    this.requireLibrary(request.library_id);
    const wanted = request.name.toLocaleLowerCase();
    if (this.repo.listByLibrary(request.library_id).some((label) => label.name.toLocaleLowerCase() === wanted)) {
      throw new AppError('CONFLICT', `label already exists: ${request.name}`);
    }
    const id = this.newId();
    this.repo.create(request.library_id, { id, name: request.name, colour: request.colour });
    return this.repo.getById(id)!;
  }

  save(request: SaveLabelsRequest): Label[] {
    this.requireLibrary(request.library_id);
    const held = this.repo.listByLibrary(request.library_id);
    const ids = new Set(held.map((label) => label.id));
    const foreign = request.labels.find((label) => label.id != null && !ids.has(label.id));
    // A label that has gone since the dialog opened is not recreated under the id another device
    // deleted it by.
    if (foreign?.id != null) throw new AppError('NOT_FOUND', `label not found: ${foreign.id}`);
    const byId = new Map(held.map((label) => [label.id, label]));
    const removed = new Set(request.removed);
    const listed = new Set(request.labels.map((label) => label.id));
    const kept = held.filter((label) => !removed.has(label.id) && !listed.has(label.id));
    const ordered = request.labels.map((label) => {
      const before = label.id == null ? undefined : byId.get(label.id);
      return {
        id: label.id ?? this.newId(),
        name: label.name ?? before!.name,
        colour: label.colour ?? before!.colour,
        renamed: label.name != null && label.name !== before?.name,
      };
    });
    // Only against a name being given now: two labels that replication left sharing one would
    // otherwise refuse every save until somebody happened to rename one.
    const resulting = [...ordered, ...kept];
    for (const label of ordered.filter((candidate) => candidate.renamed)) {
      const wanted = label.name.toLocaleLowerCase();
      if (resulting.some((other) => other.id !== label.id && other.name.toLocaleLowerCase() === wanted)) {
        throw new AppError('CONFLICT', `label already exists: ${label.name}`);
      }
    }
    this.repo.save(
      request.library_id,
      ordered.map(({ id, name, colour }) => ({ id, name, colour })),
      request.removed,
    );
    return this.repo.listByLibrary(request.library_id);
  }

  addPhotos(labelId: string, photoIds: string[]): void {
    const label = this.get(labelId);
    this.repo.addPhotos(labelId, label.library_id, photoIds);
  }

  removePhotos(labelId: string, photoIds: string[]): void {
    const label = this.get(labelId);
    this.repo.removePhotos(labelId, label.library_id, photoIds);
  }

  private get(labelId: string): Label {
    const label = this.repo.getById(labelId);
    if (label == null) throw new AppError('NOT_FOUND', `label not found: ${labelId}`);
    return label;
  }

  private requireLibrary(libraryId: string): void {
    if (this.libraries.getById(libraryId) == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
  }

  private newId(): string {
    return unusedId((id) => this.repo.getById(id) != null);
  }
}

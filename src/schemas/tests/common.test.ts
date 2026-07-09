import { SoftDeleteFilterSchema, PaginationSchema, OrderingSchema } from '../common';

describe('SoftDeleteFilterSchema', () => {
  it('parses the string "false" as false and defaults to false', () => {
    expect(SoftDeleteFilterSchema.parse({ include_deleted: 'false' }).include_deleted).toBe(false);
    expect(SoftDeleteFilterSchema.parse({ include_deleted: 'true' }).include_deleted).toBe(true);
    expect(SoftDeleteFilterSchema.parse({}).include_deleted).toBe(false);
  });
});

describe('PaginationSchema', () => {
  it('coerces string query values and applies defaults/bounds', () => {
    expect(PaginationSchema.parse({})).toEqual({ offset: 0, limit: 100 });
    expect(PaginationSchema.parse({ offset: '20', limit: '50' })).toEqual({ offset: 20, limit: 50 });
    expect(() => PaginationSchema.parse({ limit: '501' })).toThrow();
    expect(() => PaginationSchema.parse({ limit: '0' })).toThrow();
  });
});

describe('OrderingSchema', () => {
  it('accepts the four orderings and rejects others', () => {
    expect(OrderingSchema.parse('taken_desc')).toBe('taken_desc');
    expect(() => OrderingSchema.parse('name_asc')).toThrow();
  });
});

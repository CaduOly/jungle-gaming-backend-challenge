import { describe, expect, it } from 'bun:test';
import { exceedsBodyDepth, MAX_BODY_DEPTH } from './body-depth';

const nestedArrays = (depth: number): unknown => JSON.parse(`${'['.repeat(depth)}${']'.repeat(depth)}`);
const nestedObjects = (depth: number): unknown => JSON.parse(`${'{"a":'.repeat(depth - 1)}{}${'}'.repeat(depth - 1)}`);

describe('exceedsBodyDepth', () => {
  it('accepts flat bodies', () => {
    for (const body of [null, 'text', 1, true, {}, [], { a: 1, b: [] }]) expect(exceedsBodyDepth(body)).toBe(false);
  });

  it('accepts objects and arrays nested up to the limit and refuses one level more', () => {
    for (const build of [nestedArrays, nestedObjects]) {
      expect(exceedsBodyDepth(build(MAX_BODY_DEPTH))).toBe(false);
      expect(exceedsBodyDepth(build(MAX_BODY_DEPTH + 1))).toBe(true);
    }
  });

  it('finds the deep branch next to shallow siblings', () => {
    expect(exceedsBodyDepth({ shallow: 1, list: [1, 2], deep: nestedObjects(MAX_BODY_DEPTH) })).toBe(true);
    expect(exceedsBodyDepth({ shallow: 1, list: [1, 2], deep: nestedObjects(MAX_BODY_DEPTH - 1) })).toBe(false);
  });

  it('walks a body far deeper than the call stack allows without overflowing', () => {
    expect(exceedsBodyDepth(nestedArrays(200_000))).toBe(true);
  });
});

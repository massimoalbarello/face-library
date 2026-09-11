import { expect, test } from 'bun:test';
import { project } from '../src/projection.ts';

const axis = (i: number): number[] => Array.from({ length: 128 }, (_, j) => i === j ? 1 : 0);
test('empty and tiny libraries produce finite coordinates without nonlinear fitting', async () => {
  expect((await project([], () => {})).positions).toEqual([]);
  expect((await project([axis(0)], () => {})).positions).toEqual([[0, 0]]);
  const triangle = (await project([axis(0), axis(1), axis(2)], () => {})).positions;
  for (let i = 0; i < triangle.length; i++) for (let j = i + 1; j < triangle.length; j++)
    expect(Math.hypot(triangle[i]![0]! - triangle[j]![0]!, triangle[i]![1]! - triangle[j]![1]!)).toBeCloseTo(Math.sqrt(2));
});
test('identical embeddings keep identical coordinates and every view is represented', async () => {
  const result = await project([axis(0), axis(1), axis(0), axis(1)], () => {});
  expect(result.positions).toHaveLength(4);
  expect(result.unique).toBe(2);
  expect(result.positions[0]).toEqual(result.positions[2]);
  expect(result.positions[1]).toEqual(result.positions[3]);
});
test('UMAP is deterministic and projects all points beyond the fitting sample', async () => {
  const vectors = Array.from({ length: 9 }, (_, i) => axis(i));
  const a = await project(vectors, () => {}, 5);
  const b = await project(vectors, () => {}, 5);
  expect(a.method).toBe('UMAP'); expect(a.fitted).toBe(5);
  expect(a.positions).toHaveLength(vectors.length);
  expect(a.positions.flat().every(Number.isFinite)).toBe(true);
  expect(a.positions).toEqual(b.positions);
});
test('invalid vectors fail instead of rendering a misleading map', async () => {
  await expect(project([[NaN]], () => {})).rejects.toThrow('Invalid');
  const v = axis(0); v[0] = Infinity;
  await expect(project([v], () => {})).rejects.toThrow('Invalid');
});

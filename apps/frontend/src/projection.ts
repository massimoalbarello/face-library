import { UMAP } from 'umap-js';

export function seededRandom(seed = 7321) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function smallProjection(vectors: number[][]) {
  if (!vectors.length) return [];
  if (vectors.length === 1) return [[0, 0]];
  const axis = vectors[1]!.map((v, i) => v - vectors[0]![i]!);
  const length = Math.sqrt(axis.reduce((s, v) => s + v * v, 0));
  return vectors.map(v => {
    const delta = v.map((n, i) => n - vectors[0]![i]!);
    const x = length ? delta.reduce((s, n, i) => s + n * axis[i]!, 0) / length : 0;
    const y = Math.sqrt(Math.max(0, delta.reduce((s, n) => s + n * n, 0) - x * x));
    return [x, y];
  });
}

export async function project(vectors: number[][], progress: (message: string) => void,
                              fitLimit = 2000) {
  // Identical embeddings share coordinates, even if a user assigned different labels.
  const unique: number[][] = [], mapping: number[] = [];
  const buckets = new Map<number, number[]>();
  const bits = new DataView(new ArrayBuffer(4));
  for (const vector of vectors) {
    if (vector.length !== 128 || vector.some(n => !Number.isFinite(n))) throw Error('Invalid embedding data');
    let hash = 2166136261;
    for (const n of vector) { bits.setFloat32(0, n); hash = Math.imul(hash ^ bits.getUint32(0), 16777619); }
    const bucket = buckets.get(hash) || [];
    let index = bucket.find(i => unique[i]!.every((n, j) => n === vector[j]));
    if (index === undefined) {
      index = unique.length; unique.push(vector); bucket.push(index); buckets.set(hash, bucket);
    }
    mapping.push(index);
  }
  let coordinates: number[][];
  const fitted = Math.min(unique.length, fitLimit);
  if (unique.length < 4) coordinates = smallProjection(unique);
  else {
    const indices = Array.from({ length: unique.length }, (_, i) => i);
    const random = seededRandom();
    // Uniform deterministic sampling bounds the nonlinear fit, without using group labels.
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [indices[i], indices[j]] = [indices[j]!, indices[i]!];
    }
    const selected = indices.slice(0, fitted).sort((a, b) => a - b);
    const basis = selected.map(i => unique[i]!);
    const neighbors = Math.min(15, fitted - 1);
    // umap-js divides this by three during transform and tests epoch equality.
    // Keep it divisible by three so the transform loop can terminate.
    const epochs = 300;
    const umap = new UMAP({ nComponents: 2, nNeighbors: neighbors,
      minDist: 0.18, nEpochs: epochs, random: seededRandom() });
    progress(`Projecting ${fitted.toLocaleString()} distinct views…`);
    const result = await umap.fitAsync(basis, epoch => {
      if (epoch % 10 === 0) progress(`Building map · ${Math.round(epoch / epochs * 100)}%`);
    });
    coordinates = new Array(unique.length);
    selected.forEach((index, i) => { coordinates[index] = result[i]!; });
    const remaining = indices.slice(fitted);
    for (let i = 0; i < remaining.length; i += 128) {
      progress(`Placing all views · ${Math.min(fitted + i, unique.length).toLocaleString()} / ${unique.length.toLocaleString()}`);
      const batch = remaining.slice(i, i + 128);
      const placed = umap.transform(batch.map(index => unique[index]!));
      batch.forEach((index, j) => { coordinates[index] = placed[j]!; });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if (coordinates.some(p => !p || p.some(n => !Number.isFinite(n)))) throw Error('Could not compute a valid projection');
  return { positions: mapping.map(i => coordinates[i]!), fitted, unique: unique.length,
    method: unique.length < 4 ? 'Distance projection' : 'UMAP' };
}

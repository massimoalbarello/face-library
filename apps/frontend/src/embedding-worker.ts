import { project } from './projection.ts';
import type { EmbeddingView } from './embedding-types.ts';

self.onmessage = async () => {
  const progress = (message: string) => self.postMessage({ type: 'progress', message });
  try {
    const rows: (EmbeddingView & { embedding: number[] })[] = [];
    let after = 0, through: number | undefined;
    do {
      const response = await fetch(`/api/views/embeddings?after=${after}${through === undefined ? '' : `&through=${through}`}`,
        { credentials: 'same-origin' });
      if (response.status === 401) { self.postMessage({ type: 'expired' }); return; }
      if (!response.ok) throw Error('Could not load embeddings. Try refreshing the map.');
      const page = await response.json();
      if (page.dimensions !== 128 || !Array.isArray(page.items)) throw Error('Invalid embedding response');
      rows.push(...page.items);
      if (rows.length > 50000) throw Error('This map supports up to 50,000 views.');
      progress(`Loading ${rows.length.toLocaleString()} face views…`);
      through = page.through;
      if (page.done) break;
      if (page.next <= after) throw Error('The embedding cursor did not advance');
      after = page.next;
    } while (true);
    const result = await project(rows.map(r => r.embedding), progress);
    self.postMessage({ type: 'complete', ...result,
      views: rows.map(({ embedding, ...view }, i) => ({ ...view, x: result.positions[i]![0], y: result.positions[i]![1] })) });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not build the map' });
  }
};

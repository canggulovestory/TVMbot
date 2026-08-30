const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const villaData = require('../villa-data');

test('villa gallery keeps the chosen order and rejects non-web URLs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvm-gallery-'));
  villaData.init(dir);
  const gallery = ['https://example.com/pool.jpg', 'https://example.com/bedroom.jpg', 'file:///private.jpg'];
  const villa = await villaData.upsert('villas', { name: 'Villa LYSA', gallery });
  assert.deepEqual(villa.gallery, gallery.slice(0, 2));
  const reordered = await villaData.upsert('villas', { id: villa.id, gallery: [...villa.gallery].reverse() });
  assert.deepEqual(reordered.gallery, ['https://example.com/bedroom.jpg', 'https://example.com/pool.jpg']);
  await fs.rm(dir, { recursive: true, force: true });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { CatalogService } from '../src/services/catalog.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-catalog-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  db.prepare('DELETE FROM menu_aliases').run();
  db.prepare('DELETE FROM menus').run();
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

test('catalog: DB adalah master, alias dibaca dari menu_aliases', async (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO menus(id,name,price,stock,active,description,aliases) VALUES ('nasi-gudeg','Nasi Gudeg',15000,10,1,'', '[]')").run();
  db.prepare("INSERT INTO menu_aliases(menu_id,alias_norm,alias_raw) VALUES ('nasi-gudeg','gdg','gdg')").run();

  const catalog = new CatalogService({ url: 'http://127.0.0.1:1/tidak-dipakai.csv', db });
  const menus = await catalog.getMenus();
  const gudeg = menus.find((menu) => menu.id === 'nasi-gudeg');
  assert.deepEqual(gudeg.aliases, ['gdg']);
  assert.equal(gudeg.active, true);
});

test('catalog: alias dinormalisasi di server saat disimpan', (t) => {
  const db = temporaryDatabase(t);
  const catalog = new CatalogService({ db });
  catalog.createMenu({ id: 'es-teh', name: 'Es Teh Manis', price: 5000, stock: 20 });
  const menu = catalog.replaceAliases('es-teh', ['ES TEH', 'Teh.', 'es teh']);
  assert.deepEqual(menu.aliases.sort(), ['ES TEH', 'Teh.']);

  const norms = db.prepare("SELECT alias_norm FROM menu_aliases WHERE menu_id='es-teh' ORDER BY alias_norm").all().map(row => row.alias_norm);
  assert.deepEqual(norms, ['es teh', 'teh']);
});

test('catalog: tambah dan ubah menu', (t) => {
  const db = temporaryDatabase(t);
  const catalog = new CatalogService({ db });
  const created = catalog.createMenu({ id: 'ayam', name: 'Ayam Geprek', price: 18000 });
  assert.equal(created.name, 'Ayam Geprek');

  const updated = catalog.updateMenu('ayam', { price: 20000, active: false, stock: 0 });
  assert.equal(updated.price, 20000);
  assert.equal(updated.active, false);
  assert.equal(updated.stock, 0);
});

test('catalog: import CSV menonaktifkan menu yang hilang tanpa menghapus', (t) => {
  const db = temporaryDatabase(t);
  const catalog = new CatalogService({ db });
  catalog.createMenu({ id: 'lama', name: 'Menu Lama', price: 1000 });
  catalog.syncLocalCatalog([
    { id: 'baru', name: 'Menu Baru', price: 2000, stock: 5, active: true, description: '', aliases: ['br'] },
  ]);

  const menus = db.prepare('SELECT id, active FROM menus ORDER BY id').all();
  assert.deepEqual(menus, [
    { id: 'baru', active: 1 },
    { id: 'lama', active: 0 },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM menu_aliases WHERE menu_id='baru'").get().count, 1);
});

test('catalog: sinkron spreadsheet mengubah SQLite dan alias; kegagalan mempertahankan data lama', async (t) => {
  const db = temporaryDatabase(t);
  const catalog = new CatalogService({ url: 'https://example.test/menu.csv', db });
  const originalFetch = globalThis.fetch;
  let csv = 'kode,nama,harga,stok,aktif,alias\na,Nasi Jeruk,3500,20,TRUE,nj|nasi jr\nb,Lele,7000,12,TRUE,ikan lele';
  globalThis.fetch = async () => ({ ok: true, text: async () => csv });
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal((await catalog.sync()).changed, true);
  assert.equal(catalog.getStatus().itemCount, 2);

  csv = 'kode,nama,harga,stok,aktif,alias\na,Nasi Jeruk,4000,20,TRUE,jeruk rice\nb,Lele,7000,12,TRUE,ikan lele\nc,Usus,3500,50,TRUE,usus';
  assert.equal((await catalog.sync()).changed, true);
  assert.equal(db.prepare("SELECT price FROM menus WHERE id='a'").get().price, 4000);
  assert.deepEqual(db.prepare("SELECT alias_raw FROM menu_aliases WHERE menu_id='a'").all(), [{ alias_raw: 'jeruk rice' }]);

  csv = 'kode,nama,harga,stok,aktif,alias\na,Nasi Jeruk,abc,20,TRUE,jeruk';
  assert.equal((await catalog.sync()).changed, false);
  assert.match(catalog.getStatus().lastError, /Baris 2/);
  assert.equal(db.prepare("SELECT price FROM menus WHERE id='a'").get().price, 4000);
  csv = 'kode,nama,harga,stok,aktif,alias\na,Nasi Jeruk,4000,20,TRUE,jeruk';
  assert.equal((await catalog.sync()).changed, false);
  assert.match(catalog.getStatus().lastError, /turun/);
});

test('catalog: createMenu auto id, category, dan deleteMenu permanen', (t) => {
  const db = temporaryDatabase(t);
  const catalog = new CatalogService({ db });

  const created = catalog.createMenu({
    name: 'Bebek Madura',
    category: 'Lauk Satuan',
    price: 28000,
    stock: 15,
    aliases: ['bebek hitam', 'bebek madura asli'],
  });

  assert.equal(created.id, 'bebek-madura');
  assert.equal(created.category, 'Lauk Satuan');
  assert.equal(created.price, 28000);
  assert.deepEqual(created.aliases.sort(), ['bebek hitam', 'bebek madura asli']);

  const categories = catalog.getCategories();
  assert.ok(categories.includes('Lauk Satuan'));

  // Update category and price
  const updated = catalog.updateMenu(created.id, { category: 'Paket Spesial', price: 32000 });
  assert.equal(updated.category, 'Paket Spesial');
  assert.equal(updated.price, 32000);

  // Delete permanently
  const deleted = catalog.deleteMenu(created.id);
  assert.equal(deleted, true);
  assert.equal(catalog.getMenu(created.id), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM menu_aliases WHERE menu_id = ?").get(created.id).count, 0);
});

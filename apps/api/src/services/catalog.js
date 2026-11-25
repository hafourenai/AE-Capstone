import { normalize } from '../normalize.js';

const DEFAULT_TTL_MS = 60_000;

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(value => value.length)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift()?.map(value => value.trim().toLowerCase()) || [];
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || ''])));
}

export function normalizeCatalogCsv(text) {
  return parseCsv(text).map(row => ({
    id: row.kode,
    name: row.nama,
    price: Number(row.harga),
    stock: Number(row.stok),
    active: /^(true|1|ya)$/i.test(row.aktif),
    description: row.deskripsi,
    aliases: String(row.alias || '').split('|').map(value => value.trim()).filter(Boolean),
  })).filter(item => item.id && item.name && Number.isFinite(item.price) && Number.isFinite(item.stock));
}

function validateCatalogCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV tidak berisi menu');
  if (!Object.hasOwn(rows[0], 'nama') || !Object.hasOwn(rows[0], 'harga')) {
    throw new Error('CSV harus memiliki kolom nama dan harga');
  }
  const ids = new Set();
  const menus = [];
  for (const [index, row] of rows.entries()) {
    const id = row.kode || row.id || normalize(row.nama).replace(/\s+/g, '-');
    const priceText = String(row.harga ?? '').trim().replace(/,\d{1,2}$/, '').replace(/\D/g, '');
    const price = Number(priceText);
    const stock = row.stok === undefined || row.stok === '' ? 999 : Number(row.stok);
    if (!id || !row.nama || !priceText || !Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(stock) || stock < 0) {
      throw new Error(`Baris ${index + 2}: kode, nama, harga, atau stok tidak valid`);
    }
    if (ids.has(id)) throw new Error(`Baris ${index + 2}: kode menu duplikat (${id})`);
    ids.add(id);
    menus.push({
      id, name: row.nama, price, stock,
      active: !/^(false|0|tidak)$/i.test(row.aktif ?? row.tersedia ?? ''),
      description: row.deskripsi || '',
      aliases: String(row.alias || '').split(/[|,]/).map(value => value.trim()).filter(Boolean),
    });
  }
  return menus;
}

/**
 * Katalog menu.
 *
 * Sumber kebenaran adalah tabel `menus` + `menu_aliases` di SQLite (DECISIONS.md D1).
 * CSV hanya diimpor bila diminta eksplisit; tidak menimpa edit dashboard setiap request.
 */
export class CatalogService {
  constructor({ url, ttlMs = DEFAULT_TTL_MS, db, importOnStart = false, maxDrop = 0.5 }) {
    this.url = url;
    this.ttlMs = ttlMs;
    this.db = db;
    this.importOnStart = importOnStart;
    this.lastImportAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.errors = [];
    this.maxDrop = maxDrop;
    this.pendingSync = null;
  }

  async init() {
    if (this.url) await this.sync();
  }

  getStatus() {
    return {
      source: 'Database SQLite',
      itemCount: this.db.prepare('SELECT COUNT(*) AS count FROM menus WHERE active = 1').get().count,
      totalCount: this.db.prepare('SELECT COUNT(*) AS count FROM menus').get().count,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastImportAt,
      lastError: this.lastError,
      errors: this.errors,
      stale: false,
    };
  }

  sync() {
    if (this.pendingSync) return this.pendingSync;
    this.pendingSync = (async () => {
      this.lastAttemptAt = new Date().toISOString();
      try {
        const count = await this.importFromUrl();
        this.lastError = null;
        this.errors = [];
        return { changed: true, count, errors: [] };
      } catch (error) {
        this.lastError = error.message;
        this.errors = [error.message];
        console.error(`[CATALOG] Sinkronisasi gagal: ${error.message}`);
        return { changed: false, errors: this.errors };
      }
    })().finally(() => { this.pendingSync = null; });
    return this.pendingSync;
  }

  async getMenus() {
    return this.localMenus();
  }

  localMenus() {
    const aliases = (menuId) => this.db.prepare('SELECT alias_raw FROM menu_aliases WHERE menu_id = ? ORDER BY alias_raw').all(menuId);
    return this.db.prepare('SELECT id, name, category, price, stock, active, description FROM menus ORDER BY category, name').all()
      .map(item => ({
        ...item,
        category: item.category || 'Lainnya',
        active: Boolean(item.active),
        aliases: aliases(item.id).map(row => row.alias_raw),
      }));
  }

  async importFromUrl() {
    if (!this.url) throw new Error('MENU_CSV_URL belum diatur');
    const response = await fetch(this.url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const menus = validateCatalogCsv(await response.text());
    if (!menus.length) throw new Error('CSV tidak berisi menu valid');
    if (!menus.some(menu => menu.active && menu.stock > 0)) throw new Error('CSV tidak berisi menu tersedia; sinkronisasi dibatalkan');
    const previousCount = this.db.prepare('SELECT COUNT(*) AS count FROM menus WHERE active = 1').get().count;
    if (previousCount && menus.length < previousCount * (1 - this.maxDrop)) {
      throw new Error(`Jumlah menu turun dari ${previousCount} menjadi ${menus.length}; sinkronisasi dibatalkan`);
    }
    this.syncLocalCatalog(menus);
    this.lastImportAt = new Date().toISOString();
    return menus.length;
  }

  /** Upsert hasil import dalam satu transaksi; menu yang hilang dinonaktifkan. */
  syncLocalCatalog(menus) {
    const save = this.db.prepare(`INSERT INTO menus(id,name,price,active,stock,description,aliases)
      VALUES (@id,@name,@price,@active,@stock,@description,@aliases)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,active=excluded.active,
      stock=excluded.stock,description=excluded.description`);
    const insertAlias = this.db.prepare('INSERT OR IGNORE INTO menu_aliases(menu_id, alias_norm, alias_raw) VALUES (?, ?, ?)');
    this.db.transaction(items => {
      const keep = new Set(items.map(item => item.id));
      const existing = this.db.prepare('SELECT id FROM menus').all();
      items.forEach(item => {
        save.run({ ...item, active: item.active ? 1 : 0, aliases: JSON.stringify(item.aliases) });
        this.db.prepare('DELETE FROM menu_aliases WHERE menu_id = ?').run(item.id);
        for (const alias of item.aliases) {
          const norm = normalize(alias);
          if (norm) insertAlias.run(item.id, norm, alias);
        }
      });
      // Menu yang hilang dari CSV dinonaktifkan, bukan dihapus (riwayat order tetap aman).
      const deactivate = this.db.prepare('UPDATE menus SET active = 0 WHERE id = ?');
      existing.filter(item => !keep.has(item.id)).forEach(item => deactivate.run(item.id));
    })(menus);
  }

  createMenu({ id, name, category = 'Lainnya', price, stock = 999, active = true, description = '', aliases = [] }) {
    let finalId = id;
    if (!finalId) {
      const base = normalize(name).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'menu';
      finalId = base;
      let counter = 1;
      while (this.db.prepare('SELECT 1 FROM menus WHERE id = ?').get(finalId)) {
        finalId = `${base}-${counter++}`;
      }
    }
    this.db.prepare('INSERT INTO menus(id,name,category,price,active,stock,description,aliases) VALUES (?,?,?,?,?,?,?,?)')
      .run(finalId, name, category || 'Lainnya', price, active ? 1 : 0, stock, description, '[]');
    if (Array.isArray(aliases) && aliases.length > 0) {
      this.replaceAliases(finalId, aliases);
    }
    return this.getMenu(finalId);
  }

  updateMenu(id, patch) {
    const current = this.db.prepare('SELECT * FROM menus WHERE id = ?').get(id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      category: patch.category ?? current.category ?? 'Lainnya',
      price: patch.price ?? current.price,
      stock: patch.stock ?? current.stock,
      active: patch.active === undefined ? current.active : (patch.active ? 1 : 0),
      description: patch.description ?? current.description,
    };
    this.db.prepare('UPDATE menus SET name=?, category=?, price=?, stock=?, active=?, description=? WHERE id=?')
      .run(next.name, next.category, next.price, next.stock, next.active, next.description, id);
    if (Array.isArray(patch.aliases)) {
      this.replaceAliases(id, patch.aliases);
    }
    return this.getMenu(id);
  }

  deleteMenu(id) {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM menu_aliases WHERE menu_id = ?').run(id);
      return this.db.prepare('DELETE FROM menus WHERE id = ?').run(id).changes > 0;
    })();
  }

  getMenu(id) {
    const menu = this.db.prepare('SELECT id, name, category, price, stock, active, description FROM menus WHERE id = ?').get(id);
    if (!menu) return null;
    return {
      ...menu,
      category: menu.category || 'Lainnya',
      active: Boolean(menu.active),
      aliases: this.db.prepare('SELECT alias_raw FROM menu_aliases WHERE menu_id = ? ORDER BY alias_raw').all(id).map(row => row.alias_raw),
    };
  }

  getCategories() {
    return this.db.prepare("SELECT DISTINCT category FROM menus WHERE category IS NOT NULL AND category != '' ORDER BY category").all().map(r => r.category);
  }

  /** Ganti seluruh alias sebuah menu. Alias dinormalisasi di server, bukan di browser. */
  replaceAliases(menuId, aliases = []) {
    if (!this.db.prepare('SELECT 1 FROM menus WHERE id = ?').get(menuId)) return null;
    const insert = this.db.prepare('INSERT OR IGNORE INTO menu_aliases(menu_id, alias_norm, alias_raw) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM menu_aliases WHERE menu_id = ?').run(menuId);
      for (const alias of aliases) {
        const raw = String(alias ?? '').trim();
        const norm = normalize(raw);
        if (raw && norm) insert.run(menuId, norm, raw);
      }
    })();
    return this.getMenu(menuId);
  }

  /** Tambah satu alias (dipakai tombol "jadikan alias menu" di dashboard). */
  addAlias(menuId, alias) {
    const raw = String(alias ?? '').trim();
    const norm = normalize(raw);
    if (!raw || !norm) return null;
    if (!this.db.prepare('SELECT 1 FROM menus WHERE id = ?').get(menuId)) return null;
    this.db.prepare('INSERT OR IGNORE INTO menu_aliases(menu_id, alias_norm, alias_raw) VALUES (?, ?, ?)').run(menuId, norm, raw);
    return this.getMenu(menuId);
  }
}

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
    aliases: row.alias.split('|').map(value => value.trim()).filter(Boolean),
  })).filter(item => item.id && item.name && Number.isFinite(item.price) && Number.isFinite(item.stock));
}

export class CatalogService {
  constructor({ url, ttlMs = DEFAULT_TTL_MS, db }) {
    this.url = url;
    this.ttlMs = ttlMs;
    this.db = db;
    this.cache = null;
    this.expiresAt = 0;
  }

  async getMenus() {
    if (!this.url) return this.localMenus();
    if (this.cache && Date.now() < this.expiresAt) return this.cache;
    try {
      const response = await fetch(this.url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const menus = normalizeCatalogCsv(await response.text());
      if (!menus.length) throw new Error('CSV tidak berisi menu valid');
      this.cache = menus;
      this.expiresAt = Date.now() + this.ttlMs;
      this.syncLocalCatalog(menus);
      return menus;
    } catch (error) {
      console.error(`[CATALOG] Google Sheets gagal dimuat, memakai cache lokal: ${error.message}`);
      return this.cache || this.localMenus();
    }
  }

  localMenus() {
    return this.db.prepare('SELECT id, name, price, 999 AS stock, active, description, aliases FROM menus').all()
      .map(item => ({ ...item, active: Boolean(item.active), aliases: item.aliases ? JSON.parse(item.aliases) : [] }));
  }

  syncLocalCatalog(menus) {
    const save = this.db.prepare(`INSERT INTO menus(id,name,price,active,stock,description,aliases)
      VALUES (@id,@name,@price,@active,@stock,@description,@aliases)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,active=excluded.active,
      stock=excluded.stock,description=excluded.description,aliases=excluded.aliases`);
    this.db.transaction(items => {
      this.db.prepare('UPDATE menus SET active=0').run();
      items.forEach(item => save.run({ ...item, active: item.active ? 1 : 0, aliases: JSON.stringify(item.aliases) }));
    })(menus);
  }
}

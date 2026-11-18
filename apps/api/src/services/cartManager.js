// ── Helpers ──────────────────────────────────────────────────────────────────

const CONFIRM_YES = /^(ya|iya|yep|yap|oke|ok|benar|betul|bener|setuju|lanjut|fix|deal|sip|gas|confirmed?|yup|sudah benar|sudah betul|iya kak|ya kak|ok kak)[\s!.]*$/i;
const CONFIRM_NO  = /^(batal|cancel|gak jadi|nggak jadi|tidak|engga|hapus semua|stop|ga jadi|ngga jadi)[\s!.]*$/i;

// Nama yang tidak valid sebagai customer name (placeholder / generic)
const INVALID_NAMES = new Set([
  'nama', 'name', 'anda', 'saya', 'kak', 'kakak', 'bapak', 'ibu', 'mas', 'mba',
  'pelanggan', 'customer', 'user', 'anonim', 'anonymous', 'test', 'testing',
]);

function normalize(str) {
  return String(str || '').toLowerCase().trim();
}

/** Levenshtein distance (capped) untuk fuzzy match nama menu */
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 6) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[a.length][b.length];
}

/**
 * Hitung skor kecocokan antara hint dan nama menu.
 * Dipakai untuk memilih menu terbaik dari semua kandidat fuzzy.
 */
function menuMatchScore(hint, menu) {
  const h = normalize(hint);
  const name = normalize(menu.name);
  const id = normalize(menu.id);

  // Exact match — skor tertinggi
  if (name === h || id === h) return 1000;

  // hint sepenuhnya terkandung di name atau sebaliknya
  if (name.includes(h)) return 500 + (h.length / name.length) * 100;
  if (h.includes(name) && name.length >= 4) return 450 + (name.length / h.length) * 100;

  // Alias
  try {
    const aliases = Array.isArray(menu.aliases) ? menu.aliases : JSON.parse(menu.aliases || '[]');
    for (const a of aliases) {
      const al = normalize(a);
      if (al === h) return 400;
      if (al.includes(h) || h.includes(al)) return 350;
    }
  } catch {}

  // Token-level matching: hitung berapa token hint yang match ke token name
  const hTokens = h.split(/\s+/).filter(t => t.length >= 2);
  const nTokens = name.split(/\s+/).filter(t => t.length >= 2);
  if (hTokens.length === 0 || nTokens.length === 0) return 0;

  let tokenScore = 0;
  for (const ht of hTokens) {
    for (const nt of nTokens) {
      if (nt === ht) { tokenScore += 30; continue; }
      if (nt.includes(ht) || ht.includes(nt)) { tokenScore += 20; continue; }
      const dist = levenshtein(ht, nt);
      if (dist <= 2 && nt.length >= 3) tokenScore += Math.max(0, 15 - dist * 5);
    }
  }

  // Bonus jika banyak token yang cocok relatif terhadap total token
  const matchRatio = tokenScore / (hTokens.length * 30);
  return tokenScore > 0 ? tokenScore + matchRatio * 50 : 0;
}

/**
 * Resolve menuHint (string bebas dari AI) ke menu yang valid dari katalog.
 * Memilih menu dengan skor tertinggi. Return null jika tidak ada yang cukup cocok.
 */
export function resolveMenu(hint, menus) {
  const h = normalize(hint);
  if (!h) return null;
  const active = menus.filter(m => m.active && (m.stock === undefined || m.stock > 0));
  if (!active.length) return null;

  const scored = active
    .map(m => ({ menu: m, score: menuMatchScore(h, m) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].menu : null;
}

/**
 * Resolve branchHint ke branch yang valid.
 * Mencari di id, name, atau substring name.
 */
export function resolveBranch(hint, branches) {
  const h = normalize(hint);
  if (!h) return null;
  // Exact id
  let found = branches.find(b => normalize(b.id) === h);
  if (found) return found;
  // Exact name
  found = branches.find(b => normalize(b.name) === h);
  if (found) return found;
  // Partial: hint di dalam name
  found = branches.find(b => normalize(b.name).includes(h));
  if (found) return found;
  // Partial: name di dalam hint
  found = branches.find(b => h.includes(normalize(b.id)) || h.includes(normalize(b.name).split(' ').pop()));
  if (found) return found;
  return null;
}

/**
 * Coba parse branch dari teks bebas pelanggan secara langsung (tanpa AI).
 * Jauh lebih cepat dan reliable untuk input satu kata seperti "barat", "pusat", dll.
 */
export function parseBranchFromText(text, branches) {
  return resolveBranch(text.trim(), branches);
}

/**
 * Coba parse nama pelanggan dari teks bebas.
 * Pola: "nama saya X", "ini X", "nama X", "saya X", "panggil X"
 */
export function parseNameFromText(text) {
  const patterns = [
    /nama\s+saya\s+([a-z][a-z\s]{1,30})/i,
    /nama\s+ku\s+([a-z][a-z\s]{1,30})/i,
    /(?:^|\s)(?:nama|saya|aku|gue|gw|ini)\s+([a-z][a-z]{1,20})(?:\s|$|,)/i,
    /(?:panggil(?:an)?|call me)\s+([a-z][a-z\s]{1,20})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const name = m[1].trim();
      if (name.length >= 2 && !INVALID_NAMES.has(name.toLowerCase())) return name;
    }
  }
  return null;
}

// ── CartManager ───────────────────────────────────────────────────────────────

export class CartManager {
  constructor(db) {
    this.db = db;
  }

  /** Ambil cart aktif untuk conversation (step != DONE), atau kembalikan null */
  get(conversationId) {
    const row = this.db.prepare(
      "SELECT * FROM whatsapp_cart WHERE conversation_id = ? AND step != 'DONE'"
    ).get(conversationId);
    if (!row) return null;
    return { ...row, items: JSON.parse(row.items_json || '[]') };
  }

  /** Buat cart baru atau reset cart lama */
  create(conversationId) {
    this.db.prepare(
      "INSERT INTO whatsapp_cart(conversation_id, items_json, step, created_at, updated_at) VALUES (?, '[]', 'COLLECTING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(conversation_id) DO UPDATE SET customer_name=NULL, branch_id=NULL, items_json='[]', notes=NULL, step='COLLECTING', updated_at=CURRENT_TIMESTAMP"
    ).run(conversationId);
    return this.get(conversationId);
  }

  /** Simpan perubahan cart ke DB */
  save(cart) {
    this.db.prepare(
      'UPDATE whatsapp_cart SET customer_name=?, branch_id=?, items_json=?, notes=?, step=?, updated_at=CURRENT_TIMESTAMP WHERE conversation_id=?'
    ).run(
      cart.customer_name || null,
      cart.branch_id || null,
      JSON.stringify(cart.items || []),
      cart.notes || null,
      cart.step,
      cart.conversation_id
    );
  }

  /** Tandai cart selesai (order berhasil / batal) */
  done(conversationId) {
    this.db.prepare(
      "UPDATE whatsapp_cart SET step='DONE', updated_at=CURRENT_TIMESTAMP WHERE conversation_id=?"
    ).run(conversationId);
  }

  /**
   * Terapkan daftar actions dari AI ke cart.
   *
   * Perubahan penting vs versi lama:
   * - SET_NAME: validasi nama, tolak placeholder/generic
   * - ADD_ITEM: jika item sudah ada di cart, SET qty bukan ADD
   *   (mencegah quantity berlipat pada retry)
   * - UPDATE_ITEM: tetap seperti semula
   */
  applyActions(cart, actions, menus, branches) {
    const warnings = [];
    for (const action of actions) {
      switch (action.type) {
        case 'SET_NAME': {
          const name = String(action.value || '').trim();
          const nameLower = name.toLowerCase();
          if (name.length >= 2 && !INVALID_NAMES.has(nameLower)) {
            cart.customer_name = name;
          }
          break;
        }

        case 'SET_BRANCH': {
          const branch = resolveBranch(action.value, branches);
          if (branch) cart.branch_id = branch.id;
          else warnings.push(`Cabang "${action.value}" tidak ditemukan.`);
          break;
        }

        case 'ADD_ITEM': {
          const menu = resolveMenu(action.menuHint, menus);
          if (!menu) { warnings.push(`Menu "${action.menuHint}" tidak tersedia.`); break; }
          const qty = Math.max(1, Math.min(99, Number(action.quantity) || 1));
          const existing = cart.items.find(i => i.menuId === menu.id);
          if (existing) {
            // Item sudah ada: SET qty (bukan tambah) untuk mencegah duplikasi pada retry
            existing.quantity = qty;
          } else {
            cart.items.push({ menuId: menu.id, quantity: qty });
          }
          break;
        }

        case 'UPDATE_ITEM': {
          const menu = resolveMenu(action.menuHint, menus);
          if (!menu) { warnings.push(`Menu "${action.menuHint}" tidak tersedia.`); break; }
          const qty = Number(action.quantity);
          if (isNaN(qty) || qty < 0 || qty > 99) { warnings.push('Jumlah menu harus antara 0–99.'); break; }
          if (qty === 0) {
            cart.items = cart.items.filter(i => i.menuId !== menu.id);
          } else {
            const existing = cart.items.find(i => i.menuId === menu.id);
            if (existing) existing.quantity = qty;
            else cart.items.push({ menuId: menu.id, quantity: qty });
          }
          break;
        }

        case 'REMOVE_ITEM': {
          const menu = resolveMenu(action.menuHint, menus);
          if (menu) cart.items = cart.items.filter(i => i.menuId !== menu.id);
          else warnings.push(`Menu "${action.menuHint}" tidak ada di keranjang.`);
          break;
        }

        case 'SET_NOTES':
          cart.notes = String(action.value || '').trim().slice(0, 500);
          break;

        case 'RESET_ITEMS':
          cart.items = [];
          break;
      }
    }
    return warnings;
  }

  /**
   * Cek field yang masih kurang.
   * Return array of string: ['name','branch','items']
   */
  missingFields(cart) {
    const missing = [];
    const name = (cart.customer_name || '').trim();
    if (name.length < 2 || INVALID_NAMES.has(name.toLowerCase())) missing.push('name');
    if (!cart.branch_id) missing.push('branch');
    if (!cart.items || cart.items.length === 0) missing.push('items');
    return missing;
  }

  /**
   * Buat teks ringkasan untuk konfirmasi.
   * Harga diambil dari master data (bukan dari AI).
   */
  buildSummary(cart, menus, branches) {
    const branch = branches.find(b => b.id === cart.branch_id);
    const lines = cart.items.map(item => {
      const menu = menus.find(m => m.id === item.menuId);
      if (!menu) return null;
      const subtotal = menu.price * item.quantity;
      return `• ${item.quantity}x ${menu.name} — Rp ${subtotal.toLocaleString('id-ID')}`;
    }).filter(Boolean);

    const total = cart.items.reduce((sum, item) => {
      const menu = menus.find(m => m.id === item.menuId);
      return sum + (menu ? menu.price * item.quantity : 0);
    }, 0);

    const nameStr = cart.customer_name ? `, Kak ${cart.customer_name}` : '';
    return {
      text: `📋 *Ringkasan pesanan Anda${nameStr}:*\n\n${lines.join('\n')}\n\nCabang: *${branch?.name || cart.branch_id}*\n*Total: Rp ${total.toLocaleString('id-ID')}*\n\nSudah sesuai? Balas *YA* untuk konfirmasi atau *BATAL* untuk membatalkan.`,
      totalAmount: total,
    };
  }

  isConfirmYes(message) { return CONFIRM_YES.test(message.trim()); }
  isConfirmNo(message)  { return CONFIRM_NO.test(message.trim()); }
}

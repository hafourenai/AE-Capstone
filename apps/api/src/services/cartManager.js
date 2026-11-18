import crypto from 'node:crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

const CONFIRM_YES = /^(ya|iya|yep|yap|oke|ok|benar|betul|bener|setuju|lanjut|fix|deal|sip|gas|confirmed?|yup|sudah benar|sudah betul|iya kak|ya kak|ok kak)[\s!.]*$/i;
const CONFIRM_NO  = /^(batal|cancel|gak jadi|nggak jadi|tidak|engga|hapus semua|stop|ga jadi|ngga jadi)[\s!.]*$/i;

function normalize(str) {
  return String(str || '').toLowerCase().trim();
}

/** Levenshtein distance (capped) untuk fuzzy match nama menu */
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 5) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[a.length][b.length];
}

/**
 * Resolve menuHint (string bebas dari AI) ke menu yang valid dari katalog.
 * Urutan: exact id → exact name → partial name → alias → fuzzy name.
 * Return null jika tidak ditemukan.
 */
export function resolveMenu(hint, menus) {
  const h = normalize(hint);
  if (!h) return null;
  const active = menus.filter(m => m.active && m.stock > 0);

  // 1. Exact ID
  let found = active.find(m => normalize(m.id) === h);
  if (found) return found;

  // 2. Exact name
  found = active.find(m => normalize(m.name) === h);
  if (found) return found;

  // 3. Partial name (hint contains menu name or vice versa)
  found = active.find(m => normalize(m.name).includes(h) || h.includes(normalize(m.name)));
  if (found) return found;

  // 4. Alias exact / partial
  found = active.find(m => {
    try {
      const aliases = Array.isArray(m.aliases) ? m.aliases : JSON.parse(m.aliases || '[]');
      return aliases.some(a => {
        const al = normalize(a);
        return al === h || al.includes(h) || h.includes(al);
      });
    } catch { return false; }
  });
  if (found) return found;

  // 5. Fuzzy (Levenshtein ≤ 2 on name tokens)
  const hTokens = h.split(/\s+/);
  found = active.find(m => {
    const nameTokens = normalize(m.name).split(/\s+/);
    return hTokens.some(ht => nameTokens.some(nt => levenshtein(ht, nt) <= 2 && nt.length >= 3));
  });
  return found || null;
}

/** Resolve branchHint ke branch yang valid */
export function resolveBranch(hint, branches) {
  const h = normalize(hint);
  if (!h) return null;
  return (
    branches.find(b => normalize(b.id) === h) ||
    branches.find(b => normalize(b.name) === h) ||
    branches.find(b => normalize(b.name).includes(h) || h.includes(normalize(b.name))) ||
    null
  );
}

// ── CartManager ───────────────────────────────────────────────────────────────

export class CartManager {
  constructor(db) {
    this.db = db;
  }

  /** Ambil cart aktif untuk conversation, atau kembalikan null */
  get(conversationId) {
    const row = this.db.prepare(
      "SELECT * FROM whatsapp_cart WHERE conversation_id = ? AND step != 'DONE'"
    ).get(conversationId);
    if (!row) return null;
    return {
      ...row,
      items: JSON.parse(row.items_json || '[]'),
    };
  }

  /** Buat cart baru atau reset cart lama */
  create(conversationId) {
    this.db.prepare(
      "INSERT INTO whatsapp_cart(conversation_id, items_json, step, created_at, updated_at) VALUES (?, '[]', 'COLLECTING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(conversation_id) DO UPDATE SET customer_name=NULL, branch_id=NULL, items_json='[]', notes=NULL, step='COLLECTING', updated_at=CURRENT_TIMESTAMP"
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
   * Setiap action: { type, ... }
   * Types: SET_NAME, SET_BRANCH, ADD_ITEM, REMOVE_ITEM, UPDATE_ITEM, SET_NOTES, RESET_ITEMS
   */
  applyActions(cart, actions, menus, branches) {
    const warnings = [];
    for (const action of actions) {
      switch (action.type) {
        case 'SET_NAME':
          if (action.value && String(action.value).trim().length >= 2)
            cart.customer_name = String(action.value).trim();
          break;

        case 'SET_BRANCH': {
          const branch = resolveBranch(action.value, branches);
          if (branch) cart.branch_id = branch.id;
          else warnings.push(`Cabang "${action.value}" tidak ditemukan.`);
          break;
        }

        case 'ADD_ITEM': {
          const menu = resolveMenu(action.menuHint, menus);
          if (!menu) { warnings.push(`Menu "${action.menuHint}" tidak tersedia.`); break; }
          const qty = Number(action.quantity) || 1;
          if (qty < 1 || qty > 99) { warnings.push('Jumlah menu harus antara 1–99.'); break; }
          const existing = cart.items.find(i => i.menuId === menu.id);
          if (existing) existing.quantity = Math.min(99, existing.quantity + qty);
          else cart.items.push({ menuId: menu.id, quantity: qty });
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
    if (!cart.customer_name || cart.customer_name.trim().length < 2) missing.push('name');
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

    return {
      text: `Halo, Kak ${cart.customer_name}! 😊 Ini ringkasan pesanan Anda:\n\n${lines.join('\n')}\n\nCabang: ${branch?.name || cart.branch_id}\n*Total: Rp ${total.toLocaleString('id-ID')}*\n\nSudah sesuai? Balas *YA* untuk konfirmasi atau *BATAL* untuk batalkan. Atau ceritakan jika ada yang ingin diubah. 🙏`,
      totalAmount: total,
    };
  }

  isConfirmYes(message) { return CONFIRM_YES.test(message.trim()); }
  isConfirmNo(message)  { return CONFIRM_NO.test(message.trim()); }
}

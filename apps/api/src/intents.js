import { normalize } from './normalize.js';

// Enum tetap. `keluhan` ditambahkan sesuai DECISIONS.md D2.
export const INTENTS = [
  'tanya_menu',
  'tanya_jam',
  'tanya_lokasi',
  'pesan',
  'ubah_pesanan',
  'konfirmasi',
  'batal',
  'bicara_admin',
  'keluhan',
  'lainnya',
];

export const INTENT_DESCRIPTIONS = {
  tanya_menu: 'pelanggan menanyakan daftar/harga menu',
  tanya_jam: 'pelanggan menanyakan jam buka atau tutup',
  tanya_lokasi: 'pelanggan menanyakan alamat atau lokasi',
  pesan: 'pelanggan memesan menu',
  ubah_pesanan: 'pelanggan menambah, mengurangi, atau mengganti pesanan yang sudah ada',
  konfirmasi: 'pelanggan menyetujui ringkasan pesanan',
  batal: 'pelanggan membatalkan pesanan',
  bicara_admin: 'pelanggan minta bicara dengan staf/admin manusia',
  keluhan: 'pelanggan menyampaikan keluhan',
  lainnya: 'tidak termasuk intent lain atau tidak jelas',
};

/**
 * Bangun JSON schema per permintaan. `menu` hanya boleh berisi 3–5 kandidat
 * dari fuzzy match + TIDAK_ADA, sehingga model tidak bisa mengarang menu.
 */
export function buildSchema(candidateNames = []) {
  const names = [...new Set((candidateNames || []).map((name) => String(name).trim()).filter(Boolean))].slice(0, 5);
  const menuEnum = names.length ? [...names, 'TIDAK_ADA'] : ['TIDAK_ADA'];
  return {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: INTENTS },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            menu: { type: 'string', enum: menuEnum },
            qty: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['menu', 'qty'],
          additionalProperties: false,
        },
      },
      waktu: { type: 'string' },
      keluhan: { type: 'string' },
    },
    required: ['intent', 'items', 'waktu'],
    additionalProperties: false,
  };
}

/** Normalisasi intent dari LLM: "tanya menu" -> "tanya_menu". */
export function normalizeIntent(value) {
  return normalize(String(value ?? '')).replace(/ /g, '_');
}

/**
 * Validasi output LLM setelah JSON.parse.
 * Mengembalikan { ok, data, needsClarification, invalidItems, reason }.
 * Tidak pernah melempar error untuk input berbentuk apa pun.
 */
export function validateLLMOutput(value, allowedMenus = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'OUTPUT_BUKAN_OBJEK', data: null, needsClarification: true, invalidItems: [] };
  }

  const intent = normalizeIntent(value.intent);
  if (!INTENTS.includes(intent)) {
    return { ok: false, reason: 'INTENT_TIDAK_DIKENAL', data: null, needsClarification: true, invalidItems: [] };
  }

  const allowed = allowedMenus ? new Set(allowedMenus.map((name) => String(name).trim())) : null;
  const items = Array.isArray(value.items) ? value.items : [];
  const validItems = [];
  const invalidItems = [];

  for (const item of items) {
    const menu = String(item?.menu ?? '').trim();
    const qty = Number(item?.qty);
    const menuAllowed = menu && menu !== 'TIDAK_ADA' && (!allowed || allowed.has(menu));
    if (!menuAllowed || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      invalidItems.push(item);
      continue;
    }
    validItems.push({ menu, qty });
  }

  const waktu = typeof value.waktu === 'string' ? value.waktu.trim() : '';
  const keluhan = typeof value.keluhan === 'string' ? value.keluhan.trim() : '';
  const needsClarification = invalidItems.length > 0
    || ((intent === 'pesan' || intent === 'ubah_pesanan') && validItems.length === 0);

  return {
    ok: true,
    data: { intent, items: validItems, waktu, keluhan },
    needsClarification,
    invalidItems,
  };
}

import { isBareNumber } from './normalize.js';

// ── Daftar perintah baku (Lapisan 1) ─────────────────────────────────────────
// Semua nilai sudah dalam bentuk `norm` (lihat normalize.js).

export const SETUJU = new Set([
  'ya', 'iya', 'y', 'ok', 'oke', 'siap', 'betul', 'benar', 'setuju',
  'lanjut', 'gas', 'boleh', 'yup', 'yep', 'fix', 'deal', 'sudah benar', 'sudah betul',
  'semua',
]);

export const BATAL = new Set([
  'batal', 'cancel', 'gajadi', 'tidak jadi', 'tidak usah', 'stop', 'hapus semua',
  'tidak jadi pesan', 'tidak jadi order', 'gajadi pesan', 'batal pesan',
]);

export const MENU = [
  'menu', 'daftar menu', 'list menu', 'lihat menu', 'menu apa', 'ada menu apa',
  'menu nya apa', 'menunya apa', 'pilihan menu', 'daftar harga', 'harga menu',
  'berapa harganya', 'harganya berapa',
];

export const JAM = [
  'jam buka', 'buka jam berapa', 'jam berapa buka', 'jam tutup', 'tutup jam berapa',
  'jam operasional', 'buka sampai jam berapa', 'tutupnya jam berapa', 'jam tutupnya',
  'kapan buka', 'buka kapan', 'kapan tutup', 'tutup kapan',
];

export const LOKASI = [
  'lokasi', 'alamat', 'dimana', 'di mana', 'lokasinya dimana', 'alamatnya dimana',
  'lokasi nya dimana', 'dimana lokasinya', 'dimana alamatnya', 'lokasi resto',
  'alamat resto', 'restonya dimana', 'resto nya dimana',
];

export const ADMIN = [
  'admin', 'telepon', 'telpon', 'bicara orang', 'cs', 'customer service',
  'hubungi admin', 'mau ke admin', 'orang asli', 'manusia', 'staff', 'staf',
  'ngobrol sama orang', 'bicara dengan orang',
];

function padded(text) {
  return ` ${text} `;
}

function hasPhrase(norm, phrase) {
  return padded(norm).includes(padded(phrase));
}

/**
 * Cocokkan perintah baku. `norm` adalah hasil normalize(), bukan raw.
 * Urutan penting: admin & batal didahulukan agar tidak tertelan aturan lain.
 */
export function matchRule(norm) {
  if (!norm) return null;
  if (ADMIN.some((phrase) => hasPhrase(norm, phrase))) return { type: 'admin' };
  if (BATAL.has(norm) || [...BATAL].some((phrase) => phrase.includes(' ') && hasPhrase(norm, phrase))) return { type: 'batal' };
  if (MENU.some((phrase) => hasPhrase(norm, phrase))) return { type: 'menu' };
  if (JAM.some((phrase) => hasPhrase(norm, phrase))) return { type: 'jam' };
  if (LOKASI.some((phrase) => hasPhrase(norm, phrase))) return { type: 'lokasi' };
  if (SETUJU.has(norm)) return { type: 'setuju' };
  const words = norm.split(' ').filter(Boolean);
  if (words.length && words.every((word) => SETUJU.has(word))) return { type: 'setuju' };
  return null;
}

/**
 * Aturan yang bergantung pada state percakapan (spec §6).
 * Contoh: saat menunggu jumlah, "2" langsung dipahami sebagai qty.
 */
export function matchStateRule(norm, botState) {
  const base = matchRule(norm);
  if (base) return base;

  if (botState === 'PILIH_MENU' && isBareNumber(norm)) {
    return { type: 'quantity', qty: Number(norm) };
  }

  if (botState === 'KONFIRMASI') {
    if (SETUJU.has(norm)) return { type: 'setuju' };
    if (BATAL.has(norm)) return { type: 'batal' };
  }

  return null;
}

export function isConfirmYes(norm) {
  return SETUJU.has(norm);
}

export function isConfirmNo(norm) {
  return BATAL.has(norm);
}

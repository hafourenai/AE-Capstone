import { isBareNumber } from './normalize.js';

// ── Daftar perintah baku (Lapisan 1) ─────────────────────────────────────────
// Semua nilai sudah dalam bentuk `norm` (lihat normalize.js).

export const SAPAAN = new Set([
  'halo', 'hai', 'hi', 'hei', 'woi', 'p', 'tes', 'test', 'hallo', 'hello', 'helo',
  'pagi', 'selamat pagi', 'siang', 'selamat siang', 'sore', 'selamat sore', 'malam', 'selamat malam',
  'assalamualaikum', 'assalamu alaikum', 'ass', 'asslm', 'halo kak', 'hai kak', 'halo min', 'hai min',
  'permisi', 'mau tanya', 'mau nanya', 'permisi mau tanya', 'misi mau tanya', 'permisi mau nanya', 'misi mau nanya',
  'misi', 'misi min', 'misi kak', 'misi min kak', 'permisi min', 'permisi kak', 'permisi kak min',
  'punten', 'punten min', 'punten kak',
  'min', 'kak', 'kak min', 'min kak',
  'halo admin', 'hai admin', 'hi admin',
  'selamat', 'sugeng', 'met pagi', 'met siang', 'met sore', 'met malam',
]);

export const MAU_PESAN = new Set([
  'mau pesan', 'mau pesen', 'saya mau pesan', 'saya mau pesen', 'pengen pesan', 'pengen pesen',
  'ingin pesan', 'mau order', 'order dong', 'pesan dong', 'pesen dong', 'bisa pesan', 'bisa pesen',
  'mau beli', 'beli dong', 'sy mau pesan', 'sy mau pesen', 'sy mau pesan dong', 'sy mau pesen dong',
  'saya mau pesan dong', 'saya mau pesen dong',
]);

export const SETUJU = new Set([
  'ya', 'iya', 'y', 'ok', 'oke', 'siap', 'betul', 'benar', 'setuju',
  'lanjut', 'gas', 'boleh', 'yup', 'yep', 'fix', 'deal', 'sudah benar', 'sudah betul',
  'semua',
]);

export const BATAL = new Set([
  'batal', 'cancel', 'gajadi', 'tidak jadi', 'tidak usah', 'stop', 'hapus semua',
  'tidak jadi pesan', 'tidak jadi order', 'gajadi pesan', 'batal pesan', 'batal semua',
]);

export const MENU = [
  'daftar menu', 'list menu', 'lihat menu', 'menu apa', 'ada menu apa',
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
  'daftar cabang', 'list cabang', 'cabang mana aja', 'cabang apa aja',
  'ada cabang mana', 'ada cabang apa', 'pilihan cabang', 'info cabang',
];

export const ADMIN = [
  'admin', 'telepon', 'telpon', 'bicara orang', 'cs', 'customer service',
  'hubungi admin', 'mau ke admin', 'orang asli', 'manusia', 'staff', 'staf',
  'ngobrol sama orang', 'bicara dengan orang', 'operator', 'panggil staf',
  'sambungkan ke admin', 'mau ngomong sama orang',
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
  if (norm === 'menu' || MENU.some((phrase) => hasPhrase(norm, phrase))) return { type: 'menu' };
  if (JAM.some((phrase) => hasPhrase(norm, phrase))) return { type: 'jam' };
  if (LOKASI.some((phrase) => hasPhrase(norm, phrase))) return { type: 'lokasi' };
  if (SETUJU.has(norm)) return { type: 'setuju' };
  if (SAPAAN.has(norm)) return { type: 'sapaan' };
  if (MAU_PESAN.has(norm)) return { type: 'mau_pesan' };
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

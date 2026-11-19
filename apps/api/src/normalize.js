// Normalisasi tunggal untuk semua pencocokan teks pelanggan.
// `norm` HANYA untuk matching; data yang disimpan/ditampilkan tetap `raw`.

export const SLANG = {
  gk: 'tidak',
  ga: 'tidak',
  gak: 'tidak',
  tdk: 'tidak',
  bsk: 'besok',
  sm: 'sama',
  yg: 'yang',
  bs: 'bisa',
  pesen: 'pesan',
  psen: 'pesan',
  aku: 'saya',
  gw: 'saya',
  gue: 'saya',
  sy: 'saya',
  nga: 'tidak',
  ngga: 'tidak',
  engga: 'tidak',
  enggak: 'tidak',
  nggak: 'tidak',
  yaa: 'ya',
  iyaa: 'iya',
};

/**
 * Normalisasi teks untuk pencocokan.
 * - NFKC, lowercase
 * - ringkas pengulangan HANYA huruf (iyaaa -> iya), bukan angka (10000 tetap)
 * - buang tanda baca/emoji
 * - rapikan spasi dan terapkan kamus slang per kata
 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => SLANG[word] ?? word)
    .join(' ');
}

/** Ambil angka dari teks yang sudah dinormalisasi. */
export function parseNumber(norm) {
  const match = String(norm ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

/** True bila teks hanya berisi satu angka (mis. "2"). */
export function isBareNumber(norm) {
  return /^\d+$/.test(String(norm ?? '').trim());
}

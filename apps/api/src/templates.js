// Template balasan. Semua teks pelanggan berasal dari sini atau DB, bukan dari LLM.

export function formatRupiah(value) {
  const number = Number(value);
  return `Rp${Number.isFinite(number) ? number.toLocaleString('id-ID') : '0'}`;
}

/** Ganti placeholder {nama} dst. Placeholder yang tidak diisi menjadi string kosong. */
export function renderTemplate(content, vars = {}) {
  return String(content ?? '').replace(/\{(\w+)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

const CATEGORY_EMOJI = {
  'Paket Ayam': '🍗',
  'Paket Seafood & Ikan': '🐟',
  'Paket Lainnya': '📦',
  'Lauk Ayam (Satuan)': '🍗',
  'Lauk Seafood & Ikan (Satuan)': '🐟',
  'Lauk & Sayur Satuan': '🥬',
  'Minuman': '🥤',
  'Kemasan & Tambahan': '📋',
  'Lainnya': '🍽️',
};

const CATEGORY_ORDER = [
  'Paket Ayam', 'Paket Seafood & Ikan', 'Paket Lainnya',
  'Lauk Ayam (Satuan)', 'Lauk Seafood & Ikan (Satuan)', 'Lauk & Sayur Satuan',
  'Minuman', 'Kemasan & Tambahan', 'Lainnya',
];

export function formatMenuList(menus) {
  const available = (menus || []).filter((menu) => menu.active && (menu.stock === undefined || menu.stock > 0));
  if (!available.length) return '';

  const groups = {};
  available.forEach((menu) => {
    const cat = menu.category || 'Lainnya';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(menu);
  });

  const sections = [];
  for (const cat of CATEGORY_ORDER) {
    if (!groups[cat]) continue;
    const emoji = CATEGORY_EMOJI[cat] || '🍽️';
    const items = groups[cat].sort((a, b) => a.name.localeCompare(b.name));
    sections.push(`*${emoji} ${cat.toUpperCase()}*\n${items.map((m) => `• ${m.name} — ${formatRupiah(m.price)}`).join('\n')}`);
    delete groups[cat];
  }
  // Any remaining uncategorized
  for (const [cat, items] of Object.entries(groups)) {
    const emoji = CATEGORY_EMOJI[cat] || '🍽️';
    sections.push(`*${emoji} ${cat.toUpperCase()}*\n${items.sort((a, b) => a.name.localeCompare(b.name)).map((m) => `• ${m.name} — ${formatRupiah(m.price)}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

export const DEFAULT_TEMPLATES = {
  menu_utama: 'Halo Kak! Selamat datang di Sambal Joelid 🌶️\n🕒 Jam Operasional: {jam_buka}\n\nSilakan pilih layanan kami:\n*1* — Memesan Makanan 🍽️\n*2* — Mengajukan Keluhan / Kendala 📝\n*3* — Berbicara dengan Admin / Staf 👤\n\nBalas dengan angka *1*, *2*, atau *3*, atau langsung sebutkan pesanan Kakak ya! 😊',
  pilihan_tidak_valid: 'Mohon maaf Kak, pilihan belum sesuai. 🙏\n\nSilakan balas:\n*1* — Untuk memesan makanan\n*2* — Untuk mengajukan keluhan\n*3* — Untuk berbicara dengan admin\n\nAtau langsung sebutkan menu yang ingin dipesan ya!',
  sapaan: 'Halo Kak! Selamat datang di Sambal Joelid 🌶️\n🕒 Jam Operasional: {jam_buka}\n\nSilakan pilih layanan kami:\n*1* — Memesan Makanan 🍽️\n*2* — Mengajukan Keluhan / Kendala 📝\n*3* — Berbicara dengan Admin / Staf 👤\n\nBalas dengan angka *1*, *2*, atau *3*, atau langsung sebutkan pesanan Kakak ya! 😊',
  menu: '🌶️ Daftar menu Sambal Joelid:\n\n{daftar}\n\nSebutkan nama menu dan jumlahnya ya, Kak! 😊',
  menu_kosong: 'Mohon maaf Kak, belum ada menu yang tersedia saat ini. Saya sambungkan ke staf kami ya.',
  tanya_jam: 'Kami buka {jam_buka}.',
  jam_belum_diatur: 'Mohon maaf Kak, jam buka belum tersedia. Saya sambungkan ke staf kami ya.',
  tanya_lokasi: 'Alamat kami: {alamat}.',
  alamat_belum_diatur: 'Mohon maaf Kak, alamat belum tersedia. Saya sambungkan ke staf kami ya.',
  konfirmasi: '📋 Ringkasan pesanan untuk *{nama}:*\n\n{ringkasan}\n\nCabang: {cabang}\n*Total: {total}*\n\nSudah sesuai? Balas *YA* untuk konfirmasi atau *BATAL* untuk membatalkan.',
  klarifikasi_menu: 'Mohon maaf Kak, maksudnya *{opsi1}* atau *{opsi2}*?',
  tidak_paham: 'Mohon maaf Kak, saya kurang paham. Boleh ditulis ulang pesanannya? 😊',
  tanya_menu: 'Mau pesan apa hari ini, Kak? Sebutkan nama menu dan jumlahnya ya! 😊',
  tanya_jumlah: 'Berapa jumlah {menu}?',
  tanya_cabang: 'Siap Kak! Mau dipesan dari cabang mana?\n\n{daftar}',
  tanya_nama: 'Boleh tahu nama Bapak/Ibu untuk pesanannya? 😊',
  tanya_keluhan: 'Silakan ceritakan keluhan atau kendala yang Kakak alami ya. Tim kami siap mencatat dan menindaklanjutinya. 🙏',
  tanya_nama_keluhan: 'Boleh tahu nama Kakak agar keluhan ini dapat kami tindaklanjuti? 😊',
  batal: 'Baik Kak, percakapan dibatalkan. Jika butuh bantuan lagi, ketik apa saja ya!',
  handoff: 'Baik Bapak/Ibu, saya sambungkan ke staf kami ya. Mohon ditunggu sebentar.',
  timeout: 'Mohon tunggu sebentar ya Kak, kami sedang menyambungkan ke staf kami.',
  media: 'Mohon maaf Kak, untuk pesan gambar/dokumen langsung saya sambungkan ke staf kami ya. Mohon ditunggu sebentar.',
  sukses: '✅ Yeay! Pesanan Anda berhasil dicatat! 🎉\n\nNomor Pesanan: {referensi}\nTotal: {total}\n\nTerima kasih sudah memesan di Sambal Joelid, Kak {nama}! ❤️',
  gagal_simpan: 'Mohon maaf Kak, pesanan belum bisa disimpan. Saya sambungkan ke staf kami ya.',
  stok_habis: 'Mohon maaf Kak, ada menu yang stoknya habis. Silakan pilih menu lain ya.',
  keluhan_konfirmasi: 'Kami catat keluhan Bapak/Ibu: "{keluhan}". Balas YA untuk mengirim atau BATAL untuk membatalkan.',
  keluhan_sukses: 'Keluhan Bapak/Ibu sudah kami terima. Nomor referensi: {referensi}. Terima kasih.',
  rate_limit: 'Mohon maaf Kak, pesan Anda sedang kami proses. Mohon ditunggu sebentar ya.',
};

// Perbarui hanya template bawaan versi sebelumnya; template yang diedit admin tetap dipertahankan.
const PREVIOUS_TEMPLATES = {
  menu_utama: [
    'Halo Kak! Selamat datang di Sambal Joelid 🌶️\n\nSilakan pilih layanan kami:\n*1* — Memesan Makanan 🍽️\n*2* — Mengajukan Keluhan / Kendala 📝\n*3* — Berbicara dengan Admin / Staf 👤\n\nBalas dengan angka *1*, *2*, atau *3* ya! 😊',
  ],
  sapaan: [
    'Halo Kak! Selamat datang di Sambal Joelid 🌶️\n\nSilakan pilih layanan kami:\n*1* — Memesan Makanan 🍽️\n*2* — Mengajukan Keluhan / Kendala 📝\n*3* — Berbicara dengan Admin / Staf 👤\n\nBalas dengan angka *1*, *2*, atau *3* ya! 😊',
  ],
  pilihan_tidak_valid: [
    'Mohon maaf Kak, pilihan belum sesuai. 🙏\n\nSilakan balas:\n*1* — Untuk memesan makanan\n*2* — Untuk mengajukan keluhan\n*3* — Untuk berbicara dengan admin\n\nAtau ketik *batal* untuk keluar.',
  ],
  menu: [
    '🌶️ Daftar menu Sambal Joelid:\n{daftar}\n\nSebutkan nama menu dan jumlahnya ya, Kak! 😊',
  ],
  konfirmasi: [
    '📋 Ringkasan pesanan untuk *{nama}:*\n\n{ringkasan}\n\n*Total: {total}*\n\nSudah sesuai? Balas *YA* untuk konfirmasi atau *BATAL* untuk membatalkan.',
    'Pesanan {nama}: {ringkasan}. Total {total}. Sudah benar? Balas YA, atau BATAL jika ingin mengubah.',
  ],
  sukses: ['Pesanan Bapak/Ibu sudah dicatat. Nomor pesanan: {referensi}. Total {total}. Terima kasih.'],
};

export class TemplateStore {
  constructor(db) {
    this.db = db;
    this.seed();
  }

  seed() {
    const update = this.db.prepare('UPDATE message_templates SET content = ? WHERE key = ? AND content = ?');
    const insert = this.db.prepare('INSERT OR IGNORE INTO message_templates(key, content) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const [key, content] of Object.entries(DEFAULT_TEMPLATES)) {
        for (const previous of PREVIOUS_TEMPLATES[key] || []) update.run(content, key, previous);
        insert.run(key, content);
      }
    })();
  }

  get(key) {
    const row = this.db.prepare('SELECT content FROM message_templates WHERE key = ?').get(key);
    return row?.content ?? DEFAULT_TEMPLATES[key] ?? '';
  }

  render(key, vars = {}) {
    return renderTemplate(this.get(key), vars);
  }

  all() {
    return Object.fromEntries(this.db.prepare('SELECT key, content FROM message_templates ORDER BY key').all().map((row) => [row.key, row.content]));
  }
}

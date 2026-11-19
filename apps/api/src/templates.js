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

export function formatMenuList(menus) {
  const available = (menus || []).filter((menu) => menu.active && (menu.stock === undefined || menu.stock > 0));
  if (!available.length) return '';
  return available.map((menu) => `• ${menu.name} — ${formatRupiah(menu.price)}`).join('\n');
}

export const DEFAULT_TEMPLATES = {
  sapaan: 'Halo Kak! Selamat datang di Sambal Joelid 🌶️\n\nMau pesan apa hari ini? Langsung sebutkan saja nama menu dan jumlahnya ya! 😊\n\nAtau ketik *menu* untuk melihat daftar menu yang tersedia.',
  menu: '🌶️ Daftar menu Sambal Joelid:\n{daftar}\n\nSebutkan nama menu dan jumlahnya ya, Kak! 😊',
  menu_kosong: 'Mohon maaf Kak, belum ada menu yang tersedia saat ini. Saya sambungkan ke staf kami ya.',
  tanya_jam: 'Kami buka {jam_buka}.',
  jam_belum_diatur: 'Mohon maaf Kak, jam buka belum tersedia. Saya sambungkan ke staf kami ya.',
  tanya_lokasi: 'Alamat kami: {alamat}.',
  alamat_belum_diatur: 'Mohon maaf Kak, alamat belum tersedia. Saya sambungkan ke staf kami ya.',
  konfirmasi: '📋 Ringkasan pesanan untuk *{nama}:*\n\n{ringkasan}\n\n*Total: {total}*\n\nSudah sesuai? Balas *YA* untuk konfirmasi atau *BATAL* untuk membatalkan.',
  klarifikasi_menu: 'Mohon maaf Kak, maksudnya *{opsi1}* atau *{opsi2}*?',
  tidak_paham: 'Mohon maaf Kak, saya kurang paham. Boleh ditulis ulang pesanannya? 😊',
  tanya_menu: 'Mau pesan apa hari ini, Kak? 😊',
  tanya_jumlah: 'Berapa jumlah {menu}?',
  tanya_cabang: 'Siap Kak! Mau dipesan dari cabang mana?\n\n{daftar}',
  tanya_nama: 'Boleh tahu nama Bapak/Ibu untuk pesanannya? 😊',
  batal: 'Baik Bapak/Ibu, pesanan dibatalkan. Kalau mau pesan lagi, tulis saja ya.',
  handoff: 'Baik Bapak/Ibu, saya sambungkan ke staf kami ya. Mohon ditunggu sebentar.',
  timeout: 'Mohon tunggu sebentar Bapak/Ibu, kami bantu langsung.',
  media: 'Mohon maaf Bapak/Ibu, untuk pesan gambar atau dokumen saya sambungkan ke staf kami ya. Mohon ditunggu sebentar.',
  sukses: 'Pesanan Bapak/Ibu sudah dicatat. Nomor pesanan: {referensi}. Total {total}. Terima kasih.',
  gagal_simpan: 'Mohon maaf Bapak/Ibu, pesanan belum bisa disimpan. Saya sambungkan ke staf kami ya.',
  stok_habis: 'Mohon maaf Bapak/Ibu, ada menu yang stoknya habis. Silakan pilih menu lain ya.',
  keluhan_konfirmasi: 'Kami catat keluhan Bapak/Ibu: "{keluhan}". Balas YA untuk mengirim atau BATAL untuk membatalkan.',
  keluhan_sukses: 'Keluhan Bapak/Ibu sudah kami terima. Nomor referensi: {referensi}. Terima kasih.',
  rate_limit: 'Mohon maaf Kak, pesan Anda sedang kami proses. Mohon ditunggu sebentar ya.',
};

export class TemplateStore {
  constructor(db) {
    this.db = db;
    this.seed();
  }

  seed() {
    const insert = this.db.prepare('INSERT OR REPLACE INTO message_templates(key, content) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const [key, content] of Object.entries(DEFAULT_TEMPLATES)) insert.run(key, content);
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

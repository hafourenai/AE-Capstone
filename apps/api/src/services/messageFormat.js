export const CUSTOMER_WEB_URL = 'https://joelid.hontalk.my.id/';

const normalize = value => String(value || '').trim().toLocaleLowerCase('id-ID');
const categoryLabels = {
  'kualitas makanan': 'KUALITAS_MAKANAN',
  pelayanan: 'PELAYANAN',
  kebersihan: 'KEBERSIHAN',
  pesanan: 'PESANAN',
  lainnya: 'LAINNYA',
};

export function formatGuide(kind, menus = [], branches = []) {
  const available = menus.filter(item => item.active && item.stock > 0);
  const m1 = available[0]?.name || 'Nama Menu 1';
  const m2 = available[1]?.name || 'Nama Menu 2';
  const branch = branches[0]?.name || '<nama cabang>';
  const example = kind === 'ORDER'
    ? `Pesan\nNama: Budi\nCabang: ${branch}\nMenu: ${m1} x 2, ${m2} x 1\nCatatan: Tidak terlalu pedas`
    : `Keluhan\nNama: Budi\nCabang: ${branch}\nKategori: Pelayanan\nDeskripsi: Pesanan saya belum sampai setelah satu jam.`;
  return `Agar ${kind === 'ORDER' ? 'pesanan' : 'keluhan'} otomatis dicatat, kirim *satu chat* sesuai format berikut:\n\n${example}\n\n${kind === 'ORDER' ? 'Beberapa menu bisa ditulis dalam satu baris dipisah koma. Ketik *menu* untuk melihat daftar menu. ' : 'Kategori: Kualitas makanan, Pelayanan, Kebersihan, Pesanan, atau Lainnya. '}Balas *YA* setelah ringkasan kami kirim.\n\nAtau pesan via formulir web: ${CUSTOMER_WEB_URL}`;
}

export function parseCustomerMessage(message, kind, menus = [], branches = []) {
  const lines = message.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const command = kind === 'ORDER' ? 'pesan' : 'keluhan';
  if (normalize(lines[0]) !== command) return { error: `Awali pesan dengan ${command.toUpperCase()} pada baris pertama.` };
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const match = /^([^:]+):\s*(.+)$/.exec(line);
    if (!match) return { error: 'Setiap isian harus ditulis pada baris baru dengan format Nama kolom: isi.' };
    const key = normalize(match[1]);
    const allowed = kind === 'ORDER' ? ['nama', 'cabang', 'menu', 'catatan'] : ['nama', 'cabang', 'kategori', 'deskripsi'];
    if (!allowed.includes(key) || (key !== 'menu' && fields.has(key))) return { error: `Kolom ${match[1]} tidak dikenal atau ditulis berulang.` };
    fields.set(key, key === 'menu' ? [...(fields.get(key) || []), match[2].trim()] : match[2].trim());
  }
  const name = fields.get('nama');
  if (!name || name.length < 2 || name.length > 100) return { error: 'Nama wajib diisi (2–100 karakter).' };
  const branch = branches.find(item => normalize(item.name) === normalize(fields.get('cabang')) || normalize(item.id) === normalize(fields.get('cabang')));
  if (!branch) return { error: 'Cabang tidak ditemukan. Gunakan nama cabang yang tersedia.' };

  if (kind === 'ORDER') {
    const rawMenuLines = fields.get('menu') || [];
    if (!rawMenuLines.length) return { error: 'Tuliskan minimal satu menu, contoh: Menu: Nasi x 2, Ayam x 1' };
    // Setiap entri bisa mengandung koma, misal "Nasi x 2, Ayam x 3" — pecah per koma lalu trim
    const menuEntries = rawMenuLines.flatMap(line => line.split(',').map(s => s.trim()).filter(Boolean));
    if (menuEntries.length > 20) return { error: 'Maksimal 20 item menu dalam satu pesanan.' };
    const items = [];
    for (const entry of menuEntries) {
      const match = /^(.+?)\s+x\s*(\d+)$/i.exec(entry);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 99) return { error: `Format menu tidak dikenali: "${entry}". Contoh yang benar: Nasi x 2` };
      const menu = menus.find(item => item.active && item.stock > 0 && (normalize(item.name) === normalize(match[1]) || normalize(item.id) === normalize(match[1])));
      if (!menu) return { error: `Menu "${match[1].trim()}" tidak tersedia. Ketik *menu* untuk melihat daftar terbaru.` };
      items.push({ menuId: menu.id, quantity: Number(match[2]) });
    }
    const notes = fields.get('catatan') || '';
    if (notes.length > 500) return { error: 'Catatan maksimal 500 karakter.' };
    return { data: { customerName: name, branchId: branch.id, items, notes } };
  }
  const category = categoryLabels[normalize(fields.get('kategori'))];
  if (!category) return { error: 'Kategori harus Kualitas makanan, Pelayanan, Kebersihan, Pesanan, atau Lainnya.' };
  const description = fields.get('deskripsi') || '';
  if (description.length < 10 || description.length > 2000) return { error: 'Deskripsi keluhan wajib diisi (10–2000 karakter).' };
  return { data: { customerName: name, branchId: branch.id, complaintCategory: category, complaintDescription: description } };
}

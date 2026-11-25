import { isBareNumber, normalize } from './normalize.js';
import { matchRule, matchStateRule } from './rules.js';
import { extractQuantity } from './menuMatcher.js';
import { resolveBranch } from './services/cartManager.js';
import { addDraftItem, clearDraft, emptyDraft, removeDraftItem, SESSION_RESET_MINUTES } from './state.js';
import { formatMenuList, formatRupiah } from './templates.js';

const NAME_BLOCKLIST = new Set([
  'nama', 'saya', 'aku', 'kak', 'kakak', 'bapak', 'ibu', 'pak', 'bu', 'mas', 'mba',
  'admin', 'ya', 'tidak', 'batal', 'pesan', 'order', 'menu',
  'timur', 'utara', 'selatan', 'tengah', 'pesanan', 'makanan',
]);

/**
 * Orkestrasi pemahaman pesan: rules -> fuzzy -> LLM -> tanya balik/handoff.
 * Handler tidak mengirim pesan; ia mengembalikan { reply, layer, intent }.
 */
export class BotHandler {
  constructor({ db, catalog, matcher, llm, bridge, templates, state, logger = console }) {
    this.db = db;
    this.catalog = catalog;
    this.matcher = matcher;
    this.llm = llm;
    this.bridge = bridge;
    this.templates = templates;
    this.state = state;
    this.logger = logger;
  }

  async handle({ conversationId, phone, raw, norm: providedNorm, previousLastMessageAt }) {
    const session = this.state.get(conversationId);
    if (!session) return null;
    if (session.handoff || session.botState === 'HANDOFF') return null;

    const norm = providedNorm ?? normalize(raw);
    if (!norm) return null;

    const menus = await this.catalog.getMenus();
    const branches = this.db.prepare('SELECT id, name, address, is_open FROM branches WHERE active = 1').all();
    const settings = this.settings();

    // ── Deteksi jeda sesi (>= SESSION_RESET_MINUTES sejak pesan terakhir) ──
    // Jika pelanggan chat kembali setelah lama tidak aktif, sambut ulang dengan
    // sapaan + jam operasional, apapun isi pesannya, dan reset state sesi.
    if (previousLastMessageAt) {
      const prevDate = new Date(
        String(previousLastMessageAt).includes('T')
          ? previousLastMessageAt
          : `${String(previousLastMessageAt).replace(' ', 'T')}Z`
      );
      const gapMs = Date.now() - prevDate.getTime();
      if (!Number.isNaN(prevDate.getTime()) && gapMs >= SESSION_RESET_MINUTES * 60_000) {
        // Reset sesi, sambut ulang
        session.botState = 'MENU_UTAMA';
        session.draft = emptyDraft();
        session.failCount = 0;
        session.handoff = false;
        this.state.save(conversationId, session);
        const jamBuka = settings.opening_hours || 'Setiap hari 09.00 - 21.00 WIB';
        return this.out(this.templates.render('menu_utama', { jam_buka: jamBuka }), 'rules', 'sapaan');
      }
    }

    const rule = matchRule(norm);

    if (rule?.type === 'admin') return this.handoff(session);

    // Bedakan pembatalan seluruh order dengan pembatalan satu menu.
    // "mie gorengnya batal" tidak boleh menghapus item lain.
    const partialCancellation = this.isPartialCancellation(norm);
    if (partialCancellation) {
      const result = await this.removeMentionedItems(session, norm, menus);
      if (result) return result;
    }
    if (rule?.type === 'batal') return this.cancel(session);
    if (rule?.type === 'jam') return this.jam(session, settings);
    if (rule?.type === 'lokasi') return this.lokasi(session, settings);

    // Menu utama deterministik:
    // Jika pelanggan berada di state IDLE dan mengirim angka 1, 2, atau 3
    if (session.botState === 'IDLE') {
      if (norm === '1') {
        session.botState = 'PILIH_MENU';
        session.failCount = 0;
        this.save(session);
        return this.out(this.templates.render('tanya_menu'), 'rules', 'pesan');
      }
      if (norm === '2') {
        session.draft.kind = 'complaint';
        session.botState = 'KELUHAN_DESKRIPSI';
        session.failCount = 0;
        this.save(session);
        return this.out(this.templates.render('tanya_keluhan'), 'rules', 'keluhan');
      }
      if (norm === '3') {
        return this.handoff(session);
      }
      if (rule?.type === 'sapaan') {
        session.botState = 'MENU_UTAMA';
        session.failCount = 0;
        this.save(session);
        const jamBuka = settings.opening_hours || 'Setiap hari 09.00 - 21.00 WIB';
        return this.out(this.templates.render('menu_utama', { jam_buka: jamBuka }), 'rules', 'menu_utama');
      }
    }

    if (session.botState === 'MENU_UTAMA') {
      if (norm === '1') {
        session.botState = 'PILIH_MENU';
        session.failCount = 0;
        this.save(session);
        return this.out(this.templates.render('tanya_menu'), 'rules', 'pesan');
      }
      if (norm === '2') {
        session.draft.kind = 'complaint';
        session.botState = 'KELUHAN_DESKRIPSI';
        session.failCount = 0;
        this.save(session);
        return this.out(this.templates.render('tanya_keluhan'), 'rules', 'keluhan');
      }
      if (norm === '3') {
        return this.handoff(session);
      }
      if (rule?.type === 'menu') return this.menu(session, menus);
      if (rule?.type === 'mau_pesan') return this.tanyaMenu(session);
      if (rule?.type === 'sapaan') return this.sapaan(session, settings);

      // Jika mengirim angka selain 1, 2, 3 di MENU_UTAMA
      if (isBareNumber(norm)) {
        return this.out(this.templates.render('pilihan_tidak_valid'), 'rules', 'menu_utama');
      }

      // Jika bukan angka (misal langsung menyebut nama menu atau pesan), pindah ke PILIH_MENU dan lanjutkan
      session.botState = 'PILIH_MENU';
    }

    // State keluhan langkah 1: menerima deskripsi keluhan
    if (session.botState === 'KELUHAN_DESKRIPSI') {
      session.draft.kind = 'complaint';
      session.draft.description = raw;
      session.botState = 'KELUHAN_NAMA';
      session.failCount = 0;
      this.save(session);
      return this.out(this.templates.render('tanya_nama_keluhan'), 'rules', 'keluhan');
    }

    // State keluhan langkah 2: menerima nama pelapor
    if (session.botState === 'KELUHAN_NAMA') {
      session.draft.customerName = raw;
      session.botState = 'KONFIRMASI';
      session.failCount = 0;
      this.save(session);
      return this.out(this.templates.render('keluhan_konfirmasi', {
        nama: session.draft.customerName,
        keluhan: session.draft.description,
      }), 'rules', 'keluhan');
    }

    if (rule?.type === 'menu') return this.menu(session, menus);
    if (rule?.type === 'sapaan') return this.sapaan(session, settings);
    if (rule?.type === 'mau_pesan') return this.tanyaMenu(session);

    if (session.botState === 'KONFIRMASI' && rule?.type === 'setuju') {
      return this.confirm(session, phone, menus);
    }

    // Jawaban atas pertanyaan klarifikasi menu.
    if (session.draft.options?.length) {
      const choice = this.pickOption(norm, session.draft.options);
      if (choice) {
        const qty = extractQuantity(norm) || session.draft.pendingOptionQty;
        if (qty) {
          addDraftItem(session.draft, { menuId: choice.id, qty });
          session.draft.lastMenuId = choice.id;
          session.draft.options = [];
          session.draft.pendingOptionQty = null;
          return this.advance(session, menus, branches);
        }
        session.draft.pendingMenuId = choice.id;
        session.draft.lastMenuId = choice.id;
        session.draft.options = [];
        session.draft.pendingOptionQty = null;
        session.botState = 'PILIH_MENU';
        this.save(session);
        return this.out(this.templates.render('tanya_jumlah', { menu: choice.name }), 'fuzzy', 'pesan');
      }
    }

    // Menunggu jumlah dari menu yang sudah dipilih.
    if (session.botState === 'PILIH_MENU' && session.draft.pendingMenuId) {
      const stateRule = matchStateRule(norm, 'PILIH_MENU');
      if (stateRule?.type === 'quantity') {
        const menu = menus.find((item) => item.id === session.draft.pendingMenuId);
        session.draft.pendingMenuId = null;
        if (menu) {
          addDraftItem(session.draft, { menuId: menu.id, qty: stateRule.qty });
          session.draft.lastMenuId = menu.id;
        }
        return this.advance(session, menus, branches);
      }
    }

    // Perubahan singkat merujuk ke menu terakhir yang sedang dibahas.
    const contextualUpdate = this.applyContextualQuantityUpdate(session, norm, menus, branches);
    if (contextualUpdate) return contextualUpdate;

    // Proses menu sebelum menganggap pesan sebagai jawaban cabang/nama. Dengan
    // demikian "tambah mie goreng 2" tetap mengubah draft pada state apa pun.
    const match = await this.matcher.search(norm);
    if (match.status === 'ambiguous') {
      for (const item of match.matches) {
        if (item.qty) {
          this.putMatchedItem(session, item, norm);
        }
      }
      return this.askClarify(session, match.ambiguous[0]);
    }
    if (match.status === 'match') {
      const missingQty = match.matches.find((item) => !item.qty);
      for (const item of match.matches) {
        if (item.qty) this.putMatchedItem(session, item, norm);
      }
      if (missingQty) {
        session.draft.pendingMenuId = missingQty.menu.id;
        session.draft.lastMenuId = missingQty.menu.id;
        session.botState = 'PILIH_MENU';
        this.save(session);
        return this.out(this.templates.render('tanya_jumlah', { menu: missingQty.menu.name }), 'fuzzy', 'pesan');
      }
      return this.advance(session, menus, branches);
    }

    // Sedang mengumpulkan cabang/nama.
    if (session.botState === 'ALAMAT_ATAU_AMBIL') {
      const reply = this.collectBranchOrName(session, norm, raw, branches, menus);
      if (reply) return reply;
    }

    // Memori yang sudah disetujui admin: exact match aktif tanpa menunggu deployment.
    const learned = this.db.prepare('SELECT * FROM learned_examples WHERE phrase_norm = ? AND active = 1').get(norm);
    if (learned) {
      let learnedItems = [];
      try { learnedItems = JSON.parse(learned.items_json || '[]'); } catch { learnedItems = []; }
      return this.applyLearned(session, raw, learned.intent, learnedItems, menus, branches);
    }

    // Lapisan 3: LLM.
    return this.askLLM(session, raw, match.candidates, menus, branches, phone);
  }

  settings() {
    return Object.fromEntries(this.db.prepare('SELECT key, value FROM business_settings').all().map((row) => [row.key, row.value]));
  }

  applyLearned(session, raw, intent, items, menus, branches) {
    if (intent === 'tanya_menu') return this.menu(session, menus);
    if (intent === 'tanya_jam') return this.jam(session, this.settings());
    if (intent === 'tanya_lokasi') return this.lokasi(session, this.settings());
    if (intent === 'bicara_admin') return this.handoff(session);
    if (intent === 'batal') return this.cancel(session);
    if (intent === 'keluhan') {
      session.draft.kind = 'complaint';
      session.draft.description = raw;
      session.botState = 'KELUHAN_NAMA';
      this.save(session);
      return this.out(this.templates.render('tanya_nama_keluhan'), 'learned', 'keluhan');
    }
    if (intent === 'pesan') {
      for (const item of items) {
        if (menus.some(menu => menu.id === item.menuId)) {
          addDraftItem(session.draft, { menuId: item.menuId, qty: item.qty });
        }
      }
      if (session.draft.items.length) return this.advance(session, menus, branches);
    }
    return this.fail(session);
  }

  learnedExamples(norm, menus) {
    const words = new Set(norm.split(' ').filter(word => word.length > 2));
    return this.db.prepare('SELECT phrase_raw, intent, items_json FROM learned_examples WHERE active = 1 ORDER BY updated_at DESC LIMIT 100').all()
      .map(row => {
        let items = [];
        try { items = JSON.parse(row.items_json || '[]'); } catch { items = []; }
        const candidateNames = items.map(item => item.menu).filter(Boolean);
        const overlap = normalize(row.phrase_raw).split(' ').filter(word => words.has(word)).length;
        return {
          score: overlap,
          pesan: row.phrase_raw,
          kandidat: candidateNames,
          output: {
            intent: row.intent,
            items: items.map(item => ({ menu: item.menu, qty: item.qty })),
            waktu: '',
            keluhan: row.intent === 'keluhan' ? row.phrase_raw : '',
          },
        };
      })
      .filter(example => example.score > 0 || norm === normalize(example.pesan))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ score, ...example }) => example);
  }

  out(reply, layer, intent = null, extra = {}) {
    return { reply, layer, intent, ...extra };
  }

  save(session) {
    this.state.save(session.conversationId, {
      botState: session.botState,
      draft: session.draft,
      failCount: session.failCount,
      handoff: session.handoff,
    });
  }

  menu(session, menus) {
    const daftar = formatMenuList(menus);
    if (!daftar) return this.handoff(session, 'menu_kosong');
    session.botState = 'PILIH_MENU';
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('menu', { daftar }), 'rules', 'tanya_menu');
  }

  sapaan(session, settings = this.settings()) {
    session.failCount = 0;
    this.save(session);
    const jamBuka = settings?.opening_hours || 'Setiap hari 09.00 - 21.00 WIB';
    return this.out(this.templates.render('sapaan', { jam_buka: jamBuka }), 'rules', 'sapaan');
  }

  tanyaMenu(session) {
    session.botState = 'PILIH_MENU';
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('tanya_menu'), 'rules', 'pesan');
  }

  jam(session, settings) {
    if (!settings.opening_hours) return this.handoff(session, 'jam_belum_diatur');
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('tanya_jam', { jam_buka: settings.opening_hours }), 'rules', 'tanya_jam');
  }

  lokasi(session, settings) {
    if (!settings.address) return this.handoff(session, 'alamat_belum_diatur');
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('tanya_lokasi', { alamat: settings.address }), 'rules', 'tanya_lokasi');
  }

  cancel(session) {
    clearDraft(session.draft);
    session.botState = 'IDLE';
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('batal'), 'rules', 'batal');
  }

  handoff(session, templateKey = 'handoff') {
    this.state.setHandoff(session.conversationId, session.draft);
    session.handoff = true;
    session.botState = 'HANDOFF';
    return this.out(this.templates.render(templateKey), 'fallback', 'bicara_admin', { handoff: true });
  }

  askClarify(session, ambiguous) {
    const options = ambiguous.options.slice(0, 2);
    session.draft.options = options.map((menu) => ({ id: menu.id, name: menu.name }));
    session.draft.pendingMenuId = null;
    session.draft.pendingOptionQty = extractQuantity(ambiguous.segment);
    session.botState = 'PILIH_MENU';
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('klarifikasi_menu', {
      opsi1: options[0]?.name || '',
      opsi2: options[1]?.name || '',
    }), 'fuzzy', 'pesan');
  }

  pickOption(norm, options) {
    const exact = options.find((option) => {
      const name = normalize(option.name);
      return norm === name || norm.includes(name);
    });
    if (exact) return exact;

    // Jawaban seperti "ayam" dipilih dari token yang membedakan opsi
    // "Paket Es Jeruk Ayam" dan "Paket Es Jeruk Nila".
    const replyTokens = new Set(norm.split(' ').filter((token) => token.length > 1));
    const scored = options.map((option) => {
      const own = new Set(normalize(option.name).split(' '));
      const otherTokens = new Set(options.filter((item) => item.id !== option.id)
        .flatMap((item) => normalize(item.name).split(' ')));
      const uniqueHits = [...own].filter((token) => replyTokens.has(token) && !otherTokens.has(token)).length;
      return { option, uniqueHits };
    }).sort((a, b) => b.uniqueHits - a.uniqueHits);
    return scored[0]?.uniqueHits > 0 && scored[0].uniqueHits > (scored[1]?.uniqueHits || 0)
      ? scored[0].option
      : null;
  }

  isPartialCancellation(norm) {
    const hasCancel = /\b(batalin|batalkan|batal|cancel|tidak jadi|hapus)\b/.test(norm);
    if (!hasCancel) return false;
    return !/^(batal|cancel|tidak jadi|tidak usah|stop|hapus semua|batal semua)( pesan| order)?$/.test(norm);
  }

  async removeMentionedItems(session, norm, menus) {
    const query = norm
      .replace(/\b(batalin|batalkan|batal|cancel|tidak jadi|hapus)\b/g, ' ')
      .replace(/\b(yang|nya)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!query) return null;
    const match = await this.matcher.search(query);
    const ids = match.matches.map((item) => item.menu.id);
    if (!ids.length && match.status === 'ambiguous') return this.askClarify(session, match.ambiguous[0]);
    const existingIds = ids.filter((id) => session.draft.items.some((item) => item.menuId === id));
    if (!existingIds.length) return null;
    for (const id of existingIds) removeDraftItem(session.draft, id);
    session.draft.pendingMenuId = null;
    session.draft.options = [];
    session.draft.lastMenuId = session.draft.items.at(-1)?.menuId || null;
    session.botState = session.draft.items.length ? session.botState : 'PILIH_MENU';
    session.failCount = 0;
    this.save(session);
    const removed = existingIds.map((id) => menus.find((menu) => menu.id === id)?.name).filter(Boolean).join(', ');
    const remaining = session.draft.items.map((item) => {
      const menu = menus.find((candidate) => candidate.id === item.menuId);
      return menu ? `${item.qty}x ${menu.name}` : null;
    }).filter(Boolean);
    const suffix = remaining.length ? ` Sisa pesanan: ${remaining.join(', ')}.` : ' Pesananmu sekarang kosong.';
    return this.out(`Siap, Kak. ${removed} aku batalkan.${suffix}`, 'rules', 'ubah_pesanan');
  }

  putMatchedItem(session, item, norm) {
    const existing = session.draft.items.find((draftItem) => draftItem.menuId === item.menu.id);
    if (/\b(tambah|tambahkan)\b/.test(norm) && existing) {
      existing.qty = Math.min(50, existing.qty + item.qty);
    } else {
      addDraftItem(session.draft, { menuId: item.menu.id, qty: item.qty });
    }
    session.draft.lastMenuId = item.menu.id;
  }

  applyContextualQuantityUpdate(session, norm, menus, branches) {
    const menuId = session.draft.pendingMenuId || session.draft.lastMenuId;
    if (!menuId) return null;
    const existing = session.draft.items.find((item) => item.menuId === menuId);
    const qty = extractQuantity(norm);
    if (!qty) return null;
    if (/^(tambah|tambahkan)\s+\d+\s*(lagi|lg)?$/.test(norm) && existing) {
      existing.qty = Math.min(50, existing.qty + qty);
    } else if (/^jadi\s+\d+$/.test(norm) && existing) {
      existing.qty = qty;
    } else {
      return null;
    }
    session.draft.pendingMenuId = null;
    session.draft.lastMenuId = menuId;
    return this.advance(session, menus, branches);
  }

  collectBranchOrName(session, norm, raw, branches, menus) {
    const draft = session.draft;
    session.failCount = 0;

    if (!draft.branchId) {
      const branch = resolveBranch(norm, branches);
      if (branch) {
        if (branch.is_open === 0) {
          const openBranches = branches.filter(b => b.is_open === 1);
          if (openBranches.length > 0) {
            const daftarBuka = openBranches.map(b => `• ${b.name}`).join('\n');
            return this.out(`Mohon maaf Kak, ${branch.name} saat ini sedang tutup. 🙏\n\nCabang kami yang buka saat ini:\n${daftarBuka}\n\nKakak mau pesan dari cabang yang mana?`, 'rules', 'pesan');
          }
          return this.out(`Mohon maaf Kak, saat ini semua cabang kami sedang tutup. 🙏\nSilakan hubungi kami kembali saat jam operasional ya Kak.`, 'rules', 'pesan');
        }
        draft.branchId = branch.id;
        if (!draft.customerName) {
          session.botState = 'ALAMAT_ATAU_AMBIL';
          this.save(session);
          return this.out(this.templates.render('tanya_nama'), 'rules', 'pesan');
        }
        return this.summary(session, menus, branches);
      }
      session.botState = 'ALAMAT_ATAU_AMBIL';
      this.save(session);
      const daftar = branches.map((branchItem) => `• ${branchItem.name}${branchItem.address ? ` (${branchItem.address})` : ''}${branchItem.is_open === 0 ? ' (Tutup)' : ''}`).join('\n');
      return this.out(this.templates.render('tanya_cabang', { daftar }), 'rules', 'pesan');
    }

    if (!draft.customerName) {
      const name = this.parseName(raw, norm, branches);
      if (name) {
        draft.customerName = name;
        return this.summary(session, menus, branches);
      }
      session.botState = 'ALAMAT_ATAU_AMBIL';
      this.save(session);
      return this.out(this.templates.render('tanya_nama'), 'rules', 'pesan');
    }

    return this.summary(session, menus, branches);
  }

  parseName(raw, norm, branches) {
    const value = String(raw ?? '').trim();
    if (value.length < 2 || value.length > 40) return null;
    if (!/^[\p{L}.'\-\s]+$/u.test(value)) return null;
    if (NAME_BLOCKLIST.has(norm)) return null;
    if (branches.some((branch) => normalize(branch.name) === norm || normalize(branch.id) === norm)) return null;
    return value;
  }

  advance(session, menus, branches) {
    const draft = session.draft;
    session.failCount = 0;

    if (!draft.items.length) {
      session.botState = 'PILIH_MENU';
      this.save(session);
      return this.out(this.templates.render('tanya_menu'), 'rules', 'pesan');
    }
    if (!draft.branchId) {
      session.botState = 'ALAMAT_ATAU_AMBIL';
      this.save(session);
      const daftar = branches.map((branch) => `• ${branch.name}${branch.address ? ` (${branch.address})` : ''}${branch.is_open === 0 ? ' (Tutup)' : ''}`).join('\n');
      return this.out(this.templates.render('tanya_cabang', { daftar }), 'rules', 'pesan');
    }
    if (!draft.customerName) {
      session.botState = 'ALAMAT_ATAU_AMBIL';
      this.save(session);
      return this.out(this.templates.render('tanya_nama'), 'rules', 'pesan');
    }
    return this.summary(session, menus, branches);
  }

  summary(session, menus, branches) {
    const draft = session.draft;
    const lines = [];
    let total = 0;
    for (const item of draft.items) {
      const menu = menus.find((candidate) => candidate.id === item.menuId);
      if (!menu) continue;
      const subtotal = menu.price * item.qty;
      total += subtotal;
      lines.push(`• ${item.qty}x ${menu.name} — ${formatRupiah(subtotal)}`);
    }

    if (!lines.length) {
      clearDraft(draft);
      session.botState = 'PILIH_MENU';
      this.save(session);
      return this.out(this.templates.render('tanya_menu'), 'rules', 'pesan');
    }

    draft.kind = 'order';
    session.botState = 'KONFIRMASI';
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('konfirmasi', {
      nama: draft.customerName,
      ringkasan: lines.join('\n'),
      cabang: branches.find((branch) => branch.id === draft.branchId)?.name || draft.branchId,
      total: formatRupiah(total),
    }), 'rules', 'pesan');
  }

  async askLLM(session, raw, candidates, menus, branches, phone) {
    if (!this.llm) return this.fail(session);
    if (this.llm.healthy === false) return this.handoff(session, 'timeout');

    let result;
    try {
      const learnedExamples = this.learnedExamples(normalize(raw), menus);
      const candidateNames = (candidates || []).map((menu) => menu.name);
      for (const example of learnedExamples) {
        for (const name of example.kandidat || []) {
          if (menus.some(menu => menu.name === name) && !candidateNames.includes(name)) candidateNames.push(name);
        }
      }
      result = await this.llm.extract(raw, {
        candidates: candidateNames.slice(0, 5),
        context: {
          state: session.botState,
          learnedExamples,
          draft: {
            items: session.draft.items,
            branchId: session.draft.branchId,
            customerName: session.draft.customerName,
          },
        },
      });
      this.llm.healthy = true;
    } catch (error) {
      if (error.code === 'LLM_TIMEOUT') {
        this.state.setHandoff(session.conversationId, session.draft);
        return this.out(this.templates.render('timeout'), 'fallback', null, { handoff: true });
      }
      this.logger.error?.(`[bot] LLM gagal: ${error.message}`);
      return this.fail(session);
    }

    if (!result?.ok || result.needsClarification) return this.fail(session);

    const { intent, items, keluhan } = result.data;
    if (intent === 'tanya_menu') return this.menu(session, menus);
    if (intent === 'tanya_jam') return this.jam(session, this.settings());
    if (intent === 'tanya_lokasi') return this.lokasi(session, this.settings());
    if (intent === 'bicara_admin') return this.handoff(session);
    if (intent === 'batal') return this.cancel(session);

    if (intent === 'keluhan') {
      session.draft.kind = 'complaint';
      session.draft.description = keluhan || raw;
      session.botState = 'KONFIRMASI';
      this.save(session);
      return this.out(this.templates.render('keluhan_konfirmasi', { keluhan: session.draft.description }), 'llm', 'keluhan');
    }

    if (intent === 'konfirmasi') {
      if (session.botState === 'KONFIRMASI') return this.confirm(session, phone, menus);
      return this.advance(session, menus, branches);
    }

    if (intent === 'pesan' || intent === 'ubah_pesanan') {
      let added = 0;
      for (const item of items) {
        const menu = menus.find((candidate) => candidate.name === item.menu) || menus.find((candidate) => normalize(candidate.name) === normalize(item.menu));
        if (!menu) continue;
        addDraftItem(session.draft, { menuId: menu.id, qty: item.qty });
        added += 1;
      }
      if (!added) return this.fail(session);
      return this.advance(session, menus, branches);
    }

    return this.fail(session);
  }

  confirm(session, phone, menus) {
    const draft = session.draft;

    if (draft.kind === 'complaint') {
      try {
        const customerName = draft.customerName || 'Pelanggan';
        const complaint = this.bridge.createComplaint(session.conversationId, customerName, phone, draft.branchId || null, null, draft.description);
        this.state.reset(session.conversationId);
        return this.out(this.templates.render('keluhan_sukses', {
          referensi: complaint.reference,
          nama: customerName,
        }), 'rules', 'keluhan');
      } catch (error) {
        this.logger.error?.(`[bot] Gagal simpan keluhan: ${error.message}`);
        return this.handoff(session);
      }
    }

    try {
      const order = this.bridge.createOrderFromConfirmation(
        session.conversationId,
        draft.customerName,
        phone,
        draft.branchId,
        draft.items.map((item) => ({ menuId: item.menuId, quantity: item.qty })),
        draft.notes,
      );
      this.state.reset(session.conversationId);
      return this.out(this.templates.render('sukses', {
        referensi: order.reference,
        total: formatRupiah(order.totalAmount).replace(/^Rp/, 'Rp '),
        nama: draft.customerName,
      }), 'rules', 'pesan', { order });
    } catch (error) {
      if (error.message === 'BRANCH_CLOSED') {
        const branchName = error.branchName || 'Cabang yang dipilih';
        return this.out(`Mohon maaf Kak, ${branchName} saat ini sedang tutup. 🙏 Silakan pilih cabang yang buka ya Kak.`, 'rules', 'pesan');
      }
      this.logger.error?.(`[bot] Gagal simpan pesanan: ${error.message}`);
      if (/MENU_NOT_FOUND|INSUFFICIENT_STOCK|INVALID_QUANTITY/.test(error.message)) {
        session.botState = 'PILIH_MENU';
        draft.kind = 'order';
        this.save(session);
        return this.out(this.templates.render('stok_habis'), 'rules', 'pesan');
      }
      return this.handoff(session);
    }
  }

  fail(session) {
    // Jika pelanggan masih di state IDLE (belum ada transaksi / belum memilih layanan),
    // jangan pernah kirim pesan "kurang paham". Sambut mereka dengan sapaan + jam buka + menu utama!
    if (session.botState === 'IDLE') {
      session.botState = 'MENU_UTAMA';
      session.failCount = 0;
      this.save(session);
      const settings = this.settings();
      const jamBuka = settings.opening_hours || 'Setiap hari 09.00 - 21.00 WIB';
      return this.out(this.templates.render('menu_utama', { jam_buka: jamBuka }), 'rules', 'sapaan');
    }

    const failCount = this.state.incrementFail(session.conversationId, session);
    session.failCount = failCount;
    if (failCount >= 2) return this.handoff(session);
    this.save(session);
    return this.out(this.templates.render('tidak_paham'), 'fallback', null);
  }
}

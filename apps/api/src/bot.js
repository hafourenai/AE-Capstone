import { normalize } from './normalize.js';
import { matchRule, matchStateRule } from './rules.js';
import { extractQuantity } from './menuMatcher.js';
import { resolveBranch } from './services/cartManager.js';
import { addDraftItem, clearDraft, emptyDraft } from './state.js';
import { formatMenuList, formatRupiah } from './templates.js';

const NAME_BLOCKLIST = new Set([
  'nama', 'saya', 'aku', 'kak', 'kakak', 'bapak', 'ibu', 'pak', 'bu', 'mas', 'mba',
  'admin', 'ya', 'tidak', 'batal', 'pesan', 'order', 'menu', 'pusat', 'barat',
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

  async handle({ conversationId, phone, raw, norm: providedNorm }) {
    const session = this.state.get(conversationId);
    if (!session) return null;
    if (session.handoff || session.botState === 'HANDOFF') return null;

    const norm = providedNorm ?? normalize(raw);
    if (!norm) return null;

    const menus = await this.catalog.getMenus();
    const branches = this.db.prepare('SELECT id, name FROM branches WHERE active = 1').all();
    const settings = this.settings();

    const rule = matchRule(norm);

    if (rule?.type === 'admin') return this.handoff(session);
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
        return this.out(this.templates.render('menu_utama'), 'rules', 'menu_utama');
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

      // Pilihan angka lain atau input di MENU_UTAMA
      return this.out(this.templates.render('pilihan_tidak_valid'), 'rules', 'menu_utama');
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
    if (rule?.type === 'sapaan') return this.sapaan(session);
    if (rule?.type === 'mau_pesan') return this.tanyaMenu(session);

    if (session.botState === 'KONFIRMASI' && rule?.type === 'setuju') {
      return this.confirm(session, phone, menus);
    }

    // Jawaban atas pertanyaan klarifikasi menu.
    if (session.draft.options?.length) {
      const choice = this.pickOption(norm, session.draft.options);
      if (choice) {
        const qty = extractQuantity(norm);
        if (qty) {
          addDraftItem(session.draft, { menuId: choice.id, qty });
          session.draft.options = [];
          return this.advance(session, menus, branches);
        }
        session.draft.pendingMenuId = choice.id;
        session.draft.options = [];
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
        if (menu) addDraftItem(session.draft, { menuId: menu.id, qty: stateRule.qty });
        return this.advance(session, menus, branches);
      }
    }

    // Sedang mengumpulkan cabang/nama.
    if (session.botState === 'ALAMAT_ATAU_AMBIL') {
      const reply = this.collectBranchOrName(session, norm, raw, branches, menus);
      if (reply) return reply;
    }

    // Lapisan 2: fuzzy menu.
    const match = await this.matcher.search(norm);
    if (match.status === 'ambiguous') return this.askClarify(session, match.ambiguous[0]);
    if (match.status === 'match') {
      const missingQty = match.matches.find((item) => !item.qty);
      for (const item of match.matches) {
        if (item.qty) addDraftItem(session.draft, { menuId: item.menu.id, qty: item.qty });
      }
      if (missingQty) {
        session.draft.pendingMenuId = missingQty.menu.id;
        session.botState = 'PILIH_MENU';
        this.save(session);
        return this.out(this.templates.render('tanya_jumlah', { menu: missingQty.menu.name }), 'fuzzy', 'pesan');
      }
      return this.advance(session, menus, branches);
    }

    // Lapisan 3: LLM.
    return this.askLLM(session, raw, match.candidates, menus, branches, phone);
  }

  settings() {
    return Object.fromEntries(this.db.prepare('SELECT key, value FROM business_settings').all().map((row) => [row.key, row.value]));
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

  sapaan(session) {
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('sapaan'), 'rules', 'sapaan');
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
    session.botState = 'PILIH_MENU';
    session.failCount = 0;
    this.save(session);
    return this.out(this.templates.render('klarifikasi_menu', {
      opsi1: options[0]?.name || '',
      opsi2: options[1]?.name || '',
    }), 'fuzzy', 'pesan');
  }

  pickOption(norm, options) {
    return options.find((option) => {
      const name = normalize(option.name);
      return norm === name || norm.includes(name);
    }) || null;
  }

  collectBranchOrName(session, norm, raw, branches, menus) {
    const draft = session.draft;
    session.failCount = 0;

    if (!draft.branchId) {
      const branch = resolveBranch(norm, branches);
      if (branch) {
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
      const daftar = branches.map((branchItem) => `• ${branchItem.name}`).join('\n');
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
      const daftar = branches.map((branch) => `• ${branch.name}`).join('\n');
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
      result = await this.llm.extract(raw, {
        candidates: (candidates || []).map((menu) => menu.name).slice(0, 5),
        context: {
          state: session.botState,
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
    const failCount = this.state.incrementFail(session.conversationId, session);
    session.failCount = failCount;
    if (failCount >= 2) return this.handoff(session);
    if (session.botState === 'IDLE') session.botState = 'PILIH_MENU';
    this.save(session);
    return this.out(this.templates.render('tidak_paham'), 'fallback', null);
  }
}

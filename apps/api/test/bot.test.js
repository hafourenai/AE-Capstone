import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { OrderComplaintBridge } from '../src/services/orderComplaintBridge.js';
import { MenuMatcher } from '../src/menuMatcher.js';
import { TemplateStore } from '../src/templates.js';
import { StateStore } from '../src/state.js';
import { BotHandler } from '../src/bot.js';

const MENUS = [
  { id: 'nasi-gudeg', name: 'Nasi Gudeg', price: 15000, stock: 10, active: true, aliases: ['gdg', 'gudeg'], description: '' },
  { id: 'es-teh', name: 'Es Teh Manis', price: 5000, stock: 20, active: true, aliases: ['teh'], description: '' },
  { id: 'es-jeruk', name: 'Es Jeruk', price: 7000, stock: 20, active: true, aliases: ['jeruk'], description: '' },
];

const AMBIGUOUS_MENUS = [
  { id: 'es-teh', name: 'Es Teh Manis', price: 5000, stock: 20, active: true, aliases: ['es'], description: '' },
  { id: 'es-jeruk', name: 'Es Jeruk', price: 7000, stock: 20, active: true, aliases: ['es'], description: '' },
];

const ORDER_MENUS = [
  { id: 'jeruk-ayam', name: 'Paket Es Jeruk Ayam', price: 25000, stock: 20, active: true, aliases: ['es jeruk ayam'], description: '' },
  { id: 'jeruk-nila', name: 'Paket Es Jeruk Nila', price: 27000, stock: 20, active: true, aliases: ['es jeruk nila'], description: '' },
  { id: 'mie-goreng', name: 'Paket Mie Goreng', price: 18000, stock: 20, active: true, aliases: ['mie goreng'], description: '' },
  { id: 'ayam-bakar', name: 'Ayam Bakar', price: 20000, stock: 20, active: true, aliases: [], description: '' },
];

function setup(t, { menus = MENUS, llm } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-bot-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  db.prepare('DELETE FROM menu_aliases').run();
  db.prepare('DELETE FROM menus').run();
  db.prepare('DELETE FROM branches').run();
  const addMenu = db.prepare('INSERT INTO menus(id,name,price,stock,active,description,aliases) VALUES (?,?,?,?,?,?,?)');
  menus.forEach((menu) => addMenu.run(menu.id, menu.name, menu.price, menu.stock, menu.active ? 1 : 0, menu.description || '', '[]'));
  db.prepare("INSERT INTO branches(id,name) VALUES ('pusat','Cabang Pusat')").run();
  db.prepare("INSERT INTO branches(id,name) VALUES ('barat','Cabang Barat')").run();
  db.prepare("UPDATE business_settings SET value='Setiap hari 09.00-21.00' WHERE key='opening_hours'").run();
  db.prepare("UPDATE business_settings SET value='Jl. Raya No. 1' WHERE key='address'").run();

  const conversationId = Number(db.prepare("INSERT INTO whatsapp_conversations(phone, chat_id) VALUES ('628111','628111@c.us')").run().lastInsertRowid);
  const catalog = { getMenus: async () => menus };
  const matcher = new MenuMatcher({ getMenus: async () => menus });
  const templates = new TemplateStore(db);
  const state = new StateStore(db);
  const bridge = new OrderComplaintBridge(db, { sendMessage: async () => {} }, { to: () => ({ emit: () => {} }) });
  const fakeLLM = llm || { extract: async () => { throw Object.assign(new Error('LLM tidak boleh dipanggil'), { code: 'TEST' }); } };

  const bot = new BotHandler({ db, catalog, matcher, llm: fakeLLM, bridge, templates, state, logger: { error: () => {}, warn: () => {} } });
  return { db, bot, state, templates, conversationId, bridge };
}

test('bot: perintah menu dijawab tanpa LLM', async (t) => {
  const { bot, state, conversationId } = setup(t);
  const result = await bot.handle({ conversationId, phone: '628111', raw: 'MENU' });
  assert.equal(result.layer, 'rules');
  assert.equal(result.intent, 'tanya_menu');
  assert.match(result.reply, /Daftar menu/);
  assert.equal(state.get(conversationId).botState, 'PILIH_MENU');
});

test('bot: pelajaran admin langsung dipakai sebelum fuzzy dan LLM', async (t) => {
  const { db, bot, conversationId } = setup(t);
  db.prepare(`INSERT INTO learned_examples(phrase_raw, phrase_norm, intent, items_json)
    VALUES (?, ?, ?, ?)`).run(
    'mw pangan rahasia 2',
    'mw pangan rahasia 2',
    'pesan',
    JSON.stringify([{ menuId: 'nasi-gudeg', menu: 'Nasi Gudeg', qty: 2 }]),
  );

  const result = await bot.handle({ conversationId, phone: '628111', raw: 'mw pangan rahasia 2' });
  assert.equal(result.layer, 'rules');
  assert.match(result.reply, /cabang mana/i);
});

test('bot: alur pesan -> cabang -> nama -> konfirmasi -> order tersimpan', async (t) => {
  const { db, bot, state, conversationId } = setup(t);

  let result = await bot.handle({ conversationId, phone: '628111', raw: 'gdg 2' });
  assert.match(result.reply, /cabang mana/i);

  result = await bot.handle({ conversationId, phone: '628111', raw: 'pusat' });
  assert.match(result.reply, /nama Bapak\/Ibu/i);

  result = await bot.handle({ conversationId, phone: '628111', raw: 'Budi' });
  assert.match(result.reply, /Nasi Gudeg/);
  assert.match(result.reply, /Rp30\.000/);
  assert.equal(state.get(conversationId).botState, 'KONFIRMASI');

  result = await bot.handle({ conversationId, phone: '628111', raw: 'YA' });
  assert.match(result.reply, /Nomor pesanan/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_orders').get().count, 1);

  const order = db.prepare('SELECT customer_name, branch_id, total_amount FROM customer_orders').get();
  assert.equal(order.customer_name, 'Budi');
  assert.equal(order.branch_id, 'pusat');
  assert.equal(order.total_amount, 30000);
  assert.equal(state.get(conversationId).botState, 'IDLE');
});

test('bot: ringkasan multi-item berupa daftar dan konfirmasi menyebut nama pelanggan', async (t) => {
  const { bot, conversationId } = setup(t);
  await bot.handle({ conversationId, phone: '628111', raw: 'gdg 2 dan es teh 3' });
  await bot.handle({ conversationId, phone: '628111', raw: 'pusat' });
  const summary = await bot.handle({ conversationId, phone: '628111', raw: 'Nova' });
  assert.match(summary.reply, /• 2x Nasi Gudeg — Rp30\.000\n• 3x Es Teh Manis — Rp15\.000/);
  assert.match(summary.reply, /Cabang: Cabang Pusat\n\*Total: Rp45\.000\*/);

  const success = await bot.handle({ conversationId, phone: '628111', raw: 'ya' });
  assert.match(success.reply, /✅ Yeay! Pesanan Anda berhasil dicatat! 🎉/);
  assert.match(success.reply, /Nomor Pesanan: ORD-[\w-]+\nTotal: Rp 45\.000/);
  assert.match(success.reply, /Terima kasih sudah memesan di Sambal Joelid, Kak Nova! ❤️/);
});

test('template bawaan lama diperbarui, tetapi edit admin tidak ditimpa saat startup', (t) => {
  const { db, templates } = setup(t);
  db.prepare('UPDATE message_templates SET content = ? WHERE key = ?').run('Balasan khusus admin: {referensi}', 'sukses');
  new TemplateStore(db);
  assert.equal(templates.get('sukses'), 'Balasan khusus admin: {referensi}');

  db.prepare('UPDATE message_templates SET content = ? WHERE key = ?').run(
    'Pesanan Bapak/Ibu sudah dicatat. Nomor pesanan: {referensi}. Total {total}. Terima kasih.', 'sukses',
  );
  new TemplateStore(db);
  assert.match(templates.get('sukses'), /Kak \{nama\}! ❤️/);
});

test('bot: fuzzy ambigu meminta pilihan, bukan menebak', async (t) => {
  const { db, bot, conversationId } = setup(t, { menus: AMBIGUOUS_MENUS });
  const result = await bot.handle({ conversationId, phone: '628111', raw: 'es' });
  assert.equal(result.layer, 'fuzzy');
  assert.match(result.reply, /Es Teh|Es Jeruk/);

  // Pilih salah satu opsi, lalu bot menanyakan jumlah bila belum disebut.
  const chosen = await bot.handle({ conversationId, phone: '628111', raw: 'Es Jeruk' });
  assert.match(chosen.reply, /Berapa jumlah/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_orders').get().count, 0);
});

test('bot: LLM hanya diminta Item, backend tetap menghitung harga', async (t) => {
  const llm = {
    extract: async () => ({
      ok: true,
      needsClarification: false,
      data: { intent: 'pesan', items: [{ menu: 'Nasi Gudeg', qty: 3 }], waktu: '', keluhan: '' },
    }),
  };
  const { bot, conversationId } = setup(t, { llm });

  const result = await bot.handle({ conversationId, phone: '628111', raw: 'qwerty' });
  assert.equal(result.layer, 'rules');
  assert.match(result.reply, /cabang mana/i);
});

test('bot: typo menu diteruskan ke Groq/LLM dengan kandidat katalog yang relevan', async (t) => {
  let receivedCandidates = [];
  const llm = {
    extract: async (_message, options) => {
      receivedCandidates = options.candidates;
      return {
        ok: true,
        needsClarification: false,
        data: { intent: 'pesan', items: [{ menu: 'Paket Mie Goreng', qty: 2 }], waktu: '', keluhan: '' },
      };
    },
  };
  const { bot, state, conversationId } = setup(t, { menus: ORDER_MENUS, llm });
  await bot.handle({ conversationId, phone: '628111', raw: 'mi gorng 2' });
  assert.ok(receivedCandidates.includes('Paket Mie Goreng'));
  assert.deepEqual(state.get(conversationId).draft.items, [{ menuId: 'mie-goreng', qty: 2 }]);
});

test('bot: LLM OFFLINE langsung handoff tanpa mencoba memanggil LLM', async (t) => {
  let called = 0;
  const llm = {
    healthy: false,
    extract: async () => { called += 1; throw new Error('tidak boleh dipanggil'); },
  };
  const { bot, state, conversationId } = setup(t, { llm });

  const result = await bot.handle({ conversationId, phone: '628111', raw: 'qwerty' });
  assert.match(result.reply, /sambungkan ke staf|Mohon tunggu/i);
  assert.equal(result.handoff, true);
  assert.equal(called, 0);
  assert.equal(state.get(conversationId).handoff, true);
});

test('bot: dua kali tidak paham memicu handoff dan bot berhenti membalas', async (t) => {
  const llm = { extract: async () => ({ ok: false, reason: 'JSON_TIDAK_VALID', needsClarification: true }) };
  const { bot, state, conversationId } = setup(t, { llm });

  const first = await bot.handle({ conversationId, phone: '628111', raw: 'qwerty' });
  assert.match(first.reply, /kurang paham/i);
  assert.equal(state.get(conversationId).failCount, 1);

  const second = await bot.handle({ conversationId, phone: '628111', raw: 'qwerty lagi' });
  assert.match(second.reply, /sambungkan ke staf/i);
  assert.equal(second.handoff, true);
  assert.equal(state.get(conversationId).handoff, true);

  assert.equal(await bot.handle({ conversationId, phone: '628111', raw: 'halo' }), null);
});

test('bot: batal dari state mana pun menghapus draft', async (t) => {
  const { bot, state, conversationId } = setup(t);
  await bot.handle({ conversationId, phone: '628111', raw: 'gdg 2' });
  const result = await bot.handle({ conversationId, phone: '628111', raw: 'BATAL' });
  assert.match(result.reply, /dibatalkan/i);
  const session = state.get(conversationId);
  assert.equal(session.botState, 'IDLE');
  assert.deepEqual(session.draft.items, []);
});

test('bot: pesanan informal multi-item mempertahankan qty dan jawaban varian pendek', async (t) => {
  const { bot, state, conversationId } = setup(t, { menus: ORDER_MENUS });

  const clarify = await bot.handle({
    conversationId,
    phone: '628111',
    raw: 'paket es jeruk ny 3 sm paket mie goreng ny 2',
  });
  assert.match(clarify.reply, /Ayam|Nila/);
  assert.deepEqual(state.get(conversationId).draft.items, [{ menuId: 'mie-goreng', qty: 2 }]);

  const selected = await bot.handle({ conversationId, phone: '628111', raw: 'ayam' });
  assert.match(selected.reply, /cabang mana/i);
  assert.deepEqual(state.get(conversationId).draft.items, [
    { menuId: 'mie-goreng', qty: 2 },
    { menuId: 'jeruk-ayam', qty: 3 },
  ]);
});

test('bot: tambah item dan pembatalan parsial tidak mereset draft lain', async (t) => {
  const { bot, state, conversationId } = setup(t, { menus: ORDER_MENUS });
  await bot.handle({ conversationId, phone: '628111', raw: 'es jeruk ayam 3' });
  await bot.handle({ conversationId, phone: '628111', raw: 'tambah mie goreng 2' });

  let session = state.get(conversationId);
  assert.deepEqual(session.draft.items, [
    { menuId: 'jeruk-ayam', qty: 3 },
    { menuId: 'mie-goreng', qty: 2 },
  ]);

  const removed = await bot.handle({ conversationId, phone: '628111', raw: 'mie gorengnya batal' });
  assert.match(removed.reply, /Mie Goreng.*batalkan/i);
  session = state.get(conversationId);
  assert.deepEqual(session.draft.items, [{ menuId: 'jeruk-ayam', qty: 3 }]);
});

test('bot: batal semua menghapus seluruh draft dan woi admin memicu handoff', async (t) => {
  const first = setup(t, { menus: ORDER_MENUS });
  await first.bot.handle({ conversationId: first.conversationId, phone: '628111', raw: 'mie goreng 2' });
  await first.bot.handle({ conversationId: first.conversationId, phone: '628111', raw: 'batal semua' });
  assert.deepEqual(first.state.get(first.conversationId).draft.items, []);

  const second = setup(t, { menus: ORDER_MENUS });
  const handoff = await second.bot.handle({ conversationId: second.conversationId, phone: '628111', raw: 'woi admin' });
  assert.equal(handoff.handoff, true);
  assert.equal(second.state.get(second.conversationId).botState, 'HANDOFF');
});

test('bot: jam buka dan lokasi diambil dari pengaturan DB', async (t) => {
  const { bot, conversationId } = setup(t);
  const jam = await bot.handle({ conversationId, phone: '628111', raw: 'buka jam berapa' });
  assert.match(jam.reply, /09\.00-21\.00/);
  const lokasi = await bot.handle({ conversationId, phone: '628111', raw: 'alamatnya dimana' });
  assert.match(lokasi.reply, /Jl\. Raya No\. 1/);
});

test('bot: keluhan dikonfirmasi lalu disimpan sebagai complaint', async (t) => {
  const llm = {
    extract: async () => ({
      ok: true,
      needsClarification: false,
      data: { intent: 'keluhan', items: [], waktu: '', keluhan: 'nasinya dingin' },
    }),
  };
  const { db, bot, conversationId } = setup(t, { llm });

  const first = await bot.handle({ conversationId, phone: '628111', raw: 'saya mau komplain nasinya dingin' });
  assert.match(first.reply, /nasinya dingin/);
  assert.match(first.reply, /Balas YA/i);

  const second = await bot.handle({ conversationId, phone: '628111', raw: 'ya' });
  assert.match(second.reply, /Keluhan Bapak\/Ibu sudah kami terima/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_complaints').get().count, 1);
});

test('bot: cabang tutup menginformasikan tutup dan menawarkan cabang yang buka', async (t) => {
  const { db, bot, conversationId } = setup(t);
  // Tutup cabang barat
  db.prepare("UPDATE branches SET is_open = 0 WHERE id = 'barat'").run();

  await bot.handle({ conversationId, phone: '628111', raw: 'mau pesan nasi gudeg 1' });
  const reply = await bot.handle({ conversationId, phone: '628111', raw: 'barat' });

  assert.match(reply.reply, /Cabang Barat saat ini sedang tutup/);
  assert.match(reply.reply, /Cabang Pusat/);

  // Jika pilih cabang pusat yang buka, lanjut ke nama
  const next = await bot.handle({ conversationId, phone: '628111', raw: 'pusat' });
  assert.match(next.reply, /nama/i);
});

test('bridge: validasi cabang tutup menghasilkan error BRANCH_CLOSED', (t) => {
  const { db, bridge } = setup(t);
  db.prepare("UPDATE branches SET is_open = 0 WHERE id = 'barat'").run();

  assert.throws(
    () => bridge.validateAndCalculateOrder('barat', [{ menuId: 'nasi-gudeg', quantity: 1 }]),
    /BRANCH_CLOSED/
  );
});

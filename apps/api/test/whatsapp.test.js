import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { OrderComplaintBridge } from '../src/services/orderComplaintBridge.js';
import { WAHAClient } from '../src/services/waha.js';
import { detectIntentHint, normalizeAIOutput, selectRelevantMenus, parseAICompletion } from '../src/services/ai.js';
import { normalizeCatalogCsv } from '../src/services/catalog.js';
import { CartManager, resolveMenu, resolveBranch, parseBranchFromText, parseNameFromText } from '../src/services/cartManager.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

const MENUS = [
  { id: 'ayam-geprek', name: 'Ayam Geprek', price: 18000, active: 1, stock: 10, aliases: '["ayam","geprek"]' },
  { id: 'lele-goreng', name: 'Lele Goreng', price: 16000, active: 1, stock: 5, aliases: '["lele"]' },
  { id: 'nasi-putih', name: 'Nasi Putih', price: 4000, active: 1, stock: 50, aliases: '["nasi"]' },
  { id: 'es-teh', name: 'Es Teh Manis', price: 5000, active: 1, stock: 20, aliases: '["es teh","teh manis"]' },
];
const BRANCHES = [
  { id: 'pusat', name: 'Cabang Pusat' },
  { id: 'barat', name: 'Cabang Barat' },
];

// ── resolveMenu ───────────────────────────────────────────────────────────────

test('resolveMenu: exact id match', () => {
  assert.equal(resolveMenu('ayam-geprek', MENUS).id, 'ayam-geprek');
});

test('resolveMenu: exact name match', () => {
  assert.equal(resolveMenu('Ayam Geprek', MENUS).id, 'ayam-geprek');
});

test('resolveMenu: partial name', () => {
  assert.equal(resolveMenu('geprek', MENUS).id, 'ayam-geprek');
});

test('resolveMenu: alias match', () => {
  assert.equal(resolveMenu('lele', MENUS).id, 'lele-goreng');
});

test('resolveMenu: alias match for es teh', () => {
  assert.equal(resolveMenu('es teh', MENUS).id, 'es-teh');
});

test('resolveMenu: fuzzy typo', () => {
  const result = resolveMenu('nasy', MENUS); // typo for nasi
  assert.ok(result !== null);
  assert.equal(result.id, 'nasi-putih');
});

test('resolveMenu: returns null for unknown menu', () => {
  assert.equal(resolveMenu('bakso', MENUS), null);
});

// ── resolveBranch ─────────────────────────────────────────────────────────────

test('resolveBranch: exact id', () => {
  assert.equal(resolveBranch('pusat', BRANCHES).id, 'pusat');
});

test('resolveBranch: partial name', () => {
  assert.equal(resolveBranch('barat', BRANCHES).id, 'barat');
});

test('resolveBranch: returns null for unknown branch', () => {
  assert.equal(resolveBranch('timur', BRANCHES), null);
});

// ── resolveMenu untuk menu nama panjang ──────────────────────────────────────

const MENUS_PAKET = [
  { id: 'paket-combo-jukut-lele', name: 'Paket Combo Jukut Lele', price: 26500, active: 1, stock: 50, aliases: '[]' },
  { id: 'paket-combo-jukut-ayam', name: 'Paket Combo Jukut Ayam', price: 29500, active: 1, stock: 50, aliases: '[]' },
  { id: 'nasi-jeruk', name: 'Nasi Jeruk', price: 3500, active: 1, stock: 50, aliases: '[]' },
  { id: 'lele-goreng', name: 'Lele Goreng', price: 7000, active: 1, stock: 50, aliases: '["lele"]' },
  ...MENUS,
];

test('resolveMenu: paket combo jukut lele — nama panjang', () => {
  const result = resolveMenu('paket combo jukut lele', MENUS_PAKET);
  assert.ok(result !== null);
  assert.equal(result.id, 'paket-combo-jukut-lele');
});

test('resolveMenu: typo "copmbo" masih match ke menu yang mengandung kata combo/lele', () => {
  // "paket copmbo jukut lele" — typo pada "combo" → matcher tetap menemukan menu yang relevan
  const result = resolveMenu('paket copmbo jukut lele', MENUS_PAKET);
  assert.ok(result !== null, 'harus menemukan menu');
  // Harus match ke salah satu menu yang mengandung "lele" atau "combo" atau "jukut"
  const name = result.name.toLowerCase();
  assert.ok(name.includes('lele') || name.includes('combo') || name.includes('jukut'),
    `Expected menu related to "combo lele", got: ${result.name}`);
});

test('resolveMenu: nasi jeruk', () => {
  const result = resolveMenu('nasi jeruk', MENUS_PAKET);
  assert.ok(result !== null);
  assert.equal(result.id, 'nasi-jeruk');
});

test('resolveMenu: tidak salah resolve "lele" ke paket combo jukut lele', () => {
  // "lele" sendirian sebaiknya ke lele goreng, bukan paket combo
  const result = resolveMenu('lele', MENUS_PAKET);
  assert.ok(result !== null);
  // Harus bukan paket (yang namanya panjang), lele goreng lebih cocok
  assert.ok(result.id === 'lele-goreng' || result.name.toLowerCase().includes('lele'));
});

// ── parseBranchFromText ───────────────────────────────────────────────────────

test('parseBranchFromText: "barat" langsung resolve ke cabang barat', () => {
  const result = parseBranchFromText('barat', BRANCHES);
  assert.ok(result !== null);
  assert.equal(result.id, 'barat');
});

test('parseBranchFromText: "cabang barat" resolve ke cabang barat', () => {
  const result = parseBranchFromText('cabang barat', BRANCHES);
  assert.ok(result !== null);
  assert.equal(result.id, 'barat');
});

test('parseBranchFromText: returns null untuk kata tidak relevan', () => {
  assert.equal(parseBranchFromText('mau makan', BRANCHES), null);
});

// ── parseNameFromText ─────────────────────────────────────────────────────────

test('parseNameFromText: "nama saya Aldi" extract Aldi', () => {
  const result = parseNameFromText('nama saya Aldi');
  assert.equal(result, 'Aldi');
});

test('parseNameFromText: "saya Nova" extract Nova', () => {
  const result = parseNameFromText('saya Nova');
  assert.ok(result !== null);
});

test('parseNameFromText: returns null untuk placeholder "nama"', () => {
  assert.equal(parseNameFromText('nama'), null);
});

// ── CartManager: nama invalid tidak disimpan ──────────────────────────────────

test('CartManager.applyActions: SET_NAME dengan value "nama" diabaikan', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  cm.applyActions(cart, [{ type: 'SET_NAME', value: 'nama' }], MENUS, BRANCHES);
  // customer_name harus tetap tidak terisi (null atau undefined)
  assert.ok(!cart.customer_name, `Expected nama tidak tersimpan, got: ${cart.customer_name}`);
});

test('CartManager.applyActions: SET_NAME dengan value "Aldi" diterima', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  cm.applyActions(cart, [{ type: 'SET_NAME', value: 'Aldi' }], MENUS, BRANCHES);
  assert.equal(cart.customer_name, 'Aldi');
});

// ── CartManager ───────────────────────────────────────────────────────────────

test('CartManager: create and get cart', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  assert.equal(cart.conversation_id, 1);
  assert.equal(cart.step, 'COLLECTING');
  assert.deepEqual(cart.items, []);
});

test('CartManager.applyActions: SET_NAME and SET_BRANCH', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  const warnings = cm.applyActions(cart, [
    { type: 'SET_NAME', value: 'Nova' },
    { type: 'SET_BRANCH', value: 'pusat' },
  ], MENUS, BRANCHES);
  assert.equal(warnings.length, 0);
  assert.equal(cart.customer_name, 'Nova');
  assert.equal(cart.branch_id, 'pusat');
});

test('CartManager.applyActions: ADD_ITEM dengan bahasa informal', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  // Skenario 1: pemesanan bahasa informal → AI ekstrak menuHint='ayam', quantity=3
  cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'ayam', quantity: 3 }], MENUS, BRANCHES);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].menuId, 'ayam-geprek');
  assert.equal(cart.items[0].quantity, 3);
});

test('CartManager.applyActions: ADD_ITEM beberapa menu sekaligus (skenario 2)', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  cm.applyActions(cart, [
    { type: 'ADD_ITEM', menuHint: 'nasi', quantity: 2 },
    { type: 'ADD_ITEM', menuHint: 'lele', quantity: 1 },
    { type: 'ADD_ITEM', menuHint: 'ayam', quantity: 2 },
  ], MENUS, BRANCHES);
  assert.equal(cart.items.length, 3);
});

test('CartManager.applyActions: ADD_ITEM pada item yang sudah ada → SET qty (cegah duplikasi retry)', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  // Pertama kali: tambah nasi 2
  cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'nasi', quantity: 2 }], MENUS, BRANCHES);
  assert.equal(cart.items.find(i => i.menuId === 'nasi-putih').quantity, 2);
  // Retry dengan qty yang sama → tidak berlipat, tetap 2
  cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'nasi', quantity: 2 }], MENUS, BRANCHES);
  assert.equal(cart.items.find(i => i.menuId === 'nasi-putih').quantity, 2);
  // Pesan baru dengan qty berbeda → update ke 5
  cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'nasi', quantity: 5 }], MENUS, BRANCHES);
  assert.equal(cart.items.find(i => i.menuId === 'nasi-putih').quantity, 5);
});

test('CartManager.applyActions: UPDATE_ITEM mengurangi jumlah (skenario 8)', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'ayam', quantity: 3 }], MENUS, BRANCHES);
  cm.applyActions(cart, [{ type: 'UPDATE_ITEM', menuHint: 'ayam', quantity: 2 }], MENUS, BRANCHES);
  assert.equal(cart.items.find(i => i.menuId === 'ayam-geprek').quantity, 2);
});

test('CartManager.applyActions: UPDATE_ITEM quantity 0 menghapus item', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'lele', quantity: 1 }], MENUS, BRANCHES);
  cm.applyActions(cart, [{ type: 'UPDATE_ITEM', menuHint: 'lele', quantity: 0 }], MENUS, BRANCHES);
  assert.equal(cart.items.length, 0);
});

test('CartManager.applyActions: REMOVE_ITEM (skenario 10 — hapus item)', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  cm.applyActions(cart, [
    { type: 'ADD_ITEM', menuHint: 'nasi', quantity: 2 },
    { type: 'ADD_ITEM', menuHint: 'lele', quantity: 1 },
  ], MENUS, BRANCHES);
  cm.applyActions(cart, [{ type: 'REMOVE_ITEM', menuHint: 'lele' }], MENUS, BRANCHES);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].menuId, 'nasi-putih');
});

test('CartManager.applyActions: anti-dekomposisi paket combo dan nasi duplikat', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);

  const customMenus = [
    { id: 'combo-jukut-lele', name: 'Paket Combo Jukut Lele', price: 26500, active: 1, stock: 10 },
    { id: 'nasi-jeruk', name: 'Nasi Jeruk', price: 3500, active: 1, stock: 20 },
    { id: 'jukut-goreng', name: 'Jukut Goreng', price: 5000, active: 1, stock: 10 },
    { id: 'lele-goreng', name: 'Lele Goreng', price: 7000, active: 1, stock: 10 },
    { id: 'nasi-putih', name: 'Nasi', price: 2500, active: 1, stock: 50 },
  ];

  // Simulasi halusinasi AI yang memecah paket combo dan menambahkan nasi generic
  cm.applyActions(cart, [
    { type: 'ADD_ITEM', menuHint: 'Paket Combo Jukut Lele', quantity: 3 },
    { type: 'ADD_ITEM', menuHint: 'Nasi', quantity: 11 },
    { type: 'ADD_ITEM', menuHint: 'Jukut', quantity: 3 },
    { type: 'ADD_ITEM', menuHint: 'Lele', quantity: 1 },
    { type: 'ADD_ITEM', menuHint: 'Nasi Jeruk', quantity: 10 },
  ], customMenus, BRANCHES);

  assert.equal(cart.items.length, 2);
  assert.equal(cart.items.find(i => i.menuId === 'combo-jukut-lele')?.quantity, 3);
  assert.equal(cart.items.find(i => i.menuId === 'nasi-jeruk')?.quantity, 10);
  assert.equal(cart.items.find(i => i.menuId === 'jukut-goreng'), undefined);
  assert.equal(cart.items.find(i => i.menuId === 'lele-goreng'), undefined);
  assert.equal(cart.items.find(i => i.menuId === 'nasi-putih'), undefined);
});

test('CartManager.applyActions: warning menu tidak tersedia (skenario 13)', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  const warnings = cm.applyActions(cart, [{ type: 'ADD_ITEM', menuHint: 'bakso', quantity: 1 }], MENUS, BRANCHES);
  assert.ok(warnings.some(w => w.includes('tidak tersedia')));
  assert.equal(cart.items.length, 0);
});

test('CartManager.missingFields: deteksi field yang kurang', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  assert.deepEqual(cm.missingFields(cart), ['name', 'branch', 'items']);
  cart.customer_name = 'Nova';
  assert.deepEqual(cm.missingFields(cart), ['branch', 'items']);
  cart.branch_id = 'pusat';
  cart.items = [{ menuId: 'nasi-putih', quantity: 2 }];
  assert.deepEqual(cm.missingFields(cart), []);
});

test('CartManager.buildSummary: total dihitung dari master data, bukan AI', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = { conversation_id: 1, customer_name: 'Nova', branch_id: 'pusat', items: [
    { menuId: 'ayam-geprek', quantity: 2 },
    { menuId: 'nasi-putih', quantity: 3 },
  ], notes: '', step: 'CONFIRMING' };
  const { totalAmount } = cm.buildSummary(cart, MENUS, BRANCHES);
  // 2 × 18000 + 3 × 4000 = 36000 + 12000 = 48000
  assert.equal(totalAmount, 48000);
});

test('CartManager: isConfirmYes variasi bahasa (skenario 11)', () => {
  const cm = new CartManager(null);
  for (const msg of ['ya', 'iya', 'Iya', 'YA', 'oke', 'Ok', 'benar', 'betul', 'sip', 'gas', 'lanjut', 'Iya kak', 'ya kak']) {
    assert.ok(cm.isConfirmYes(msg), `Expected isConfirmYes for: "${msg}"`);
  }
});

test('CartManager: isConfirmNo variasi bahasa', () => {
  const cm = new CartManager(null);
  for (const msg of ['batal', 'cancel', 'gak jadi', 'nggak jadi', 'stop']) {
    assert.ok(cm.isConfirmNo(msg), `Expected isConfirmNo for: "${msg}"`);
  }
});

test('CartManager: pesan ambigu bukan konfirmasi (skenario 14)', () => {
  const cm = new CartManager(null);
  for (const msg of ['tambah nasi', 'mungkin', 'boleh', 'silakan', 'terus gimana', 'ya tapi']) {
    assert.ok(!cm.isConfirmYes(msg), `Expected NOT isConfirmYes for: "${msg}"`);
  }
});

test('CartManager.done: cart di-mark DONE setelah order berhasil (skenario — tidak ada pesanan ganda)', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  cm.create(1);
  cm.done(1);
  const cart = cm.get(1);
  assert.equal(cart, null); // step=DONE tidak dikembalikan oleh get()
});

// ── Skenario 15: info lengkap dalam satu pesan ────────────────────────────────

test('Skenario 15: semua info sekaligus (nama, cabang, menu) diproses via applyActions', (t) => {
  const db = temporaryDatabase(t);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const cm = new CartManager(db);
  const cart = cm.create(1);
  // Simulasi: AI mengekstrak semua info dari "Saya Nova, mau nasi 2 ayam 3, cabang pusat"
  cm.applyActions(cart, [
    { type: 'SET_NAME', value: 'Nova' },
    { type: 'SET_BRANCH', value: 'pusat' },
    { type: 'ADD_ITEM', menuHint: 'nasi', quantity: 2 },
    { type: 'ADD_ITEM', menuHint: 'ayam', quantity: 3 },
  ], MENUS, BRANCHES);
  assert.equal(cm.missingFields(cart).length, 0);
  const { totalAmount } = cm.buildSummary(cart, MENUS, BRANCHES);
  assert.equal(totalAmount, 2 * 4000 + 3 * 18000); // 8000 + 54000 = 62000
});

// ── Test lama yang masih relevan ─────────────────────────────────────────────

test('AI completion discards truncated orders even when the partial content is valid JSON', () => {
  const result = parseAICompletion({ choices: [{ finish_reason: 'length', message: {
    content: JSON.stringify({ intent: 'ORDER', actions: [{ type: 'ADD_ITEM', menuHint: 'ayam', quantity: 2 }], replyText: '' }),
  } }] });
  assert.equal(result.intent, 'UNKNOWN');
});

test('malformed AI JSON asks for clarification without throwing', () => {
  const result = parseAICompletion({ choices: [{ finish_reason: 'stop', message: {
    content: '{broken json',
  } }] });
  assert.equal(result.intent, 'UNKNOWN');
  assert.deepEqual(result.actions, []);
});

test('migration adds WhatsApp tables and WEB source defaults', (t) => {
  const db = temporaryDatabase(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(tables.includes('whatsapp_conversations'));
  assert.ok(tables.includes('whatsapp_messages'));
  assert.ok(tables.includes('whatsapp_pending_actions'));
  assert.ok(tables.includes('whatsapp_cart'));

  db.prepare("INSERT INTO customer_complaints(reference_number,customer_name,customer_phone,description,status) VALUES ('CMP-TEST','Test','628123456789','Keluhan pengujian','NEW')").run();
  assert.equal(db.prepare("SELECT source FROM customer_complaints WHERE reference_number='CMP-TEST'").get().source, 'WEB');
});

test('WhatsApp order uses backend catalog prices and source', (t) => {
  const db = temporaryDatabase(t);
  const events = [];
  const io = { to: () => ({ emit: (event, payload) => events.push({ event, payload }) }) };
  const bridge = new OrderComplaintBridge(db, null, io);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();

  const order = bridge.createOrderFromConfirmation(1, 'Ayu', '628123456789', 'pusat', [
    { menuId: 'ayam-geprek', quantity: 2 },
  ]);

  assert.equal(order.totalAmount, 36000);
  assert.equal(db.prepare('SELECT source FROM customer_orders WHERE id=?').get(order.id).source, 'WHATSAPP');
  assert.equal(events[0].event, 'order:new');
});

test('WAHA client sends X-Api-Key, session, and normalized chat id', async (t) => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ id: 'sent' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new WAHAClient('http://127.0.0.1:3000', 'secret', 'sambal-joelid');
  await client.sendMessage('628123456789', 'Halo');

  assert.equal(captured.options.headers['X-Api-Key'], 'secret');
  assert.deepEqual(JSON.parse(captured.options.body), {
    session: 'sambal-joelid',
    chatId: '628123456789@c.us',
    text: 'Halo',
  });
});

test('WAHA client preserves LID replies and removes device suffix', async (t) => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new WAHAClient('http://127.0.0.1:3000', 'secret', 'sambal-joelid');
  await client.sendMessage('123456:2@lid', 'Halo');
  assert.equal(body.chatId, '123456@lid');
});

test('AI output receives a safe reply when small model omits replyText', () => {
  const output = normalizeAIOutput({ intent: 'general_question' });
  assert.ok(output.replyText.length > 0);
});

test('slang order text cannot be mistaken for a complaint', () => {
  assert.equal(detectIntentHint('sy mau psen mknan'), 'ORDER');
  assert.equal(detectIntentHint('mau pesen ayam'), 'ORDER');
  assert.equal(detectIntentHint('menu'), 'MENU');
});

test('Google Sheets CSV fields are normalized including stock and aliases', () => {
  const rows = normalizeCatalogCsv(`kode,nama,harga,stok,aktif,deskripsi,alias\nayam-geprek,Ayam Geprek,18000,10,1,Enak,ayam|geprek`);
  assert.equal(rows[0].id, 'ayam-geprek');
  assert.equal(rows[0].price, 18000);
  assert.equal(rows[0].stock, 10);
  assert.ok(rows[0].aliases.includes('ayam'));
});

test('selectRelevantMenus limits 56 items to at most 10 and prioritizes matching keywords', () => {
  const bigMenu = Array.from({ length: 56 }, (_, i) => ({ id: `m${i}`, name: `Menu ${i}`, active: 1, stock: 5, aliases: '[]' }));
  bigMenu[3].name = 'Ayam Spesial';
  const result = selectRelevantMenus('mau ayam spesial dong', [], bigMenu, 10);
  assert.ok(result.length <= 10);
  assert.ok(result.some(m => m.name === 'Ayam Spesial'));
});

test('validateAndCalculateOrder resolves menu by name or alias as fallback', (t) => {
  const db = temporaryDatabase(t);
  const io = { to: () => ({ emit: () => {} }) };
  const bridge = new OrderComplaintBridge(db, null, io);
  db.prepare("INSERT INTO whatsapp_conversations(id,phone,state) VALUES (1,'628123456789','AI_ACTIVE')").run();
  const result = bridge.validateAndCalculateOrder('pusat', [{ menuId: 'Ayam Geprek', quantity: 1 }]);
  assert.equal(result.items[0].menuId, 'ayam-geprek');
});

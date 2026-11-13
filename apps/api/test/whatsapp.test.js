import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { OrderComplaintBridge } from '../src/services/orderComplaintBridge.js';
import { WAHAClient } from '../src/services/waha.js';
import { detectIntentHint, normalizeAIOutput, selectRelevantMenus } from '../src/services/ai.js';
import { normalizeCatalogCsv } from '../src/services/catalog.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('migration adds WhatsApp tables and WEB source defaults', (t) => {
  const db = temporaryDatabase(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(tables.includes('whatsapp_conversations'));
  assert.ok(tables.includes('whatsapp_messages'));
  assert.ok(tables.includes('whatsapp_pending_actions'));
  const conversationColumns = db.prepare('PRAGMA table_info(whatsapp_conversations)').all().map(row => row.name);
  assert.ok(conversationColumns.includes('chat_id'));

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
  assert.equal(output.intent, 'GENERAL_QUESTION');
  assert.match(output.replyText, /bantu/i);
});

test('invalid extracted AI data is discarded instead of failing the conversation', () => {
  const output = normalizeAIOutput({
    intent: 'ORDER',
    replyText: 'Baik.',
    extractedData: { items: [{ menuId: 'ayam-geprek', quantity: 0 }] },
  });
  assert.deepEqual(output, { intent: 'ORDER', replyText: 'Silakan sebutkan menu, jumlah, dan cabang yang Anda pilih agar pesanan dapat kami rangkum.' });
});

test('slang order text cannot be mistaken for a complaint', () => {
  assert.equal(detectIntentHint('sy mau psen mknan'), 'ORDER');
  assert.equal(detectIntentHint('mau pesen ayam'), 'ORDER');
  assert.equal(detectIntentHint('menu'), 'MENU');
});

test('Google Sheets CSV fields are normalized including stock and aliases', () => {
  const [menu] = normalizeCatalogCsv('kode,nama,harga,stok,aktif,deskripsi,alias\nREG_AYAM,Paket Ayam,20300,5,TRUE,"Nasi, Ayam",paket ayam|ayam reguler');
  assert.deepEqual(menu, { id: 'REG_AYAM', name: 'Paket Ayam', price: 20300, stock: 5, active: true, description: 'Nasi, Ayam', aliases: ['paket ayam', 'ayam reguler'] });
});

test('selectRelevantMenus limits 56 items to at most 10 and prioritizes matching keywords', () => {
  const dummyMenus = Array.from({ length: 56 }, (_, i) => ({
    id: `menu-${i}`,
    name: `Menu Item ${i}`,
    price: 15000 + i * 1000,
    stock: 10,
    active: true,
    aliases: i === 42 ? ['sambal spesial'] : [],
  }));
  dummyMenus[50].name = 'Ayam Geprek Spesial';
  dummyMenus[50].id = 'ayam-geprek';

  const selected = selectRelevantMenus('Saya mau pesan ayam geprek 2 porsi', [], dummyMenus, 10);
  assert.equal(selected.length, 10);
  assert.equal(selected[0].id, 'ayam-geprek');

  const aliasSelected = selectRelevantMenus('ada sambal spesial?', [], dummyMenus, 10);
  assert.equal(aliasSelected.length, 10);
  assert.equal(aliasSelected[0].id, 'menu-42');
});

test('validateAndCalculateOrder resolves menu by name or alias as fallback', (t) => {
  const db = temporaryDatabase(t);
  const bridge = new OrderComplaintBridge(db, null, null);

  // 'ayam-geprek' is seeded in temporaryDatabase
  const result = bridge.validateAndCalculateOrder('pusat', [
    { menuId: 'Ayam Geprek', quantity: 2 },
  ]);
  assert.equal(result.items[0].menuId, 'ayam-geprek');
  assert.equal(result.totalAmount, 36000);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { OrderComplaintBridge } from '../src/services/orderComplaintBridge.js';
import { WAHAClient } from '../src/services/waha.js';

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

  db.prepare("INSERT INTO customer_complaints(reference_number,customer_name,customer_phone,description,status) VALUES ('CMP-TEST','Test','628123456789','Keluhan pengujian','NEW')").run();
  assert.equal(db.prepare("SELECT source FROM customer_complaints WHERE reference_number='CMP-TEST'").get().source, 'WEB');
});

test('WhatsApp order uses backend catalog prices and source', (t) => {
  const db = temporaryDatabase(t);
  const events = [];
  const io = { to: () => ({ emit: (event, payload) => events.push({ event, payload }) }) };
  const bridge = new OrderComplaintBridge(db, null, io);

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

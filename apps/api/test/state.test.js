import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import {
  StateStore,
  emptyDraft,
  addDraftItem,
  isStale,
  STALE_MINUTES,
} from '../src/state.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-state-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function createConversation(db) {
  const result = db.prepare("INSERT INTO whatsapp_conversations(phone, chat_id) VALUES ('628111','628111@c.us')").run();
  return Number(result.lastInsertRowid);
}

test('state: default IDLE dan draft kosong', (t) => {
  const db = temporaryDatabase(t);
  const conversationId = createConversation(db);
  const store = new StateStore(db);
  const session = store.get(conversationId);
  assert.equal(session.botState, 'IDLE');
  assert.deepEqual(session.draft.items, []);
  assert.equal(session.failCount, 0);
  assert.equal(session.handoff, false);
});

test('state: simpan state dan draft, lalu reset', (t) => {
  const db = temporaryDatabase(t);
  const conversationId = createConversation(db);
  const store = new StateStore(db);
  const draft = emptyDraft();
  addDraftItem(draft, { menuId: 'nasi-gudeg', qty: 2 });

  store.save(conversationId, { botState: 'KONFIRMASI', draft, failCount: 0, handoff: false });
  let session = store.get(conversationId);
  assert.equal(session.botState, 'KONFIRMASI');
  assert.deepEqual(session.draft.items, [{ menuId: 'nasi-gudeg', qty: 2 }]);

  store.reset(conversationId);
  session = store.get(conversationId);
  assert.equal(session.botState, 'IDLE');
  assert.deepEqual(session.draft.items, []);
});

test('state: handoff memakai state legacy WAITING_ADMIN dan tidak auto-resume', (t) => {
  const db = temporaryDatabase(t);
  const conversationId = createConversation(db);
  const store = new StateStore(db);
  store.setHandoff(conversationId);

  const session = store.get(conversationId);
  assert.equal(session.handoff, true);
  assert.equal(session.botState, 'HANDOFF');
  const row = db.prepare('SELECT state, paused_until FROM whatsapp_conversations WHERE id=?').get(conversationId);
  assert.equal(row.state, 'WAITING_ADMIN');
  assert.equal(row.paused_until, null);
});

test('state: fail_count bertambah dan reset saat berhasil', (t) => {
  const db = temporaryDatabase(t);
  const conversationId = createConversation(db);
  const store = new StateStore(db);
  const session = store.get(conversationId);
  assert.equal(store.incrementFail(conversationId, session), 1);
  assert.equal(store.incrementFail(conversationId, store.get(conversationId)), 2);

  store.reset(conversationId);
  assert.equal(store.get(conversationId).failCount, 0);
});

test('state: kedaluwarsa setelah 30 menit kembali ke IDLE', (t) => {
  const db = temporaryDatabase(t);
  const conversationId = createConversation(db);
  const store = new StateStore(db);
  const draft = emptyDraft();
  addDraftItem(draft, { menuId: 'a', qty: 1 });
  store.save(conversationId, { botState: 'PILIH_MENU', draft, failCount: 1, handoff: false });

  db.prepare("UPDATE whatsapp_conversations SET updated_at = datetime('now', '-31 minutes') WHERE id=?").run(conversationId);
  const session = store.get(conversationId);
  assert.equal(session.botState, 'IDLE');
  assert.equal(session.failCount, 0);
  assert.deepEqual(session.draft.items, []);
});

test('state: isStale menghormati batas menit', () => {
  assert.equal(isStale(new Date().toISOString(), Date.now(), STALE_MINUTES), false);
  assert.equal(isStale(new Date(Date.now() - 31 * 60_000).toISOString()), true);
  assert.equal(isStale(null), false);
});

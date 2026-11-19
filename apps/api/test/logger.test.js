import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import { MessageLogger } from '../src/logger.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-log-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

test('logger: mencatat log pesan dan hasil lapisan', (t) => {
  const db = temporaryDatabase(t);
  const logger = new MessageLogger(db);
  logger.log({
    conversationId: 1,
    phone: '628111',
    raw: 'gdg 2',
    norm: 'gdg 2',
    layer: 'fuzzy',
    intent: 'pesan',
    result: 'reply',
    processMs: 12,
  });

  const row = db.prepare('SELECT * FROM wa_message_logs').get();
  assert.equal(row.phone, '628111');
  assert.equal(row.layer, 'fuzzy');
  assert.equal(row.process_ms, 12);
});

test('logger: pesan gagal bisa didaftar, dijadikan alias, dan diselesaikan', (t) => {
  const db = temporaryDatabase(t);
  const logger = new MessageLogger(db);
  const id = logger.fail({ conversationId: 1, phone: '628111', raw: 'Gdg', norm: 'gdg', reason: 'tidak_paham', layer: 'fallback' });
  assert.ok(id > 0);

  const list = logger.listFailed();
  assert.equal(list.length, 1);
  assert.equal(list[0].raw, 'Gdg');

  assert.equal(logger.resolve(id), true);
  assert.equal(logger.listFailed().length, 0);
  assert.equal(logger.getFailed(id).resolved, 1);
});

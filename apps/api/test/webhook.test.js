import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database.js';
import {
  extractIncomingMessage,
  normalizeChatId,
  normalizePhoneNumber,
  MessageAggregator,
  IncomingPipeline,
  verifyWebhookSignature,
} from '../src/webhook.js';

function messageEvent(payload = {}, overrides = {}) {
  return {
    event: 'message',
    session: 'sambal-joelid',
    payload: {
      id: 'msg-1',
      from: '628111111111@s.whatsapp.net',
      body: 'halo',
      fromMe: false,
      hasMedia: false,
      ...payload,
    },
    ...overrides,
  };
}

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sambal-joelid-hook-'));
  const db = openDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Ekstraksi & filter ────────────────────────────────────────────────────────

test('extract: pesan teks valid diekstrak dan dijadikan lowercase', () => {
  const result = extractIncomingMessage(messageEvent({ body: 'HALO Cabang PUSAT' }), 'sambal-joelid');
  assert.equal(result.kind, 'text');
  assert.equal(result.phone, '628111111111');
  assert.equal(result.chatId, '628111111111@c.us');
  assert.equal(result.raw, 'halo cabang pusat');
});

test('extract: abaikan fromMe, grup, newsletter, event lain, session lain, body kosong', () => {
  assert.equal(extractIncomingMessage(messageEvent({ fromMe: true }), 'sambal-joelid'), null);
  assert.equal(extractIncomingMessage(messageEvent({ from: '123@g.us' }), 'sambal-joelid'), null);
  assert.equal(extractIncomingMessage(messageEvent({ from: '123@newsletter' }), 'sambal-joelid'), null);
  assert.equal(extractIncomingMessage(messageEvent({ from: '123@broadcast' }), 'sambal-joelid'), null);
  assert.equal(extractIncomingMessage(messageEvent({ body: '   ' }), 'sambal-joelid'), null);
  assert.equal(extractIncomingMessage(messageEvent({}, { event: 'presence' }), 'sambal-joelid'), null);
  assert.equal(extractIncomingMessage(messageEvent({}, { session: 'lain' }), 'sambal-joelid'), null);
});

test('extract: media dikembalikan sebagai kind media, bukan dibuang', () => {
  const result = extractIncomingMessage(messageEvent({ body: '', hasMedia: true }), 'sambal-joelid');
  assert.equal(result.kind, 'media');
});

test('extract: lokasi/stiker/dokumen tanpa hasMedia tetap dianggap media', () => {
  for (const type of ['location', 'sticker', 'document', 'audio', 'video']) {
    const result = extractIncomingMessage(messageEvent({ body: '', type }), 'sambal-joelid');
    assert.equal(result?.kind, 'media', `tipe ${type} harus handoff`);
  }
  assert.equal(extractIncomingMessage(messageEvent({ body: 'halo', type: 'chat' }), 'sambal-joelid').kind, 'text');
});

test('extract: memakai SenderAlt bila ada (LID)', () => {
  const result = extractIncomingMessage(messageEvent({
    from: '999999999999999@lid',
    _data: { Info: { SenderAlt: '628123456789@s.whatsapp.net' } },
  }), 'sambal-joelid');
  assert.equal(result.phone, '628123456789');
});

// ── Nomor & chat id ───────────────────────────────────────────────────────────

test('normalizePhoneNumber: 08..., 62..., device suffix', () => {
  assert.equal(normalizePhoneNumber('0812-3456-7890'), '6281234567890');
  assert.equal(normalizePhoneNumber('6281234567890'), '6281234567890');
  assert.equal(normalizePhoneNumber('6281234567890:12@s.whatsapp.net'), '6281234567890');
  assert.equal(normalizePhoneNumber(''), '');
});

test('normalizeChatId: domain s.whatsapp.net -> c.us dan buang device suffix', () => {
  assert.equal(normalizeChatId('62812:5@s.whatsapp.net'), '62812@c.us');
  assert.equal(normalizeChatId('62812@c.us'), '62812@c.us');
  assert.equal(normalizeChatId('62812'), '62812');
});

// ── Debounce ──────────────────────────────────────────────────────────────────

test('aggregator: pesan beruntun digabung menjadi satu batch', async () => {
  const batches = [];
  const aggregator = new MessageAggregator({ delayMs: 30, onFlush: (batch) => batches.push(batch) });
  aggregator.push({ phone: '6281', chatId: '6281@c.us', raw: 'mau', messageId: 'a', kind: 'text' });
  await sleep(10);
  aggregator.push({ phone: '6281', chatId: '6281@c.us', raw: 'pesan', messageId: 'b', kind: 'text' });
  await sleep(10);
  aggregator.push({ phone: '6281', chatId: '6281@c.us', raw: 'gdg 2', messageId: 'c', kind: 'text' });
  await sleep(60);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw, 'mau pesan gdg 2');
  assert.deepEqual(batches[0].messageIds, ['a', 'b', 'c']);
});

test('aggregator: nomor berbeda punya timer terpisah', async () => {
  const batches = [];
  const aggregator = new MessageAggregator({ delayMs: 20, onFlush: (batch) => batches.push(batch) });
  aggregator.push({ phone: '6281', chatId: '6281@c.us', raw: 'satu', messageId: 'a', kind: 'text' });
  aggregator.push({ phone: '6282', chatId: '6282@c.us', raw: 'dua', messageId: 'b', kind: 'text' });
  await sleep(50);
  assert.equal(batches.length, 2);
});

// ── Pipeline ──────────────────────────────────────────────────────────────────

test('pipeline: pesan duplikat diabaikan dan batch diteruskan sekali', async (t) => {
  const db = temporaryDatabase(t);
  const batches = [];
  const pipeline = new IncomingPipeline({
    db,
    delayMs: 10,
    processBatch: async (batch) => batches.push(batch),
    onUnsupported: async () => {},
  });

  assert.equal(pipeline.ingest(messageEvent(), 'sambal-joelid'), 'queued');
  assert.equal(pipeline.ingest(messageEvent(), 'sambal-joelid'), 'duplicate');
  await pipeline.idle();

  assert.equal(batches.length, 1);
  assert.equal(batches[0].raw, 'halo');
});

test('pipeline: media memicu onUnsupported, teks tidak', async (t) => {
  const db = temporaryDatabase(t);
  const unsupported = [];
  const pipeline = new IncomingPipeline({
    db,
    delayMs: 10,
    processBatch: async () => { throw new Error('teks tidak boleh diproses sebagai media'); },
    onUnsupported: async (message) => unsupported.push(message),
  });

  pipeline.ingest(messageEvent({ id: 'media-1', body: '', hasMedia: true }), 'sambal-joelid');
  await pipeline.idle();

  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].phone, '628111111111');
});

test('pipeline: antrian global concurrency 1', async (t) => {
  const db = temporaryDatabase(t);
  let active = 0;
  let maxActive = 0;
  const pipeline = new IncomingPipeline({
    db,
    delayMs: 5,
    processBatch: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active -= 1;
    },
    onUnsupported: async () => {},
  });

  ['a', 'b', 'c'].forEach((id, index) => {
    pipeline.ingest(messageEvent({ id, from: `62810000000${index}@s.whatsapp.net`, body: `pesan ${id}` }), 'sambal-joelid');
  });
  await pipeline.idle();

  assert.equal(maxActive, 1);
});

// ── Signature ─────────────────────────────────────────────────────────────────

test('verifyWebhookSignature: valid, invalid, dan panjang berbeda', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const secret = 'rahasia';
  const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, 'deadbeef', secret), false);
  assert.equal(verifyWebhookSignature(body, signature, 'salah'), false);
  assert.equal(verifyWebhookSignature(null, signature, secret), false);
});

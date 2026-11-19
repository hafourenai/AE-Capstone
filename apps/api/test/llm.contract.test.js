import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LLMClient, LLMError } from '../src/llm.js';
import { buildSchema, normalizeIntent, validateLLMOutput, INTENTS } from '../src/intents.js';

async function startMock(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function chatPayload(content, finishReason = 'stop') {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

const clientFor = (url, extra = {}) => new LLMClient({
  baseUrl: url,
  model: 'qwen-test',
  apiKey: 'kunci-uji',
  timeoutMs: 2000,
  fewshot: [],
  ...extra,
});

test('llm: memanggil chat completions dan mengembalikan JSON tervalidasi', async () => {
  let requestBody = null;
  let authHeader = null;
  const mock = await startMock(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      requestBody = JSON.parse(await readBody(req));
      authHeader = req.headers.authorization;
      return jsonResponse(res, 200, chatPayload(JSON.stringify({
        intent: 'pesan',
        items: [{ menu: 'Nasi Gudeg', qty: 2 }],
        waktu: '',
      })));
    }
    jsonResponse(res, 404, {});
  });

  try {
    const client = clientFor(mock.url);
    const result = await client.extract('pesen gdg 2', { candidates: ['Nasi Gudeg', 'Es Teh Manis'] });
    assert.equal(result.ok, true);
    assert.equal(result.data.intent, 'pesan');
    assert.deepEqual(result.data.items, [{ menu: 'Nasi Gudeg', qty: 2 }]);
    assert.equal(result.needsClarification, false);
    assert.equal(requestBody.temperature, 0);
    assert.equal(requestBody.max_tokens, 120);
    assert.equal(requestBody.cache_prompt, true);
    assert.equal(requestBody.response_format.schema.properties.intent.enum.length, INTENTS.length);
    assert.deepEqual(requestBody.response_format.schema.properties.items.items.properties.menu.enum, ['Nasi Gudeg', 'Es Teh Manis', 'TIDAK_ADA']);
    assert.equal(authHeader, 'Bearer kunci-uji');
    assert.equal(client.mode, 'json_object');
  } finally { await mock.close(); }
});

test('llm: fallback ke json_schema saat format pertama ditolak', async () => {
  const modes = [];
  const mock = await startMock(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      modes.push(body.response_format.type);
      if (body.response_format.type === 'json_object') return jsonResponse(res, 400, { error: 'unsupported' });
      return jsonResponse(res, 200, chatPayload(JSON.stringify({ intent: 'tanya_menu', items: [], waktu: '' })));
    }
    jsonResponse(res, 404, {});
  });

  try {
    const client = clientFor(mock.url);
    const result = await client.extract('menu apa');
    assert.equal(result.data.intent, 'tanya_menu');
    assert.deepEqual(modes, ['json_object', 'json_schema']);
    assert.equal(client.mode, 'json_schema');
  } finally { await mock.close(); }
});

test('llm: fallback terakhir ke /completion dengan json_schema', async () => {
  let completionBody = null;
  const mock = await startMock(async (req, res) => {
    if (req.url === '/v1/completion') {
      completionBody = JSON.parse(await readBody(req));
      return jsonResponse(res, 200, { content: '{"intent":"tanya_jam","items":[],"waktu":""}', stop: true });
    }
    jsonResponse(res, 404, {});
  });

  try {
    const client = clientFor(mock.url);
    const result = await client.extract('buka jam berapa');
    assert.equal(result.data.intent, 'tanya_jam');
    assert.ok(completionBody.json_schema);
    assert.equal(completionBody.json_schema.properties.intent.type, 'string');
    assert.equal(client.mode, 'completion');
  } finally { await mock.close(); }
});

test('llm: timeout menjadi LLM_TIMEOUT, bukan crash', async () => {
  const mock = await startMock(async (_req, res) => {
    setTimeout(() => jsonResponse(res, 200, chatPayload('{}')), 300);
  });
  try {
    const client = clientFor(mock.url, { timeoutMs: 50 });
    await assert.rejects(
      () => client.extract('halo'),
      (error) => error instanceof LLMError && error.code === 'LLM_TIMEOUT',
    );
  } finally { await mock.close(); }
});

test('llm: JSON tidak valid dikembalikan sebagai tidak paham', async () => {
  const mock = await startMock(async (_req, res) => {
    jsonResponse(res, 200, chatPayload('ini bukan json'));
  });
  try {
    const client = clientFor(mock.url);
    const result = await client.extract('halo');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'JSON_TIDAK_VALID');
    assert.equal(result.needsClarification, true);
  } finally { await mock.close(); }
});

test('llm: output terpotong ditandai OUTPUT_TERPOTONG', async () => {
  const mock = await startMock(async (_req, res) => {
    jsonResponse(res, 200, chatPayload('{"intent":"pesan"', 'length'));
  });
  try {
    const client = clientFor(mock.url);
    const result = await client.extract('pesen');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OUTPUT_TERPOTONG');
  } finally { await mock.close(); }
});

test('llm: health check', async () => {
  const mock = await startMock(async (req, res) => {
    if (req.url === '/health') return jsonResponse(res, 200, { status: 'ok' });
    jsonResponse(res, 404, {});
  });
  try {
    const client = clientFor(mock.url);
    assert.equal(await client.health(), true);
  } finally { await mock.close(); }

  const client = clientFor('http://127.0.0.1:1/v1', { timeoutMs: 200 });
  assert.equal(await client.health(), false);
});

// ── Schema & validasi ────────────────────────────────────────────────────────

test('intents: buildSchema membatasi enum menu ke kandidat', () => {
  const schema = buildSchema(['Nasi Gudeg', 'Es Teh Manis', 'Nasi Gudeg']);
  assert.deepEqual(schema.properties.items.items.properties.menu.enum, ['Nasi Gudeg', 'Es Teh Manis', 'TIDAK_ADA']);
  assert.deepEqual(schema.required, ['intent', 'items', 'waktu']);
  assert.equal(buildSchema([]).properties.items.items.properties.menu.enum.length, 1);
});

test('intents: normalizeIntent dan validasi menolak menu di luar kandidat', () => {
  assert.equal(normalizeIntent('Tanya Menu'), 'tanya_menu');
  assert.equal(normalizeIntent('ubah pesanan'), 'ubah_pesanan');

  const invalid = validateLLMOutput({ intent: 'pesan', items: [{ menu: 'Bakso', qty: 1 }], waktu: '' }, ['Nasi Gudeg']);
  assert.equal(invalid.ok, true);
  assert.equal(invalid.needsClarification, true);
  assert.equal(invalid.invalidItems.length, 1);

  const unknownIntent = validateLLMOutput({ intent: 'order', items: [], waktu: '' });
  assert.equal(unknownIntent.ok, false);
  assert.equal(unknownIntent.reason, 'INTENT_TIDAK_DIKENAL');
});

test('intents: pesan tanpa item valid memicu klarifikasi', () => {
  const result = validateLLMOutput({ intent: 'pesan', items: [{ menu: 'TIDAK_ADA', qty: 1 }], waktu: '' }, ['Nasi Gudeg']);
  assert.equal(result.ok, true);
  assert.equal(result.needsClarification, true);
  assert.equal(result.data.items.length, 0);
});

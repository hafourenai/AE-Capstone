import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiAccountGroqProvider } from '../src/services/llmPool.js';

test('llmPool: multi-account failover saat akun pertama terkena 429', async () => {
  let callCount = 0;
  const callsWithKey = [];

  const fakeFetch = async (url, options) => {
    callCount++;
    const authHeader = options.headers?.Authorization || '';
    const key = authHeader.replace('Bearer ', '');
    callsWithKey.push(key);

    if (key === 'gsk_key1') {
      // Simulasikan 429 rate limit
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'Rate limit exceeded: retry after 2 seconds',
        json: async () => ({ error: { message: 'Rate limit exceeded: retry after 2' } }),
      };
    }

    // Akun 2 berhasil
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'pesan',
                items: [{ menu: 'Ayam Geprek', qty: 2 }],
                waktu: '',
                keluhan: '',
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    };
  };

  const pool = new MultiAccountGroqProvider({
    apiKeys: ['gsk_key1', 'gsk_key2', 'gsk_key3'],
    fetchImpl: fakeFetch,
  });

  const res = await pool.extract('pesen ayam geprek 2', { candidates: ['Ayam Geprek'] });
  assert.equal(res.ok, true);
  assert.equal(res.data.intent, 'pesan');
  assert.equal(res.provider, 'groq_account_2');
  assert.deepEqual(callsWithKey, ['gsk_key1', 'gsk_key2']);
});

test('llmPool: jika akun 1 masih cooldown, panggilan berikutnya langsung loncat ke akun 2', async () => {
  let callCount = 0;
  const callsWithKey = [];

  const fakeFetch = async (url, options) => {
    callCount++;
    const authHeader = options.headers?.Authorization || '';
    const key = authHeader.replace('Bearer ', '');
    callsWithKey.push(key);

    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'pesan',
                items: [{ menu: 'Es Teh Manis', qty: 1 }],
                waktu: '',
                keluhan: '',
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    };
  };

  const pool = new MultiAccountGroqProvider({
    apiKeys: ['gsk_key1', 'gsk_key2'],
    fetchImpl: fakeFetch,
  });

  // Tandai akun 1 cooldown
  pool.markCooldown(0, '429 Rate Limit', 60);

  const res = await pool.extract('es teh 1', { candidates: ['Es Teh Manis'] });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'groq_account_2');
  assert.deepEqual(callsWithKey, ['gsk_key2']);
});

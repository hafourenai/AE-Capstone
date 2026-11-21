import fs from 'node:fs';
import PQueue from 'p-queue';
import { buildSchema, INTENTS, INTENT_DESCRIPTIONS, validateLLMOutput } from './intents.js';

const DEFAULT_TIMEOUT_MS = 25_000;

function loadFewshot() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../prompts/fewshot.json', import.meta.url), 'utf8'));
  } catch {
    return [];
  }
}

export class LLMError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
  }
}

export const SYSTEM_PROMPT = [
  'Anda mesin ekstraksi pesanan restoran. Pahami pesan pelanggan lalu balas HANYA JSON sesuai schema. Jangan menulis balasan untuk pelanggan.',
  'Intent yang tersedia:',
  ...INTENTS.map((intent) => `- ${intent}: ${INTENT_DESCRIPTIONS[intent]}`),
  'Aturan:',
  '- Jika tidak yakin, gunakan intent "lainnya".',
  '- Menu HANYA boleh dari daftar Kandidat. Jika tidak ada yang cocok, gunakan "TIDAK_ADA".',
  '- Jangan mengarang harga, total, stok, atau jam. Hanya ekstrak maksud dan item.',
  '- Ambil jumlah dari pesan. Jika tidak disebut, qty = 1.',
  '- Isi "waktu" hanya bila pelanggan menyebut waktu.',
  '- Isi "keluhan" hanya untuk intent keluhan.',
].join('\n');

function buildUserContent(message, candidates, context = {}) {
  const lines = [
    `Kandidat: ${candidates.length ? candidates.join(', ') : '(tidak ada)'}`,
    `Pesan: "${message}"`,
  ];
  if (context.state) lines.push(`State: ${context.state}`);
  if (context.draft) {
    const draft = JSON.stringify(context.draft);
    lines.push(`Draft: ${draft.length > 300 ? `${draft.slice(0, 300)}...` : draft}`);
  }
  return lines.join('\n');
}

function parseContent(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { return null; }
}

export class LLMClient {
  constructor({
    baseUrl,
    model,
    apiKey = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    queue = new PQueue({ concurrency: 1 }),
    fetchImpl = fetch,
    fewshot = loadFewshot(),
  } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.queue = queue;
    this.fetchImpl = fetchImpl;
    this.fewshot = fewshot;
    this.mode = null;
    this.healthy = null;
  }

  get origin() {
    return this.baseUrl.replace(/\/v1$/, '');
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  /** Cek llama-server. Return boolean, tidak pernah melempar. */
  async health() {
    if (!this.origin) { this.healthy = false; return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetchImpl(`${this.origin}/health`, { headers: this.headers, signal: controller.signal });
      this.healthy = Boolean(response.ok);
      return this.healthy;
    } catch {
      this.healthy = false;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  buildMessages(message, candidates, context) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    const learned = Array.isArray(context?.learnedExamples) ? context.learnedExamples : [];
    const examples = [...learned.slice(0, 3), ...(this.fewshot || [])].slice(0, 3);
    for (const example of examples) {
      messages.push({ role: 'user', content: buildUserContent(example.pesan, example.kandidat || [], {}) });
      messages.push({ role: 'assistant', content: JSON.stringify(example.output) });
    }
    messages.push({ role: 'user', content: buildUserContent(message, candidates, context) });
    return messages;
  }

  _chatBody(messages, schema, mode) {
    const responseFormat = mode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'bot_response', strict: true, schema } }
      : { type: 'json_object', schema };
    return JSON.stringify({
      model: this.model,
      messages,
      temperature: 0,
      max_tokens: 120,
      cache_prompt: true,
      response_format: responseFormat,
    });
  }

  _completionBody(messages, schema) {
    const prompt = `${messages.map((item) => `${item.role}: ${item.content}`).join('\n')}\nassistant:`;
    return JSON.stringify({
      prompt,
      temperature: 0,
      n_predict: 120,
      cache_prompt: true,
      json_schema: schema,
    });
  }

  async _requestAttempt(mode, messages, schema, signal) {
    const isCompletion = mode === 'completion';
    const url = isCompletion ? `${this.baseUrl}/completion` : `${this.baseUrl}/chat/completions`;
    const body = isCompletion ? this._completionBody(messages, schema) : this._chatBody(messages, schema, mode);
    const response = await this.fetchImpl(url, { method: 'POST', headers: this.headers, body, signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LLMError('LLM_HTTP_ERROR', `llama-server ${response.status}: ${text.slice(0, 200)}`, response.status);
    }
    const data = await response.json();
    const content = isCompletion ? data?.content : data?.choices?.[0]?.message?.content;
    const finishReason = isCompletion ? data?.stop : data?.choices?.[0]?.finish_reason;
    return { content, finishReason };
  }

  async _attemptAllModes(messages, schema) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const modes = this.mode ? [this.mode, 'json_schema', 'json_object', 'completion'] : ['json_object', 'json_schema', 'completion'];
    const tried = new Set();
    let lastError = null;
    try {
      for (const mode of modes) {
        if (tried.has(mode)) continue;
        tried.add(mode);
        try {
          const result = await this._requestAttempt(mode, messages, schema, controller.signal);
          this.mode = mode;
          return result;
        } catch (error) {
          if (error.name === 'AbortError' || error.code === 'LLM_TIMEOUT') {
            throw new LLMError('LLM_TIMEOUT', `LLM timeout setelah ${this.timeoutMs}ms`);
          }
          // Format request tidak didukung: coba mode berikutnya.
          if (error.status === 400 || error.status === 404 || error.status === 422) {
            lastError = error;
            this.mode = null;
            continue;
          }
          throw error;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    throw new LLMError('LLM_UNAVAILABLE', lastError ? lastError.message : 'Semua format response LLM gagal', lastError?.status);
  }

  /**
   * Ekstrak maksud dan item dari pesan.
   * Mengembalikan hasil tervalidasi; melempar LLMError untuk timeout/kegagalan jaringan.
   */
  async extract(message, { candidates = [], context = {} } = {}) {
    const startedAt = Date.now();
    const schema = buildSchema(candidates);
    const messages = this.buildMessages(message, candidates, context);

    return this.queue.add(async () => {
      try {
        const { content, finishReason } = await this._attemptAllModes(messages, schema);
        const raw = parseContent(content);
        if (!raw) {
          return {
            ok: false,
            reason: finishReason === 'length' ? 'OUTPUT_TERPOTONG' : 'JSON_TIDAK_VALID',
            data: null,
            needsClarification: true,
            invalidItems: [],
            candidates,
            latencyMs: Date.now() - startedAt,
          };
        }
        const validation = validateLLMOutput(raw, candidates);
        return { ...validation, candidates, raw: content, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if (error.name === 'AbortError') throw new LLMError('LLM_TIMEOUT', `LLM timeout setelah ${this.timeoutMs}ms`);
        throw error;
      }
    });
  }
}

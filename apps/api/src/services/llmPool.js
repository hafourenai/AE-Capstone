import PQueue from 'p-queue';
import { LLMClient, LLMError } from '../llm.js';

export class MultiAccountGroqProvider {
  constructor({
    apiKeys = [],
    model = 'llama-3.1-8b-instant',
    baseUrl = 'https://api.groq.com/openai/v1',
    timeoutMs = 12000,
    cooldownMs = 60000,
    fetchImpl = fetch,
  } = {}) {
    this.apiKeys = apiKeys.map((k) => String(k).trim()).filter(Boolean);
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.cooldownMs = cooldownMs;
    this.fetchImpl = fetchImpl;
    // Map of keyIndex -> cooldownUntil timestamp
    this.keyCooldowns = new Map();
    this.currentKeyIndex = 0;
  }

  get isConfigured() {
    return this.apiKeys.length > 0;
  }

  isKeyAvailable(index) {
    const cooldownUntil = this.keyCooldowns.get(index) || 0;
    return Date.now() >= cooldownUntil;
  }

  getNextAvailableKey() {
    if (!this.apiKeys.length) return null;
    const n = this.apiKeys.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.currentKeyIndex + i) % n;
      if (this.isKeyAvailable(idx)) {
        this.currentKeyIndex = idx;
        return { index: idx, key: this.apiKeys[idx] };
      }
    }
    return null;
  }

  markCooldown(index, reason = 'RATE_LIMIT', retryAfterSec = null) {
    const duration = retryAfterSec ? retryAfterSec * 1000 : this.cooldownMs;
    const cooldownUntil = Date.now() + duration;
    this.keyCooldowns.set(index, cooldownUntil);
    console.warn(`[Groq Multi-Account] Akun index #${index} kena limit (${reason}). Diistirahatkan selama ${Math.round(duration / 1000)} detik.`);
  }

  async extract(message, options = {}) {
    if (!this.isConfigured) {
      throw new LLMError('GROQ_NOT_CONFIGURED', 'Tidak ada Groq API Key yang aktif');
    }

    const maxTries = this.apiKeys.length;
    let lastError = null;

    for (let attempt = 0; attempt < maxTries; attempt++) {
      const active = this.getNextAvailableKey();
      if (!active) {
        throw new LLMError('GROQ_ALL_EXHAUSTED', 'Semua API key Groq sedang dalam masa tunggu/cooldown rate limit');
      }

      const client = new LLMClient({
        baseUrl: this.baseUrl,
        model: this.model,
        apiKey: active.key,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });

      try {
        const result = await client.extract(message, options);
        return { ...result, provider: `groq_account_${active.index + 1}` };
      } catch (err) {
        lastError = err;
        const msg = String(err.message || '');
        const is429 = err.status === 429 || /429|rate_limit|exceeded/i.test(msg);
        const isAuthError = err.status === 401 || /invalid_api_key|unauthorized/i.test(msg);

        if (is429) {
          // Parse retry-after if available in message or default
          let retryAfter = null;
          const match = msg.match(/retry(?:-|\s+)after\s+(\d+)/i);
          if (match) retryAfter = parseInt(match[1], 10);
          this.markCooldown(active.index, '429 Rate Limit', retryAfter);
          // Putar ke akun berikutnya
          this.currentKeyIndex = (active.index + 1) % this.apiKeys.length;
          continue;
        }

        if (isAuthError) {
          this.markCooldown(active.index, 'Invalid API Key', 86400); // cooldown 24 jam
          this.currentKeyIndex = (active.index + 1) % this.apiKeys.length;
          continue;
        }

        // Error lain (seperti timeout atau server error 5xx): jangan langsung blacklist tapi coba key berikutnya jika ada
        console.warn(`[Groq Multi-Account] Akun #${active.index} error: ${msg}. Mencoba failover...`);
        this.currentKeyIndex = (active.index + 1) % this.apiKeys.length;
      }
    }

    throw lastError || new LLMError('GROQ_FAILED', 'Gagal memanggil semua akun Groq');
  }
}

export class HybridLLMOrchestrator {
  constructor({
    localClient,
    groqProvider,
    preferGroq = true,
  } = {}) {
    this.localClient = localClient;
    this.groqProvider = groqProvider;
    this.preferGroq = preferGroq;
    this.healthy = true;
  }

  async health() {
    if (this.groqProvider?.isConfigured) {
      this.healthy = true;
      return true;
    }
    if (this.localClient) {
      return this.localClient.health();
    }
    this.healthy = false;
    return false;
  }

  async extract(message, options = {}) {
    // 1. Coba Groq terlebih dahulu jika diaktifkan dan dikonfigurasi
    if (this.preferGroq && this.groqProvider?.isConfigured) {
      try {
        const res = await this.groqProvider.extract(message, options);
        if (res && res.ok) return res;
      } catch (groqErr) {
        console.warn(`[LLM Orchestrator] Groq fallback gagal (${groqErr.message}). Mengalihkan ke SLM lokal (Termux)...`);
      }
    }

    // 2. Fallback ke SLM lokal (Termux Qwen)
    if (this.localClient) {
      try {
        const localRes = await this.localClient.extract(message, options);
        return { ...localRes, provider: 'local_termux_slm' };
      } catch (localErr) {
        console.error(`[LLM Orchestrator] SLM lokal juga gagal (${localErr.message}).`);
        throw localErr;
      }
    }

    throw new LLMError('NO_LLM_PROVIDER_AVAILABLE', 'Tidak ada provider LLM/SLM yang dapat digunakan');
  }
}

import { z } from 'zod';

// Output schema dari AI untuk mode interaktif
const CartAIOutputSchema = z.object({
  actions: z.array(z.union([
    z.object({ type: z.literal('SET_NAME'), value: z.string() }),
    z.object({ type: z.literal('SET_BRANCH'), value: z.string() }),
    z.object({ type: z.literal('ADD_ITEM'), menuHint: z.string(), quantity: z.number().int().min(1).max(99) }),
    z.object({ type: z.literal('UPDATE_ITEM'), menuHint: z.string(), quantity: z.number().int().min(0).max(99) }),
    z.object({ type: z.literal('REMOVE_ITEM'), menuHint: z.string() }),
    z.object({ type: z.literal('SET_NOTES'), value: z.string() }),
    z.object({ type: z.literal('RESET_ITEMS') }),
  ])).default([]),
  intent: z.enum(['ORDER', 'COMPLAINT', 'HANDOFF', 'MENU', 'GENERAL_QUESTION', 'UNKNOWN']).default('UNKNOWN'),
  replyText: z.string().default(''),
  askFor: z.enum(['name', 'branch', 'items', 'quantity', 'clarify', '']).optional(),
});

const safeReplies = {
  ORDER: 'Siap kak! Mau pesan menu apa hari ini? 😊',
  COMPLAINT: 'Mohon ceritakan keluhan Anda beserta nama dan cabang terkait agar dapat kami catat.',
  GENERAL_QUESTION: 'Halo! Ada yang bisa kami bantu terkait menu, pesanan, atau keluhan Sambal Joelid?',
  HANDOFF: 'Baik, kami akan menghubungkan Anda dengan admin.',
  UNKNOWN: 'Ada yang bisa kami bantu? 😊',
  MENU: '',
};

export function detectIntentHint(message) {
  const text = message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  if (/\b(admin|operator|manusia)\b/.test(text)) return 'HANDOFF';
  if (/\b(keluhan|keluh|komplain|complain|kecewa|rusak|basi|salah pesanan)\b/.test(text)) return 'COMPLAINT';
  if (/\b(pesan|pesen|psen|order|beli|mau makan|mknan|makanan|bungkus|porsi|paket)\b/.test(text)) return 'ORDER';
  if (/\b(menu|daftar menu|harga)\b/.test(text)) return 'MENU';
  if (/^(halo+|hai+|hi+|pagi|siang|sore|malam|ass?alamualaikum)[\s!,.]*$/.test(text.trim())) return 'GREETING';
  return null;
}

const STOP_WORDS = new Set([
  'saya', 'sy', 'aku', 'gue', 'gw', 'mau', 'ingin', 'tolong', 'bisa', 'dong', 'kak',
  'min', 'admin', 'ya', 'dan', 'sama', 'di', 'ke', 'dari', 'ini', 'itu', 'ada',
  'apa', 'berapa', 'pesan', 'pesen', 'psen', 'order', 'beli', 'cabang', 'bungkus',
  'porsi', 'paket', 'untuk', 'aja', 'saja', 'juga', 'buat', 'nya',
]);

export function selectRelevantMenus(message, history = [], allMenus = [], maxItems = 4) {
  const available = (allMenus || []).filter(m => m.active && (m.stock === undefined || m.stock > 0));
  if (available.length <= maxItems) return available;

  const recentTexts = [
    message || '',
    ...(history || []).slice(-2).map(h => h.content || ''),
  ].join(' ').toLowerCase();

  const tokens = recentTexts
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  const scored = available.map(menu => {
    let score = 0;
    const nameLower = (menu.name || '').toLowerCase();
    const idLower = (menu.id || '').toLowerCase();
    const aliases = Array.isArray(menu.aliases) ? menu.aliases.map(a => String(a).toLowerCase()) : [];

    if (nameLower && recentTexts.includes(nameLower)) score += 30;
    if (idLower && recentTexts.includes(idLower)) score += 30;
    for (const alias of aliases) {
      if (alias && recentTexts.includes(alias)) { score += 25; break; }
    }
    for (const token of tokens) {
      if (nameLower.includes(token)) score += 10;
      if (idLower.includes(token)) score += 5;
      for (const alias of aliases) {
        if (alias.includes(token)) { score += 8; break; }
      }
    }
    return { menu, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter(s => s.score > 0).map(s => s.menu);
  const remaining = scored.filter(s => s.score <= 0).map(s => s.menu);
  const result = [...matched];
  for (const item of remaining) {
    if (result.length >= maxItems) break;
    result.push(item);
  }
  return result.slice(0, maxItems);
}

const aiResponseFormat = { type: 'json_object' };

export function normalizeCartAIOutput(value) {
  const result = CartAIOutputSchema.safeParse(value);
  if (result.success) return result.data;
  const intent = typeof value?.intent === 'string' ? value.intent.toUpperCase() : 'UNKNOWN';
  return {
    actions: [],
    intent: Object.hasOwn(safeReplies, intent) ? intent : 'UNKNOWN',
    replyText: typeof value?.replyText === 'string' ? value.replyText : safeReplies[intent] || '',
    askFor: '',
  };
}

export function parseAICompletion(data) {
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    console.warn('[AI] Respons terpotong (finish_reason=length)');
    return { actions: [], intent: 'UNKNOWN', replyText: 'Maaf kak, pesan belum terbaca lengkap. Bisa diulangi ya? 🙏', askFor: '' };
  }
  const content = choice?.message?.content;
  try {
    if (typeof content !== 'string') throw new Error('Missing content');
    const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return normalizeCartAIOutput(JSON.parse(text));
  } catch {
    console.warn('[AI] Respons JSON tidak valid');
    return { actions: [], intent: 'UNKNOWN', replyText: 'Maaf kak, pesan belum berhasil dipahami. Coba ceritakan lagi ya! 😊', askFor: '' };
  }
}

// Tetap diekspor untuk backward compat test lama
export function normalizeAIOutput(value) {
  return normalizeCartAIOutput(value);
}

export class AIEngine {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs || 15000;
    this.apiKey = config.apiKey;
    this.queue = [];
    this.processing = false;
  }

  async processWithQueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const { fn, resolve, reject } = this.queue.shift();
    try { resolve(await fn()); }
    catch (error) { reject(error); }
    finally { this.processing = false; this._processQueue(); }
  }

  /**
   * Mode interaktif: AI menerima konteks cart + riwayat, mengembalikan actions + replyText.
   * System prompt dibuat seringkas mungkin untuk Qwen 1.5B di Termux.
   */
  async processOrderMessage(customerMessage, { menus, branches, cart }, history = []) {
    // Hanya kirim nama menu (tanpa harga/id) untuk hemat token
    const menuLines = menus.length
      ? menus.map(m => m.name).join(', ')
      : '(tidak ada)';
    // Hanya id cabang — lebih pendek
    const branchLines = branches.map(b => b.id).join(', ');

    // Konteks cart: hanya sebutkan yang belum terisi
    const missingCtx = [];
    if (!cart?.customer_name) missingCtx.push('nama');
    if (!cart?.branch_id) missingCtx.push('cabang');
    if (!cart?.items?.length) missingCtx.push('menu');
    const cartCtx = missingCtx.length
      ? `Belum ada: ${missingCtx.join(', ')}`
      : 'Sudah lengkap';

    // Prompt sangat ringkas — prioritas utama untuk model kecil
    const systemPrompt = `Ekstrak pesanan dari pesan pelanggan. Balas JSON saja tanpa teks lain.
Format: {"intent":"ORDER","actions":[...],"replyText":"...","askFor":""}
Actions: SET_NAME {"type":"SET_NAME","value":"nama"} | SET_BRANCH {"type":"SET_BRANCH","value":"id"} | ADD_ITEM {"type":"ADD_ITEM","menuHint":"nama","quantity":N} | REMOVE_ITEM {"type":"REMOVE_ITEM","menuHint":"nama"}
Menu: ${menuLines}
Cabang: ${branchLines}
Cart: ${cartCtx}
Jika bukan pesanan: intent=UNKNOWN, actions=[]. replyText singkat bahasa Indonesia.`;

    return this.processWithQueue(async () => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        // Hanya 2 pesan history terakhir, max 100 char per pesan
        const historyItems = history.slice(-2).map(item => {
          let content = (item.content || '').trim();
          if (content.length > 100) content = content.slice(0, 90) + '...';
          return { role: item.sender_type === 'CUSTOMER' ? 'user' : 'assistant', content };
        });

        const body = JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...historyItems,
            { role: 'user', content: customerMessage },
          ],
          temperature: 0.1,
          max_tokens: 120,
          response_format: aiResponseFormat,
        });

        let response;
        try {
          response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            },
            body,
            signal: controller.signal,
          });
        } catch (err) {
          if (err.name === 'AbortError') throw new Error('AI_TIMEOUT');
          throw err;
        }

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(`AI API ${response.status}: ${payload?.error?.message || response.statusText}`);
        }

        const data = await response.json();
        const parsed = parseAICompletion(data);
        console.info(`[AI] ${Date.now() - startedAt}ms intent=${parsed.intent} actions=${parsed.actions?.length ?? 0}`);
        return parsed;
      } catch (error) {
        if (error.message === 'AI_TIMEOUT' || error.name === 'AbortError') {
          console.error(`[AI] Timeout setelah ${Date.now() - startedAt}ms`);
          throw new Error('AI_TIMEOUT');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  // Alias lama — dipakai oleh test yang belum dimigrasi
  async classifyIntent(customerMessage, catalogContext, history = []) {
    return this.processOrderMessage(customerMessage, {
      menus: catalogContext?.menus || [],
      branches: catalogContext?.branches || [],
      cart: null,
    }, history);
  }
}

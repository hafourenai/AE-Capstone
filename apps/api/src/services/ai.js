import { z } from 'zod';

const AIOutputSchema = z.object({
  intent: z.enum(['ORDER', 'COMPLAINT', 'GENERAL_QUESTION', 'HANDOFF', 'UNKNOWN']),
  extractedData: z.object({
    customerName: z.string().optional(),
    branchId: z.string().optional(),
    items: z.array(z.object({
      menuId: z.string(),
      quantity: z.number().int().min(1),
    })).optional(),
    notes: z.string().optional(),
    complaintCategory: z.string().optional(),
    complaintDescription: z.string().optional(),
  }).optional(),
  replyText: z.string(),
});

const safeReplies = {
  ORDER: 'Silakan sebutkan menu, jumlah, dan cabang yang Anda pilih agar pesanan dapat kami rangkum.',
  COMPLAINT: 'Mohon ceritakan keluhan Anda beserta nama dan cabang terkait agar dapat kami catat.',
  GENERAL_QUESTION: 'Halo! Ada yang bisa kami bantu terkait menu, pesanan, atau keluhan Sambal Joelid?',
  HANDOFF: 'Baik, kami akan menghubungkan Anda dengan admin.',
  UNKNOWN: 'Mohon jelaskan kebutuhan Anda, apakah ingin bertanya, membuat pesanan, atau menyampaikan keluhan.',
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
  'porsi', 'paket', 'untuk', 'aja', 'saja', 'juga', 'buat', 'nya'
]);

/**
 * Filter menu relevan maksimal maxItems (default: 10) untuk mencegah AI timeout
 * pada small model / Termux saat katalog berukuran besar (50+ items).
 */
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
      if (alias && recentTexts.includes(alias)) {
        score += 25;
        break;
      }
    }

    for (const token of tokens) {
      if (nameLower.includes(token)) score += 10;
      if (idLower.includes(token)) score += 5;
      for (const alias of aliases) {
        if (alias.includes(token)) {
          score += 8;
          break;
        }
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

// `json_schema` menambahkan grammar/schema yang besar ke setiap request. Model lokal
// di HP jauh lebih cepat dengan JSON mode biasa; hasil tetap divalidasi oleh Zod.
const aiResponseFormat = { type: 'json_object' };

export function normalizeAIOutput(value) {
  const rawIntent = typeof value?.intent === 'string' ? value.intent.toUpperCase() : 'UNKNOWN';
  const intent = Object.hasOwn(safeReplies, rawIntent) ? rawIntent : 'UNKNOWN';
  const extractedData = value?.extractedData && typeof value.extractedData === 'object'
    ? value.extractedData
    : undefined;
  const replyText = typeof value?.replyText === 'string' && value.replyText.trim()
    ? value.replyText.trim()
    : safeReplies[intent];

  const result = AIOutputSchema.safeParse({ intent, extractedData, replyText });
  if (result.success) return result.data;
  return { intent, replyText: safeReplies[intent] };
}

export class AIEngine {
  constructor(config) {
    this.baseUrl = config.baseUrl; // https://termux-tunnel-url/v1
    this.model = config.model;     // qwen2.5-1.5b-instruct
    this.timeoutMs = config.timeoutMs || 15000;
    this.apiKey = config.apiKey;
    this.queue = [];
    this.processing = false;
  }

  /**
   * Queue AI request untuk mencegah concurrent load pada HP Termux
   */
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
    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.processing = false;
      this._processQueue();
    }
  }

  /**
   * Klasifikasi intent dan ekstraksi data dari pesan pelanggan
   */
  async classifyIntent(customerMessage, catalogContext, history = []) {
    const menus = catalogContext?.menus || [];
    const branches = catalogContext?.branches || [];
    const menuLines = menus.length
      ? menus.map(m => `${m.id}|${m.name}|${m.price}`).join('\n')
      : '(tidak ada)';
    const branchLines = branches.length
      ? branches.map(b => `${b.id}|${b.name}`).join(';')
      : '(tidak ada)';

    const systemPrompt = `CS Sambal Joelid. Balas singkat bahasa Indonesia, format HANYA JSON:
{"intent":"ORDER|COMPLAINT|GENERAL_QUESTION|HANDOFF|UNKNOWN","extractedData":{"branchId":"","items":[{"menuId":"","quantity":1}],"complaintDescription":""},"replyText":""}
Menu:
${menuLines}
Cabang: ${branchLines}
Gunakan hanya id di atas. Jika cabang belum ada, branchId="". Jangan hitung total. Admin=HANDOFF.`;

    return this.processWithQueue(async () => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const requestCompletion = async (historyItems, maxTokens = 80) => {
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: this.model,
              messages: [
                { role: 'system', content: systemPrompt },
                ...historyItems.map(item => {
                  let content = (item.content || '').trim();
                  // Pangkas pesan riwayat yang terlalu panjang (misal daftar menu penuh 50+ item)
                  // agar tidak membebani context & waktu evaluasi prompt pada model lokal.
                  if (content.length > 120) {
                    content = content.slice(0, 100) + '...';
                  }
                  return { role: item.sender_type === 'CUSTOMER' ? 'user' : 'assistant', content };
                }),
                { role: 'user', content: customerMessage },
              ],
              temperature: 0.2,
              max_tokens: maxTokens,
              response_format: aiResponseFormat,
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            const detail = String(payload?.error?.message || payload?.message || response.statusText)
              .replaceAll(customerMessage, '[redacted]')
              .slice(0, 300);
            const error = new Error(`AI API returned ${response.status}: ${detail}`);
            error.status = response.status;
            throw error;
          }
          return response.json();
        };

        let data;
        try {
          data = await requestCompletion(history.slice(-2), 80);
        } catch (error) {
          if (error.status !== 400) throw error;
          console.warn(`[AI] Request ditolak (${error.message}); mencoba ulang tanpa riwayat percakapan`);
          data = await requestCompletion([], 70);
        }
        const content = data.choices?.[0]?.message?.content || '';

        // Parse JSON dari response (toleran terhadap teks pengantar)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        console.info(`[AI] Selesai dalam ${Date.now() - startedAt}ms (menu=${catalogContext.menus.length}, history=${Math.min(history.length, 2)})`);
        return normalizeAIOutput(parsed);
      } catch (error) {
        if (error.name === 'AbortError') {
          console.error(`[AI] Timeout setelah ${Date.now() - startedAt}ms (menu=${catalogContext.menus.length}, history=${Math.min(history.length, 2)})`);
          throw new Error('AI_TIMEOUT');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

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
  if (/\b(pesan|pesen|psen|order|beli|mau makan|mknan|makanan)\b/.test(text)) return 'ORDER';
  if (/\b(menu|daftar menu|harga)\b/.test(text)) return 'MENU';
  if (/^(halo+|hai+|hi+|pagi|siang|sore|malam|ass?alamualaikum)[\s!,.]*$/.test(text.trim())) return 'GREETING';
  return null;
}

const aiResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'sambal_joelid_customer_assistant',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: {
          type: 'string',
          enum: ['ORDER', 'COMPLAINT', 'GENERAL_QUESTION', 'HANDOFF', 'UNKNOWN'],
        },
        extractedData: {
          type: 'object',
          additionalProperties: false,
          properties: {
            customerName: { type: 'string' },
            branchId: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  menuId: { type: 'string' },
                  quantity: { type: 'integer', minimum: 1 },
                },
                required: ['menuId', 'quantity'],
              },
            },
            notes: { type: 'string' },
            complaintCategory: { type: 'string' },
            complaintDescription: { type: 'string' },
          },
        },
        replyText: { type: 'string', minLength: 1 },
      },
      required: ['intent', 'extractedData', 'replyText'],
    },
  },
};

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
    const systemPrompt = `Anda adalah customer service Sambal Joelid. Jawab natural, singkat, dan ramah dalam bahasa Indonesia.

MENU AKTIF (id|nama|harga):
${catalogContext.menus.map(m => `${m.id}|${m.name}|${m.price}`).join('\n')}

CABANG (id|nama):
${catalogContext.branches.map(b => `${b.id}|${b.name}`).join('\n')}

Tentukan intent ORDER, COMPLAINT, GENERAL_QUESTION, HANDOFF, atau UNKNOWN. Admin/operator/manusia berarti HANDOFF.
ORDER: ekstrak branchId, items [{menuId,quantity}], notes. COMPLAINT: ekstrak complaintDescription dan complaintCategory.
Pahami singkatan Indonesia; "sy mau psen mknan" adalah ORDER, bukan keluhan. Jangan mengarang menu/harga/cabang dan jangan hitung harga akhir.
Output hanya JSON: {"intent":"GENERAL_QUESTION","extractedData":{},"replyText":"Halo! Ada yang bisa kami bantu?"}`;

    return this.processWithQueue(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const requestCompletion = async (historyItems, maxTokens) => {
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
              ...historyItems.map(item => ({ role: item.sender_type === 'CUSTOMER' ? 'user' : 'assistant', content: item.content })),
              { role: 'user', content: customerMessage },
            ],
            temperature: 0.3,
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
          data = await requestCompletion(history.slice(-4), 220);
        } catch (error) {
          if (error.status !== 400) throw error;
          console.warn(`[AI] Request ditolak (${error.message}); mencoba ulang tanpa riwayat percakapan`);
          data = await requestCompletion([], 180);
        }
        const content = data.choices?.[0]?.message?.content || '';

        // Parse JSON dari response (toleran terhadap teks pengantar)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        return normalizeAIOutput(parsed);
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error('AI_TIMEOUT');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

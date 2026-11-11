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
  async classifyIntent(customerMessage, catalogContext) {
    const systemPrompt = `Anda adalah AI asisten customer service untuk Sambal Joelid, sebuah restoran cepat saji.

KATALOG MENU AKTIF:
${catalogContext.menus.map(m => `- ${m.id}: ${m.name} (Rp ${m.price.toLocaleString('id-ID')})`).join('\n')}

CABANG AKTIF:
${catalogContext.branches.map(b => `- ${b.id}: ${b.name}`).join('\n')}

KATA KUNCI HANDOFF (jika pelanggan menulis ini, set intent ke HANDOFF):
- admin, operator, manusia, bantuan langsung, komplain serius

INSTRUKSI:
1. Klasifikasikan pesan ke salah satu intent: ORDER, COMPLAINT, GENERAL_QUESTION, HANDOFF, UNKNOWN.
2. Jika ORDER: ekstrak branchId, items (menuId + quantity), dan notes opsional.
3. Jika COMPLAINT: ekstrak deskripsi keluhan dan kategori (KUALITAS_MAKANAN, PELAYANAN, KEBERSIHAN, PESANAN, LAINNYA).
4. Berikan replyText ramah dalam bahasa Indonesia yang sesuai intent.
5. Output HARUS berupa JSON valid tanpa teks tambahan.

Jangan mengarang menu, harga, atau cabang yang tidak ada dalam katalog.
Jangan menentukan harga akhir order (backend yang akan kalkulasi).`;

    return this.processWithQueue(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
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
              { role: 'user', content: customerMessage },
            ],
            temperature: 0.3,
            max_tokens: 250,
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`AI API returned ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        // Parse JSON dari response (toleran terhadap teks pengantar)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        return AIOutputSchema.parse(parsed);
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

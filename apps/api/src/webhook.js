import crypto from 'node:crypto';
import PQueue from 'p-queue';

// ── Identitas ─────────────────────────────────────────────────────────────────

/** Ubah nomor WhatsApp (JID/LID/telepon) menjadi nomor lokal 62... tanpa device suffix. */
export function normalizePhoneNumber(phone) {
  const localPart = String(phone ?? '').split('@')[0].split(':')[0];
  let normalized = localPart.replace(/\D/g, '');
  if (!normalized) return '';
  if (!normalized.startsWith('62') && normalized.startsWith('0')) normalized = '62' + normalized.slice(1);
  if (!normalized.startsWith('62')) normalized = '62' + normalized;
  return normalized;
}

/** Bersihkan chat id: buang device suffix, samakan domain s.whatsapp.net -> c.us. */
export function normalizeChatId(rawChatId) {
  const value = String(rawChatId ?? '');
  if (!value) return '';
  const [localPart, domain] = value.split('@');
  const local = localPart.split(':')[0];
  if (!domain) return local;
  const normalizedDomain = domain === 's.whatsapp.net' ? 'c.us' : domain;
  return `${local}@${normalizedDomain}`;
}

function isIgnoredChat(chatId) {
  return /@(g\.us|newsletter|broadcast)$/i.test(chatId);
}

/**
 * Ambil pesan masuk yang layak diproses dari event webhook WAHA.
 * Mengembalikan null untuk event yang harus diabaikan.
 * Media tetap dikembalikan (kind: 'media') agar bisa di-handoff, bukan dibuang diam-diam.
 */
export function extractIncomingMessage(event, sessionName) {
  if (!event || event.event !== 'message') return null;
  if (event.session && sessionName && event.session !== sessionName) return null;
  const payload = event.payload;
  if (!payload || payload.fromMe) return null;

  const chatId = normalizeChatId(payload.from);
  if (!chatId || isIgnoredChat(chatId)) return null;

  const raw = String(payload.body ?? '').trim();
  const type = String(payload.type ?? '').toLowerCase();
  const isTextType = !type || type === 'chat' || type === 'text';
  // Gambar, dokumen, audio, stiker, lokasi, kontak, dll. tidak diproses sebagai teks.
  const hasMedia = Boolean(payload.hasMedia) || !isTextType;
  if (!raw && !hasMedia) return null;

  const messageId = String(payload.id ?? '').trim();
  if (!messageId) return null;

  const senderAlt = payload._data?.Info?.SenderAlt;
  return {
    kind: hasMedia ? 'media' : 'text',
    messageId,
    chatId,
    phone: normalizePhoneNumber(senderAlt || payload.from),
    raw,
    timestamp: payload.timestamp ?? null,
  };
}

// ── Debounce per nomor ────────────────────────────────────────────────────────

/**
 * Menggabungkan pesan beruntun dari nomor yang sama dalam `delayMs`.
 * Setiap pesan baru mereset timer nomor tersebut.
 */
export class MessageAggregator {
  constructor({ delayMs = 4000, onFlush, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.buckets = new Map();
  }

  push(item) {
    const key = item.phone || item.chatId || item.messageId;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.items.push(item);
      this.clearTimeoutFn(existing.timer);
      existing.timer = this.setTimeoutFn(() => this._flush(key), this.delayMs);
      return;
    }
    const bucket = { items: [item], timer: null };
    bucket.timer = this.setTimeoutFn(() => this._flush(key), this.delayMs);
    this.buckets.set(key, bucket);
  }

  _flush(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.buckets.delete(key);
    const items = bucket.items;
    const batch = {
      phone: items[0].phone,
      chatId: items[0].chatId,
      raw: items.map((item) => item.raw).filter(Boolean).join(' ').trim(),
      messageIds: items.map((item) => item.messageId),
      kind: items.some((item) => item.kind === 'media') ? 'media' : 'text',
      timestamp: items.at(-1).timestamp,
    };
    try {
      this.onFlush?.(batch);
    } catch (error) {
      console.error('[webhook] Gagal memproses batch:', error.message);
    }
  }

  /** Paksa semua bucket yang tertunda untuk flush (dipakai saat shutdown/test). */
  flushAll() {
    for (const key of [...this.buckets.keys()]) {
      const bucket = this.buckets.get(key);
      this.clearTimeoutFn(bucket.timer);
      this._flush(key);
    }
  }

  get pendingCount() {
    return this.buckets.size;
  }
}

// ── Pipeline masuk ────────────────────────────────────────────────────────────

/**
 * Menyatukan filter, idempotensi, debounce, dan antrian global.
 *
 * - Pesan duplikat (message ID sama) diabaikan.
 * - Semua pemrosesan lewat p-queue concurrency 1.
 * - `processBatch` dipanggil setelah debounce dengan raw gabungan.
 * - `onUnsupported` dipanggil untuk media (handoff), bukan dibuang.
 */
export class IncomingPipeline {
  constructor({
    db,
    delayMs = 4000,
    processBatch,
    onUnsupported,
    logger = console,
    queue = new PQueue({ concurrency: 1 }),
    setTimeoutFn,
    clearTimeoutFn,
  }) {
    this.db = db;
    this.processBatch = processBatch;
    this.onUnsupported = onUnsupported;
    this.logger = logger;
    this.queue = queue;
    this.aggregator = new MessageAggregator({
      delayMs,
      onFlush: (batch) => this._dispatch(batch),
      setTimeoutFn,
      clearTimeoutFn,
    });
  }

  _claim(messageId, phone) {
    if (!this.db) return true;
    try {
      const result = this.db
        .prepare('INSERT OR IGNORE INTO wa_processed_messages(message_id, phone) VALUES (?, ?)')
        .run(messageId, phone || null);
      return result.changes > 0;
    } catch (error) {
      // Tabel belum dimigrasi: jangan blokir pesan.
      this.logger.warn?.(`[webhook] Idempotensi gagal: ${error.message}`);
      return true;
    }
  }

  /** Terima satu event WAHA. Mengembalikan status untuk logging/test. */
  ingest(event, sessionName) {
    const message = extractIncomingMessage(event, sessionName);
    if (!message) return 'ignored';
    if (!this._claim(message.messageId, message.phone)) return 'duplicate';

    if (message.kind === 'media') {
      this.queue.add(async () => {
        try {
          await this.onUnsupported?.(message);
        } catch (error) {
          this.logger.error?.(`[webhook] Handoff media gagal: ${error.message}`);
        }
      });
      return 'unsupported';
    }

    this.aggregator.push(message);
    return 'queued';
  }

  _dispatch(batch) {
    if (batch.kind === 'media') {
      this.queue.add(() => this.onUnsupported?.(batch));
      return;
    }
    if (!batch.raw) return;
    this.queue.add(async () => {
      try {
        await this.processBatch(batch);
      } catch (error) {
        this.logger.error?.(`[webhook] Pemrosesan batch gagal: ${error.message}`);
      }
    });
  }

  /** Tunggu semua debounce dan antrian selesai (test/shutdown). */
  async idle() {
    this.aggregator.flushAll();
    await this.queue.onIdle();
  }
}

/** HMAC SHA-512 untuk webhook WAHA. */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || typeof signature !== 'string' || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

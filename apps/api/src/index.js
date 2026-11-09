import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { z } from 'zod';
import { openDatabase, orderTransitions, complaintTransitions } from './database.js';
import { WAHAClient } from './services/waha.js';
import { AIEngine } from './services/ai.js';
import { OrderComplaintBridge } from './services/orderComplaintBridge.js';

const env = {
  port: Number(process.env.PORT || 3001), dbPath: process.env.CUSTOMER_MODULE_DB_PATH || './data/customer-module.sqlite',
  jwtSecret: process.env.JWT_SECRET || 'development-only-change-me', email: process.env.ADMIN_EMAIL || 'admin@sambaljoelid.local',
  password: process.env.ADMIN_PASSWORD || 'change-this-before-production', origins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(','),
  wahaBaseUrl: process.env.WAHA_BASE_URL || 'http://127.0.0.1:3000',
  wahaApiKey: process.env.WAHA_API_KEY || 'development-waha-key',
  wahaWebhookSecret: process.env.WAHA_WEBHOOK_SECRET || 'development-webhook-secret',
  wahaSession: process.env.WAHA_SESSION_NAME || 'sambal-joelid',
  aiBaseUrl: process.env.AI_BASE_URL || 'http://127.0.0.1:8080/v1',
  aiModel: process.env.AI_MODEL || 'qwen2.5-1.5b-instruct',
  aiApiKey: process.env.AI_API_KEY || '',
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 90000),
  whatsappRateWindowMs: Number(process.env.WHATSAPP_RATE_LIMIT_WINDOW_SECONDS || 60) * 1000,
  whatsappRateMax: Number(process.env.WHATSAPP_RATE_LIMIT_MAX_MESSAGES || 8),
  whatsappRetentionDays: Number(process.env.WHATSAPP_MESSAGE_RETENTION_DAYS || 30),
};
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'development-only-change-me')) {
  throw new Error('JWT_SECRET wajib diatur dengan nilai acak yang kuat pada production.');
}
if (process.env.NODE_ENV === 'production' && (!process.env.WAHA_API_KEY || !process.env.WAHA_WEBHOOK_SECRET)) {
  throw new Error('WAHA_API_KEY dan WAHA_WEBHOOK_SECRET wajib diatur pada production.');
}
const db = openDatabase(env.dbPath);
const waha = new WAHAClient(env.wahaBaseUrl, env.wahaApiKey, env.wahaSession);
const ai = new AIEngine({ baseUrl: env.aiBaseUrl, model: env.aiModel, apiKey: env.aiApiKey, timeoutMs: env.aiTimeoutMs });
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: env.origins, methods: ['GET', 'POST'] } });
const bridge = new OrderComplaintBridge(db, waha, io);
const messageRateBuckets = new Map();

if (env.whatsappRetentionDays > 0) {
  db.prepare("DELETE FROM whatsapp_messages WHERE created_at < datetime('now', ?)")
    .run(`-${env.whatsappRetentionDays} days`);
  db.prepare("DELETE FROM whatsapp_pending_actions WHERE status != 'PENDING' AND created_at < datetime('now', ?)")
    .run(`-${env.whatsappRetentionDays} days`);
}
app.set('trust proxy', 1);
app.use(helmet()); app.use(cors({ origin: env.origins }));
app.use(express.json({ limit: '32kb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const api = express.Router(); app.use('/api/v1', api);
const phone = z.string().trim().regex(/^\+?[0-9]{8,16}$/, 'Nomor WhatsApp tidak valid');
const orderInput = z.object({ customerName: z.string().trim().min(2).max(100), customerPhone: phone, branchId: z.string().min(1), notes: z.string().trim().max(500).optional(), items: z.array(z.object({ menuId: z.string().min(1), quantity: z.number().int().min(1).max(99) })).min(1).max(20) });
const complaintInput = z.object({ customerName: z.string().trim().min(2).max(100), customerPhone: phone, branchId: z.string().optional(), category: z.enum(['KUALITAS_MAKANAN','PELAYANAN','KEBERSIHAN','PESANAN','LAINNYA']).optional(), description: z.string().trim().min(10).max(2000) });

function normalizePhoneNumber(phone) {
  let normalized = phone.replace(/\D/g, '');
  if (!normalized.startsWith('62') && normalized.startsWith('0')) normalized = '62' + normalized.slice(1);
  if (!normalized.startsWith('62')) normalized = '62' + normalized;
  return normalized;
}

function verifyWebhookSignature(body, signature) {
  if (!body || typeof signature !== 'string') return false;
  const expected = crypto.createHmac('sha512', env.wahaWebhookSecret).update(body).digest('hex');
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isRateLimited(phoneNumber) {
  const now = Date.now();
  const recent = (messageRateBuckets.get(phoneNumber) || []).filter(timestamp => now - timestamp < env.whatsappRateWindowMs);
  recent.push(now);
  messageRateBuckets.set(phoneNumber, recent);
  return recent.length > env.whatsappRateMax;
}

const rows = (sql, ...p) => db.prepare(sql).all(...p);
const ref = (prefix) => `${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;

async function handleIncomingMessage(wahaMessage) {
  // Filter: hanya personal chat, bukan group (@g.us), bukan status, bukan milik sendiri
  const chatId = wahaMessage.from || '';
  if (wahaMessage.fromMe || chatId.endsWith('@g.us') || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return null;
  if (!wahaMessage.body || wahaMessage.body.trim().length === 0 || wahaMessage.hasMedia) return null;

  const normalizedPhone = normalizePhoneNumber(wahaMessage.from);
  const messageContent = wahaMessage.body.trim();

  // Deduplikasi: cek apakah messageId sudah pernah diproses
  const existingMsg = db.prepare('SELECT id FROM whatsapp_messages WHERE waha_message_id = ?').get(wahaMessage.id);
  if (existingMsg) {
    console.log(`[WAHA] Message ID ${wahaMessage.id} sudah diproses, skip.`);
    return null;
  }

  if (isRateLimited(normalizedPhone)) {
    console.warn(`[WAHA] Rate limit tercapai untuk nomor berakhiran ${normalizedPhone.slice(-4)}`);
    return null;
  }

  // Buat atau update conversation
  let conv = db.prepare('SELECT id FROM whatsapp_conversations WHERE phone = ?').get(normalizedPhone);
  if (!conv) {
    const result = db.prepare('INSERT INTO whatsapp_conversations(phone, state, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(normalizedPhone, 'AI_ACTIVE');
    conv = { id: result.lastInsertRowid };
  }

  // Simpan pesan inbound
  db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(conv.id, wahaMessage.id, 'INBOUND', 'CUSTOMER', messageContent);

  // Update timestamp percakapan
  db.prepare('UPDATE whatsapp_conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conv.id);

  return { conversationId: conv.id, phone: normalizedPhone, message: messageContent };
}

async function processMessage(conversationId, phone, message) {
  const conv = db.prepare('SELECT state FROM whatsapp_conversations WHERE id = ?').get(conversationId);

  // Jika state WAITING_ADMIN atau ADMIN_ACTIVE, jangan proses dengan AI
  if (conv.state !== 'AI_ACTIVE') {
    console.log(`[AI] Conversation ${conversationId} tidak dalam state AI_ACTIVE, skip AI processing`);
    io.to('admins').emit('whatsapp:message-received', { conversationId, phone, message });
    return;
  }

  try {
    // Cek jika ada pending action (order/complaint confirmation)
    const pending = db.prepare("SELECT * FROM whatsapp_pending_actions WHERE conversation_id = ? AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1").get(conversationId);

    if (pending) {
      const answer = message.toUpperCase().trim();
      if (answer === 'YA' || answer === 'YES' || answer === 'OK') {
        // Konfirmasi
        const payload = JSON.parse(pending.payload_json);
        bridge.updatePendingActionStatus(pending.id, 'CONFIRMED');

        let response = '';
        if (pending.action_type === 'ORDER_CONFIRMATION') {
          const order = bridge.createOrderFromConfirmation(conversationId, payload.customerName, phone, payload.branchId, payload.items, payload.notes);
          response = `✅ Pesanan Anda berhasil dibuat!\n\nNomor Referensi: *${order.reference}*\nTotal: Rp ${order.totalAmount.toLocaleString('id-ID')}\n\nTerima kasih telah memesan di Sambal Joelid!`;
        } else if (pending.action_type === 'COMPLAINT_CONFIRMATION') {
          const complaint = bridge.createComplaint(conversationId, payload.customerName, phone, payload.branchId, payload.category, payload.description);
          response = `✅ Keluhan Anda telah kami terima.\n\nNomor Referensi: *${complaint.reference}*\n\nTim kami akan menghubungi Anda segera untuk penyelesaian.`;
        }

        await waha.sendMessage(phone, response);
        db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(conversationId, `outbound-${crypto.randomUUID()}`, 'OUTBOUND', 'AI', response);
        return;
      } else if (answer === 'BATAL' || answer === 'CANCEL' || answer === 'NO') {
        // Batalkan
        bridge.updatePendingActionStatus(pending.id, 'CANCELLED');
        const response = 'Baik, permintaan Anda dibatalkan. Ada yang bisa kami bantu lagi?';
        await waha.sendMessage(phone, response);
        db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(conversationId, `outbound-${crypto.randomUUID()}`, 'OUTBOUND', 'AI', response);
        return;
      }
    }

    // Panggil AI untuk klasifikasi
    const menus = db.prepare('SELECT id, name, price FROM menus WHERE active = 1').all();
    const branches = db.prepare('SELECT id, name FROM branches WHERE active = 1').all();

    const aiResult = await ai.classifyIntent(message, { menus, branches });

    // Cek handoff keywords
    const handoffKeywords = ['admin', 'operator', 'manusia', 'bantuan', 'help'];
    if (aiResult.intent === 'HANDOFF' || handoffKeywords.some(kw => message.toLowerCase().includes(kw))) {
      db.prepare('UPDATE whatsapp_conversations SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('WAITING_ADMIN', conversationId);
      const response = '👋 Mohon tunggu, kami sedang menghubungkan Anda dengan tim admin kami...';
      await waha.sendMessage(phone, response);
      db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(conversationId, `outbound-${Date.now()}`, 'OUTBOUND', 'AI', response);
      io.to('admins').emit('whatsapp:conversation-updated', { conversationId, state: 'WAITING_ADMIN' });
      return;
    }

    let response = aiResult.replyText;

    // Jika ORDER, buat pending action untuk konfirmasi
    if (aiResult.intent === 'ORDER' && aiResult.extractedData?.items?.length > 0) {
      try {
        const validated = bridge.validateAndCalculateOrder(aiResult.extractedData.branchId, aiResult.extractedData.items);
        const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(aiResult.extractedData.branchId);
        const summary = bridge.formatOrderSummary(branch.name, aiResult.extractedData.items, menus, validated.totalAmount);

        // Simpan pending action
        bridge.savePendingAction(conversationId, 'ORDER_CONFIRMATION', {
          customerName: aiResult.extractedData.customerName || 'Pelanggan',
          branchId: aiResult.extractedData.branchId,
          items: aiResult.extractedData.items,
          notes: aiResult.extractedData.notes,
        });

        response = summary;
      } catch (e) {
        console.error('[ORDER] Validasi gagal:', e.message);
        response = `❌ Maaf, ada masalah dengan pesanan Anda. Pesan Anda telah kami teruskan ke admin untuk ditangani.`;
        db.prepare('UPDATE whatsapp_conversations SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('WAITING_ADMIN', conversationId);
      }
    } else if (aiResult.intent === 'COMPLAINT' && aiResult.extractedData?.complaintDescription) {
      // Simpan pending action untuk complaint
      bridge.savePendingAction(conversationId, 'COMPLAINT_CONFIRMATION', {
        customerName: aiResult.extractedData.customerName || 'Pelanggan',
        branchId: aiResult.extractedData.branchId,
        category: aiResult.extractedData.complaintCategory,
        description: aiResult.extractedData.complaintDescription,
      });

      response = `📝 Ringkasan keluhan Anda:\n\n"${aiResult.extractedData.complaintDescription}"\n\nBalas dengan *YA* untuk kirim keluhan, atau *BATAL* untuk batal.`;
    }

    // Kirim response AI
    await waha.sendMessage(phone, response);
    db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(conversationId, `outbound-${Date.now()}`, 'OUTBOUND', 'AI', response);
  } catch (error) {
    console.error('[AI] Error:', error.message);
    const fallback = `⏳ Mohon maaf, sistem kami sedang sibuk. Pesan Anda telah kami teruskan ke admin untuk ditangani.`;
    db.prepare('UPDATE whatsapp_conversations SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('WAITING_ADMIN', conversationId);
    try {
      await waha.sendMessage(phone, fallback);
      db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(conversationId, `outbound-${crypto.randomUUID()}`, 'OUTBOUND', 'AI', fallback);
    } catch (sendError) {
      console.error('[WAHA] Fallback gagal dikirim:', sendError.message);
    }
  }
}
function auth(req, res, next) { try { req.admin = jwt.verify(req.headers.authorization?.replace('Bearer ', ''), env.jwtSecret); next(); } catch { res.status(401).json({ error: 'UNAUTHORIZED', message: 'Autentikasi admin diperlukan.' }); } }
function validate(schema) { return (req, res, next) => { const result = schema.safeParse(req.body); if (!result.success) return res.status(422).json({ error: 'VALIDATION_ERROR', details: result.error.flatten() }); req.body = result.data; next(); }; }

api.get('/', (_, res) => res.json({ name: 'Sambal Joelid API', status: 'running', version: '1.0.0', health: '/health' }));
api.get('/health', (_, res) => res.json({ ok: true }));
api.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), (req, res) => {
  if (req.body?.email !== env.email || req.body?.password !== env.password) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email atau kata sandi tidak tepat.' });
  res.json({ token: jwt.sign({ role: 'ADMIN', email: env.email }, env.jwtSecret, { expiresIn: '8h' }) });
});
api.get('/public/menu', (_, res) => res.json(rows('SELECT id,name,price FROM menus WHERE active=1 ORDER BY name')));
api.get('/public/branches', (_, res) => res.json(rows('SELECT id,name FROM branches WHERE active=1 ORDER BY name')));
api.post('/public/orders', publicLimiter, validate(orderInput), (req, res) => {
  const create = db.transaction((input) => {
    if (!db.prepare('SELECT 1 FROM branches WHERE id=? AND active=1').get(input.branchId)) throw new Error('BRANCH_NOT_FOUND');
    const unique = [...new Map(input.items.map(i => [i.menuId, i])).values()];
    const menus = unique.map(i => ({ ...i, menu: db.prepare('SELECT id,name,price FROM menus WHERE id=? AND active=1').get(i.menuId) }));
    if (menus.some(i => !i.menu)) throw new Error('MENU_NOT_FOUND');
    const total = menus.reduce((sum, i) => sum + i.menu.price * i.quantity, 0); const reference = ref('ORD');
    const result = db.prepare('INSERT INTO customer_orders(reference_number,customer_name,customer_phone,branch_id,notes,total_amount,status) VALUES (?,?,?,?,?,?,?)').run(reference, input.customerName, input.customerPhone, input.branchId, input.notes || null, total, 'NEW');
    const add = db.prepare('INSERT INTO customer_order_items(order_id,menu_id,menu_name_snapshot,unit_price_snapshot,quantity,subtotal) VALUES (?,?,?,?,?,?)');
    menus.forEach(i => add.run(result.lastInsertRowid, i.menu.id, i.menu.name, i.menu.price, i.quantity, i.menu.price * i.quantity));
    return { id: result.lastInsertRowid, referenceNumber: reference, totalAmount: total };
  });
  try { const order = create(req.body); io.to('admins').emit('order:new', order); res.status(201).json(order); } catch (e) { res.status(422).json({ error: e.message, message: 'Pesanan tidak dapat diproses.' }); }
});
api.post('/public/complaints', publicLimiter, validate(complaintInput), (req, res) => {
  try { if (req.body.branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND active=1').get(req.body.branchId)) throw new Error('BRANCH_NOT_FOUND'); const reference = ref('CMP'); const result = db.prepare('INSERT INTO customer_complaints(reference_number,customer_name,customer_phone,branch_id,category,description,status) VALUES (?,?,?,?,?,?,?)').run(reference, req.body.customerName, req.body.customerPhone, req.body.branchId || null, req.body.category || null, req.body.description, 'NEW'); const complaint = { id: result.lastInsertRowid, referenceNumber: reference }; io.to('admins').emit('complaint:new', complaint); res.status(201).json(complaint); } catch (e) { res.status(422).json({ error: e.message, message: 'Keluhan tidak dapat diproses.' }); }
});
function listRoute(table) { return (req, res) => { const { q = '', status = '', branchId = '', page = '1' } = req.query; const offset = (Math.max(1, Number(page)) - 1) * 20; const where = [`(reference_number LIKE @q OR customer_name LIKE @q)`]; const params = { q: `%${q}%`, limit: 20, offset }; if (status) { where.push('status=@status'); params.status = status; } if (branchId) { where.push('branch_id=@branchId'); params.branchId = branchId; } const clause = where.join(' AND '); const data = rows(`SELECT t.*, b.name AS branch_name FROM ${table} t LEFT JOIN branches b ON b.id=t.branch_id WHERE ${clause} ORDER BY t.created_at DESC LIMIT @limit OFFSET @offset`, params); const total = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${clause}`).get(params).count; res.json({ data, total, page: Number(page) }); }; }
api.get('/admin/orders', auth, listRoute('customer_orders'));
api.get('/admin/orders/:id', auth, (req,res) => { const order = db.prepare('SELECT * FROM customer_orders WHERE id=?').get(req.params.id); if (!order) return res.sendStatus(404); order.items = rows('SELECT * FROM customer_order_items WHERE order_id=?', order.id); res.json(order); });
api.patch('/admin/orders/:id/status', auth, validate(z.object({ status: z.enum(['NEW','CONFIRMED','PROCESSING','COMPLETED','CANCELLED']) })), (req,res) => updateStatus('customer_orders', orderTransitions, 'order:updated', req,res));
api.get('/admin/complaints', auth, listRoute('customer_complaints'));
api.get('/admin/complaints/:id', auth, (req,res) => { const item = db.prepare('SELECT * FROM customer_complaints WHERE id=?').get(req.params.id); item ? res.json(item) : res.sendStatus(404); });
api.patch('/admin/complaints/:id/status', auth, validate(z.object({ status: z.enum(['NEW','IN_REVIEW','IN_PROGRESS','RESOLVED','CLOSED']) })), (req,res) => updateStatus('customer_complaints', complaintTransitions, 'complaint:updated', req,res));
api.patch('/admin/complaints/:id/notes', auth, validate(z.object({ adminNotes: z.string().trim().max(2000).nullable() })), (req,res) => { const result = db.prepare("UPDATE customer_complaints SET admin_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.adminNotes, req.params.id); if (!result.changes) return res.sendStatus(404); io.to('admins').emit('complaint:updated', { id: Number(req.params.id) }); res.sendStatus(204); });
function updateStatus(table, transitions, event, req, res) { const item = db.prepare(`SELECT id,status FROM ${table} WHERE id=?`).get(req.params.id); if (!item) return res.sendStatus(404); if (!transitions[item.status].includes(req.body.status)) return res.status(409).json({ error: 'INVALID_STATUS_TRANSITION' }); db.prepare(`UPDATE ${table} SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.body.status, item.id); io.to('admins').emit(event, { id: item.id, status: req.body.status }); res.sendStatus(204); }

// WhatsApp Webhook
api.post('/integrations/waha/webhook', async (req, res) => {
  try {
    // Verifikasi signature
    const signature = req.headers['x-webhook-hmac'];
    if (req.headers['x-webhook-hmac-algorithm'] !== 'sha512' || !verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    }

    const wahaMessage = req.body;

    // Handle message event
    if (wahaMessage.event === 'message' && wahaMessage.session === env.wahaSession) {
      const parsed = await handleIncomingMessage(wahaMessage.payload);
      if (parsed) {
        // Process async, don't wait
        processMessage(parsed.conversationId, parsed.phone, parsed.message).catch(err => {
          console.error('[Message Processing Error]', err);
        });
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Webhook Error]', error);
    res.status(500).json({ error: 'WEBHOOK_PROCESSING_ERROR' });
  }
});

// Admin WhatsApp Routes
api.get('/admin/whatsapp/conversations', auth, (req, res) => {
  const { state = '', page = '1' } = req.query;
  const offset = (Math.max(1, Number(page)) - 1) * 20;
  let query = 'SELECT * FROM whatsapp_conversations';
  let params = { limit: 20, offset };

  if (state) {
    query += ' WHERE state = @state';
    params.state = state;
  }

  query += ' ORDER BY last_message_at DESC LIMIT @limit OFFSET @offset';
  const data = db.prepare(query).all(params);
  const total = db.prepare('SELECT COUNT(*) as count FROM whatsapp_conversations' + (state ? ' WHERE state = @state' : '')).get(params).count;

  res.json({ data, total, page: Number(page) });
});

api.get('/admin/whatsapp/conversations/:id', auth, (req, res) => {
  const conv = db.prepare('SELECT * FROM whatsapp_conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.sendStatus(404);

  const messages = db.prepare('SELECT * FROM whatsapp_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conv.id);
  res.json({ ...conv, messages });
});

api.get('/admin/whatsapp/conversations/:id/messages', auth, (req, res) => {
  const { limit = '50', offset = '0' } = req.query;
  const messages = db.prepare('SELECT * FROM whatsapp_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.params.id, Math.min(Number(limit), 100), Number(offset));
  res.json(messages);
});

api.post('/admin/whatsapp/conversations/:id/messages', auth, validate(z.object({ content: z.string().trim().min(1).max(2000) })), async (req, res) => {
  try {
    const { content } = req.body;
    const conv = db.prepare('SELECT phone FROM whatsapp_conversations WHERE id = ?').get(req.params.id);
    if (!conv) return res.sendStatus(404);

    // Kirim ke WAHA
    await waha.sendMessage(conv.phone, content);

    // Simpan message sebagai ADMIN
    db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(req.params.id, `admin-${crypto.randomUUID()}`, 'OUTBOUND', 'ADMIN', content);

    io.to('admins').emit('whatsapp:message-received', { conversationId: req.params.id, sender: 'ADMIN' });
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error('[Admin Message Error]', error);
    res.status(500).json({ error: 'MESSAGE_SEND_FAILED' });
  }
});

api.patch('/admin/whatsapp/conversations/:id/state', auth, validate(z.object({ state: z.enum(['AI_ACTIVE', 'WAITING_ADMIN', 'ADMIN_ACTIVE']) })), (req, res) => {
  const { state } = req.body;
  const result = db.prepare('UPDATE whatsapp_conversations SET state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(state, req.params.id);
  if (!result.changes) return res.sendStatus(404);

  io.to('admins').emit('whatsapp:conversation-updated', { conversationId: req.params.id, state });
  res.sendStatus(204);
});
io.use((socket,next) => { try { socket.admin = jwt.verify(socket.handshake.auth?.token, env.jwtSecret); next(); } catch { next(new Error('unauthorized')); } }); io.on('connection', socket => socket.join('admins'));
server.listen(env.port, () => console.log(`Sambal Joelid API listening on :${env.port}`));

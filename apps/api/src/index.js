import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
import { OrderComplaintBridge } from './services/orderComplaintBridge.js';
import { CatalogService } from './services/catalog.js';
import { IncomingPipeline, verifyWebhookSignature } from './webhook.js';
import { MenuMatcher } from './menuMatcher.js';
import { LLMClient } from './llm.js';
import { MultiAccountGroqProvider, HybridLLMOrchestrator } from './services/llmPool.js';
import { BotHandler } from './bot.js';
import { TemplateStore } from './templates.js';
import { StateStore } from './state.js';
import { normalize } from './normalize.js';
import { MessageLogger } from './logger.js';

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
  groqEnabled: String(process.env.GROQ_ENABLED || 'true').toLowerCase() === 'true',
  groqApiKeys: (process.env.GROQ_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean),
  groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  groqTimeoutMs: Number(process.env.GROQ_TIMEOUT_MS || 12000),
  groqCooldownMs: Number(process.env.GROQ_COOLDOWN_SECONDS || 60) * 1000,
  whatsappDebounceMs: Number(process.env.WHATSAPP_DEBOUNCE_MS || 4000),
  llmHealthCheckMs: Number(process.env.LLM_HEALTH_CHECK_MS || 120000),
  replyDelayMinMs: Number(process.env.WHATSAPP_REPLY_DELAY_MIN_MS || 1000),
  replyDelayMaxMs: Number(process.env.WHATSAPP_REPLY_DELAY_MAX_MS || 3000),
  // Data berlabel dari dashboard adalah data runtime, bukan fixture test yang dilacak Git.
  testSetPath: process.env.TEST_SET_PATH || './data/admin-labeled-testset.jsonl',
  whatsappRateWindowMs: Number(process.env.WHATSAPP_RATE_LIMIT_WINDOW_SECONDS || 60) * 1000,
  whatsappRateMax: Number(process.env.WHATSAPP_RATE_LIMIT_MAX_MESSAGES || 8),
  whatsappRetentionDays: Number(process.env.WHATSAPP_MESSAGE_RETENTION_DAYS || 30),
  adminPauseSeconds: Number(process.env.WHATSAPP_ADMIN_PAUSE_SECONDS || 180),
  catalogUrl: process.env.MENU_CSV_URL || '',
  catalogTtlMs: Number(process.env.MENU_SYNC_INTERVAL_MS || 300000),
  bankName: process.env.PAYMENT_BANK_NAME || '',
  bankAccount: process.env.PAYMENT_BANK_ACCOUNT || '',
  bankHolder: process.env.PAYMENT_BANK_HOLDER || '',
};
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'development-only-change-me')) {
  throw new Error('JWT_SECRET wajib diatur dengan nilai acak yang kuat pada production.');
}
if (process.env.NODE_ENV === 'production' && (!process.env.WAHA_API_KEY || !process.env.WAHA_WEBHOOK_SECRET)) {
  throw new Error('WAHA_API_KEY dan WAHA_WEBHOOK_SECRET wajib diatur pada production.');
}
const db = openDatabase(env.dbPath);
const waha = new WAHAClient(env.wahaBaseUrl, env.wahaApiKey, env.wahaSession);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: env.origins, methods: ['GET', 'POST'] } });
const bridge = new OrderComplaintBridge(db, waha, io);
const catalog = new CatalogService({ url: env.catalogUrl, ttlMs: env.catalogTtlMs, db, maxDrop: Number(process.env.MENU_SYNC_MAX_DROP || 0.5) });
const menuMatcher = new MenuMatcher({ getMenus: () => catalog.getMenus() });
const templates = new TemplateStore(db);
const stateStore = new StateStore(db);
const localLlm = new LLMClient({
  baseUrl: env.aiBaseUrl,
  model: env.aiModel,
  apiKey: env.aiApiKey,
  timeoutMs: env.aiTimeoutMs,
});

const groqProvider = new MultiAccountGroqProvider({
  apiKeys: env.groqApiKeys,
  model: env.groqModel,
  baseUrl: env.groqBaseUrl,
  timeoutMs: env.groqTimeoutMs,
  cooldownMs: env.groqCooldownMs,
});

const llm = new HybridLLMOrchestrator({
  localClient: localLlm,
  groqProvider,
  preferGroq: env.groqEnabled,
});
const messageLogger = new MessageLogger(db);
const bot = new BotHandler({
  db,
  catalog,
  matcher: menuMatcher,
  llm,
  bridge,
  templates,
  state: stateStore,
  logger: console,
});
catalog.init().catch(err => console.error('[CATALOG] init error:', err.message));
const messageRateBuckets = new Map();
let lastWebhookAt = null;

if (env.whatsappRetentionDays > 0) {
  db.prepare("DELETE FROM whatsapp_messages WHERE created_at < datetime('now', ?)")
    .run(`-${env.whatsappRetentionDays} days`);
  db.prepare("DELETE FROM whatsapp_pending_actions WHERE status != 'PENDING' AND created_at < datetime('now', ?)")
    .run(`-${env.whatsappRetentionDays} days`);
  db.prepare("DELETE FROM wa_processed_messages WHERE received_at < datetime('now', '-7 days')").run();
  db.prepare("DELETE FROM wa_message_logs WHERE created_at < datetime('now', ?)")
    .run(`-${env.whatsappRetentionDays} days`);
  db.prepare("DELETE FROM failed_messages WHERE resolved = 1 AND created_at < datetime('now', ?)")
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

function isRateLimited(phoneNumber) {
  const now = Date.now();
  const recent = (messageRateBuckets.get(phoneNumber) || []).filter(timestamp => now - timestamp < env.whatsappRateWindowMs);
  recent.push(now);
  messageRateBuckets.set(phoneNumber, recent);
  return recent.length > env.whatsappRateMax;
}

const rows = (sql, ...p) => db.prepare(sql).all(...p);
const ref = (prefix) => `${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
const helpText = `Halo kak! Selamat datang di Sambal Joelid 🌶️\n\nMau pesan apa hari ini? Langsung sebutkan saja nama menu dan jumlahnya, ya! Tidak perlu format khusus. 😊\n\nAtau ketik *menu* untuk melihat daftar menu yang tersedia.`;
const pauseUntil = () => new Date(Date.now() + env.adminPauseSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);

function formatMenuList(menus) {
  const available = menus.filter(menu => menu.active && menu.stock > 0);
  return `🌶️ *Menu Sambal Joelid*\n\n${available.map(menu => `• ${menu.name} — Rp ${menu.price.toLocaleString('id-ID')} (stok ${menu.stock})`).join('\n') || 'Belum ada menu tersedia.'}\n\nLangsung sebut menu yang kamu mau ya, Kak! 😊`;
}

function resumeExpiredConversations() {
  const expired = db.prepare("SELECT id FROM whatsapp_conversations WHERE state != 'AI_ACTIVE' AND paused_until IS NOT NULL AND paused_until <= CURRENT_TIMESTAMP").all();
  if (!expired.length) return;
  db.prepare("UPDATE whatsapp_conversations SET state='AI_ACTIVE', paused_until=NULL, bot_state='IDLE', draft_order_json=NULL, fail_count=0, handoff=0, updated_at=CURRENT_TIMESTAMP WHERE state != 'AI_ACTIVE' AND paused_until IS NOT NULL AND paused_until <= CURRENT_TIMESTAMP").run();
  expired.forEach(({ id }) => io.to('admins').emit('whatsapp:conversation-updated', { conversationId: id, state: 'AI_ACTIVE' }));
}
setInterval(resumeExpiredConversations, 15_000).unref();

function upsertConversation(phone, chatId) {
  const conv = db.prepare('SELECT id, last_message_at FROM whatsapp_conversations WHERE chat_id = ? OR phone = ?').get(chatId, phone);
  if (!conv) {
    const result = db.prepare('INSERT INTO whatsapp_conversations(phone, chat_id, state, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(phone, chatId, 'AI_ACTIVE');
    return { id: Number(result.lastInsertRowid), previousLastMessageAt: null };
  }
  db.prepare('UPDATE whatsapp_conversations SET chat_id = ?, phone = ? WHERE id = ?').run(chatId, phone, conv.id);
  return { id: conv.id, previousLastMessageAt: conv.last_message_at };
}

function saveInbound(conversationId, messageId, content) {
  db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .run(conversationId, messageId, 'INBOUND', 'CUSTOMER', content);
  db.prepare('UPDATE whatsapp_conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
}

async function markHandoff(conversationId, chatId, text) {
  db.prepare("UPDATE whatsapp_conversations SET state='WAITING_ADMIN', paused_until=NULL, handoff=1, bot_state='HANDOFF', updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(conversationId);
  await waha.sendMessage(chatId, text);
  db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .run(conversationId, `outbound-${crypto.randomUUID()}`, 'OUTBOUND', 'AI', text);
  io.to('admins').emit('whatsapp:conversation-updated', { conversationId, state: 'WAITING_ADMIN' });
}

async function sendStored(conversationId, chatId, text) {
  if (!text) return;
  const min = Math.max(0, Math.min(env.replyDelayMinMs, env.replyDelayMaxMs));
  const max = Math.max(min, env.replyDelayMaxMs);
  const delay = min + Math.floor(Math.random() * (max - min + 1));
  await waha.startTyping(chatId).catch(() => {});
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  try {
    await waha.sendMessage(chatId, text);
  } finally {
    await waha.stopTyping(chatId).catch(() => {});
  }
  db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
    .run(conversationId, `outbound-${crypto.randomUUID()}`, 'OUTBOUND', 'AI', text);
  io.to('admins').emit('whatsapp:message-received', { conversationId, sender: 'AI' });
}

let llmHealthCheckedAt = null;
async function refreshLLMHealth() {
  await llm.health();
  llmHealthCheckedAt = new Date().toISOString();
}
refreshLLMHealth();
setInterval(refreshLLMHealth, env.llmHealthCheckMs).unref();

function auth(req, res, next) { try { req.admin = jwt.verify(req.headers.authorization?.replace('Bearer ', ''), env.jwtSecret); next(); } catch { res.status(401).json({ error: 'UNAUTHORIZED', message: 'Autentikasi admin diperlukan.' }); } }
function validate(schema) { return (req, res, next) => { const result = schema.safeParse(req.body); if (!result.success) return res.status(422).json({ error: 'VALIDATION_ERROR', details: result.error.flatten() }); req.body = result.data; next(); }; }

api.get('/', (_, res) => res.json({ name: 'Sambal Joelid API', status: 'running', version: '1.0.0', health: '/health' }));
api.get('/health', (_, res) => res.json({ ok: true }));
api.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), (req, res) => {
  if (req.body?.email !== env.email || req.body?.password !== env.password) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Email atau kata sandi tidak tepat.' });
  res.json({ token: jwt.sign({ role: 'ADMIN', email: env.email }, env.jwtSecret, { expiresIn: '8h' }) });
});
api.get('/public/menu', async (_, res) => {
  const menus = await catalog.getMenus();
  res.json(menus.filter(menu => menu.active && menu.stock > 0).sort((a, b) => a.name.localeCompare(b.name)));
});
api.get('/public/branches', (_, res) => res.json(rows('SELECT id,name,address,is_open FROM branches WHERE active=1 ORDER BY name')));
api.get('/public/info', (_, res) => {
  const settings = Object.fromEntries(rows('SELECT key, value FROM business_settings').map(row => [row.key, row.value]));
  res.json(settings);
});

// ── Admin: menu, cabang, alias, jam/lokasi, template ─────────────────────────
const settingsInput = z.object({
  opening_hours: z.string().trim().max(300).optional(),
  address: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(40).optional(),
  business_name: z.string().trim().max(120).optional(),
});

const menuCreateInput = z.object({
  id: z.string().trim().max(50).optional(),
  name: z.string().trim().min(2).max(100),
  category: z.string().trim().min(1).max(50).optional().default('Lainnya'),
  price: z.number().int().min(0),
  stock: z.number().int().min(0).optional().default(999),
  active: z.boolean().optional().default(true),
  description: z.string().trim().max(500).optional().default(''),
  aliases: z.array(z.string().trim()).optional().default([]),
});

const menuUpdateInput = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  price: z.number().int().min(0).optional(),
  stock: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  description: z.string().trim().max(500).optional(),
  aliases: z.array(z.string().trim()).optional(),
});

api.get('/admin/menus', auth, async (_, res) => res.json(await catalog.getMenus()));
api.get('/admin/menu-categories', auth, (_, res) => res.json(catalog.getCategories()));

api.post('/admin/menus', auth, validate(menuCreateInput), (req, res) => {
  try {
    const menu = catalog.createMenu(req.body);
    menuMatcher.invalidate();
    res.status(201).json(menu);
  } catch (error) {
    res.status(400).json({ error: 'CREATE_MENU_FAILED', message: error.message });
  }
});

api.put('/admin/menus/:id', auth, validate(menuUpdateInput), (req, res) => {
  try {
    const updated = catalog.updateMenu(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'MENU_NOT_FOUND', message: 'Menu tidak ditemukan' });
    menuMatcher.invalidate();
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: 'UPDATE_MENU_FAILED', message: error.message });
  }
});

api.delete('/admin/menus/:id', auth, (req, res) => {
  try {
    const success = catalog.deleteMenu(req.params.id);
    if (!success) return res.status(404).json({ error: 'MENU_NOT_FOUND', message: 'Menu tidak ditemukan' });
    menuMatcher.invalidate();
    res.json({ ok: true, deleted: true });
  } catch (error) {
    res.status(400).json({ error: 'DELETE_MENU_FAILED', message: error.message });
  }
});

api.get('/admin/menu-sync-status', auth, (_, res) => res.json(catalog.getStatus()));
api.post('/admin/menu-sync', auth, async (_, res) => {
  res.json({ changed: false, status: catalog.getStatus(), message: 'Katalog kini dikelola langsung dari database.' });
});

// ── Admin: cabang ────────────────────────────────────────────────────────────
const branchCreateInput = z.object({
  id: z.string().trim().max(50).optional(),
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().max(300).optional().default(''),
  is_open: z.boolean().optional().default(true),
});

const branchUpdateInput = z.object({
  id: z.string().trim().min(1).max(50).optional(),
  name: z.string().trim().min(2).max(100).optional(),
  address: z.string().trim().max(300).optional(),
  is_open: z.boolean().optional(),
  active: z.boolean().optional(),
});

function sanitizeBranchId(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

api.get('/admin/branches', auth, (_, res) => {
  res.json(rows('SELECT id, name, address, is_open, active FROM branches WHERE active = 1 ORDER BY name'));
});

api.post('/admin/branches', auth, validate(branchCreateInput), (req, res) => {
  try {
    const customIdProvided = Boolean(req.body.id && req.body.id.trim());
    let finalId = customIdProvided ? sanitizeBranchId(req.body.id) : '';
    if (customIdProvided && !finalId) {
      return res.status(400).json({ error: 'INVALID_BRANCH_ID', message: 'ID cabang hanya boleh berisi huruf kecil, angka, atau tanda hubung (-).' });
    }
    if (customIdProvided && db.prepare('SELECT 1 FROM branches WHERE id = ?').get(finalId)) {
      return res.status(400).json({ error: 'BRANCH_ID_EXISTS', message: `ID cabang "${finalId}" sudah digunakan. Silakan pilih ID lain.` });
    }
    if (!finalId) {
      finalId = sanitizeBranchId(req.body.name) || ('cabang-' + Date.now());
      let counter = 1;
      const baseId = finalId;
      while (db.prepare('SELECT 1 FROM branches WHERE id = ?').get(finalId)) {
        finalId = `${baseId}-${counter++}`;
      }
    }
    db.prepare('INSERT INTO branches(id, name, address, active, is_open) VALUES (?, ?, ?, 1, ?)')
      .run(finalId, req.body.name, req.body.address || '', req.body.is_open ? 1 : 0);
    const branch = db.prepare('SELECT id, name, address, is_open, active FROM branches WHERE id = ?').get(finalId);
    res.status(201).json(branch);
  } catch (error) {
    res.status(400).json({ error: 'CREATE_BRANCH_FAILED', message: error.message });
  }
});

api.patch('/admin/branches/:id', auth, validate(branchUpdateInput), (req, res) => {
  const current = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'BRANCH_NOT_FOUND', message: 'Cabang tidak ditemukan' });

  const nextId = req.body.id !== undefined ? sanitizeBranchId(req.body.id) : current.id;
  if (!nextId) {
    return res.status(400).json({ error: 'INVALID_BRANCH_ID', message: 'ID cabang tidak valid.' });
  }
  if (nextId !== current.id && db.prepare('SELECT 1 FROM branches WHERE id = ?').get(nextId)) {
    return res.status(400).json({ error: 'BRANCH_ID_EXISTS', message: `ID cabang "${nextId}" sudah digunakan oleh cabang lain.` });
  }

  const next = {
    id: nextId,
    name: req.body.name ?? current.name,
    address: req.body.address ?? (current.address || ''),
    is_open: req.body.is_open === undefined ? current.is_open : (req.body.is_open ? 1 : 0),
    active: req.body.active === undefined ? current.active : (req.body.active ? 1 : 0),
  };

  try {
    db.transaction(() => {
      if (next.id !== current.id) {
        db.prepare('INSERT INTO branches(id, name, address, active, is_open) VALUES (?, ?, ?, ?, ?)')
          .run(next.id, next.name, next.address, next.active, next.is_open);
        db.prepare('UPDATE customer_orders SET branch_id = ? WHERE branch_id = ?').run(next.id, current.id);
        db.prepare('UPDATE customer_complaints SET branch_id = ? WHERE branch_id = ?').run(next.id, current.id);
        db.prepare('UPDATE whatsapp_cart SET branch_id = ? WHERE branch_id = ?').run(next.id, current.id);
        const drafts = db.prepare('SELECT id, draft_order_json FROM whatsapp_conversations WHERE draft_order_json IS NOT NULL').all();
        const updateDraft = db.prepare('UPDATE whatsapp_conversations SET draft_order_json = ? WHERE id = ?');
        for (const row of drafts) {
          try {
            const parsed = JSON.parse(row.draft_order_json);
            if (parsed && parsed.branchId === current.id) {
              parsed.branchId = next.id;
              updateDraft.run(JSON.stringify(parsed), row.id);
            }
          } catch {
            // abaikan draft JSON yang tidak valid
          }
        }
        db.prepare('DELETE FROM branches WHERE id = ?').run(current.id);
      } else {
        db.prepare('UPDATE branches SET name = ?, address = ?, is_open = ?, active = ? WHERE id = ?')
          .run(next.name, next.address, next.is_open, next.active, current.id);
      }
    })();

    const updated = db.prepare('SELECT id, name, address, is_open, active FROM branches WHERE id = ?').get(next.id);
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: 'UPDATE_BRANCH_FAILED', message: error.message });
  }
});

api.delete('/admin/branches/:id', auth, (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch) return res.status(404).json({ error: 'BRANCH_NOT_FOUND', message: 'Cabang tidak ditemukan' });

  const hasOrders = db.prepare('SELECT 1 FROM customer_orders WHERE branch_id = ?').get(req.params.id);
  const hasComplaints = db.prepare('SELECT 1 FROM customer_complaints WHERE branch_id = ?').get(req.params.id);

  if (hasOrders || hasComplaints) {
    db.prepare('UPDATE branches SET active = 0 WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, archived: true, message: 'Cabang dinonaktifkan/diarsipkan karena memiliki riwayat data.' });
  }

  db.prepare('DELETE FROM branches WHERE id = ?').run(req.params.id);
  res.json({ ok: true, deleted: true });
});


api.get('/admin/settings', auth, (_, res) => {
  res.json(Object.fromEntries(rows('SELECT key, value FROM business_settings').map(row => [row.key, row.value])));
});

api.put('/admin/settings', auth, validate(settingsInput), (req, res) => {
  const save = db.prepare('INSERT INTO business_settings(key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP');
  db.transaction(() => {
    for (const [key, value] of Object.entries(req.body)) save.run(key, value);
  })();
  res.json(Object.fromEntries(rows('SELECT key, value FROM business_settings').map(row => [row.key, row.value])));
});

api.get('/admin/templates', auth, (_, res) => {
  res.json(Object.fromEntries(rows('SELECT key, content FROM message_templates').map(row => [row.key, row.content])));
});

api.put('/admin/templates/:key', auth, validate(z.object({ content: z.string().trim().min(1).max(2000) })), (req, res) => {
  const key = String(req.params.key);
  if (!/^[a-z0-9_]{2,40}$/.test(key)) return res.status(422).json({ error: 'INVALID_TEMPLATE_KEY' });
  db.prepare('INSERT INTO message_templates(key, content, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET content=excluded.content, updated_at=CURRENT_TIMESTAMP')
    .run(key, req.body.content);
  res.json({ key, content: req.body.content });
});

// ── Admin: pesan gagal dipahami ──────────────────────────────────────────────
api.get('/admin/failed-messages', auth, (req, res) => {
  res.json(messageLogger.listFailed({ limit: req.query.limit, offset: req.query.offset, resolved: req.query.resolved === '1' ? 1 : 0 }));
});

api.patch('/admin/failed-messages/:id/resolve', auth, (req, res) => {
  if (!messageLogger.resolve(req.params.id)) return res.sendStatus(404);
  res.sendStatus(204);
});

api.delete('/admin/failed-messages/:id', auth, (req, res) => {
  if (!messageLogger.remove(req.params.id)) return res.sendStatus(404);
  res.sendStatus(204);
});

const learningInput = z.object({
  intent: z.enum(['pesan', 'keluhan', 'tanya_menu', 'tanya_jam', 'tanya_lokasi', 'bicara_admin', 'batal', 'lainnya']),
  items: z.array(z.object({ menuId: z.string().min(1), qty: z.number().int().min(1).max(99) })).max(10).default([]),
});

api.post('/admin/failed-messages/:id/learn', auth, validate(learningInput), (req, res) => {
  const failed = messageLogger.getFailed(req.params.id);
  if (!failed) return res.sendStatus(404);
  const items = req.body.items.map(item => {
    const menu = db.prepare('SELECT id, name FROM menus WHERE id = ?').get(item.menuId);
    if (!menu) return null;
    return { menuId: menu.id, menu: menu.name, qty: item.qty };
  }).filter(Boolean);
  if (req.body.intent === 'pesan' && !items.length) {
    return res.status(400).json({ error: 'Pilih minimal satu menu untuk intent pesanan.' });
  }
  db.prepare(`INSERT INTO learned_examples(phrase_raw, phrase_norm, intent, items_json, active, updated_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(phrase_norm) DO UPDATE SET phrase_raw=excluded.phrase_raw, intent=excluded.intent,
      items_json=excluded.items_json, active=1, updated_at=CURRENT_TIMESTAMP`)
    .run(failed.raw, failed.norm || normalize(failed.raw), req.body.intent, JSON.stringify(items));
  messageLogger.resolve(failed.id);
  res.json({ learned: true, phrase: failed.raw, intent: req.body.intent, items });
});

api.get('/admin/learned-examples', auth, (_req, res) => {
  const examples = db.prepare('SELECT * FROM learned_examples ORDER BY updated_at DESC LIMIT 200').all()
    .map(row => ({ ...row, active: Boolean(row.active), items: JSON.parse(row.items_json || '[]') }));
  res.json(examples);
});


api.post('/admin/failed-messages/:id/testset', auth, (req, res) => {
  const failed = messageLogger.getFailed(req.params.id);
  if (!failed) return res.sendStatus(404);
  const directory = path.dirname(env.testSetPath);
  fs.mkdirSync(directory, { recursive: true });

  const intent = typeof req.body?.intent === 'string' ? req.body.intent : '';
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  fs.appendFileSync(env.testSetPath, `${JSON.stringify({ pesan: failed.raw, intent, items })}\n`, 'utf8');
  messageLogger.resolve(failed.id);
  res.json({ appended: true, path: env.testSetPath, intent, items });
});
api.post('/public/orders', publicLimiter, validate(orderInput), (req, res) => {
  const create = db.transaction((input) => {
    const branch = db.prepare('SELECT id, name, is_open FROM branches WHERE id=? AND active=1').get(input.branchId);
    if (!branch) throw new Error('BRANCH_NOT_FOUND');
    if (!branch.is_open) {
      const err = new Error('BRANCH_CLOSED');
      err.branchName = branch.name;
      throw err;
    }
    const unique = [...new Map(input.items.map(i => [i.menuId, i])).values()];
    const menus = unique.map(i => ({ ...i, menu: db.prepare('SELECT id,name,price,stock FROM menus WHERE id=? AND active=1 AND stock>0').get(i.menuId) }));
    if (menus.some(i => !i.menu)) throw new Error('MENU_NOT_FOUND');
    if (menus.some(i => i.quantity > i.menu.stock)) throw new Error('INSUFFICIENT_STOCK');
    const total = menus.reduce((sum, i) => sum + i.menu.price * i.quantity, 0); const reference = ref('ORD');
    const result = db.prepare('INSERT INTO customer_orders(reference_number,customer_name,customer_phone,branch_id,notes,total_amount,status) VALUES (?,?,?,?,?,?,?)').run(reference, input.customerName, input.customerPhone, input.branchId, input.notes || null, total, 'NEW');
    const add = db.prepare('INSERT INTO customer_order_items(order_id,menu_id,menu_name_snapshot,unit_price_snapshot,quantity,subtotal) VALUES (?,?,?,?,?,?)');
    menus.forEach(i => add.run(result.lastInsertRowid, i.menu.id, i.menu.name, i.menu.price, i.quantity, i.menu.price * i.quantity));
    return { id: result.lastInsertRowid, referenceNumber: reference, totalAmount: total };
  });
  try {
    const order = create(req.body);
    io.to('admins').emit('order:new', order);
    res.status(201).json(order);
  } catch (e) {
    const message = e.message === 'BRANCH_CLOSED' ? `Cabang ${e.branchName || ''} saat ini sedang tutup. Silakan pilih cabang lain yang buka.` : 'Pesanan tidak dapat diproses.';
    res.status(422).json({ error: e.message, message });
  }
});
api.post('/public/complaints', publicLimiter, validate(complaintInput), (req, res) => {
  try { if (req.body.branchId && !db.prepare('SELECT 1 FROM branches WHERE id=? AND active=1').get(req.body.branchId)) throw new Error('BRANCH_NOT_FOUND'); const reference = ref('CMP'); const result = db.prepare('INSERT INTO customer_complaints(reference_number,customer_name,customer_phone,branch_id,category,description,status) VALUES (?,?,?,?,?,?,?)').run(reference, req.body.customerName, req.body.customerPhone, req.body.branchId || null, req.body.category || null, req.body.description, 'NEW'); const complaint = { id: result.lastInsertRowid, referenceNumber: reference }; io.to('admins').emit('complaint:new', complaint); res.status(201).json(complaint); } catch (e) { res.status(422).json({ error: e.message, message: 'Keluhan tidak dapat diproses.' }); }
});
function listRoute(table) { return (req, res) => { const { q = '', status = '', branchId = '', page = '1' } = req.query; const offset = (Math.max(1, Number(page)) - 1) * 20; const where = [`(reference_number LIKE @q OR customer_name LIKE @q)`]; const params = { q: `%${q}%`, limit: 20, offset }; if (status) { where.push('status=@status'); params.status = status; } if (branchId) { where.push('branch_id=@branchId'); params.branchId = branchId; } const clause = where.join(' AND '); const data = rows(`SELECT t.*, b.name AS branch_name FROM ${table} t LEFT JOIN branches b ON b.id=t.branch_id WHERE ${clause} ORDER BY t.created_at DESC LIMIT @limit OFFSET @offset`, params); const total = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${clause}`).get(params).count; res.json({ data, total, page: Number(page) }); }; }
api.get('/admin/orders', auth, listRoute('customer_orders'));
api.get('/admin/orders/:id', auth, (req,res) => { const order = db.prepare("SELECT o.*, COALESCE(o.whatsapp_conversation_id, c.id) AS conversation_id FROM customer_orders o LEFT JOIN whatsapp_conversations c ON o.source='WHATSAPP' AND c.phone=o.customer_phone WHERE o.id=?").get(req.params.id); if (!order) return res.sendStatus(404); order.items = rows('SELECT * FROM customer_order_items WHERE order_id=?', order.id); res.json(order); });
api.patch('/admin/orders/:id/status', auth, validate(z.object({ status: z.enum(['NEW','CONFIRMED','PROCESSING','COMPLETED','CANCELLED']) })), (req,res) => updateStatus('customer_orders', orderTransitions, 'order:updated', req,res));
api.get('/admin/complaints', auth, listRoute('customer_complaints'));
api.get('/admin/complaints/:id', auth, (req,res) => { const item = db.prepare("SELECT x.*, COALESCE(x.whatsapp_conversation_id, c.id) AS conversation_id FROM customer_complaints x LEFT JOIN whatsapp_conversations c ON x.source='WHATSAPP' AND c.phone=x.customer_phone WHERE x.id=?").get(req.params.id); item ? res.json(item) : res.sendStatus(404); });
api.patch('/admin/complaints/:id/status', auth, validate(z.object({ status: z.enum(['NEW','IN_REVIEW','IN_PROGRESS','RESOLVED','CLOSED']) })), (req,res) => updateStatus('customer_complaints', complaintTransitions, 'complaint:updated', req,res));
api.patch('/admin/complaints/:id/notes', auth, validate(z.object({ adminNotes: z.string().trim().max(2000).nullable() })), (req,res) => { const result = db.prepare("UPDATE customer_complaints SET admin_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.body.adminNotes, req.params.id); if (!result.changes) return res.sendStatus(404); io.to('admins').emit('complaint:updated', { id: Number(req.params.id) }); res.sendStatus(204); });
function updateStatus(table, _transitions, event, req, res) { const item = db.prepare(`SELECT id,status FROM ${table} WHERE id=?`).get(req.params.id); if (!item) return res.sendStatus(404); db.prepare(`UPDATE ${table} SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.body.status, item.id); io.to('admins').emit(event, { id: item.id, status: req.body.status }); res.sendStatus(204); }

// WhatsApp Webhook
const messagePipeline = new IncomingPipeline({
  db,
  delayMs: env.whatsappDebounceMs,
  processBatch: async ({ phone, chatId, raw: incomingRaw, messageIds }) => {
    const raw = String(incomingRaw ?? '').toLowerCase();
    const { id: conversationId, previousLastMessageAt } = upsertConversation(phone, chatId);
    saveInbound(conversationId, messageIds[0], raw);
    const startedAt = Date.now();
    const norm = normalize(raw);

    if (isRateLimited(phone)) {
      console.warn(`[WAHA] Rate limit tercapai untuk nomor berakhiran ${phone.slice(-4)}`);
      await sendStored(conversationId, chatId, templates.render('rate_limit')).catch(() => {});
      return;
    }

    let result = null;
    try {
      result = await bot.handle({ conversationId, phone, raw, norm, previousLastMessageAt });
    } catch (error) {
      console.error('[Bot] Kesalahan tak terduga:', error.message);
      stateStore.setHandoff(conversationId);
      await sendStored(conversationId, chatId, templates.render('timeout')).catch(() => {});
      messageLogger.fail({ conversationId, phone, raw, norm, reason: 'ERROR', layer: 'error' });
      return;
    }
    messageLogger.log({
      conversationId,
      phone,
      raw,
      norm,
      layer: result?.layer ?? 'fallback',
      intent: result?.intent ?? null,
      result: result ? (result.handoff ? 'handoff' : 'reply') : 'skip',
      processMs: Date.now() - startedAt,
    });
    if (result && (result.layer === 'fallback' || result.handoff)) {
      messageLogger.fail({
        conversationId,
        phone,
        raw,
        norm,
        reason: result.handoff ? 'handoff' : 'tidak_paham',
        layer: result.layer,
      });
    }
    if (result?.reply) await sendStored(conversationId, chatId, result.reply);
  },
  onUnsupported: async ({ phone, chatId, messageId, raw }) => {
    const conversationId = upsertConversation(phone, chatId);
    const content = raw || '[media]';
    saveInbound(conversationId, messageId, content);
    messageLogger.log({ conversationId, phone, raw: content, norm: normalize(raw), layer: 'fallback', result: 'handoff' });
    messageLogger.fail({ conversationId, phone, raw: content, norm: normalize(raw), reason: 'media', layer: 'fallback' });
    await markHandoff(conversationId, chatId, templates.render('media'));
  },
});

api.post('/integrations/waha/webhook', (req, res) => {
  try {
    // Verifikasi signature
    const signature = req.headers['x-webhook-hmac'];
    if (req.headers['x-webhook-hmac-algorithm'] !== 'sha512' || !verifyWebhookSignature(req.rawBody, signature, env.wahaWebhookSecret)) {
      return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    }

    const wahaMessage = req.body;
    lastWebhookAt = new Date().toISOString();

    // Filter, idempotensi, debounce, dan antrian ditangani pipeline.
    messagePipeline.ingest(wahaMessage, env.wahaSession);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Webhook Error]', error);
    res.status(500).json({ error: 'WEBHOOK_PROCESSING_ERROR' });
  }
});

api.get('/admin/integrations/health', auth, async (_req, res) => {
  const latestInbound = db.prepare("SELECT MAX(created_at) AS value FROM whatsapp_messages WHERE direction='INBOUND'").get().value;
  const webhookSeenAt = lastWebhookAt || latestInbound;
  const llmStatus = llm.healthy === true ? 'ONLINE' : llm.healthy === false ? 'OFFLINE' : 'UNKNOWN';
  const base = {
    webhook: webhookSeenAt ? 'RECEIVING' : 'UNKNOWN',
    lastWebhookAt: webhookSeenAt,
    llm: llmStatus,
    llmCheckedAt: llmHealthCheckedAt,
    degraded: llm.healthy === false,
  };
  try {
    const sessions = await Promise.race([
      waha.checkHealth(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('WAHA_TIMEOUT')), 4000)),
    ]);
    res.json({ ...base, waha: 'ONLINE', sessions: Array.isArray(sessions) ? sessions.length : undefined });
  } catch (error) {
    res.status(503).json({ ...base, waha: 'OFFLINE', message: 'Integrasi WhatsApp sedang bermasalah. Periksa WAHA dan konfigurasi webhook.' });
  }
});

api.post('/admin/integrations/llm-check', auth, async (_req, res) => {
  await refreshLLMHealth();
  res.json({ llm: llm.healthy ? 'ONLINE' : 'OFFLINE', checkedAt: llmHealthCheckedAt });
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
    const conv = db.prepare('SELECT phone, chat_id FROM whatsapp_conversations WHERE id = ?').get(req.params.id);
    if (!conv) return res.sendStatus(404);

    // Kirim ke WAHA
    await waha.sendMessage(conv.chat_id || conv.phone, content);

    // Simpan message sebagai ADMIN
    db.prepare('INSERT INTO whatsapp_messages(conversation_id, waha_message_id, direction, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(req.params.id, `admin-${crypto.randomUUID()}`, 'OUTBOUND', 'ADMIN', content);
    const pausedUntil = pauseUntil();
    db.prepare("UPDATE whatsapp_conversations SET state='ADMIN_ACTIVE', paused_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(pausedUntil, req.params.id);

    io.to('admins').emit('whatsapp:message-received', { conversationId: req.params.id, sender: 'ADMIN' });
    io.to('admins').emit('whatsapp:conversation-updated', { conversationId: req.params.id, state: 'ADMIN_ACTIVE', pausedUntil });
    res.status(201).json({ ok: true, state: 'ADMIN_ACTIVE', pausedUntil });
  } catch (error) {
    console.error('[Admin Message Error]', error);
    res.status(500).json({ error: 'MESSAGE_SEND_FAILED' });
  }
});

api.patch('/admin/whatsapp/conversations/:id/state', auth, validate(z.object({ state: z.enum(['AI_ACTIVE', 'WAITING_ADMIN', 'ADMIN_ACTIVE']) })), (req, res) => {
  const { state } = req.body;
  const pausedUntil = state === 'AI_ACTIVE' ? null : pauseUntil();
  let result;
  if (state === 'AI_ACTIVE') {
    result = db.prepare("UPDATE whatsapp_conversations SET state=?, paused_until=NULL, bot_state='IDLE', draft_order_json=NULL, fail_count=0, handoff=0, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(state, req.params.id);
  } else {
    result = db.prepare('UPDATE whatsapp_conversations SET state=?, paused_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(state, pausedUntil, req.params.id);
  }
  if (!result.changes) return res.sendStatus(404);

  io.to('admins').emit('whatsapp:conversation-updated', { conversationId: req.params.id, state });
  res.sendStatus(204);
});
io.use((socket,next) => { try { socket.admin = jwt.verify(socket.handshake.auth?.token, env.jwtSecret); next(); } catch { next(new Error('unauthorized')); } }); io.on('connection', socket => socket.join('admins'));
server.listen(env.port, () => console.log(`Sambal Joelid API listening on :${env.port}`));

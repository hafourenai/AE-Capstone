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

const env = {
  port: Number(process.env.PORT || 3001), dbPath: process.env.CUSTOMER_MODULE_DB_PATH || './data/customer-module.sqlite',
  jwtSecret: process.env.JWT_SECRET || 'development-only-change-me', email: process.env.ADMIN_EMAIL || 'admin@sambaljoelid.local',
  password: process.env.ADMIN_PASSWORD || 'change-this-before-production', origins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')
};
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'development-only-change-me')) {
  throw new Error('JWT_SECRET wajib diatur dengan nilai acak yang kuat pada production.');
}
const db = openDatabase(env.dbPath); const app = express(); const server = http.createServer(app);
const io = new Server(server, { cors: { origin: env.origins, methods: ['GET', 'POST'] } });
app.set('trust proxy', 1);
app.use(helmet()); app.use(cors({ origin: env.origins })); app.use(express.json({ limit: '32kb' }));
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const api = express.Router(); app.use('/api/v1', api);
const phone = z.string().trim().regex(/^\+?[0-9]{8,16}$/, 'Nomor WhatsApp tidak valid');
const orderInput = z.object({ customerName: z.string().trim().min(2).max(100), customerPhone: phone, branchId: z.string().min(1), notes: z.string().trim().max(500).optional(), items: z.array(z.object({ menuId: z.string().min(1), quantity: z.number().int().min(1).max(99) })).min(1).max(20) });
const complaintInput = z.object({ customerName: z.string().trim().min(2).max(100), customerPhone: phone, branchId: z.string().optional(), category: z.enum(['KUALITAS_MAKANAN','PELAYANAN','KEBERSIHAN','PESANAN','LAINNYA']).optional(), description: z.string().trim().min(10).max(2000) });
const ref = (prefix) => `${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
const rows = (sql, ...p) => db.prepare(sql).all(...p);
function auth(req, res, next) { try { req.admin = jwt.verify(req.headers.authorization?.replace('Bearer ', ''), env.jwtSecret); next(); } catch { res.status(401).json({ error: 'UNAUTHORIZED', message: 'Autentikasi admin diperlukan.' }); } }
function validate(schema) { return (req, res, next) => { const result = schema.safeParse(req.body); if (!result.success) return res.status(422).json({ error: 'VALIDATION_ERROR', details: result.error.flatten() }); req.body = result.data; next(); }; }

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
io.use((socket,next) => { try { socket.admin = jwt.verify(socket.handshake.auth?.token, env.jwtSecret); next(); } catch { next(new Error('unauthorized')); } }); io.on('connection', socket => socket.join('admins'));
server.listen(env.port, () => console.log(`Sambal Joelid API listening on :${env.port}`));

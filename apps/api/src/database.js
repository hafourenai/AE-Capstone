import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './normalize.js';

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS menus (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS customer_orders (
      id INTEGER PRIMARY KEY, reference_number TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branches(id), notes TEXT, total_amount INTEGER NOT NULL CHECK(total_amount >= 0),
      status TEXT NOT NULL CHECK(status IN ('NEW','CONFIRMED','PROCESSING','COMPLETED','CANCELLED')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE, menu_id TEXT,
      menu_name_snapshot TEXT NOT NULL, unit_price_snapshot INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
      subtotal INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_complaints (
      id INTEGER PRIMARY KEY, reference_number TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
      branch_id TEXT REFERENCES branches(id), category TEXT, description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('NEW','IN_REVIEW','IN_PROGRESS','RESOLVED','CLOSED')),
      admin_notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON customer_orders(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_branch ON customer_orders(branch_id);
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON customer_orders(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_complaints_status_created ON customer_complaints(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_complaints_branch ON customer_complaints(branch_id);
  `);

  // Migrasi additive: tambah kolom source jika belum ada
  const orderColumns = db.prepare("PRAGMA table_info(customer_orders)").all();
  if (!orderColumns.some(col => col.name === 'source')) {
    db.exec("ALTER TABLE customer_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'WEB' CHECK(source IN ('WEB','WHATSAPP'))");
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_source ON customer_orders(source)");
  }

  const complaintColumns = db.prepare("PRAGMA table_info(customer_complaints)").all();
  if (!complaintColumns.some(col => col.name === 'source')) {
    db.exec("ALTER TABLE customer_complaints ADD COLUMN source TEXT NOT NULL DEFAULT 'WEB' CHECK(source IN ('WEB','WHATSAPP'))");
    db.exec("CREATE INDEX IF NOT EXISTS idx_complaints_source ON customer_complaints(source)");
  }
  if (!orderColumns.some(col => col.name === 'whatsapp_conversation_id')) {
    db.exec('ALTER TABLE customer_orders ADD COLUMN whatsapp_conversation_id INTEGER REFERENCES whatsapp_conversations(id)');
  }
  if (!complaintColumns.some(col => col.name === 'whatsapp_conversation_id')) {
    db.exec('ALTER TABLE customer_complaints ADD COLUMN whatsapp_conversation_id INTEGER REFERENCES whatsapp_conversations(id)');
  }

  // Tabel WhatsApp
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, chat_id TEXT, customer_name TEXT,
      state TEXT NOT NULL DEFAULT 'AI_ACTIVE' CHECK(state IN ('AI_ACTIVE','WAITING_ADMIN','ADMIN_ACTIVE')),
      last_message_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
      waha_message_id TEXT UNIQUE, direction TEXT NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')),
      sender_type TEXT NOT NULL CHECK(sender_type IN ('CUSTOMER','AI','ADMIN')), content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_pending_actions (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL CHECK(action_type IN ('ORDER_CONFIRMATION','COMPLAINT_CONFIRMATION')),
      payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wa_processed_messages (
      message_id TEXT PRIMARY KEY,
      phone TEXT,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wa_message_logs (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      phone TEXT,
      raw TEXT,
      norm TEXT,
      layer TEXT,
      intent TEXT,
      result TEXT,
      process_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS failed_messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      phone TEXT,
      raw TEXT,
      norm TEXT,
      reason TEXT,
      layer TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wa_logs_created ON wa_message_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_failed_resolved ON failed_messages(resolved, created_at);
    CREATE INDEX IF NOT EXISTS idx_wa_msg_id ON whatsapp_messages(waha_message_id);
    CREATE INDEX IF NOT EXISTS idx_wa_conv_phone ON whatsapp_conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_wa_pending_status ON whatsapp_pending_actions(status);
    CREATE INDEX IF NOT EXISTS idx_wa_processed_received ON wa_processed_messages(received_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_pending_idempotency
      ON whatsapp_pending_actions(conversation_id, action_type, status)
      WHERE status = 'PENDING';
  `);

  const conversationColumns = db.prepare("PRAGMA table_info(whatsapp_conversations)").all();
  if (!conversationColumns.some(col => col.name === 'chat_id')) {
    db.exec('ALTER TABLE whatsapp_conversations ADD COLUMN chat_id TEXT');
  }
  if (!conversationColumns.some(col => col.name === 'paused_until')) {
    db.exec('ALTER TABLE whatsapp_conversations ADD COLUMN paused_until TEXT');
  }
  const menuColumns = db.prepare("PRAGMA table_info(menus)").all();
  if (!menuColumns.some(col => col.name === 'stock')) db.exec('ALTER TABLE menus ADD COLUMN stock INTEGER NOT NULL DEFAULT 999');
  if (!menuColumns.some(col => col.name === 'description')) db.exec("ALTER TABLE menus ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!menuColumns.some(col => col.name === 'aliases')) db.exec("ALTER TABLE menus ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'");

  // ── Katalog & pengaturan yang editable dari dashboard ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_aliases (
      id INTEGER PRIMARY KEY,
      menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
      alias_norm TEXT NOT NULL,
      alias_raw TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(menu_id, alias_norm)
    );
    CREATE INDEX IF NOT EXISTS idx_menu_alias_norm ON menu_aliases(alias_norm);
    CREATE INDEX IF NOT EXISTS idx_menu_alias_menu ON menu_aliases(menu_id);

    CREATE TABLE IF NOT EXISTS business_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_templates (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrasi alias lama (JSON) ke tabel acuan yang sudah dinormalisasi — sekali saja.
  const aliasMigrationDone = db.prepare("SELECT value FROM business_settings WHERE key = 'aliases_migrated_v1'").get();
  if (!aliasMigrationDone) {
    const legacyAliasRows = db.prepare("SELECT id, aliases FROM menus WHERE aliases IS NOT NULL AND aliases != '' AND aliases != '[]'").all();
    const insertAlias = db.prepare('INSERT OR IGNORE INTO menu_aliases(menu_id, alias_norm, alias_raw) VALUES (?, ?, ?)');
    const migrateAliases = db.transaction((items) => {
      for (const row of items) {
        let aliases = [];
        try { aliases = JSON.parse(row.aliases); } catch { aliases = []; }
        for (const alias of aliases) {
          const raw = String(alias ?? '').trim();
          const norm = normalize(raw);
          if (raw && norm) insertAlias.run(row.id, norm, raw);
        }
      }
      db.prepare("INSERT OR REPLACE INTO business_settings(key, value, updated_at) VALUES ('aliases_migrated_v1', '1', CURRENT_TIMESTAMP)").run();
    });
    migrateAliases(legacyAliasRows);
  }

  const seedSetting = db.prepare('INSERT OR IGNORE INTO business_settings(key, value) VALUES (?, ?)');
  [['opening_hours', ''], ['address', ''], ['phone', ''], ['business_name', 'Sambal Joelid']].forEach(([key, value]) => seedSetting.run(key, value));

  // ── State bot dipisah dari kolom `state` lama (lihat DECISIONS.md D3) ──
  const conversationColumnsAfter = db.prepare('PRAGMA table_info(whatsapp_conversations)').all();
  if (!conversationColumnsAfter.some(col => col.name === 'bot_state')) {
    db.exec("ALTER TABLE whatsapp_conversations ADD COLUMN bot_state TEXT NOT NULL DEFAULT 'IDLE'");
  }
  if (!conversationColumnsAfter.some(col => col.name === 'draft_order_json')) {
    db.exec('ALTER TABLE whatsapp_conversations ADD COLUMN draft_order_json TEXT');
  }
  if (!conversationColumnsAfter.some(col => col.name === 'fail_count')) {
    db.exec('ALTER TABLE whatsapp_conversations ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!conversationColumnsAfter.some(col => col.name === 'handoff')) {
    db.exec('ALTER TABLE whatsapp_conversations ADD COLUMN handoff INTEGER NOT NULL DEFAULT 0');
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conv_chat_id ON whatsapp_conversations(chat_id)');

  // Cart untuk percakapan interaktif order
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_cart (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL UNIQUE REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
      customer_name TEXT,
      branch_id TEXT,
      items_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      step TEXT NOT NULL DEFAULT 'COLLECTING' CHECK(step IN ('COLLECTING','CONFIRMING','DONE')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wa_cart_conv ON whatsapp_cart(conversation_id);
  `);

  const count = db.prepare('SELECT COUNT(*) AS count FROM menus').get().count;
  if (!count) {
    db.prepare('INSERT INTO branches (id,name) VALUES (?,?)').run('pusat', 'Cabang Pusat');
    db.prepare('INSERT INTO branches (id,name) VALUES (?,?)').run('barat', 'Cabang Barat');
    const add = db.prepare('INSERT INTO menus (id,name,price) VALUES (?,?,?)');
    [['ayam-geprek','Ayam Geprek',18000],['lele-goreng','Lele Goreng',16000],['es-teh','Es Teh Manis',5000]].forEach((x) => add.run(...x));
  }
  return db;
}

export const orderTransitions = { NEW: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['PROCESSING', 'CANCELLED'], PROCESSING: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
export const complaintTransitions = { NEW: ['IN_REVIEW'], IN_REVIEW: ['IN_PROGRESS', 'CLOSED'], IN_PROGRESS: ['RESOLVED', 'CLOSED'], RESOLVED: ['CLOSED'], CLOSED: [] };

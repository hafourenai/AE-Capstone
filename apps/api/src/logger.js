// Log pesan dan pesan gagal untuk evaluasi serta tindak lanjut admin.

export class MessageLogger {
  constructor(db) {
    this.db = db;
  }

  log({ conversationId = null, phone = null, raw = '', norm = '', layer = null, intent = null, result = null, processMs = null }) {
    this.db.prepare(`INSERT INTO wa_message_logs(conversation_id, phone, raw, norm, layer, intent, result, process_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, phone, raw, norm, layer, intent, result, processMs);
  }

  fail({ conversationId = null, phone = null, raw = '', norm = '', reason = 'tidak_paham', layer = null }) {
    const result = this.db.prepare(`INSERT INTO failed_messages(conversation_id, phone, raw, norm, reason, layer)
      VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, phone, raw, norm, reason, layer);
    return Number(result.lastInsertRowid);
  }

  listFailed({ limit = 50, offset = 0, resolved = 0 } = {}) {
    return this.db.prepare(`SELECT * FROM failed_messages WHERE resolved = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(resolved ? 1 : 0, Math.min(Number(limit) || 50, 200), Math.max(0, Number(offset) || 0));
  }

  resolve(id) {
    return this.db.prepare('UPDATE failed_messages SET resolved = 1 WHERE id = ?').run(id).changes > 0;
  }

  remove(id) {
    return this.db.prepare('DELETE FROM failed_messages WHERE id = ?').run(id).changes > 0;
  }

  getFailed(id) {
    return this.db.prepare('SELECT * FROM failed_messages WHERE id = ?').get(id);
  }
}

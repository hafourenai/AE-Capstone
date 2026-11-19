// State percakapan per nomor, disimpan di DB agar aman saat restart.

export const BOT_STATES = ['IDLE', 'PILIH_MENU', 'KONFIRMASI', 'ALAMAT_ATAU_AMBIL', 'SELESAI', 'HANDOFF'];
export const STALE_MINUTES = 30;

export function emptyDraft() {
  return {
    items: [],
    customerName: '',
    branchId: '',
    notes: '',
    pendingMenuId: null,
    options: [],
    kind: 'order',
    description: '',
  };
}

function safeParse(value) {
  if (!value) return emptyDraft();
  try {
    const parsed = JSON.parse(value);
    return { ...emptyDraft(), ...parsed, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return emptyDraft();
  }
}

function parseSqliteDate(value) {
  if (!value) return null;
  const date = new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isStale(updatedAt, now = Date.now(), minutes = STALE_MINUTES) {
  const date = parseSqliteDate(updatedAt);
  if (!date) return false;
  return now - date.getTime() > minutes * 60_000;
}

export function addDraftItem(draft, { menuId, qty }) {
  const quantity = Math.max(1, Math.min(50, Number(qty) || 1));
  const existing = draft.items.find((item) => item.menuId === menuId);
  if (existing) existing.qty = quantity;
  else draft.items.push({ menuId, qty: quantity });
  return draft;
}

export function removeDraftItem(draft, menuId) {
  draft.items = draft.items.filter((item) => item.menuId !== menuId);
  return draft;
}

export function clearDraft(draft) {
  Object.assign(draft, emptyDraft());
  return draft;
}

export class StateStore {
  constructor(db) {
    this.db = db;
  }

  get(conversationId) {
    const row = this.db.prepare(
      'SELECT id, bot_state, draft_order_json, fail_count, handoff, updated_at FROM whatsapp_conversations WHERE id = ?',
    ).get(conversationId);
    if (!row) return null;

    let botState = BOT_STATES.includes(row.bot_state) ? row.bot_state : 'IDLE';
    let draft = safeParse(row.draft_order_json);
    let failCount = Number(row.fail_count) || 0;
    let handoff = Boolean(row.handoff);

    if (botState !== 'IDLE' && isStale(row.updated_at)) {
      botState = 'IDLE';
      draft = emptyDraft();
      failCount = 0;
      handoff = false;
      this.save(conversationId, { botState, draft, failCount, handoff });
    }

    return { conversationId, botState, draft, failCount, handoff, updatedAt: row.updated_at };
  }

  save(conversationId, { botState = 'IDLE', draft = emptyDraft(), failCount = 0, handoff = false } = {}) {
    const current = this.db.prepare('SELECT state FROM whatsapp_conversations WHERE id = ?').get(conversationId);
    const legacyState = current?.state === 'ADMIN_ACTIVE'
      ? 'ADMIN_ACTIVE'
      : (handoff || botState === 'HANDOFF' ? 'WAITING_ADMIN' : 'AI_ACTIVE');
    const pausedUntil = legacyState === 'WAITING_ADMIN' ? null : null;

    this.db.prepare(`UPDATE whatsapp_conversations
      SET bot_state=?, draft_order_json=?, fail_count=?, handoff=?, state=?, paused_until=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(
      botState,
      draft ? JSON.stringify(draft) : null,
      Math.max(0, Number(failCount) || 0),
      handoff ? 1 : 0,
      legacyState,
      pausedUntil,
      conversationId,
    );
    return { conversationId, botState, draft, failCount, handoff };
  }

  reset(conversationId) {
    return this.save(conversationId, { botState: 'IDLE', draft: emptyDraft(), failCount: 0, handoff: false });
  }

  setHandoff(conversationId, draft = null) {
    const session = this.get(conversationId);
    return this.save(conversationId, {
      botState: 'HANDOFF',
      draft: draft ?? session?.draft ?? emptyDraft(),
      failCount: session?.failCount ?? 0,
      handoff: true,
    });
  }

  incrementFail(conversationId, session) {
    const failCount = (session?.failCount ?? 0) + 1;
    this.save(conversationId, {
      botState: session?.botState ?? 'IDLE',
      draft: session?.draft ?? emptyDraft(),
      failCount,
      handoff: false,
    });
    return failCount;
  }
}

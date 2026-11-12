import crypto from 'node:crypto';

export class OrderComplaintBridge {
  constructor(db, waha, io) {
    this.db = db;
    this.waha = waha;
    this.io = io;
  }

  /**
   * Generate reference code (misal: ORD-20261109-XXXX)
   */
  generateRef(prefix) {
    return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  }

  /**
   * Format ringkasan order untuk konfirmasi
   */
  formatOrderSummary(branchName, items, menus, totalAmount) {
    const itemLines = items
      .map(item => {
        const menu = menus.find(m => m.id === item.menuId);
        const subtotal = menu.price * item.quantity;
        return `• ${item.quantity}x ${menu.name} (Rp ${subtotal.toLocaleString('id-ID')})`;
      })
      .join('\n');

    return `📋 *Ringkasan Pesanan Anda*\n\n${itemLines}\n\nCabang: ${branchName}\n*Total: Rp ${totalAmount.toLocaleString('id-ID')}*\n\nBalas dengan *YA* untuk konfirmasi atau *BATAL* untuk membatalkan.`;
  }

  /**
   * Validasi dan hitung ulang order dari master data
   */
  validateAndCalculateOrder(branchId, items) {
    // Validasi branch
    const branch = this.db.prepare('SELECT id, name FROM branches WHERE id = ? AND active = 1').get(branchId);
    if (!branch) {
      throw new Error('BRANCH_NOT_FOUND');
    }

    // Deduplikasi items by menuId
    const deduped = [...new Map(items.map(i => [i.menuId, i])).values()];

    // Validasi dan ambil harga dari master
    const enrichedItems = deduped.map(item => {
      const menu = this.db.prepare('SELECT id, name, price, stock FROM menus WHERE id = ? AND active = 1 AND stock > 0').get(item.menuId);
      if (!menu) throw new Error(`MENU_NOT_FOUND: ${item.menuId}`);
      if (item.quantity < 1 || item.quantity > 99) throw new Error('INVALID_QUANTITY');
      if (item.quantity > menu.stock) throw new Error(`INSUFFICIENT_STOCK: ${item.menuId}`);
      return { ...item, menu };
    });

    // Hitung total dari backend (bukan dari AI/customer)
    const totalAmount = enrichedItems.reduce((sum, item) => sum + item.menu.price * item.quantity, 0);

    return {
      branch,
      items: enrichedItems,
      totalAmount,
    };
  }

  /**
   * Buat order setelah konfirmasi pelanggan
   */
  createOrderFromConfirmation(conversationId, customerName, customerPhone, branchId, items, notes) {
    const create = this.db.transaction(() => {
      const { branch, items: enrichedItems, totalAmount } = this.validateAndCalculateOrder(branchId, items);

      const reference = this.generateRef('ORD');
      const result = this.db
        .prepare(
          'INSERT INTO customer_orders(reference_number, customer_name, customer_phone, branch_id, notes, total_amount, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
        )
        .run(reference, customerName, customerPhone, branchId, notes || null, totalAmount, 'NEW', 'WHATSAPP');

      const orderId = result.lastInsertRowid;
      const addItem = this.db.prepare(
        'INSERT INTO customer_order_items(order_id, menu_id, menu_name_snapshot, unit_price_snapshot, quantity, subtotal, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
      );

      enrichedItems.forEach(item => {
        addItem.run(orderId, item.menu.id, item.menu.name, item.menu.price, item.quantity, item.menu.price * item.quantity);
      });

      return { id: orderId, reference, totalAmount };
    });

    try {
      const order = create();
      // Emit socket event ke admin
      this.io.to('admins').emit('order:new', {
        id: order.id,
        referenceNumber: order.reference,
        totalAmount: order.totalAmount,
        source: 'WHATSAPP',
      });
      return order;
    } catch (error) {
      throw new Error(`ORDER_CREATION_FAILED: ${error.message}`);
    }
  }

  /**
   * Buat complaint dari WhatsApp
   */
  createComplaint(conversationId, customerName, customerPhone, branchId, category, description) {
    try {
      if (branchId && !this.db.prepare('SELECT 1 FROM branches WHERE id = ? AND active = 1').get(branchId)) {
        throw new Error('BRANCH_NOT_FOUND');
      }
      const reference = this.generateRef('CMP');
      const result = this.db
        .prepare(
          'INSERT INTO customer_complaints(reference_number, customer_name, customer_phone, branch_id, category, description, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
        )
        .run(reference, customerName, customerPhone, branchId || null, category || null, description, 'NEW', 'WHATSAPP');

      const complaint = { id: result.lastInsertRowid, reference };
      // Emit socket event ke admin
      this.io.to('admins').emit('complaint:new', {
        id: complaint.id,
        referenceNumber: complaint.reference,
        source: 'WHATSAPP',
      });
      return complaint;
    } catch (error) {
      throw new Error(`COMPLAINT_CREATION_FAILED: ${error.message}`);
    }
  }

  /**
   * Simpan pending action (konfirmasi order/complaint) dengan expiry
   */
  savePendingAction(conversationId, actionType, payload, expirySeconds = 600) {
    const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();
    this.db.prepare(
      "UPDATE whatsapp_pending_actions SET status = 'EXPIRED' WHERE conversation_id = ? AND status = 'PENDING'"
    ).run(conversationId);
    const result = this.db
      .prepare(
        'INSERT INTO whatsapp_pending_actions(conversation_id, action_type, payload_json, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
      )
      .run(conversationId, actionType, JSON.stringify(payload), 'PENDING', expiresAt);

    return result.lastInsertRowid;
  }

  /**
   * Ambil pending action yang masih valid
   */
  getPendingAction(conversationId, actionType) {
    return this.db
      .prepare(
        "SELECT * FROM whatsapp_pending_actions WHERE conversation_id = ? AND action_type = ? AND status = 'PENDING' AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1"
      )
      .get(conversationId, actionType);
  }

  /**
   * Update status pending action
   */
  updatePendingActionStatus(actionId, newStatus) {
    this.db.prepare('UPDATE whatsapp_pending_actions SET status = ? WHERE id = ?').run(newStatus, actionId);
  }
}

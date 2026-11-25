import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { Archive, ArrowUpDown, BrainCircuit, Check, Edit2, Headphones, LayoutDashboard, LogOut, MapPin, MessageCircle, Minus, Plus, PlusCircle, Power, RotateCcw, Search, Send, Settings, ShoppingCart, Store, Trash2, Utensils, Wifi, X } from 'lucide-react';
import './style.css';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1';
const currency = (v) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(v);
const formatDateTime = (v) => {
  if (!v) return '';
  const d = new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  const valid = !isNaN(d.getTime()) ? d : new Date(v);
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(valid);
};
const request = async (path, options = {}) => {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.message || payload.error || `Permintaan gagal (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
};

// ─────────────────────────── Customer ───────────────────────────────────────

function Customer({ mode, setMode }) {
  const [menus, setMenus] = useState([]);
  const [branches, setBranches] = useState([]);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [quantities, setQuantities] = useState({});
  const [menuQuery, setMenuQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState('');

  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError('');
    Promise.all([request('/public/menu'), request('/public/branches')])
      .then(([m, b]) => { setMenus(m); setBranches(b); })
      .catch(() => setCatalogError('Menu belum dapat dimuat. Silakan coba lagi.'))
      .finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  const sendOrder = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const items = menus
      .map(m => ({ menuId: m.id, quantity: Number(quantities[m.id] || 0) }))
      .filter(i => i.quantity > 0);
    if (!items.length) { setError('Pilih minimal satu menu sebelum mengirim pesanan.'); return; }
    try {
      setError('');
      setSent(await request('/public/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerName: fd.get('name'),
          customerPhone: fd.get('phone'),
          branchId: fd.get('branch'),
          notes: fd.get('notes'),
          items,
        }),
      }));
    } catch (e) { setError(e.message); }
  };

  const sendComplaint = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      setError('');
      setSent(await request('/public/complaints', {
        method: 'POST',
        body: JSON.stringify({
          customerName: fd.get('name'),
          customerPhone: fd.get('phone'),
          branchId: fd.get('branch') || undefined,
          category: fd.get('category') || undefined,
          description: fd.get('description'),
        }),
      }));
    } catch (e) { setError(e.message); }
  };

  const navigate = next => { setError(''); setMode(next); };
  const setQuantity = (menuId, value) => setQuantities(current => ({ ...current, [menuId]: Math.max(0, Math.min(99, Number(value) || 0)) }));
  const orderCount = Object.values(quantities).reduce((sum, qty) => sum + qty, 0);
  const orderTotal = menus.reduce((sum, menu) => sum + menu.price * (quantities[menu.id] || 0), 0);
  const selectedMenus = useMemo(() => menus.filter(m => (quantities[m.id] || 0) > 0), [menus, quantities]);
  const selectedBranch = useMemo(() => branches.find(b => b.id === selectedBranchId), [branches, selectedBranchId]);

  const categoryList = useMemo(() => {
    const preferredOrder = [
      'Paket Ayam',
      'Paket Seafood & Ikan',
      'Paket Lainnya',
      'Lauk Ayam (Satuan)',
      'Lauk Seafood & Ikan (Satuan)',
      'Lauk & Sayur Satuan',
      'Minuman',
      'Kemasan & Tambahan',
      'Lainnya',
    ];
    const cats = Array.from(new Set(menus.map(m => m.category || 'Lainnya')));
    return cats.sort((a, b) => {
      const idxA = preferredOrder.indexOf(a);
      const idxB = preferredOrder.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [menus]);

  const groupedMenus = useMemo(() => {
    const groups = {};
    const q = menuQuery.trim().toLowerCase();
    const filtered = menus.filter(m => {
      const cat = m.category || 'Lainnya';
      if (activeCategory === '__SELECTED__' && !(quantities[m.id] > 0)) return false;
      if (activeCategory && activeCategory !== '__SELECTED__' && cat !== activeCategory) return false;
      if (q) {
        const matchName = m.name?.toLowerCase().includes(q);
        const matchDesc = m.description?.toLowerCase().includes(q);
        const matchCat = cat.toLowerCase().includes(q);
        if (!matchName && !matchDesc && !matchCat) return false;
      }
      return true;
    });

    categoryList.forEach(cat => {
      const items = filtered.filter(m => (m.category || 'Lainnya') === cat);
      if (items.length) groups[cat] = items;
    });
    return groups;
  }, [menus, menuQuery, activeCategory, quantities, categoryList]);

  return (
    <div className="customer-page">
      <header className="customer-header">
        <button className="customer-logo" onClick={() => { setSent(null); navigate('home'); }} aria-label="Ke beranda Sambal Joelid">
          <span><video src="/sambal_joelid_motion.mp4" autoPlay loop muted playsInline aria-label="Logo Sambal Joelid" /></span><b>SAMBAL<br />JOELID</b>
        </button>
        <span className="customer-header-note">PEDESNYA KELEWATAN, BIKIN NAGIH!</span>
        <span className="customer-header-tag">LAYANAN PELANGGAN</span>
      </header>

      {sent ? (
        <section className="success customer-success">
          <p className="eyebrow">BERHASIL DICATAT</p>
          <h2>Terima kasih! {mode === 'order' ? 'Pesanan' : 'Keluhan'} Anda sudah kami terima.</h2>
          <p>Simpan nomor referensi ini untuk memudahkan pengecekan:</p>
          <strong>{sent.referenceNumber}</strong>
          {sent.totalAmount && <p>Total: {currency(sent.totalAmount)}</p>}
          <button onClick={() => { setSent(null); navigate('home'); }}>Kembali ke awal →</button>
        </section>
      ) : mode === 'home' ? (
        <>
          <section className="customer-hero">
            <div className="customer-hero-copy">
              <p className="eyebrow">SELAMAT DATANG DI SAMBAL JOELID</p>
              <h1>Yang pedas,<br /><em>yang berkesan.</em></h1>
              <p>Mau pesan yang bikin nagih atau ada cerita yang ingin disampaikan? Kami siap bantu.</p>
              <div className="customer-hero-actions">
                <button onClick={() => navigate('order')}>Pesan sekarang <span>↗</span></button>
                <button onClick={() => navigate('complaint')}>Sampaikan keluhan <span>↗</span></button>
              </div>
            </div>
            <div className="customer-hero-art">
              <video src="/sambal_joelid_motion.mp4" autoPlay loop muted playsInline aria-label="Logo Sambal Joelid" />
            </div>
          </section>
          <section className="customer-intro">
            <span>01 / PILIH LAYANAN</span>
            <h2>Ada yang bisa kami bantu?</h2>
            <p>Pilih kebutuhan Anda, kami urus sisanya.</p>
          </section>
          <section className="customer-choices">
            <button className="customer-choice" onClick={() => navigate('order')}>
              <span className="customer-choice-icon"><ShoppingCart size={27} /></span>
              <span><small>BUAT PESANAN</small><b>Pesan makanan</b><span>Pilih menu favorit, atur jumlahnya, dan kirim pesanan.</span></span>
              <span className="customer-choice-arrow">↗</span>
            </button>
            <button className="customer-choice" onClick={() => navigate('complaint')}>
              <span className="customer-choice-icon"><Headphones size={27} /></span>
              <span><small>KAMI MENDENGAR</small><b>Sampaikan keluhan</b><span>Ceritakan pengalaman Anda agar kami bisa lebih baik.</span></span>
              <span className="customer-choice-arrow">↗</span>
            </button>
          </section>
        </>
      ) : (
        <section className="customer-form-page">
          <button className="back" onClick={() => navigate('home')}>← Kembali ke beranda</button>
          <div className="customer-form-banner">
            <div>
              <p className="eyebrow">{mode === 'order' ? 'PESANAN BARU' : 'SUARA PELANGGAN'}</p>
              <h1>{mode === 'order' ? 'Racik pesanan Anda.' : 'Kami siap mendengar.'}</h1>
              <p>{mode === 'order' ? 'Pilih menu dan cabang, lalu kami siapkan untuk Anda.' : 'Cerita Anda membantu kami memberikan pengalaman yang lebih baik.'}</p>
            </div>
            <video src="/sambal_joelid_motion.mp4" autoPlay loop muted playsInline aria-label="Logo Sambal Joelid" />
          </div>
          <div className="customer-form-card">
            {catalogError && <p className="error" role="alert">{catalogError} <button type="button" onClick={loadCatalog}>Coba lagi</button></p>}
            {error && <p className="error" role="alert">{error}</p>}
            <form onSubmit={mode === 'order' ? sendOrder : sendComplaint}>
              <div className="customer-form-row">
                <div className="form-field">
                  <label htmlFor="f-name">Nama Anda</label>
                  <input id="f-name" name="name" required minLength="2" placeholder="Contoh: Budi" />
                </div>
                <div className="form-field">
                  <label htmlFor="f-phone">Nomor WhatsApp</label>
                  <input id="f-phone" name="phone" required placeholder="Contoh: 081234567890" inputMode="tel" pattern="(\+?62|0)[0-9]{8,13}" />
                  <small className="input-help">Gunakan nomor aktif agar kami bisa menghubungi Anda.</small>
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="f-branch">Cabang</label>
                <select
                  id="f-branch"
                  name="branch"
                  required={mode === 'order'}
                  value={selectedBranchId}
                  onChange={e => setSelectedBranchId(e.target.value)}
                >
                  <option value="">Pilih cabang</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id} disabled={b.is_open === 0}>
                      {b.name}{b.address ? ` — ${b.address}` : ''}{b.is_open === 0 ? ' (Tutup)' : ''}
                    </option>
                  ))}
                </select>
                {selectedBranch?.address && (
                  <small className="input-help branch-address-hint">
                    <MapPin size={12} /> Alamat cabang: {selectedBranch.address}
                  </small>
                )}
              </div>

              {mode === 'order' ? (
                <>
                  <div className="customer-form-section">
                    <div className="customer-menu-header">
                      <div>
                        <h2>Pilih menu favorit</h2>
                        <p>Klik <b>+ Tambah</b> pada menu yang ingin dipesan, lalu sesuaikan jumlahnya.</p>
                      </div>
                      <div className="customer-menu-search">
                        <Search size={14} />
                        <input
                          type="text"
                          placeholder="Cari menu favorit..."
                          value={menuQuery}
                          onChange={e => setMenuQuery(e.target.value)}
                        />
                        {menuQuery && (
                          <button type="button" onClick={() => setMenuQuery('')} aria-label="Reset pencarian">×</button>
                        )}
                      </div>
                    </div>

                    {categoryList.length > 1 && (
                      <div className="customer-category-pills" role="tablist" aria-label="Filter kategori menu">
                        <button
                          type="button"
                          className={`cat-pill ${activeCategory === '' ? 'active' : ''}`}
                          onClick={() => setActiveCategory('')}
                        >
                          Semua ({menus.length})
                        </button>
                        {orderCount > 0 && (
                          <button
                            type="button"
                            className={`cat-pill selected-pill ${activeCategory === '__SELECTED__' ? 'active' : ''}`}
                            onClick={() => setActiveCategory(activeCategory === '__SELECTED__' ? '' : '__SELECTED__')}
                          >
                            Dipilih ({selectedMenus.length})
                          </button>
                        )}
                        {categoryList.map(cat => (
                          <button
                            key={cat}
                            type="button"
                            className={`cat-pill ${activeCategory === cat ? 'active' : ''}`}
                            onClick={() => setActiveCategory(activeCategory === cat ? '' : cat)}
                          >
                            {cat}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="menu-groups">
                      {Object.entries(groupedMenus).map(([category, items]) => (
                        <div key={category} className="menu-group-block">
                          <div className="menu-group-head">
                            <h3 className="menu-group-title">{category}</h3>
                            <span className="menu-group-count">{items.length} menu</span>
                          </div>
                          <div className="menu-list">
                            {items.map(m => {
                              const qty = quantities[m.id] || 0;
                              return (
                                <div className={`menu ${qty > 0 ? 'selected' : ''}`} key={m.id}>
                                  <div className="menu-info">
                                    <b>{m.name}</b>
                                    {m.description && <small className="menu-desc">{m.description}</small>}
                                    <small className="menu-price">{currency(m.price)}</small>
                                  </div>
                                  <div className="menu-action">
                                    {qty > 0 ? (
                                      <div className="quantity-stepper" aria-label={`Jumlah ${m.name}`}>
                                        <button type="button" onClick={() => setQuantity(m.id, qty - 1)} aria-label={`Kurangi ${m.name}`}><Minus size={14} /></button>
                                        <input name={`qty-${m.id}`} type="number" min="0" max="99" value={qty} onChange={event => setQuantity(m.id, event.target.value)} />
                                        <button type="button" onClick={() => setQuantity(m.id, qty + 1)} aria-label={`Tambah ${m.name}`}><Plus size={14} /></button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        className="menu-add-btn"
                                        onClick={() => setQuantity(m.id, 1)}
                                        aria-label={`Tambah ${m.name}`}
                                      >
                                        <Plus size={14} /> Tambah
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {menus.length > 0 && !Object.keys(groupedMenus).length && (
                        <p className="menu-empty-filter">
                          Tidak ada menu yang cocok dengan pencarian/filter.{' '}
                          <button type="button" className="link-reset-btn" onClick={() => { setMenuQuery(''); setActiveCategory(''); }}>
                            Tampilkan semua menu
                          </button>
                        </p>
                      )}
                      {!menus.length && <p>{catalogLoading ? 'Memuat menu…' : catalogError ? 'Gagal memuat menu.' : 'Menu belum tersedia. Silakan coba lagi nanti.'}</p>}
                    </div>
                  </div>
                  <div className="form-field">
                    <label htmlFor="f-notes">Catatan untuk pesanan</label>
                    <textarea id="f-notes" name="notes" maxLength="500" placeholder="Contoh: Tidak terlalu pedas (opsional)" />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-field">
                    <label htmlFor="f-category">Kategori keluhan</label>
                    <select id="f-category" name="category">
                      <option value="">Pilih kategori (opsional)</option>
                      <option value="KUALITAS_MAKANAN">Kualitas makanan</option>
                      <option value="PELAYANAN">Pelayanan</option>
                      <option value="PESANAN">Kesalahan pesanan</option>
                      <option value="LAINNYA">Lainnya</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="f-desc">Ceritakan keluhan Anda</label>
                    <textarea id="f-desc" name="description" required minLength="10" maxLength="2000" placeholder="Ceritakan pengalaman Anda secara detail..." />
                  </div>
                </>
              )}

              {mode === 'order' && (
                <div className="order-summary-box">
                  {selectedMenus.length > 0 && (
                    <div className="selected-items-list">
                      {selectedMenus.map(m => (
                        <span key={m.id} className="selected-item-chip">
                          <b>{m.name}</b> × {quantities[m.id]}
                          <button type="button" onClick={() => setQuantity(m.id, 0)} aria-label={`Hapus ${m.name} dari pesanan`}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="order-summary">
                    <span><b>{orderCount}</b> item dipilih</span>
                    <strong>{currency(orderTotal)}</strong>
                  </div>
                </div>
              )}
              <button className="customer-submit" type="submit">{mode === 'order' ? 'Kirim pesanan' : 'Kirim keluhan'} <span>→</span></button>
            </form>
          </div>
        </section>
      )}

      <footer className="customer-footer">
        <b>SAMBAL JOELID</b>
        <span>Pedasnya kelewatan. Bikin nagih.</span>
      </footer>
    </div>
  );
}

// ─────────────────────── WhatsApp Chat Panel ─────────────────────────────────

function WhatsAppChat({ token, conversationId, onClose }) {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [convState, setConvState] = useState('AI_ACTIVE');
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  const reload = useCallback(() => {
    request(`/admin/whatsapp/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(conv => {
        setMessages(conv.messages || []);
        setConvState(conv.state);
      })
      .catch(e => setError(e.message));
  }, [conversationId, token]);

  useEffect(() => {
    reload();
    const socket = io(API.replace('/api/v1', ''), { auth: { token } });
    socket.on('whatsapp:message-received', event => {
      if (Number(event.conversationId) === Number(conversationId)) reload();
    });
    socket.on('whatsapp:conversation-updated', event => {
      if (Number(event.conversationId) === Number(conversationId)) reload();
    });
    return () => socket.disconnect();
  }, [conversationId, token, reload]);

  // Auto-scroll ke bawah saat messages berubah
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async (e) => {
    e.preventDefault();
    if (!newMsg.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await request(`/admin/whatsapp/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: newMsg }),
      });
      setNewMsg('');
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Kirim dengan Enter, newline dengan Shift+Enter
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(e);
    }
  };

  const activateAI = async () => {
    const prev = convState;
    setConvState('AI_ACTIVE');
    try {
      await request(`/admin/whatsapp/conversations/${conversationId}/state`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: 'AI_ACTIVE' }),
      });
      setError('');
    } catch (e) {
      setConvState(prev);
      setError(e.message);
    }
  };

  return (
    <aside className="chat-screen">
      <header className="chat-header">
        <button onClick={onClose} aria-label="Tutup percakapan"><X size={18} /></button>
        <div className="chat-avatar"><MessageCircle size={19} /></div>
        <div>
          <b>Percakapan WhatsApp</b>
          <span>{convState.replaceAll('_', ' ').toLowerCase()}</span>
        </div>
        {convState !== 'AI_ACTIVE' && (
          <button className="resume-ai" type="button" onClick={activateAI}>Aktifkan AI</button>
        )}
      </header>

      {error && <p className="error" style={{ margin: '8px 12px 0' }}>{error}</p>}

      <div className="chat-messages">
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#888', fontSize: '.72rem', padding: '40px 20px' }}>
            Belum ada pesan dalam percakapan ini.
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-line ${msg.sender_type === 'CUSTOMER' ? 'incoming' : 'outgoing'}`}>
            <div className="message-bubble">
              <small>{msg.sender_type === 'ADMIN' ? 'Admin' : msg.sender_type === 'AI' ? 'AI Sambal Joelid' : 'Pelanggan'}</small>
              <p>{msg.content}</p>
              <time>{new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form className="chat-compose" onSubmit={send}>
        <textarea
          ref={textareaRef}
          value={newMsg}
          onChange={e => setNewMsg(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ketik balasan… (Enter untuk kirim, Shift+Enter untuk baris baru)"
          maxLength="2000"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !newMsg.trim()} aria-label="Kirim pesan">
          <Send size={20} />
        </button>
      </form>
    </aside>
  );
}

// ───────────────────────────── Admin ─────────────────────────────────────────

function SourceBadge({ source }) {
  const color = source === 'WHATSAPP' ? '#25D366' : '#666';
  return (
    <span style={{ display: 'inline-block', fontSize: '0.7em', marginLeft: '0.5em', padding: '0.25em 0.5em', backgroundColor: color, color: '#fff', borderRadius: '0.25em' }}>
      {source}
    </span>
  );
}

// ─────────────────────── Admin: katalog & pengaturan ────────────────────────

function CatalogSettings({ token, onError }) {
  const [tab, setTab] = useState('menu');
  const [menus, setMenus] = useState([]);
  const [branches, setBranches] = useState([]);
  const [categories, setCategories] = useState([]);
  const [settings, setSettings] = useState({ opening_hours: '', address: '', phone: '', business_name: '' });
  const [templates, setTemplates] = useState({});
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // Search & filter for menu
  const [menuSearch, setMenuSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Modal for Add/Edit Menu
  const [menuModal, setMenuModal] = useState(null);
  const [menuForm, setMenuForm] = useState({
    id: '',
    name: '',
    category: 'Lainnya',
    price: 15000,
    stock: 999,
    active: true,
    description: '',
    aliasesText: '',
  });

  // Modal for Add/Edit Branch
  const [branchModal, setBranchModal] = useState(null);
  const [branchForm, setBranchForm] = useState({ id: '', name: '', address: '', is_open: true });

  // Drafts for Bot Templates
  const [templateDrafts, setTemplateDrafts] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [menuList, branchList, catList, settingMap, templateMap] = await Promise.all([
        request('/admin/menus', { headers }),
        request('/admin/branches', { headers }),
        request('/admin/menu-categories', { headers }),
        request('/admin/settings', { headers }),
        request('/admin/templates', { headers }),
      ]);
      setMenus(menuList);
      setBranches(branchList);
      setCategories(catList || []);
      setSettings(prev => ({ ...prev, ...settingMap }));
      setTemplates(templateMap);
      setTemplateDrafts(templateMap);
    } catch (error) {
      onError(error.message);
    } finally {
      setLoading(false);
    }
  }, [token, onError]);

  useEffect(() => { load(); }, [load]);

  const flash = (message) => { setNotice(message); setTimeout(() => setNotice(''), 3000); };

  // Menu operations
  const openAddMenu = () => {
    setMenuForm({
      id: '',
      name: '',
      category: categories[0] || 'Paket',
      price: 15000,
      stock: 999,
      active: true,
      description: '',
      aliasesText: '',
    });
    setMenuModal({ mode: 'create' });
  };

  const openEditMenu = (menu) => {
    setMenuForm({
      id: menu.id,
      name: menu.name,
      category: menu.category || 'Lainnya',
      price: menu.price,
      stock: menu.stock,
      active: Boolean(menu.active),
      description: menu.description || '',
      aliasesText: Array.isArray(menu.aliases) ? menu.aliases.join(', ') : '',
    });
    setMenuModal({ mode: 'edit', id: menu.id });
  };

  const handleSaveMenu = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      const aliases = menuForm.aliasesText
        ? menuForm.aliasesText.split(/[,|\n]/).map(s => s.trim()).filter(Boolean)
        : [];
      const payload = {
        name: menuForm.name,
        category: menuForm.category,
        price: Number(menuForm.price),
        stock: Number(menuForm.stock),
        active: Boolean(menuForm.active),
        description: menuForm.description,
        aliases,
      };

      if (menuModal.mode === 'create') {
        await request('/admin/menus', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        flash(`Menu "${menuForm.name}" berhasil ditambahkan.`);
      } else {
        await request(`/admin/menus/${menuModal.id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        flash(`Menu "${menuForm.name}" berhasil diperbarui.`);
      }
      setMenuModal(null);
      await load();
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMenu = async (menu) => {
    if (!window.confirm(`Yakin ingin menghapus permanen menu "${menu.name}"?\nData riwayat pesanan terdahulu akan tetap aman.`)) {
      return;
    }
    try {
      setSaving(true);
      await request(`/admin/menus/${menu.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      flash(`Menu "${menu.name}" berhasil dihapus permanen.`);
      await load();
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleMenuActive = async (menu) => {
    try {
      setSaving(true);
      await request(`/admin/menus/${menu.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ active: !menu.active }),
      });
      flash(`Menu "${menu.name}" sekarang ${!menu.active ? 'Aktif' : 'Nonaktif'}.`);
      await load();
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  // Branch operations
  const openAddBranch = () => {
    setBranchForm({ id: '', name: '', address: '', is_open: true });
    setBranchModal({ mode: 'create' });
  };

  const openEditBranch = (branch) => {
    setBranchForm({
      id: branch.id || '',
      name: branch.name || '',
      address: branch.address || '',
      is_open: branch.is_open === 1 || branch.is_open === true,
    });
    setBranchModal({ mode: 'edit', id: branch.id });
  };

  const handleSaveBranch = async (e) => {
    e.preventDefault();
    if (!branchForm.name.trim()) return;
    try {
      setSaving(true);
      const cleanedId = (branchForm.id || '').trim().toLowerCase();
      const payload = {
        ...(cleanedId ? { id: cleanedId } : {}),
        name: branchForm.name.trim(),
        address: (branchForm.address || '').trim(),
        is_open: Boolean(branchForm.is_open),
      };
      if (branchModal?.mode === 'edit') {
        await request(`/admin/branches/${branchModal.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        flash(`Cabang "${branchForm.name}" berhasil diperbarui.`);
      } else {
        await request('/admin/branches', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        flash(`Cabang "${branchForm.name}" berhasil ditambahkan.`);
      }
      setBranchForm({ id: '', name: '', address: '', is_open: true });
      setBranchModal(null);
      await load();
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleBranchOpen = async (branch) => {
    try {
      setSaving(true);
      const nextIsOpen = branch.is_open === 1 ? false : true;
      await request(`/admin/branches/${branch.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_open: nextIsOpen }),
      });
      flash(`Cabang "${branch.name}" sekarang ${nextIsOpen ? 'BUKA' : 'TUTUP'}.`);
      await load();
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteBranch = async (branch) => {
    if (!window.confirm(`Yakin ingin menghapus cabang "${branch.name}"?`)) {
      return;
    }
    try {
      setSaving(true);
      const res = await request(`/admin/branches/${branch.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res?.archived) {
        flash(`Cabang "${branch.name}" dinonaktifkan karena memiliki riwayat data.`);
      } else {
        flash(`Cabang "${branch.name}" berhasil dihapus.`);
      }
      await load();
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  // Settings & Templates operations
  const saveSettings = async (event) => {
    event.preventDefault();
    try {
      setSaving(true);
      await request('/admin/settings', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings),
      });
      flash('Informasi jam buka & usaha berhasil disimpan.');
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const saveTemplate = async (key, contentToSave) => {
    const content = contentToSave !== undefined ? contentToSave : (templateDrafts[key] ?? templates[key] ?? '');
    try {
      setSaving(true);
      await request(`/admin/templates/${key}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      setTemplates(prev => ({ ...prev, [key]: content }));
      setTemplateDrafts(prev => ({ ...prev, [key]: content }));
      flash(`Perubahan template "${key}" berhasil disimpan.`);
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const dirtyTemplateKeys = useMemo(() => {
    return Object.keys(templates).filter(key => (templateDrafts[key] ?? templates[key]) !== templates[key]);
  }, [templates, templateDrafts]);

  const saveAllTemplates = async () => {
    const keysToSave = dirtyTemplateKeys.length ? dirtyTemplateKeys : Object.keys(templates);
    if (!keysToSave.length) return;
    try {
      setSaving(true);
      await Promise.all(
        keysToSave.map(key =>
          request(`/admin/templates/${key}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({ content: templateDrafts[key] ?? templates[key] }),
          })
        )
      );
      setTemplates(prev => ({ ...prev, ...templateDrafts }));
      flash(`Berhasil menyimpan perubahan pada ${keysToSave.length} template bot.`);
    } catch (error) {
      onError(error.message);
    } finally {
      setSaving(false);
    }
  };

  // Filtered menus
  const filteredMenus = useMemo(() => {
    return menus.filter(m => {
      if (menuSearch) {
        const q = menuSearch.toLowerCase();
        const matchName = m.name?.toLowerCase().includes(q);
        const matchId = m.id?.toLowerCase().includes(q);
        const matchCat = m.category?.toLowerCase().includes(q);
        const matchAliases = Array.isArray(m.aliases) && m.aliases.some(a => a.toLowerCase().includes(q));
        if (!matchName && !matchId && !matchCat && !matchAliases) return false;
      }
      if (selectedCategory && (m.category || 'Lainnya') !== selectedCategory) return false;
      if (statusFilter === 'active' && !m.active) return false;
      if (statusFilter === 'inactive' && m.active) return false;
      return true;
    });
  }, [menus, menuSearch, selectedCategory, statusFilter]);

  return (
    <div className="settings-stack">
      {notice && <p className="settings-notice" role="alert">{notice}</p>}
      {loading && <p role="status">Memuat pengaturan…</p>}

      {/* Subtab Navigation */}
      <nav className="settings-nav-bar" aria-label="Navigasi Pengaturan">
        <button
          type="button"
          className={`subtab-btn ${tab === 'menu' ? 'active' : ''}`}
          onClick={() => setTab('menu')}
        >
          <Utensils size={15} /> Katalog Menu <span className="subtab-badge">{menus.length}</span>
        </button>
        <button
          type="button"
          className={`subtab-btn ${tab === 'branches' ? 'active' : ''}`}
          onClick={() => setTab('branches')}
        >
          <Store size={15} /> Cabang Restoran <span className="subtab-badge">{branches.length}</span>
        </button>
        <button
          type="button"
          className={`subtab-btn ${tab === 'info' ? 'active' : ''}`}
          onClick={() => setTab('info')}
        >
          <MapPin size={15} /> Info Usaha
        </button>
        <button
          type="button"
          className={`subtab-btn ${tab === 'templates' ? 'active' : ''}`}
          onClick={() => setTab('templates')}
        >
          <MessageCircle size={15} /> Template Bot <span className="subtab-badge">{Object.keys(templates).length}</span>
        </button>
      </nav>

      {/* Tab 1: Menu Makanan */}
      {tab === 'menu' && (
        <section className="data-panel settings-panel">
          <div className="panel-heading settings-heading">
            <div>
              <p className="eyebrow">DATABASE SQLITE</p>
              <h2>Katalog Menu Restoran</h2>
            </div>
            <button type="button" className="action-btn-primary" onClick={openAddMenu}>
              <PlusCircle size={15} /> Tambah Menu Baru
            </button>
          </div>

          <div className="menu-toolbar">
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder="Cari nama menu, id, atau alias..."
                value={menuSearch}
                onChange={e => setMenuSearch(e.target.value)}
              />
              {menuSearch && <button type="button" onClick={() => setMenuSearch('')} aria-label="Hapus pencarian">×</button>}
            </div>
            <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
              <option value="">Semua Kategori ({categories.length})</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">Semua Status</option>
              <option value="active">Aktif</option>
              <option value="inactive">Nonaktif</option>
            </select>
          </div>

          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Menu &amp; Deskripsi</th>
                  <th>Kategori</th>
                  <th>Harga</th>
                  <th>Stok</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const grouped = {};
                  filteredMenus.forEach(m => {
                    const cat = m.category || 'Lainnya';
                    if (!grouped[cat]) grouped[cat] = [];
                    grouped[cat].push(m);
                  });
                  const rows = [];
                  Object.entries(grouped).forEach(([cat, items]) => {
                    rows.push(
                      <tr key={`cat-${cat}`} className="category-group-row">
                        <td colSpan="6">{cat} <span className="category-group-count">({items.length})</span></td>
                      </tr>
                    );
                    items.forEach(menu => {
                      rows.push(
                        <tr key={menu.id} className={menu.active ? '' : 'row-muted'}>
                          <td>
                            <div className="menu-title-cell">
                              <b>{menu.name}</b>
                              <span className="menu-id-tag">{menu.id}</span>
                            </div>
                            {menu.description && <p className="menu-desc-text">{menu.description}</p>}
                            {menu.aliases?.length > 0 && (
                              <div className="menu-aliases-list">
                                <small>Alias: </small>
                                {menu.aliases.map((a, i) => (
                                  <span key={i} className="alias-chip">{a}</span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td><span className="category-badge">{menu.category || 'Lainnya'}</span></td>
                          <td className="price-cell">{currency(menu.price)}</td>
                          <td>
                            <span className={`stock-badge ${menu.stock < 10 ? 'low' : ''}`}>
                              {menu.stock}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className={`status-toggle ${menu.active ? 'active' : 'inactive'}`}
                              onClick={() => toggleMenuActive(menu)}
                              title="Klik untuk ubah status aktif/nonaktif"
                            >
                              {menu.active ? 'Aktif' : 'Nonaktif'}
                            </button>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div className="row-actions">
                              <button type="button" className="btn-icon" onClick={() => openEditMenu(menu)} title="Edit Menu">
                                <Edit2 size={14} />
                              </button>
                              <button type="button" className="btn-icon danger" onClick={() => handleDeleteMenu(menu)} title="Hapus Permanen">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    });
                  });
                  return rows;
                })()}
                {!filteredMenus.length && (
                  <tr>
                    <td colSpan="6" className="table-empty">
                      {menus.length ? 'Tidak ada menu yang sesuai dengan filter pencarian.' : 'Belum ada menu tersimpan di database.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Modal Add / Edit Menu */}
          {menuModal && (
            <div className="modal-overlay" onClick={() => setMenuModal(null)}>
              <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h3>{menuModal.mode === 'create' ? 'Tambah Menu Baru' : 'Edit Menu Makanan'}</h3>
                  <button type="button" className="close-btn" onClick={() => setMenuModal(null)}>×</button>
                </div>
                <form onSubmit={handleSaveMenu} className="modal-form">
                  <div className="form-grid">
                    <label className="span-2">
                      Nama Menu *
                      <input
                        required
                        value={menuForm.name}
                        onChange={e => setMenuForm({ ...menuForm, name: e.target.value })}
                        placeholder="Contoh: Bebek Goreng Sambal Korek"
                      />
                    </label>
                    <label>
                      Kategori *
                      <input
                        required
                        list="category-suggestions"
                        value={menuForm.category}
                        onChange={e => setMenuForm({ ...menuForm, category: e.target.value })}
                        placeholder="Pilih atau ketik kategori..."
                      />
                      <datalist id="category-suggestions">
                        <option value="Paket" />
                        <option value="Lauk Satuan" />
                        <option value="Minuman" />
                        <option value="Tambahan" />
                        <option value="Lainnya" />
                        {categories.map(c => <option key={c} value={c} />)}
                      </datalist>
                    </label>
                    <label>
                      Harga Satuan (Rp) *
                      <input
                        required
                        type="number"
                        min="0"
                        step="500"
                        value={menuForm.price}
                        onChange={e => setMenuForm({ ...menuForm, price: e.target.value })}
                      />
                    </label>
                    <label>
                      Stok
                      <input
                        type="number"
                        min="0"
                        value={menuForm.stock}
                        onChange={e => setMenuForm({ ...menuForm, stock: e.target.value })}
                      />
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={menuForm.active}
                        onChange={e => setMenuForm({ ...menuForm, active: e.target.checked })}
                      />
                      Menu Aktif (Dapat Dipesan)
                    </label>
                    <label className="span-2">
                      Deskripsi Menu
                      <textarea
                        rows="2"
                        value={menuForm.description}
                        onChange={e => setMenuForm({ ...menuForm, description: e.target.value })}
                        placeholder="Contoh: Daging bebek empuk disajikan dengan serundeng gurih dan sambal pedas."
                      />
                    </label>
                    <label className="span-2">
                      Alias / Variasi Nama Bot (Pisahkan dengan koma)
                      <input
                        value={menuForm.aliasesText}
                        onChange={e => setMenuForm({ ...menuForm, aliasesText: e.target.value })}
                        placeholder="Contoh: bebek, bebek goreng, bebek madura"
                      />
                      <small className="field-hint">Kata kunci alternatif agar bot WhatsApp langsung mengenali pesanan pelanggan.</small>
                    </label>
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={() => setMenuModal(null)}>Batal</button>
                    <button type="submit" className="action-btn-primary" disabled={saving}>
                      {menuModal.mode === 'create' ? 'Tambah Menu' : 'Simpan Perubahan'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Tab 2: Cabang Restoran */}
      {tab === 'branches' && (
        <section className="data-panel settings-panel">
          <div className="panel-heading settings-heading">
            <div>
              <p className="eyebrow">PENGATURAN CABANG</p>
              <h2>Manajemen Cabang Restoran</h2>
            </div>
            <button type="button" className="action-btn-primary" onClick={openAddBranch}>
              <PlusCircle size={15} /> Tambah Cabang
            </button>
          </div>

          <div className="branches-grid">
            {branches.map(branch => (
              <div key={branch.id} className={`branch-card ${branch.is_open ? 'is-open' : 'is-closed'}`}>
                <div className="branch-card-header">
                  <div>
                    <h3>{branch.name}</h3>
                    <span className="branch-id-code">ID: {branch.id}</span>
                  </div>
                  <span className={`branch-status-badge ${branch.is_open ? 'open' : 'closed'}`}>
                    {branch.is_open ? 'Buka' : 'Tutup'}
                  </span>
                </div>

                <div className={`branch-card-address ${branch.address ? '' : 'empty'}`}>
                  <MapPin size={14} />
                  <span>{branch.address || 'Alamat belum diatur — klik Edit untuk mengisi alamat cabang.'}</span>
                </div>

                <p className="branch-card-desc">
                  {branch.is_open
                    ? 'Cabang ini beroperasi normal dan menerima pesanan dari web maupun bot WhatsApp.'
                    : 'Cabang ditutup sementara. Pelanggan yang memesan cabang ini akan diberi tahu dan diarahkan ke cabang buka.'}
                </p>
                <div className="branch-card-actions">
                  <button
                    type="button"
                    className={`toggle-open-btn ${branch.is_open ? 'action-close' : 'action-open'}`}
                    onClick={() => toggleBranchOpen(branch)}
                    disabled={saving}
                  >
                    <Power size={14} />
                    {branch.is_open ? 'Tutup Cabang Sementara' : 'Buka Cabang Sekarang'}
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => openEditBranch(branch)}
                    title="Edit Cabang & Alamat"
                    disabled={saving}
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn-icon danger"
                    onClick={() => handleDeleteBranch(branch)}
                    title="Hapus Cabang"
                    disabled={saving}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            {!branches.length && (
              <p className="field-help">Belum ada cabang terdaftar. Silakan tambahkan cabang baru.</p>
            )}
          </div>

          {/* Modal Add / Edit Branch */}
          {branchModal && (
            <div className="modal-overlay" onClick={() => setBranchModal(null)}>
              <div className="modal-dialog small" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h3>{branchModal.mode === 'edit' ? 'Edit Cabang Restoran' : 'Tambah Cabang Baru'}</h3>
                  <button type="button" className="close-btn" onClick={() => setBranchModal(null)}>×</button>
                </div>
                <form onSubmit={handleSaveBranch} className="modal-form">
                  <label>
                    Nama Cabang *
                    <input
                      required
                      value={branchForm.name}
                      onChange={e => setBranchForm({ ...branchForm, name: e.target.value })}
                      placeholder="Contoh: Cabang Selatan"
                    />
                  </label>
                  <label style={{ marginTop: 12 }}>
                    ID / Kata Kunci Cabang {branchModal.mode === 'edit' ? '*' : '(Opsional)'}
                    <input
                      required={branchModal.mode === 'edit'}
                      value={branchForm.id}
                      onChange={e => setBranchForm({ ...branchForm, id: e.target.value.toLowerCase() })}
                      placeholder="Contoh: selatan, pusat, suhat"
                    />
                    <small className="field-hint">
                      Kode singkat huruf kecil (lowercase). Dipakai sebagai identitas cabang &amp; kata kunci saat pelanggan memilih cabang lewat chat WhatsApp.
                    </small>
                  </label>
                  <label style={{ marginTop: 12 }}>
                    Alamat Lengkap Cabang
                    <textarea
                      rows="3"
                      value={branchForm.address}
                      onChange={e => setBranchForm({ ...branchForm, address: e.target.value })}
                      placeholder="Contoh: Jl. Sudirman No. 45, Kec. Klojen, Kota Malang"
                    />
                  </label>
                  <label className="checkbox-label" style={{ marginTop: 12 }}>
                    <input
                      type="checkbox"
                      checked={branchForm.is_open}
                      onChange={e => setBranchForm({ ...branchForm, is_open: e.target.checked })}
                    />
                    {branchModal.mode === 'edit' ? 'Status Cabang: Sedang Buka' : 'Status Awal: Langsung Buka'}
                  </label>
                  <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={() => setBranchModal(null)}>Batal</button>
                    <button type="submit" className="action-btn-primary" disabled={saving}>
                      {branchModal.mode === 'edit' ? 'Simpan Perubahan' : 'Simpan Cabang'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Tab 3: Info Usaha */}
      {tab === 'info' && (
        <section className="data-panel settings-panel">
          <div className="panel-heading settings-heading">
            <div><p className="eyebrow">INFORMASI BISNIS</p><h2>Jam buka &amp; lokasi</h2></div>
          </div>
          <form className="settings-form" onSubmit={saveSettings}>
            <label>Nama usaha<input value={settings.business_name || ''} onChange={e => setSettings({ ...settings, business_name: e.target.value })} /></label>
            <label>Jam operasional<input value={settings.opening_hours || ''} onChange={e => setSettings({ ...settings, opening_hours: e.target.value })} placeholder="Setiap hari 09.00–21.00" /></label>
            <label>Alamat usaha<input value={settings.address || ''} onChange={e => setSettings({ ...settings, address: e.target.value })} placeholder="Jl. ..." /></label>
            <label>Nomor telepon / WhatsApp<input value={settings.phone || ''} onChange={e => setSettings({ ...settings, phone: e.target.value })} /></label>
            <button className="action-btn-primary" style={{ justifySelf: 'start', marginTop: 10 }} disabled={saving}>Simpan Informasi Usaha</button>
          </form>
        </section>
      )}

      {/* Tab 4: Template Bot */}
      {tab === 'templates' && (
        <section className="data-panel settings-panel">
          <div className="panel-heading settings-heading">
            <div>
              <p className="eyebrow">INTEGRASI BOT WHATSAPP</p>
              <h2>Template pesan bot</h2>
            </div>
            <div className="template-heading-actions">
              <span className="panel-count">{Object.keys(templates).length} template</span>
              <button
                type="button"
                className="action-btn-primary"
                onClick={saveAllTemplates}
                disabled={saving}
              >
                Simpan Perubahan{dirtyTemplateKeys.length > 0 ? ` (${dirtyTemplateKeys.length})` : ''}
              </button>
            </div>
          </div>
          <div className="settings-rows">
            {Object.entries(templates).map(([key, content]) => {
              const currentVal = templateDrafts[key] ?? content;
              const isDirty = currentVal !== content;
              return (
                <div className={`settings-row ${isDirty ? 'is-dirty' : ''}`} key={key}>
                  <div className="settings-row-head">
                    <div className="template-key-group">
                      <b>{key}</b>
                      {isDirty && <span className="template-dirty-badge">Belum disimpan</span>}
                    </div>
                    <button
                      type="button"
                      className={`template-save-btn ${isDirty ? 'dirty' : ''}`}
                      onClick={() => saveTemplate(key, currentVal)}
                      disabled={saving}
                    >
                      Simpan Perubahan
                    </button>
                  </div>
                  <label>
                    Isi template balasan
                    <textarea
                      value={currentVal}
                      onChange={e => setTemplateDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                    />
                  </label>
                </div>
              );
            })}
            {!Object.keys(templates).length && <p className="field-help">Template akan muncul di sini setelah diinisialisasi backend.</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function BotEvaluation({ token, onError }) {
  const [failed, setFailed] = useState([]);
  const [learned, setLearned] = useState([]);
  const [menus, setMenus] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ intent: 'pesan', menuId: '', qty: 1 });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [failedList, learnedList, menuList] = await Promise.all([
        request('/admin/failed-messages', { headers }),
        request('/admin/learned-examples', { headers }),
        request('/admin/menus', { headers }),
      ]);
      setFailed(failedList);
      setLearned(learnedList);
      setMenus(menuList.filter(menu => menu.active));
    } catch (error) { onError(error.message); }
  }, [token, onError]);

  useEffect(() => { load(); }, [load]);
  const flash = message => { setNotice(message); window.setTimeout(() => setNotice(''), 3000); };
  const headers = { Authorization: `Bearer ${token}` };

  const teach = async event => {
    event.preventDefault();
    if (!editing) return;
    try {
      setSaving(true);
      const items = form.intent === 'pesan' ? [{ menuId: form.menuId, qty: Number(form.qty) }] : [];
      await request(`/admin/failed-messages/${editing.id}/learn`, {
        method: 'POST', headers, body: JSON.stringify({ intent: form.intent, items }),
      });
      setEditing(null);
      flash('Pelajaran disimpan dan langsung aktif.');
      await load();
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const archive = async item => {
    try {
      setSaving(true);
      await request(`/admin/failed-messages/${item.id}/resolve`, { method: 'PATCH', headers });
      flash('Pesan diarsipkan tanpa mengajari bot.');
      await load();
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const remove = async item => {
    if (!window.confirm(`Hapus permanen pesan “${item.raw}”? Data ini tidak akan dipakai untuk pembelajaran.`)) return;
    try {
      setSaving(true);
      await request(`/admin/failed-messages/${item.id}`, { method: 'DELETE', headers });
      if (editing?.id === item.id) setEditing(null);
      flash('Pesan dihapus permanen.');
      await load();
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  return (
    <div className="evaluation-stack">
      {notice && <p className="settings-notice">{notice}</p>}
      <section className="evaluation-guide">
        <BrainCircuit />
        <div><p className="eyebrow">AUTO-LEARNING TERKENDALI</p><h2>Ajarkan sekali, langsung aktif.</h2><p>Bot hanya belajar setelah persetujuan admin. <b>Ajarkan</b> menyimpan contoh ke database, <b>Arsipkan</b> menyimpannya sebagai riwayat, dan <b>Hapus</b> membuangnya permanen.</p></div>
      </section>

      <section className="data-panel settings-panel evaluation-panel">
        <div className="panel-heading"><div><p className="eyebrow">PERLU DITINJAU</p><h2>Pesan gagal dipahami</h2></div><span>{failed.length} pesan</span></div>
        <div className="evaluation-list">
          {failed.map(item => (
            <article className="evaluation-item" key={item.id}>
              <div className="evaluation-copy"><blockquote>“{item.raw}”</blockquote><small>{formatDateTime(item.created_at)} · {item.reason || 'tidak dipahami'}</small></div>
              <div className="evaluation-actions">
                <button className="teach" onClick={() => { setEditing(item); setForm({ intent: 'pesan', menuId: menus[0]?.id || '', qty: 1 }); }} disabled={saving}><BrainCircuit /> Ajarkan</button>
                <button onClick={() => archive(item)} disabled={saving}><Archive /> Arsipkan</button>
                <button className="danger" onClick={() => remove(item)} disabled={saving}><Trash2 /> Hapus</button>
              </div>
              {editing?.id === item.id && (
                <form className="learning-form" onSubmit={teach}>
                  <label>Maksud pelanggan<select value={form.intent} onChange={event => setForm({ ...form, intent: event.target.value })}>
                    <option value="pesan">Memesan makanan</option><option value="keluhan">Keluhan</option><option value="tanya_menu">Tanya menu</option><option value="tanya_jam">Tanya jam buka</option><option value="tanya_lokasi">Tanya lokasi</option><option value="bicara_admin">Minta admin</option><option value="batal">Membatalkan</option><option value="lainnya">Lainnya</option>
                  </select></label>
                  {form.intent === 'pesan' && <><label>Menu<select required value={form.menuId} onChange={event => setForm({ ...form, menuId: event.target.value })}><option value="">Pilih menu</option>{menus.map(menu => <option key={menu.id} value={menu.id}>{menu.name}</option>)}</select></label><label>Jumlah<input type="number" min="1" max="99" value={form.qty} onChange={event => setForm({ ...form, qty: event.target.value })} /></label></>}
                  <div><button disabled={saving}>Simpan &amp; aktifkan</button><button type="button" className="ghost" onClick={() => setEditing(null)}>Batal</button></div>
                </form>
              )}
            </article>
          ))}
          {!failed.length && <div className="empty-state"><b>Semua sudah ditinjau</b><span>Tidak ada pesan gagal yang menunggu keputusan.</span></div>}
        </div>
      </section>

      <section className="data-panel settings-panel learned-panel">
        <div className="panel-heading"><div><p className="eyebrow">MEMORI BOT</p><h2>Pelajaran aktif</h2></div><span>{learned.length} contoh</span></div>
        <div className="settings-rows">{learned.slice(0, 20).map(item => <div className="settings-row" key={item.id}><div className="settings-row-head"><b>“{item.phrase_raw}”</b><small>{item.intent}</small></div>{item.items.length > 0 && <p className="field-help">{item.items.map(entry => `${entry.qty}× ${entry.menu}`).join(', ')}</p>}</div>)}{!learned.length && <p className="field-help settings-row">Belum ada pelajaran aktif.</p>}</div>
      </section>
    </div>
  );
}

function AdminSession({ token, onLogout }) {
  const [kind, setKind] = useState('dashboard');
  const [data, setData] = useState([]);
  const [overview, setOverview] = useState({ orders: [], complaints: [], whatsapp: [] });
  const [health, setHealth] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [chatConv, setChatConv] = useState(null);
  const [saving, setSaving] = useState(false);
  const [branches, setBranches] = useState([]);
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [filterBranch, setFilterBranch] = useState('ALL');
  const [filterDatePreset, setFilterDatePreset] = useState('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [sortOrder, setSortOrder] = useState('ASC');
  const [loading, setLoading] = useState(false);
  const loadSequence = useRef(0);

  useEffect(() => {
    request('/public/branches').then(setBranches).catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!token) return;
    if (kind === 'settings' || kind === 'evaluation') return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError('');
    if (kind === 'dashboard') {
      Promise.all([
        request('/admin/orders', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/complaints', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/whatsapp/conversations', { headers: { Authorization: `Bearer ${token}` } }),
      ])
        .then(([orders, complaints, whatsapp]) => {
          if (sequence === loadSequence.current) setOverview({ orders: orders.data, complaints: complaints.data, whatsapp: whatsapp.data });
        })
        .catch(e => {
          if (sequence !== loadSequence.current) return;
          if (e.status === 401) onLogout();
          else setError(e.message);
        })
        .finally(() => { if (sequence === loadSequence.current) setLoading(false); });
      request('/admin/integrations/health', { headers: { Authorization: `Bearer ${token}` } })
        .then(value => { if (sequence === loadSequence.current) setHealth(value); })
        .catch(e => {
          if (sequence !== loadSequence.current) return;
          if (e.status === 401) onLogout();
          else setHealth({ waha: 'OFFLINE', message: e.message });
        });
      return;
    }
    const endpoint = kind === 'whatsapp' ? '/admin/whatsapp/conversations' : `/admin/${kind}`;
    request(endpoint, { headers: { Authorization: `Bearer ${token}` } })
      .then(x => { if (sequence === loadSequence.current) setData(x.data || x); })
      .catch(e => {
        if (sequence !== loadSequence.current) return;
        if (e.status === 401) onLogout();
        else setError(e.message);
      })
      .finally(() => { if (sequence === loadSequence.current) setLoading(false); });
  }, [token, kind, onLogout]);

  useEffect(() => {
    load();
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { loadSequence.current += 1; document.removeEventListener('visibilitychange', refresh); };
  }, [load]);

  useEffect(() => {
    if (!token) return;
    const socket = io(API.replace('/api/v1', ''), { auth: { token } });
    ['order:new', 'order:updated', 'complaint:new', 'complaint:updated',
      'whatsapp:conversation-updated', 'whatsapp:message-received'].forEach(ev => socket.on(ev, load));
    return () => socket.disconnect();
  }, [token, load]);

  // Reset data dan detail saat berpindah tab
  const switchKind = (next) => {
    loadSequence.current += 1;
    setKind(next);
    setDetail(null);
    setChatConv(null);
    setData([]);
    resetFilters();
    setError('');
  };

  const resetFilters = () => {
    setFilterStatus('ALL');
    setFilterBranch('ALL');
    setFilterDatePreset('ALL');
    setStartDate('');
    setEndDate('');
    setSortOrder('ASC');
  };

  const statusOptions = kind === 'orders'
    ? ['NEW', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED']
    : kind === 'complaints'
    ? ['NEW', 'IN_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']
    : [];

  const statusLabel = value => ({
    NEW: 'Baru', CONFIRMED: 'Dikonfirmasi', PROCESSING: 'Diproses',
    COMPLETED: 'Selesai', CANCELLED: 'Dibatalkan', IN_REVIEW: 'Ditinjau',
    IN_PROGRESS: 'Ditangani', RESOLVED: 'Terselesaikan', CLOSED: 'Ditutup',
    AI_ACTIVE: 'AI aktif', WAITING_ADMIN: 'Menunggu admin', ADMIN_ACTIVE: 'Admin aktif',
  }[value] || value);

  const open = async (id) => {
    try {
      setError('');
      const endpoint = kind === 'whatsapp'
        ? `/admin/whatsapp/conversations/${id}`
        : `/admin/${kind}/${id}`;
      const result = await request(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      setDetail(result);
      setChatConv(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const change = async (e) => {
    const value = e.target.value;
    const previous = detail;
    try {
      setError('');
      setSaving(true);
      setDetail({ ...detail, [kind === 'whatsapp' ? 'state' : 'status']: value });
      if (kind === 'whatsapp') {
        await request(`/admin/whatsapp/conversations/${detail.id}/state`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ state: value }),
        });
      } else {
        await request(`/admin/${kind}/${detail.id}/status`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: value }),
        });
      }
      load();
    } catch (changeError) {
      setDetail(previous);
      setError(changeError.message);
    } finally {
      setSaving(false);
    }
  };

  const filteredData = useMemo(() => {
    if (kind === 'whatsapp' || kind === 'dashboard') return data;
    let list = [...data];
    if (filterStatus !== 'ALL') list = list.filter(item => (item.status || item.state) === filterStatus);
    if (filterBranch !== 'ALL') list = list.filter(item => String(item.branch_id) === String(filterBranch));
    if (filterDatePreset !== 'ALL') {
      const now = new Date();
      list = list.filter(item => {
        if (!item.created_at) return true;
        const d = new Date(item.created_at.includes('T') ? item.created_at : item.created_at.replace(' ', 'T') + 'Z');
        const itemDate = !isNaN(d.getTime()) ? d : new Date(item.created_at);
        if (filterDatePreset === 'TODAY') return itemDate.toDateString() === now.toDateString();
        if (filterDatePreset === '7DAYS') return itemDate >= new Date(now - 7 * 86400000);
        if (filterDatePreset === '30DAYS') return itemDate >= new Date(now - 30 * 86400000);
        if (filterDatePreset === 'CUSTOM') {
          if (startDate) { const s = new Date(startDate); s.setHours(0, 0, 0, 0); if (itemDate < s) return false; }
          if (endDate) { const en = new Date(endDate); en.setHours(23, 59, 59, 999); if (itemDate > en) return false; }
        }
        return true;
      });
    }
    list.sort((a, b) => {
      const t = v => { if (!v) return 0; const d = new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z'); return !isNaN(d.getTime()) ? d.getTime() : 0; };
      return sortOrder === 'ASC' ? t(a.created_at) - t(b.created_at) : t(b.created_at) - t(a.created_at);
    });
    return list;
  }, [data, kind, filterStatus, filterBranch, filterDatePreset, startDate, endDate, sortOrder]);

  const hasActiveFilters = filterStatus !== 'ALL' || filterBranch !== 'ALL' || filterDatePreset !== 'ALL' || startDate || endDate || sortOrder !== 'ASC';
  const title = kind === 'dashboard' ? 'Ikhtisar' : kind === 'orders' ? 'Pesanan' : kind === 'complaints' ? 'Keluhan' : kind === 'settings' ? 'Pengaturan Bot' : kind === 'evaluation' ? 'Evaluasi Bot' : 'Percakapan WhatsApp';
  const newCount = data.filter(item => ['NEW', 'WAITING_ADMIN'].includes(item.status || item.state)).length;
  const activeCount = data.filter(item => ['CONFIRMED', 'PROCESSING', 'IN_REVIEW', 'IN_PROGRESS', 'ADMIN_ACTIVE'].includes(item.status || item.state)).length;

  return (
    <section className="admin-shell">
      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <video src="/sambal_joelid_motion.mp4" autoPlay loop muted playsInline aria-label="Logo Sambal Joelid" />
          <div><b>Sambal Joelid</b><small>Pusat Operasional</small></div>
        </div>
        <nav>
          <button className={kind === 'dashboard' ? 'active' : ''} onClick={() => switchKind('dashboard')}>
            <LayoutDashboard /> Ikhtisar
          </button>
          <button className={kind === 'orders' ? 'active' : ''} onClick={() => switchKind('orders')}>
            <ShoppingCart /> Pesanan <i>{kind === 'orders' ? data.length : ''}</i>
          </button>
          <button className={kind === 'complaints' ? 'active' : ''} onClick={() => switchKind('complaints')}>
            <Headphones /> Keluhan <i>{kind === 'complaints' ? data.length : ''}</i>
          </button>
          <button className={kind === 'whatsapp' ? 'active' : ''} onClick={() => switchKind('whatsapp')}>
            <MessageCircle /> WhatsApp <i>{kind === 'whatsapp' ? data.length : ''}</i>
          </button>
          <button className={kind === 'settings' ? 'active' : ''} onClick={() => switchKind('settings')}>
            <Settings /> Pengaturan
          </button>
          <button className={kind === 'evaluation' ? 'active' : ''} onClick={() => switchKind('evaluation')}>
            <BrainCircuit /> Evaluasi
          </button>
          <button className="mobile-logout" onClick={onLogout}>
            <LogOut /> Keluar
          </button>
        </nav>
        <div className="sidebar-foot">
          <span className="online-dot" /> Sistem online
          <button onClick={onLogout}>Keluar →</button>
        </div>
      </aside>

      {/* Workspace */}
      <div className="admin-workspace">
        <header className="admin-topbar">
          <div className="admin-heading">
            <p className="eyebrow">DAPUR KOMANDO / {title.toUpperCase()}</p>
            <h1>{kind === 'dashboard' ? 'Halo, Admin!' : title}</h1>
            <p>Pantau pesanan, keluhan, dan percakapan pelanggan secara real-time.</p>
          </div>
          <div className="admin-visual">
            <video src="/sambal_joelid_motion.mp4" autoPlay loop muted playsInline aria-label="Logo Sambal Joelid" />
            <div className="admin-profile"><span>AD</span><b>Admin</b></div>
          </div>
        </header>

        {kind === 'settings' || kind === 'evaluation' ? null : kind === 'dashboard' ? (
          <>
            <div className="metric-grid overview-metrics">
              <article>
                <ShoppingCart />
                <small>Pesanan</small>
                <strong>{overview.orders.length}</strong>
                <span>{overview.orders.filter(x => x.status === 'NEW').length} pesanan baru</span>
              </article>
              <article>
                <Headphones />
                <small>Keluhan</small>
                <strong>{overview.complaints.length}</strong>
                <span>{overview.complaints.filter(x => x.status === 'NEW').length} perlu ditinjau</span>
              </article>
              <article>
                <MessageCircle />
                <small>WhatsApp</small>
                <strong>{overview.whatsapp.length}</strong>
                <span>{overview.whatsapp.filter(x => x.state === 'WAITING_ADMIN').length} menunggu admin</span>
              </article>
            </div>
            <div className={`integration-status ${health?.waha === 'ONLINE' && !health?.degraded ? 'healthy' : 'degraded'}`}>
              <Wifi />
              <div>
                <b>Integrasi WhatsApp: {health?.waha || 'Memeriksa...'} · LLM: {health?.llm || 'Memeriksa...'}</b>
                <span>
                  {health?.degraded
                    ? 'Mode degradasi: LLM offline. Bot hanya memakai aturan dan pencocokan menu, lalu handoff bila perlu.'
                    : health?.waha === 'ONLINE'
                      ? 'WAHA dapat diakses. Pesan masuk dipantau secara real-time.'
                      : health?.message || 'Status sedang diperiksa.'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="metric-grid">
            <article><small>Data {title}</small><strong>{data.length}</strong><span>Total saat ini</span></article>
            <article><small>Perlu perhatian</small><strong>{newCount}</strong><span>Baru atau menunggu</span></article>
            <article><small>Sedang aktif</small><strong>{activeCount}</strong><span>Dalam penanganan</span></article>
          </div>
        )}

        {error && <p className="error" role="alert">{error} <button type="button" onClick={load}>Coba lagi</button></p>}
        {loading && kind !== 'settings' && kind !== 'evaluation' && <p role="status">Memuat data…</p>}

        {kind === 'settings' && <CatalogSettings token={token} onError={setError} />}
        {kind === 'evaluation' && <BotEvaluation token={token} onError={setError} />}

        {kind !== 'dashboard' && kind !== 'settings' && kind !== 'evaluation' && (
          <div className={`admin-panel ${(detail || chatConv) ? 'has-detail' : ''}`}>
            {/* Daftar */}
            <section className="data-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">MEJA OPERASIONAL</p>
                  <h2>{title}</h2>
                </div>
                <span className="panel-count">{filteredData.length} dari {data.length} data</span>
              </div>

              {kind !== 'whatsapp' && (
                <div className="admin-filter-bar">
                  <div className="filter-group">
                    <label htmlFor="f-status">Status</label>
                    <select id="f-status" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                      <option value="ALL">Semua Status</option>
                      {statusOptions.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
                    </select>
                  </div>
                  {kind === 'orders' && (
                    <div className="filter-group">
                      <label htmlFor="f-branch">Cabang</label>
                      <select id="f-branch" value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
                        <option value="ALL">Semua Cabang</option>
                        {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="filter-group">
                    <label htmlFor="f-date">Rentang Waktu</label>
                    <select id="f-date" value={filterDatePreset} onChange={e => setFilterDatePreset(e.target.value)}>
                      <option value="ALL">Semua Waktu</option>
                      <option value="TODAY">Hari Ini</option>
                      <option value="7DAYS">7 Hari Terakhir</option>
                      <option value="30DAYS">30 Hari Terakhir</option>
                      <option value="CUSTOM">Pilih Tanggal...</option>
                    </select>
                  </div>
                  {filterDatePreset === 'CUSTOM' && (
                    <div className="filter-group date-range-group">
                      <label>Periode</label>
                      <div className="date-inputs">
                        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} aria-label="Dari tanggal" />
                        <span>-</span>
                        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} aria-label="Sampai tanggal" />
                      </div>
                    </div>
                  )}
                  <div className="filter-group sort-group">
                    <label>Urutan</label>
                    <button type="button" className="sort-toggle-btn" onClick={() => setSortOrder(p => p === 'ASC' ? 'DESC' : 'ASC')}>
                      <ArrowUpDown size={13} />{sortOrder === 'ASC' ? 'Masuk Lebih Dulu' : 'Terbaru Dulu'}
                    </button>
                  </div>
                  {hasActiveFilters && (
                    <div className="filter-group reset-group">
                      <label>&nbsp;</label>
                      <button type="button" className="reset-filter-btn" onClick={resetFilters}>
                        <RotateCcw size={12} /> Reset
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="table-head">
                <span>{kind === 'whatsapp' ? 'Nomor / Identitas' : 'Referensi'}</span>
                <span>Pelanggan / {kind === 'whatsapp' ? 'Kontak' : 'Cabang'} / Waktu</span>
                <span>Status</span>
              </div>
              <div className="table">
                {filteredData.map(x => (
                  <button
                    className={`row ${detail?.id === x.id ? 'selected' : ''}`}
                    key={x.id}
                    onClick={() => { open(x.id); }}
                  >
                    <b>{x.reference_number || `+${x.phone}`}</b>
                    <span>
                      <b>{x.customer_name || 'Pelanggan WhatsApp'}</b>
                      <small>
                        {kind !== 'whatsapp' ? (x.branch_name || 'Tanpa cabang') : (x.phone || 'Kontak WhatsApp')}
                        {x.created_at && <span className="row-timestamp"> • {formatDateTime(x.created_at)}</span>}
                      </small>
                    </span>
                    <em className={`status-badge status-${(x.status || x.state).toLowerCase()}`}>
                      {statusLabel(x.status || x.state)}
                    </em>
                  </button>
                ))}
                {!loading && !error && !filteredData.length && (
                  <div className="empty-state">
                    <b>{data.length ? 'Tidak ada data yang cocok dengan filter' : 'Belum ada data'}</b>
                    <span>{data.length ? 'Coba ubah opsi filter atau tekan tombol Reset.' : 'Data baru akan muncul otomatis di sini.'}</span>
                  </div>
                )}
              </div>
            </section>

            {/* Detail / Chat Panel */}
            {chatConv ? (
              <WhatsAppChat
                token={token}
                conversationId={chatConv.id}
                onClose={() => setChatConv(null)}
              />
            ) : detail ? (
              <aside className="detail-panel">
                <div className="detail-heading">
                  <div>
                    <p className="eyebrow">DETAIL</p>
                    <h3>{detail.reference_number || `+${detail.phone}`}</h3>
                  </div>
                  <button onClick={() => setDetail(null)} aria-label="Tutup detail">×</button>
                </div>

                <div className="detail-body">
                  <div className="customer-card">
                    <small>Pelanggan</small>
                    <b>{detail.customer_name || 'Pelanggan WhatsApp'}</b>
                    <span>{detail.customer_phone || detail.phone}</span>
                    {detail.created_at && (
                      <div className="detail-timestamp">
                        <small>Waktu Masuk</small>
                        <span>{formatDateTime(detail.created_at)}</span>
                      </div>
                    )}
                  </div>

                  {detail.items?.length > 0 && (
                    <div className="order-items">
                      <small>Rincian pesanan</small>
                      {detail.items.map(i => (
                        <div key={i.id}>
                          <span>{i.menu_name_snapshot} × {i.quantity}</span>
                          <b>{currency(i.subtotal)}</b>
                        </div>
                      ))}
                      {detail.total_amount && (
                        <div style={{ borderBottom: 'none', fontWeight: 600 }}>
                          <span>Total</span>
                          <b>{currency(detail.total_amount)}</b>
                        </div>
                      )}
                    </div>
                  )}

                  {kind === 'whatsapp' ? (
                    <>
                      <label>
                        Mode percakapan
                        <select disabled={saving} value={detail.state} onChange={change}>
                          <option value="AI_ACTIVE">AI aktif</option>
                          <option value="WAITING_ADMIN">Menunggu admin</option>
                          <option value="ADMIN_ACTIVE">Admin aktif</option>
                        </select>
                      </label>
                      <p className="field-help">Mode admin bersifat sementara. AI akan aktif kembali otomatis setelah jeda berakhir.</p>
                      <button className="primary-action" onClick={() => setChatConv(detail)}>
                        <MessageCircle size={16} />
                        Buka percakapan →
                      </button>
                    </>
                  ) : (
                    <>
                      <label>
                        Status
                        <select disabled={saving} value={detail.status} onChange={change}>
                          {statusOptions.map(s => <option value={s} key={s}>{statusLabel(s)}</option>)}
                        </select>
                      </label>
                      {detail.source && <SourceBadge source={detail.source} />}
                      {detail.source === 'WHATSAPP' && detail.whatsapp_conversation_id && (
                        <button className="primary-action chat-link" onClick={() => setChatConv({ id: detail.whatsapp_conversation_id })}>
                          <MessageCircle size={16} /> Buka percakapan
                        </button>
                      )}
                      {kind === 'complaints' && (
                        <label>
                          Catatan internal
                          <textarea
                            defaultValue={detail.admin_notes || ''}
                            onBlur={async e => {
                              try {
                                await request(`/admin/complaints/${detail.id}/notes`, {
                                  method: 'PATCH',
                                  headers: { Authorization: `Bearer ${token}` },
                                  body: JSON.stringify({ adminNotes: e.target.value || null }),
                                });
                              } catch (noteError) { setError(noteError.message); }
                            }}
                          />
                        </label>
                      )}
                      {kind === 'complaints' && detail.description && (
                        <div style={{ marginTop: 16 }}>
                          <small style={{ color: '#817a76', fontSize: '.63rem', textTransform: 'uppercase', letterSpacing: '.08em' }}>Deskripsi Keluhan</small>
                          <p style={{ marginTop: 6, fontSize: '.75rem', lineHeight: 1.6, color: '#333' }}>{detail.description}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </aside>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function Admin() {
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');
  const [error, setError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const loginAttempt = useRef(0);

  const logout = useCallback(() => {
    loginAttempt.current += 1;
    localStorage.removeItem('token');
    setToken('');
    setError('');
    setLoggingIn(false);
  }, []);

  useEffect(() => {
    const syncSession = (event) => {
      if (event.key !== 'token' && event.key !== null) return;
      loginAttempt.current += 1;
      setToken(localStorage.getItem('token') || '');
      setError('');
      setLoggingIn(false);
    };
    window.addEventListener('storage', syncSession);
    return () => window.removeEventListener('storage', syncSession);
  }, []);

  if (token) return <AdminSession key={token} token={token} onLogout={logout} />;

  const login = async (event) => {
    event.preventDefault();
    if (loggingIn) return;
    const attempt = ++loginAttempt.current;
    const form = new FormData(event.currentTarget);
    setLoggingIn(true);
    setError('');
    try {
      const { token: nextToken } = await request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (attempt !== loginAttempt.current) return;
      localStorage.setItem('token', nextToken);
      setToken(nextToken);
    } catch (loginError) {
      if (attempt === loginAttempt.current) setError(loginError.message);
    } finally {
      if (attempt === loginAttempt.current) setLoggingIn(false);
    }
  };

  return (
    <section className="login">
      <video className="login-brand-art" src="/sambal_joelid_motion.mp4" autoPlay loop muted playsInline aria-label="Logo Sambal Joelid" />
      <p className="eyebrow">RUANG OPERASIONAL</p>
      <h2>Masuk sebagai Admin</h2>
      {error && <p className="error" role="alert">{error}</p>}
      <form onSubmit={login}>
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Kata sandi<input name="password" type="password" required autoComplete="current-password" /></label>
        <button disabled={loggingIn}>{loggingIn ? 'Memproses…' : 'Masuk →'}</button>
      </form>
    </section>
  );
}

// ───────────────────────────── App ───────────────────────────────────────────

function App() {
  const adminPage = window.location.hostname.startsWith('admin.') || window.location.pathname.startsWith('/admin');
  const [mode, setMode] = useState('home');
  return (
    <main className={adminPage ? 'admin-main' : ''}>
      {adminPage ? <Admin /> : <Customer mode={mode} setMode={setMode} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);

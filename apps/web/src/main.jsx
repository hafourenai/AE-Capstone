import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { ArrowUpDown, Filter, Headphones, LayoutDashboard, MessageCircle, RotateCcw, Send, Settings, ShoppingCart, Wifi, X } from 'lucide-react';
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
      .map(m => ({ menuId: m.id, quantity: Number(fd.get(`qty-${m.id}`)) }))
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

  return (
    <div className="customer-page">
      <header className="customer-header">
        <button className="customer-logo" onClick={() => { setSent(null); navigate('home'); }} aria-label="Ke beranda Sambal Joelid">
          <span>🌶</span><b>SAMBAL<br />JOELID</b>
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
              <img src="/brand-top-right.jpg" alt="Ilustrasi maskot cabai Sambal Joelid" />
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
            <img src="/brand-top-right.jpg" alt="Maskot Sambal Joelid" />
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
                <select id="f-branch" name="branch" required={mode === 'order'}>
                  <option value="">Pilih cabang</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>

              {mode === 'order' ? (
                <>
                  <div className="customer-form-section">
                    <h2>Pilih menu favorit</h2>
                    <p>Isi jumlah untuk menu yang ingin dipesan.</p>
                    <div className="menu-list">
                      {menus.map(m => (
                        <label className="menu" key={m.id}>
                          <span><b>{m.name}</b><small>{currency(m.price)}</small></span>
                          <input name={`qty-${m.id}`} type="number" min="0" max="99" defaultValue="0" aria-label={`Jumlah ${m.name}`} />
                        </label>
                      ))}
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
                      <option value="FOOD_QUALITY">Kualitas makanan</option>
                      <option value="SERVICE">Pelayanan</option>
                      <option value="ORDER_ERROR">Kesalahan pesanan</option>
                      <option value="OTHER">Lainnya</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="f-desc">Ceritakan keluhan Anda</label>
                    <textarea id="f-desc" name="description" required minLength="10" maxLength="2000" placeholder="Ceritakan pengalaman Anda secara detail..." />
                  </div>
                </>
              )}

              <button type="submit">{mode === 'order' ? 'Kirim pesanan →' : 'Kirim keluhan →'}</button>
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
  const [menus, setMenus] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [settings, setSettings] = useState({ opening_hours: '', address: '', phone: '', business_name: '' });
  const [templates, setTemplates] = useState({});
  const [failed, setFailed] = useState([]);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [menuList, settingMap, templateMap, failedList, status] = await Promise.all([
        request('/admin/menus', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/settings', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/templates', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/failed-messages', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/menu-sync-status', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      setMenus(menuList);
      setSettings(prev => ({ ...prev, ...settingMap }));
      setTemplates(templateMap);
      setFailed(failedList);
      setSyncStatus(status);
    } catch (error) { onError(error.message); }
    finally { setLoading(false); }
  }, [token, onError]);

  useEffect(() => { load(); }, [load]);

  const flash = (message) => { setNotice(message); setTimeout(() => setNotice(''), 2500); };

  const syncMenu = async () => {
    try {
      setSaving(true);
      const result = await request('/admin/menu-sync', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      await load();
      if (!result.changed) onError(result.errors?.join(', ') || 'Menu belum berubah.');
      else flash('Menu dari spreadsheet diperbarui.');
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    try {
      setSaving(true);
      await request('/admin/settings', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings),
      });
      flash('Jam buka & lokasi disimpan.');
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const saveTemplate = async (key, content) => {
    try {
      setSaving(true);
      await request(`/admin/templates/${key}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      flash(`Template ${key} disimpan.`);
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const sendToTestSet = async (item) => {
    try {
      setSaving(true);
      await request(`/admin/failed-messages/${item.id}/testset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      await load();
      flash('Pesan ditambahkan ke test set.');
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  const resolveFailed = async (item) => {
    try {
      setSaving(true);
      await request(`/admin/failed-messages/${item.id}/resolve`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      await load();
    } catch (error) { onError(error.message); } finally { setSaving(false); }
  };

  return (
    <div className="settings-stack">
      {notice && <p className="settings-notice">{notice}</p>}
      {loading && <p role="status">Memuat pengaturan…</p>}
      {!loading && !syncStatus && <button type="button" onClick={load}>Muat ulang pengaturan</button>}

      <section className="data-panel settings-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">KATALOG</p><h2>Menu dari Google Sheets</h2></div>
          <span className="panel-count">{menus.length} menu</span>
        </div>
        <p className="field-help">Edit nama, harga, stok, status, dan alias langsung di spreadsheet. SQLite mengikuti perubahan otomatis setiap beberapa menit.</p>
        <p className="field-help">Sinkron terakhir: {syncStatus?.lastSuccessAt ? formatDateTime(syncStatus.lastSuccessAt) : 'Belum berhasil'} {syncStatus?.stale ? '· Data mungkin belum terbaru' : ''}</p>
        {syncStatus?.errors?.map((message, index) => <p className="error" key={index}>{message}</p>)}
        <button type="button" onClick={syncMenu} disabled={saving}>Sinkron sekarang</button>
        <div className="settings-rows">
          {menus.map(menu => (
            <div className="settings-row" key={menu.id}>
              <div className="settings-row-head"><b>{menu.name}</b><small>{menu.id}</small></div>
              <p>{currency(menu.price)} · Stok {menu.stock} · {menu.active ? 'Aktif' : 'Nonaktif'}</p>
            </div>
          ))}
          {!menus.length && <p className="field-help">Belum ada menu tersimpan. Periksa URL spreadsheet dan status sinkronisasi.</p>}
        </div>
      </section>

      <section className="data-panel settings-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">INFORMASI</p><h2>Jam buka &amp; lokasi</h2></div>
        </div>
        <form className="settings-form" onSubmit={saveSettings}>
          <label>Nama usaha<input value={settings.business_name || ''} onChange={e => setSettings({ ...settings, business_name: e.target.value })} /></label>
          <label>Jam buka<input value={settings.opening_hours || ''} onChange={e => setSettings({ ...settings, opening_hours: e.target.value })} placeholder="Setiap hari 09.00–21.00" /></label>
          <label>Alamat<input value={settings.address || ''} onChange={e => setSettings({ ...settings, address: e.target.value })} placeholder="Jl. ..." /></label>
          <label>Telepon<input value={settings.phone || ''} onChange={e => setSettings({ ...settings, phone: e.target.value })} /></label>
          <button disabled={saving}>Simpan informasi</button>
        </form>
      </section>

      <section className="data-panel settings-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">EVALUASI</p><h2>Pesan gagal dipahami</h2></div>
          <span className="panel-count">{failed.length} pesan</span>
        </div>
        <div className="settings-rows">
          {failed.map(item => (
            <div className="settings-row" key={item.id}>
              <div className="settings-row-head">
                <b>“{item.raw}”</b>
                <small>{formatDateTime(item.created_at)} · {item.phone || '-'} · {item.reason}</small>
              </div>
                <div className="settings-row-fields">
                  <div className="settings-actions">
                  <button type="button" onClick={() => sendToTestSet(item)} disabled={saving}>Ke test set</button>
                  <button type="button" className="ghost" onClick={() => resolveFailed(item)} disabled={saving}>Tandai selesai</button>
                </div>
              </div>
            </div>
          ))}
          {!failed.length && <p className="field-help">Belum ada pesan yang gagal dipahami. Bagus!</p>}
        </div>
      </section>

      <section className="data-panel settings-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">BOT</p><h2>Template pesan</h2></div>
          <span className="panel-count">{Object.keys(templates).length} template</span>
        </div>
        <div className="settings-rows">
          {Object.entries(templates).map(([key, content]) => (
            <div className="settings-row" key={key}>
              <div className="settings-row-head"><b>{key}</b></div>
              <label>Isi template<textarea defaultValue={content} onBlur={e => saveTemplate(key, e.target.value)} /></label>
            </div>
          ))}
          {!Object.keys(templates).length && <p className="field-help">Template akan muncul di sini setelah diinisialisasi backend.</p>}
        </div>
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
    if (kind === 'settings') return;
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
  const title = kind === 'dashboard' ? 'Ikhtisar' : kind === 'orders' ? 'Pesanan' : kind === 'complaints' ? 'Keluhan' : kind === 'settings' ? 'Pengaturan Bot' : 'Percakapan WhatsApp';
  const newCount = data.filter(item => ['NEW', 'WAITING_ADMIN'].includes(item.status || item.state)).length;
  const activeCount = data.filter(item => ['CONFIRMED', 'PROCESSING', 'IN_REVIEW', 'IN_PROGRESS', 'ADMIN_ACTIVE'].includes(item.status || item.state)).length;

  return (
    <section className="admin-shell">
      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <img src="/brand-top-right.jpg" alt="" />
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
            <img src="/brand-top-right.jpg" alt="Maskot Sambal Joelid" />
            <div className="admin-profile"><span>AD</span><b>Admin</b></div>
          </div>
        </header>

        {kind === 'settings' ? null : kind === 'dashboard' ? (
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
        {loading && kind !== 'settings' && <p role="status">Memuat data…</p>}

        {kind === 'settings' && <CatalogSettings token={token} onError={setError} />}

        {kind !== 'dashboard' && kind !== 'settings' && (
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
                      <MessageCircle size={15} style={{ marginRight: 6, verticalAlign: 'middle' }} />
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
      <img className="login-brand-art" src="/brand-top-right.jpg" alt="Maskot Sambal Joelid" />
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

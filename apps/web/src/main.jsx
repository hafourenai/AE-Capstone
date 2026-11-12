import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { Headphones, LayoutDashboard, MessageCircle, Send, ShoppingCart, Wifi, X } from 'lucide-react';
import './style.css';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1';
const currency = (v) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(v);
const request = async (path, options = {}) => {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || `Permintaan gagal (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
};

function Customer({ mode, setMode }) {
  const [menus, setMenus] = useState([]), [branches, setBranches] = useState([]), [sent, setSent] = useState(null), [error, setError] = useState('');
  useEffect(() => { Promise.all([request('/public/menu'), request('/public/branches')]).then(([m,b]) => { setMenus(m); setBranches(b); }).catch(() => setError('Menu belum dapat dimuat. Silakan coba lagi.')); }, []);
  const sendOrder = async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); const items = menus.map(m => ({ menuId:m.id, quantity:Number(fd.get(`qty-${m.id}`)) })).filter(i => i.quantity > 0); try { setSent(await request('/public/orders', { method:'POST', body:JSON.stringify({ customerName:fd.get('name'), customerPhone:fd.get('phone'), branchId:fd.get('branch'), notes:fd.get('notes'), items }) })); } catch(e) { setError(e.message); } };
  const sendComplaint = async (e) => { e.preventDefault(); const fd=new FormData(e.currentTarget); try { setSent(await request('/public/complaints', {method:'POST',body:JSON.stringify({customerName:fd.get('name'),customerPhone:fd.get('phone'),branchId:fd.get('branch')||undefined,category:fd.get('category')||undefined,description:fd.get('description')})})); } catch(e) {setError(e.message);} };
  if (sent) return <section className="success"><p className="eyebrow">TERCATAT</p><h2>Terima kasih, {mode === 'order' ? 'pesanan' : 'keluhan'} Anda sudah kami terima.</h2><strong>{sent.referenceNumber}</strong>{sent.totalAmount && <p>Total: {currency(sent.totalAmount)}</p>}<button onClick={() => {setSent(null);setMode('home');}}>Kembali ke awal</button></section>;
  if (mode === 'home') return <section className="choices"><p className="eyebrow">SAMBAL JOELID</p><h1>Mau kami bantu apa hari ini?</h1><button className="choice order" onClick={() => setMode('order')}><b>Pesan makanan</b><span>Pilih menu, atur jumlah, kirim pesanan.</span></button><button className="choice complaint" onClick={() => setMode('complaint')}><b>Sampaikan keluhan</b><span>Ceritakan pengalaman Anda agar kami perbaiki.</span></button></section>;
  return <section className="form-wrap"><button className="back" onClick={() => setMode('home')}>← Kembali</button><p className="eyebrow">{mode === 'order' ? 'PESANAN BARU' : 'DENGAR DARI ANDA'}</p><h2>{mode === 'order' ? 'Racik pesanan Anda' : 'Sampaikan keluhan Anda'}</h2>{error && <p className="error">{error}</p>}<form onSubmit={mode === 'order' ? sendOrder : sendComplaint}><label>Nama<input name="name" required minLength="2" /></label><label>Nomor WhatsApp<input name="phone" required placeholder="Contoh: 081234567890" inputMode="tel" pattern="(\+?62|0)[0-9]{8,13}" /><small className="input-help">Gunakan nomor WhatsApp aktif agar admin dapat menghubungi Anda bila diperlukan.</small></label><label>Cabang<select name="branch" required={mode === 'order'}><option value="">Pilih cabang</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>{mode === 'order' ? <><div className="menu-list">{menus.map(m=><label className="menu" key={m.id}><span><b>{m.name}</b><small>{currency(m.price)}</small></span><input name={`qty-${m.id}`} type="number" min="0" max="99" defaultValue="0" /></label>)}</div><label>Catatan untuk pesanan<textarea name="notes" maxLength="500" /></label></> : <><label>Kategori<select name="category"><option value="">Pilih kategori</option><option value="KUALITAS_MAKANAN">Kualitas makanan</option><option value="PELAYANAN">Pelayanan</option><option value="KEBERSIHAN">Kebersihan</option><option value="PESANAN">Pesanan</option><option value="LAINNYA">Lainnya</option></select></label><label>Ceritakan keluhan Anda<textarea name="description" required minLength="10" maxLength="2000" /></label></>}<button type="submit">Kirim {mode === 'order' ? 'pesanan' : 'keluhan'} →</button></form></section>;
}

function SourceBadge({ source }) {
  const color = source === 'WHATSAPP' ? '#25D366' : '#666';
  const label = source === 'WHATSAPP' ? '💬' : '🌐';
  return <span style={{ display: 'inline-block', fontSize: '0.7em', marginLeft: '0.5em', padding: '0.25em 0.5em', backgroundColor: color, color: '#fff', borderRadius: '0.25em' }}>{label} {source}</span>;
}

function WhatsAppChat({ token, conversationId, onClose }) {
  const [messages, setMessages] = useState([]), [newMsg, setNewMsg] = useState(''), [loading, setLoading] = useState(false), [state, setState] = useState('AI_ACTIVE'), [error, setError] = useState('');
  useEffect(() => {
    const reload = () => request(`/admin/whatsapp/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${token}` } }).then(conv => {
      setMessages(conv.messages || []);
      setState(conv.state);
    }).catch(e => console.error(e));
    reload();
    const socket = io(API.replace('/api/v1', ''), { auth: { token } });
    socket.on('whatsapp:message-received', event => Number(event.conversationId) === Number(conversationId) && reload());
    socket.on('whatsapp:conversation-updated', event => Number(event.conversationId) === Number(conversationId) && reload());
    return () => socket.disconnect();
  }, [conversationId, token]);

  const send = async (e) => {
    e.preventDefault();
    if (!newMsg.trim()) return;
    setLoading(true);
    try {
      const result = await request(`/admin/whatsapp/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: newMsg }),
      });
      setMessages([...messages, { sender_type: 'ADMIN', content: newMsg, created_at: new Date().toISOString() }]);
      setState(result.state);
      setNewMsg('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="chat-screen">
      <header className="chat-header"><button onClick={onClose}><X size={18} /></button><div className="chat-avatar"><MessageCircle size={19} /></div><div><b>Percakapan WhatsApp</b><span>{state.replaceAll('_', ' ').toLowerCase()}</span></div>{state !== 'AI_ACTIVE' && <button className="resume-ai" type="button" onClick={async () => { const previous = state; setState('AI_ACTIVE'); try { await request(`/admin/whatsapp/conversations/${conversationId}/state`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ state: 'AI_ACTIVE' }) }); setError(''); } catch (e) { setState(previous); setError(e.message); } }}>Aktifkan AI</button>}</header>
      {error && <p className="error">{error}</p>}
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-line ${msg.sender_type === 'CUSTOMER' ? 'incoming' : 'outgoing'}`}><div className="message-bubble"><small>{msg.sender_type === 'ADMIN' ? 'Admin' : msg.sender_type === 'AI' ? 'AI Sambal Joelid' : 'Pelanggan'}</small><p>{msg.content}</p><time>{new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time></div></div>
        ))}
      </div>
      <form className="chat-compose" onSubmit={send}>
        <textarea value={newMsg} onChange={e => setNewMsg(e.target.value)} placeholder="Ketik balasan untuk pelanggan..." maxLength="500" />
        <button type="submit" disabled={loading} aria-label="Kirim pesan"><Send size={20} /></button>
      </form>
    </aside>
  );
}

function Admin() {
  const [token, setToken] = useState(localStorage.token || ''), [kind, setKind] = useState('dashboard'), [data, setData] = useState([]), [overview, setOverview] = useState({ orders: [], complaints: [], whatsapp: [] }), [health, setHealth] = useState(null), [detail, setDetail] = useState(null), [error, setError] = useState(''), [chatConv, setChatConv] = useState(null), [saving, setSaving] = useState(false);

  const load = () => {
    if (!token) return;
    if (kind === 'dashboard') {
      Promise.all([
        request('/admin/orders', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/complaints', { headers: { Authorization: `Bearer ${token}` } }),
        request('/admin/whatsapp/conversations', { headers: { Authorization: `Bearer ${token}` } }),
      ]).then(([orders, complaints, whatsapp]) => setOverview({ orders: orders.data, complaints: complaints.data, whatsapp: whatsapp.data })).catch(e => setError(e.message));
      request('/admin/integrations/health', { headers: { Authorization: `Bearer ${token}` } }).then(setHealth).catch(e => setHealth({ waha: 'OFFLINE', message: e.message }));
      return;
    }
    const endpoint = kind === 'whatsapp' ? '/admin/whatsapp/conversations' : `/admin/${kind}`;
    request(endpoint, { headers: { Authorization: `Bearer ${token}` } })
      .then(x => setData(x.data || x))
      .catch(e => {
        setError(e.message);
        if (e.message.includes('Autentikasi')) setToken('');
      });
  };

  useEffect(load, [token, kind]);

  useEffect(() => {
    if (!token) return;
    const socket = io(API.replace('/api/v1', ''), { auth: { token } });
    const handlers = {
      'order:new': load,
      'order:updated': load,
      'complaint:new': load,
      'complaint:updated': load,
      'whatsapp:conversation-updated': load,
      'whatsapp:message-received': load,
    };
    Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler));
    return () => socket.disconnect();
  }, [token, kind]);

  if (!token)
    return (
      <section className="login">
        <p className="eyebrow">RUANG OPERASIONAL</p>
        <h2>Masuk sebagai Admin</h2>
        {error && <p className="error">{error}</p>}
        <form
          onSubmit={async e => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              const { token } = await request('/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email: f.get('email'), password: f.get('password') }),
              });
              localStorage.token = token;
              setToken(token);
            } catch (x) {
              setError(x.message);
            }
          }}
        >
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Kata sandi
            <input name="password" type="password" required />
          </label>
          <button>Masuk →</button>
        </form>
      </section>
    );

  const status = kind === 'orders' ? ['NEW', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED'] : kind === 'complaints' ? ['NEW', 'IN_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] : [];
  const open = async id => {
    const endpoint = kind === 'whatsapp' ? `/admin/whatsapp/conversations/${id}` : `/admin/${kind}/${id}`;
    setDetail(await request(endpoint, { headers: { Authorization: `Bearer ${token}` } }));
  };
  const change = async e => {
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

  if (chatConv) return <section className="admin"><WhatsAppChat token={token} conversationId={chatConv.id} onClose={() => setChatConv(null)} /></section>;

  const title = kind === 'dashboard' ? 'Ikhtisar' : kind === 'orders' ? 'Pesanan' : kind === 'complaints' ? 'Keluhan' : 'Percakapan WhatsApp';
  const newCount = data.filter(item => ['NEW', 'WAITING_ADMIN'].includes(item.status || item.state)).length;
  const activeCount = data.filter(item => ['CONFIRMED', 'PROCESSING', 'IN_REVIEW', 'IN_PROGRESS', 'ADMIN_ACTIVE'].includes(item.status || item.state)).length;
  const statusLabel = value => ({ NEW: 'Baru', CONFIRMED: 'Dikonfirmasi', PROCESSING: 'Diproses', COMPLETED: 'Selesai', CANCELLED: 'Dibatalkan', IN_REVIEW: 'Ditinjau', IN_PROGRESS: 'Ditangani', RESOLVED: 'Terselesaikan', CLOSED: 'Ditutup', AI_ACTIVE: 'AI aktif', WAITING_ADMIN: 'Menunggu admin', ADMIN_ACTIVE: 'Admin aktif' }[value] || value);

  return (
    <section className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span>SJ</span><div><b>Sambal Joelid</b><small>Operations</small></div></div>
        <nav>
          <button className={kind === 'dashboard' ? 'active' : ''} onClick={() => { setKind('dashboard'); setDetail(null); }}><LayoutDashboard /> Ikhtisar</button>
          <button className={kind === 'orders' ? 'active' : ''} onClick={() => { setKind('orders'); setDetail(null); }}><ShoppingCart /> Pesanan <i>{kind === 'orders' ? data.length : ''}</i></button>
          <button className={kind === 'complaints' ? 'active' : ''} onClick={() => { setKind('complaints'); setDetail(null); }}><Headphones /> Keluhan <i>{kind === 'complaints' ? data.length : ''}</i></button>
          <button className={kind === 'whatsapp' ? 'active' : ''} onClick={() => { setKind('whatsapp'); setDetail(null); }}><MessageCircle /> WhatsApp <i>{kind === 'whatsapp' ? data.length : ''}</i></button>
        </nav>
        <div className="sidebar-foot"><span className="online-dot" /> Sistem online<button onClick={() => { localStorage.removeItem('token'); setToken(''); }}>Keluar →</button></div>
      </aside>
      <div className="admin-workspace">
        <header className="admin-topbar"><div><p className="eyebrow">SAMBAL JOELID / ADMIN</p><h1>Dashboard Admin</h1><p>Pantau pesanan, keluhan, dan percakapan pelanggan secara real-time.</p></div><div className="admin-profile"><span>AD</span><b>Admin</b></div></header>
        {kind === 'dashboard' ? <><div className="metric-grid overview-metrics">
          <article><ShoppingCart /><small>Pesanan</small><strong>{overview.orders.length}</strong><span>{overview.orders.filter(x => x.status === 'NEW').length} pesanan baru</span></article>
          <article><Headphones /><small>Keluhan</small><strong>{overview.complaints.length}</strong><span>{overview.complaints.filter(x => x.status === 'NEW').length} perlu ditinjau</span></article>
          <article><MessageCircle /><small>WhatsApp</small><strong>{overview.whatsapp.length}</strong><span>{overview.whatsapp.filter(x => x.state === 'WAITING_ADMIN').length} menunggu admin</span></article>
        </div><div className={`integration-status ${health?.waha === 'ONLINE' ? 'healthy' : 'degraded'}`}><Wifi /><div><b>Integrasi WhatsApp: {health?.waha || 'Memeriksa...'}</b><span>{health?.waha === 'ONLINE' ? 'WAHA dapat diakses. Pesan masuk dipantau secara real-time.' : health?.message || 'Status sedang diperiksa.'}</span></div></div></> : <div className="metric-grid">
          <article><small>Data {title}</small><strong>{data.length}</strong><span>Total saat ini</span></article>
          <article><small>Perlu perhatian</small><strong>{newCount}</strong><span>Baru atau menunggu</span></article>
          <article><small>Sedang aktif</small><strong>{activeCount}</strong><span>Dalam penanganan</span></article>
        </div>}
        {error && <p className="error">{error}</p>}
        {kind !== 'dashboard' && <div className={`admin-panel ${detail ? 'has-detail' : ''}`}>
          <section className="data-panel">
            <div className="panel-heading"><div><p className="eyebrow">MEJA OPERASIONAL</p><h2>{title}</h2></div><span>{data.length} data</span></div>
            <div className="table-head"><span>Referensi</span><span>Pelanggan / Cabang</span><span>Status</span></div>
            <div className="table">
              {data.map(x => <button className={`row ${detail?.id === x.id ? 'selected' : ''}`} key={x.id} onClick={() => { open(x.id); setChatConv(null); }}>
                <b>{x.reference_number || `+${x.phone}`}</b>
                <span>{x.customer_name || 'Pelanggan WhatsApp'}<small>{kind !== 'whatsapp' ? x.branch_name || 'Tanpa cabang' : 'Percakapan langsung'}</small></span>
                <em className={`status-badge status-${(x.status || x.state).toLowerCase()}`}>{statusLabel(x.status || x.state)}</em>
              </button>)}
              {!data.length && <div className="empty-state"><b>Belum ada data</b><span>Data baru akan muncul otomatis di sini.</span></div>}
            </div>
          </section>
          {detail && <aside className="detail-panel">
            <div className="detail-heading"><div><p className="eyebrow">DETAIL</p><h3>{detail.reference_number || `+${detail.phone}`}</h3></div><button onClick={() => setDetail(null)}>×</button></div>
            <div className="customer-card"><small>Pelanggan</small><b>{detail.customer_name || 'Pelanggan WhatsApp'}</b><span>{detail.customer_phone || detail.phone}</span></div>
            {detail.items?.length > 0 && <div className="order-items"><small>Rincian pesanan</small>{detail.items.map(i => <div key={i.id}><span>{i.menu_name_snapshot} × {i.quantity}</span><b>{currency(i.subtotal)}</b></div>)}</div>}
            {kind === 'whatsapp' ? <>
              <label>Mode percakapan<select disabled={saving} value={detail.state} onChange={change}><option value="AI_ACTIVE">AI aktif</option><option value="WAITING_ADMIN">Menunggu admin</option><option value="ADMIN_ACTIVE">Admin aktif</option></select></label>
              <p className="field-help">Mode admin bersifat sementara. AI akan aktif kembali otomatis setelah jeda berakhir.</p>
              <button className="primary-action" onClick={() => setChatConv(detail)}>Buka percakapan →</button>
            </> : <>
              <label>Status<select disabled={saving} value={detail.status} onChange={change}>{status.map(s => <option value={s} key={s}>{statusLabel(s)}</option>)}</select></label>
              {detail.source === 'WHATSAPP' && detail.conversation_id && <button className="primary-action chat-link" onClick={() => setChatConv({ id: detail.conversation_id })}><MessageCircle size={16} /> Buka percakapan</button>}
              {kind === 'complaints' && <label>Catatan internal<textarea defaultValue={detail.admin_notes || ''} onBlur={async e => { try { await request(`/admin/complaints/${detail.id}/notes`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ adminNotes: e.target.value || null }) }); } catch (noteError) { setError(noteError.message); } }} /></label>}
            </>}
          </aside>}
        </div>}
      </div>
    </section>
  );
}

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

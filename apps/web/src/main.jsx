import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './style.css';

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api/v1';
const currency = (v) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(v);
const request = async (path, options = {}) => { const response = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || 'Permintaan gagal'); return response.status === 204 ? null : response.json(); };

function Customer({ mode, setMode }) {
  const [menus, setMenus] = useState([]), [branches, setBranches] = useState([]), [sent, setSent] = useState(null), [error, setError] = useState('');
  useEffect(() => { Promise.all([request('/public/menu'), request('/public/branches')]).then(([m,b]) => { setMenus(m); setBranches(b); }).catch(() => setError('Menu belum dapat dimuat. Silakan coba lagi.')); }, []);
  const sendOrder = async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); const items = menus.map(m => ({ menuId:m.id, quantity:Number(fd.get(`qty-${m.id}`)) })).filter(i => i.quantity > 0); try { setSent(await request('/public/orders', { method:'POST', body:JSON.stringify({ customerName:fd.get('name'), customerPhone:fd.get('phone'), branchId:fd.get('branch'), notes:fd.get('notes'), items }) })); } catch(e) { setError(e.message); } };
  const sendComplaint = async (e) => { e.preventDefault(); const fd=new FormData(e.currentTarget); try { setSent(await request('/public/complaints', {method:'POST',body:JSON.stringify({customerName:fd.get('name'),customerPhone:fd.get('phone'),branchId:fd.get('branch')||undefined,category:fd.get('category')||undefined,description:fd.get('description')})})); } catch(e) {setError(e.message);} };
  if (sent) return <section className="success"><p className="eyebrow">TERCATAT</p><h2>Terima kasih, {mode === 'order' ? 'pesanan' : 'keluhan'} Anda sudah kami terima.</h2><strong>{sent.referenceNumber}</strong>{sent.totalAmount && <p>Total: {currency(sent.totalAmount)}</p>}<button onClick={() => {setSent(null);setMode('home');}}>Kembali ke awal</button></section>;
  if (mode === 'home') return <section className="choices"><p className="eyebrow">SAMBAL JOELID</p><h1>Mau kami bantu apa hari ini?</h1><button className="choice order" onClick={() => setMode('order')}><b>Pesan makanan</b><span>Pilih menu, atur jumlah, kirim pesanan.</span></button><button className="choice complaint" onClick={() => setMode('complaint')}><b>Sampaikan keluhan</b><span>Ceritakan pengalaman Anda agar kami perbaiki.</span></button></section>;
  return <section className="form-wrap"><button className="back" onClick={() => setMode('home')}>← Kembali</button><p className="eyebrow">{mode === 'order' ? 'PESANAN BARU' : 'DENGAR DARI ANDA'}</p><h2>{mode === 'order' ? 'Racik pesanan Anda' : 'Sampaikan keluhan Anda'}</h2>{error && <p className="error">{error}</p>}<form onSubmit={mode === 'order' ? sendOrder : sendComplaint}><label>Nama<input name="name" required minLength="2" /></label><label>Nomor WhatsApp<input name="phone" required placeholder="0812..." inputMode="tel" /></label><label>Cabang<select name="branch" required={mode === 'order'}><option value="">Pilih cabang</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>{mode === 'order' ? <><div className="menu-list">{menus.map(m=><label className="menu" key={m.id}><span><b>{m.name}</b><small>{currency(m.price)}</small></span><input name={`qty-${m.id}`} type="number" min="0" max="99" defaultValue="0" /></label>)}</div><label>Catatan untuk pesanan<textarea name="notes" maxLength="500" /></label></> : <><label>Kategori<select name="category"><option value="">Pilih kategori</option><option value="KUALITAS_MAKANAN">Kualitas makanan</option><option value="PELAYANAN">Pelayanan</option><option value="KEBERSIHAN">Kebersihan</option><option value="PESANAN">Pesanan</option><option value="LAINNYA">Lainnya</option></select></label><label>Ceritakan keluhan Anda<textarea name="description" required minLength="10" maxLength="2000" /></label></>}<button type="submit">Kirim {mode === 'order' ? 'pesanan' : 'keluhan'} →</button></form></section>;
}

function SourceBadge({ source }) {
  const color = source === 'WHATSAPP' ? '#25D366' : '#666';
  const label = source === 'WHATSAPP' ? '💬' : '🌐';
  return <span style={{ display: 'inline-block', fontSize: '0.7em', marginLeft: '0.5em', padding: '0.25em 0.5em', backgroundColor: color, color: '#fff', borderRadius: '0.25em' }}>{label} {source}</span>;
}

function WhatsAppChat({ token, conversationId, onClose }) {
  const [messages, setMessages] = useState([]), [newMsg, setNewMsg] = useState(''), [loading, setLoading] = useState(false), [state, setState] = useState('AI_ACTIVE'), [error, setError] = useState('');
  useEffect(() => {
    request(`/admin/whatsapp/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${token}` } }).then(conv => {
      setMessages(conv.messages || []);
      setState(conv.state);
    }).catch(e => console.error(e));
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
    <aside style={{ display: 'flex', flexDirection: 'column', gap: '1em', maxHeight: '80vh', overflow: 'hidden' }}>
      <button onClick={onClose} style={{ alignSelf: 'flex-end' }}>✕ Tutup</button>
      <div><strong>Mode: {state}</strong>{state !== 'AI_ACTIVE' && <button type="button" onClick={async () => { try { await request(`/admin/whatsapp/conversations/${conversationId}/state`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ state: 'AI_ACTIVE' }) }); setState('AI_ACTIVE'); setError(''); } catch (e) { setError(e.message); } }} style={{ marginLeft: '1em' }}>Aktifkan AI sekarang</button>}</div>
      {error && <p className="error">{error}</p>}
      <div style={{ flex: 1, overflowY: 'auto', borderBottom: '1px solid #ddd', paddingBottom: '1em' }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: '0.5em', fontSize: '0.9em', color: msg.sender_type === 'ADMIN' ? '#0084ff' : '#333' }}>
            <strong>{msg.sender_type === 'ADMIN' ? 'Admin' : msg.sender_type === 'AI' ? 'AI' : 'Pelanggan'}:</strong> {msg.content}
          </div>
        ))}
      </div>
      <form onSubmit={send} style={{ display: 'flex', gap: '0.5em' }}>
        <textarea value={newMsg} onChange={e => setNewMsg(e.target.value)} placeholder="Ketik pesan..." maxLength="500" style={{ flex: 1, minHeight: '3em' }} />
        <button type="submit" disabled={loading}>Kirim</button>
      </form>
    </aside>
  );
}

function Admin() {
  const [token, setToken] = useState(localStorage.token || ''), [kind, setKind] = useState('orders'), [data, setData] = useState([]), [detail, setDetail] = useState(null), [error, setError] = useState(''), [chatConv, setChatConv] = useState(null);

  const load = () => {
    if (!token) return;
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
    try {
      setError('');
      if (kind === 'whatsapp') {
      await request(`/admin/whatsapp/conversations/${detail.id}/state`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: e.target.value }),
      });
      setDetail({ ...detail, state: e.target.value });
      } else {
      await request(`/admin/${kind}/${detail.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: e.target.value }),
      });
      setDetail({ ...detail, status: e.target.value });
      }
      load();
    } catch (changeError) {
      setError(changeError.message);
    }
  };

  if (chatConv) return <section className="admin"><WhatsAppChat token={token} conversationId={chatConv.id} onClose={() => setChatConv(null)} /></section>;

  return (
      <section className="admin">
      <header>
        <span className="stamp">SJ</span>
        <div>
          <p className="eyebrow">ADMIN</p>
          <h2>Meja kendali</h2>
        </div>
        <button className="logout" onClick={() => { localStorage.removeItem('token'); setToken(''); }}>
          Keluar
        </button>
      </header>
      <nav>
        <button className={kind === 'orders' ? 'active' : ''} onClick={() => { setKind('orders'); setDetail(null); }}>
          Pesanan
        </button>
        <button className={kind === 'complaints' ? 'active' : ''} onClick={() => { setKind('complaints'); setDetail(null); }}>
          Keluhan
        </button>
        <button className={kind === 'whatsapp' ? 'active' : ''} onClick={() => { setKind('whatsapp'); setDetail(null); }}>
          WhatsApp
        </button>
      </nav>
      {error && <p className="error">{error}</p>}
      <div className="admin-grid">
        <div className="table">
          {data.map(x => (
            <button className="row" key={x.id} onClick={() => { open(x.id); setChatConv(null); }}>
              <b>{x.reference_number || x.phone}</b>
              <span>
                {x.customer_name || 'Chat WhatsApp'} {kind !== 'whatsapp' && <>· {x.branch_name || '—'}</>}
              </span>
              <em>
                {x.status || x.state} {kind !== 'whatsapp' && x.source && <SourceBadge source={x.source} />}
              </em>
            </button>
          ))}
          {!data.length && <p>Belum ada data.</p>}
        </div>
        {detail && (
          <aside>
            <p className="eyebrow">DETAIL</p>
            <h3>{detail.reference_number || detail.phone}</h3>
            <p>
              {detail.customer_name}<br />
              {detail.customer_phone}
            </p>
            {detail.items && (
              <ul>
                {detail.items.map(i => (
                  <li key={i.id}>
                    {i.menu_name_snapshot} × {i.quantity} — {currency(i.subtotal)}
                  </li>
                ))}
              </ul>
            )}
            {kind === 'whatsapp' ? (
              <>
                <label>
                  State
                  <select value={detail.state} onChange={change}>
                    <option>AI_ACTIVE</option>
                    <option>WAITING_ADMIN</option>
                    <option>ADMIN_ACTIVE</option>
                  </select>
                </label>
                <button onClick={() => setChatConv(detail)} style={{ width: '100%', marginTop: '1em' }}>
                  💬 Buka Chat
                </button>
              </>
            ) : (
              <>
                <label>
                  Status
                  <select value={detail.status} onChange={change}>
                    {status.map(s => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                {kind === 'complaints' && (
                  <label>
                    Catatan internal
                    <textarea
                      defaultValue={detail.admin_notes || ''}
                      onBlur={async e => {
                        await request(`/admin/complaints/${detail.id}/notes`, {
                          method: 'PATCH',
                          headers: { Authorization: `Bearer ${token}` },
                          body: JSON.stringify({ adminNotes: e.target.value || null }),
                        });
                      }}
                    />
                  </label>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}

function App() {
  const [tab, setTab] = useState('customer'), [mode, setMode] = useState('home');
  return (
    <main>
      <div className="tabs">
        <button className={tab === 'customer' ? 'selected' : ''} onClick={() => setTab('customer')}>
          Untuk pelanggan
        </button>
        <button className={tab === 'admin' ? 'selected' : ''} onClick={() => setTab('admin')}>
          Admin
        </button>
      </div>
      {tab === 'customer' ? <Customer mode={mode} setMode={setMode} /> : <Admin />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);

# PRD — WAHA WhatsApp & AI Customer Assistant

**Produk:** Sambal Joelid  
**Versi:** 1.0  
**Status:** Baseline telah diimplementasikan; dokumen dipertahankan sebagai acuan requirement
**Tanggal:** 9 November 2026  
**Dokumen terkait:** `docs/deployment-vps-vercel.html`

> Catatan implementasi 12 November 2026: katalog aktif berasal dari published CSV dengan cache, dashboard customer/admin dipisahkan, handoff admin bersifat sementara dan otomatis kembali ke AI, chat admin menggunakan realtime bubble view, serta pembayaran memakai kerangka transfer manual opsional—bukan payment gateway. Detail operasional terkini berada di folder `docs/`.

---

## 1. Ringkasan

Sambal Joelid saat ini memiliki customer web, API Express, SQLite, dashboard admin, dan realtime Socket.IO. Pengembangan ini menambahkan WhatsApp sebagai kanal percakapan pelanggan dengan WAHA sebagai WhatsApp HTTP API dan AI sebagai asisten respons.

Pesan WhatsApp yang merupakan pesanan atau keluhan harus masuk ke database dan dashboard admin yang sama dengan customer web. AI membantu menjawab, mengklasifikasikan, dan mengekstrak data, tetapi backend tetap menjadi sumber kebenaran untuk harga, katalog, status, dan penyimpanan transaksi.

## 2. Tujuan

1. Pelanggan dapat menghubungi bisnis melalui WhatsApp.
2. AI dapat memberikan respons percakapan dasar sesuai kebijakan bisnis.
3. AI dapat mengenali intent pesanan dan keluhan.
4. Pesanan dan keluhan WhatsApp tersimpan pada modul yang sama dengan customer web.
5. Admin menerima notifikasi realtime dan dapat mengambil alih percakapan.
6. Integrasi tidak mengubah atau mengganggu customer web, dashboard, SQLite, atau konfigurasi Termux existing.

## 3. Batasan dan Non-Goal

- WAHA adalah layanan terpisah dari aplikasi Sambal Joelid dan berjalan dengan Docker pada VPS.
- WAHA tidak boleh dipasang di Vercel, tidak boleh masuk ke frontend, dan tidak boleh membuka port API WAHA ke internet.
- Integrasi ini tidak menggantikan WhatsApp Cloud API resmi Meta. WAHA berbasis WhatsApp Web sehingga terdapat risiko logout, pembatasan, atau perubahan perilaku platform.
- Nomor WhatsApp utama/pribadi tidak boleh digunakan untuk pengujian awal; gunakan nomor bisnis khusus.
- AI tidak boleh mengubah harga, status, data master, atau membuat pengembalian dana secara otomatis.
- AI tidak boleh mengakses catatan internal admin.
- Fitur pembayaran, stok real-time, refund otomatis, dan broadcast massal bukan bagian dari scope awal.

## 4. Arsitektur Target

```text
Pelanggan WhatsApp
        │
        ▼
WAHA container (VPS, jaringan internal saja)
        │ webhook / REST
        ▼
Sambal Joelid API (Express)
 ├─ validasi webhook dan deduplikasi pesan
 ├─ AI orchestration
 ├─ order / complaint service
 ├─ SQLite customer module
 └─ Socket.IO
        │
        ▼
Dashboard Admin di Vercel
```

| Komponen | Lokasi |
|---|---|
| Aplikasi utama | `/var/www/sambal-joelid` |
| WAHA runtime/config | `/opt/waha` |
| WAHA session persistent | `/var/lib/waha` |
| SQLite Sambal Joelid | `/var/lib/sambal-joelid/customer-module.sqlite` |
| Frontend | Vercel / `joelid.hontalk.my.id` |
| API publik | VPS / `api.joelid.hontalk.my.id` |

## 5. Aktor

| Aktor | Hak dan kebutuhan |
|---|---|
| Pelanggan WhatsApp | Mengirim pertanyaan, pesanan, atau keluhan; menerima respons dan nomor referensi. |
| AI Assistant | Menjawab sesuai kebijakan, meminta klarifikasi, menghasilkan draft terstruktur. |
| Admin | Melihat order/keluhan WhatsApp, mengambil alih percakapan, mengubah status, dan melihat catatan internal. |
| Backend | Memvalidasi data, menghitung harga, menyimpan transaksi, dan mengirim event realtime. |

## 6. Functional Requirements

### 6.1 WAHA Session

1. WAHA harus berjalan sebagai Docker container dengan restart policy.
2. Session WhatsApp harus disimpan pada persistent volume di VPS.
3. QR login hanya dapat diakses admin VPS yang berwenang.
4. Health check WAHA harus tersedia untuk monitoring internal.
5. WAHA API harus memakai API key dan hanya listen pada loopback atau jaringan Docker internal.

### 6.2 Pesan Masuk

1. API menerima event pesan masuk dari WAHA pada endpoint webhook khusus.
2. Webhook harus memverifikasi secret/API key, ukuran payload, dan tipe event.
3. Message ID WAHA harus disimpan/diperiksa agar event duplikat tidak menghasilkan respons atau transaksi ganda.
4. Pesan dari grup, channel, status, pesan milik sendiri, dan tipe media yang tidak didukung harus diabaikan dengan aman pada fase awal.
5. Nomor telepon dinormalisasi ke format internasional sebelum digunakan sebagai customer phone.

### 6.3 AI Customer Assistant

1. AI hanya menerima konteks percakapan minimum yang diperlukan.
2. AI dapat mengenali minimal intent: `GENERAL_QUESTION`, `ORDER`, `COMPLAINT`, `HANDOFF`, dan `UNKNOWN`.
3. AI harus meminta klarifikasi untuk nama, nomor, cabang, item, atau kuantitas yang belum jelas.
4. AI harus menggunakan katalog backend sebagai konteks; tidak boleh mengarang menu, harga, promo, atau status pesanan.
5. Jika provider AI timeout/gagal, backend mengirim respons fallback yang meminta pelanggan menunggu admin.
6. Tambahkan rate limit per nomor pelanggan dan batas concurrency AI.

### 6.4 Pesanan WhatsApp

1. AI menghasilkan draft order terstruktur; backend memvalidasi branch, menu, dan quantity.
2. Harga unit, subtotal, dan total dihitung ulang dari sumber master backend.
3. Sebelum create order, pelanggan menerima ringkasan dan harus melakukan konfirmasi eksplisit.
4. Setelah konfirmasi dan transaksi SQLite berhasil, backend membuat order dengan `source=WHATSAPP` dan mengirim nomor referensi.
5. Event `order:new` hanya dipancarkan setelah database commit sukses.
6. Jika validasi gagal, transaksi tidak dibuat dan AI meminta koreksi pelanggan.

### 6.5 Keluhan WhatsApp

1. AI mengumpulkan nama, nomor WhatsApp, cabang opsional, kategori opsional, dan deskripsi keluhan.
2. Pelanggan menerima ringkasan keluhan sebelum submit bila data mencukupi.
3. Setelah database commit sukses, backend membuat complaint dengan `source=WHATSAPP`, mengirim nomor referensi, dan memancarkan `complaint:new`.
4. Catatan internal admin tidak boleh dikirim ke WAHA atau pelanggan.

### 6.6 Human Handoff

1. Kata kunci seperti `admin`, `operator`, dan `manusia` harus membuat AI berhenti membalas otomatis untuk percakapan tersebut.
2. Admin dapat mengaktifkan kembali AI setelah handoff selesai.
3. Dashboard menampilkan status percakapan: `AI_ACTIVE`, `WAITING_ADMIN`, atau `ADMIN_ACTIVE`.
4. Pesan admin yang dikirim melalui dashboard harus dikirim melalui WAHA dan tidak diproses ulang sebagai pesan customer.

### 6.7 Dashboard Admin

1. Order dan complaint menampilkan sumber kanal: `WEB` atau `WHATSAPP`.
2. Admin menerima event realtime untuk order/complaint dari WhatsApp.
3. Akses percakapan dan data nomor pelanggan dilindungi autentikasi admin existing.
4. Dashboard tidak menampilkan QR WAHA, API key, token AI, atau secret lain.

## 7. Data Requirements

Tambahkan migration additive, tanpa mengubah atau menghapus tabel existing:

| Tabel/kolom | Kebutuhan minimum |
|---|---|
| `customer_orders.source` | `WEB` atau `WHATSAPP`, default `WEB`. |
| `customer_complaints.source` | `WEB` atau `WHATSAPP`, default `WEB`. |
| `whatsapp_conversations` | Nomor pelanggan ter-normalisasi, session WAHA, state handoff, timestamps. |
| `whatsapp_messages` | WAHA message ID unik, direction, type, metadata minimum, processing state, timestamp. |
| `whatsapp_pending_actions` | Draft order/complaint, state konfirmasi, expiration, idempotency key. |

Retention isi pesan harus dapat dikonfigurasi. Hindari menyimpan isi percakapan lebih lama dari kebutuhan operasional. Jangan simpan QR, credential, token, atau session key WAHA di SQLite aplikasi.

## 8. API dan Event (Rancangan)

| Jenis | Endpoint / Event | Akses |
|---|---|---|
| WAHA webhook | `POST /api/v1/integrations/waha/webhook` | WAHA internal + secret |
| WAHA health proxy (opsional) | Tidak dipublikasikan | Internal VPS saja |
| Admin conversation detail | `GET /api/v1/admin/whatsapp/conversations/:id` | Admin JWT |
| Admin handoff | `PATCH /api/v1/admin/whatsapp/conversations/:id/state` | Admin JWT |
| Admin send message | `POST /api/v1/admin/whatsapp/conversations/:id/messages` | Admin JWT |
| Realtime | `whatsapp:conversation-updated` | Admin Socket.IO |
| Realtime | `whatsapp:message-received` | Admin Socket.IO, metadata aman |

Endpoint, payload WAHA, dan format signature harus disesuaikan dengan dokumentasi WAHA versi yang dipin sebelum implementasi.

## 9. Security & Privacy Requirements

1. Docker WAHA tidak mempublikasikan port `3000` pada public interface.
2. WAHA API key, AI API key, webhook secret, dan session data hanya tersedia melalui environment file permission ketat.
3. Request WAHA harus diverifikasi dan deduplicated.
4. Semua input AI dan WhatsApp divalidasi server-side dengan schema eksplisit.
5. AI output diperlakukan sebagai data tidak tepercaya; jangan mengeksekusi instruksi/tool call tanpa allowlist.
6. Log tidak boleh mencatat isi pesan pelanggan, token, QR, maupun Authorization header.
7. Backup SQLite tidak boleh secara tidak sengaja mengunggah secret WAHA/session ke storage publik.
8. Admin endpoint tetap harus melalui HTTPS, JWT, dan otorisasi backend.

## 10. Konfigurasi Environment (Rancangan)

```env
# Sambal Joelid API — jangan commit nilai asli
WAHA_BASE_URL=http://127.0.0.1:3000
WAHA_API_KEY=<secret>
WAHA_WEBHOOK_SECRET=<secret>
WAHA_SESSION_NAME=sambal-joelid

AI_PROVIDER=gemini
AI_API_KEY=<secret>
AI_MODEL=<model-name>
AI_TIMEOUT_SECONDS=20
AI_MAX_CONCURRENCY=1

WHATSAPP_RATE_LIMIT_WINDOW_SECONDS=60
WHATSAPP_RATE_LIMIT_MAX_MESSAGES=8
```

## 11. Testing & Acceptance Criteria

Pengembangan diterima bila:

1. WAHA berjalan ulang otomatis dan session bertahan setelah restart VPS.
2. Port WAHA tidak dapat diakses dari publik.
3. Pesan WhatsApp valid diterima satu kali walaupun webhook diulang.
4. AI menjawab pertanyaan umum dengan fallback aman saat provider gagal.
5. Pesanan WhatsApp hanya tercipta setelah validasi backend dan konfirmasi pelanggan.
6. Harga snapshot order WhatsApp dihitung backend dan tidak berasal dari AI/pelanggan.
7. Keluhan WhatsApp tersimpan terpisah dari pesanan dan membuat nomor referensi unik.
8. Order/complaint WhatsApp muncul realtime pada dashboard admin.
9. Handoff menghentikan respons AI sampai admin mengaktifkannya kembali.
10. User tanpa JWT admin tidak dapat melihat percakapan atau mengirim pesan.
11. Customer tidak dapat mengakses order/complaint/conversation pelanggan lain.
12. Test restart WAHA, API, dan backup tidak menyebabkan pesan/transaksi duplikat.

## 12. Keputusan Wajib Sebelum Implementasi

1. Provider AI yang digunakan: Gemini, OpenAI, atau lainnya.
2. Nomor WhatsApp bisnis khusus untuk WAHA.
3. Bahasa, tone, jam operasional, dan daftar kondisi handoff ke admin.
4. Aturan konfirmasi order: customer confirmation wajib (direkomendasikan) atau admin confirmation wajib.
5. Kebijakan retensi isi percakapan dan akses dashboard.
6. Versi/image WAHA yang dipin serta strategi update/rollback.

## 13. Tahapan Implementasi

1. Review dokumentasi WAHA versi terpilih dan persetujuan keputusan di bagian 12.
2. Pasang Docker dan WAHA terisolasi di VPS; uji QR/session/health internal.
3. Tambahkan WAHA client dan webhook security pada API.
4. Tambahkan migrasi SQLite additive serta idempotency.
5. Tambahkan AI provider abstraction, intent extraction, fallback, dan rate limiting.
6. Tambahkan order/complaint WhatsApp dengan konfirmasi pelanggan.
7. Tambahkan admin handoff, conversation view, dan Socket.IO event.
8. Jalankan test integrasi, security review, backup/restart test, dan regression test web existing.
9. Dokumentasikan prosedur operasi QR reconnect, key rotation, monitoring, backup, dan rollback.

---

**Prinsip utama:** WAHA dan AI memperluas kanal pelanggan, bukan menggantikan validasi backend maupun dashboard admin. Database dan service order/complaint existing tetap menjadi sumber data utama.

# Sambal Joelid — Customer Order & Complaint

Monorepo mandiri untuk customer web chat dan pengelolaan order/keluhan admin.

## Jalankan lokal

1. Salin `.env.example` menjadi `.env`, lalu isi `JWT_SECRET` dan password admin.
2. `npm install`
3. Terminal 1: `npm run dev:api`
4. Terminal 2: `npm run dev:web`
5. Buka `http://localhost:5173` untuk customer atau `http://localhost:5173/admin` untuk login admin.

Pada build terbaru, akses customer berada di `/` dan dashboard admin berada di `/admin` atau hostname admin terpisah. Dashboard menyediakan ikhtisar, status integrasi, pengelolaan order/keluhan, state handoff, dan bubble chat WhatsApp realtime.

API membuat SQLite di `CUSTOMER_MODULE_DB_PATH`, menjalankan schema migration aman, dan mengisi seed menu/cabang awal. Seed ini hanya fallback pengembangan. Menu production adalah tabel `menus` + `menu_aliases` di SQLite dan diedit dari tab **Pengaturan** dashboard; CSV hanya untuk import manual.

## Production

- Web: deploy `apps/web` ke Vercel dengan `VITE_API_BASE_URL=https://api.example.com/api/v1`.
- API: jalankan `apps/api` di VPS sebagai service, dengan `CUSTOMER_MODULE_DB_PATH=/var/lib/sambal-joelid/customer-module.sqlite`.
- Set `CORS_ORIGINS` ke domain Vercel resmi dan gunakan HTTPS reverse proxy.
- Backup SQLite: gunakan `.backup` SQLite atau `VACUUM INTO` secara terjadwal ke storage berbeda; jangan menyalin file aktif pada mode WAL secara langsung.

Spreadsheet CSV pada `MENU_CSV_URL` adalah sumber utama menu. SQLite menyimpan salinan terakhir yang valid: sinkron dilakukan saat startup, setiap `MENU_SYNC_INTERVAL_MS` (default 300000 ms), atau lewat tombol "Sinkron sekarang" di dashboard. Kolom CSV yang didukung: `kode`, `nama`, `harga`, `stok`, `aktif`, `alias` (alias dipisahkan `|` atau koma). Menu yang hilang dari CSV dinonaktifkan; CSV rusak, kosong, atau penurunan jumlah menu > 50% tidak mengganti data lama. Edit menu dan alias hanya melalui spreadsheet, bukan dashboard. Item nonaktif atau tanpa stok tidak dapat dipesan. Deployment VPS menggunakan `ops/deploy-vps.sh`, yang melakukan backup, instalasi dependency native, test, restart service, dan health check secara berurutan.

## Bot WhatsApp

Pipeline pesan: **rules → fuzzy menu → LLM (ekstraksi JSON) → tanya balik/handoff**. LLM tidak pernah menulis balasan pelanggan dan tidak menerima seluruh daftar menu; prompt hanya berisi 3–5 kandidat hasil fuzzy.

- Normalisasi tunggal `apps/api/src/normalize.js` dipakai untuk semua pencocokan. Data yang disimpan/ditampilkan tetap teks asli.
- Webhook WAHA membalas `200` segera, lalu memproses lewat debounce 4 detik per nomor dan antrian global concurrency 1.
- Timeout LLM 25 detik. Bila LLM mati/timeout atau dua kali tidak paham, percakapan masuk mode handoff (`WAITING_ADMIN`) dan bot berhenti sampai admin mengaktifkan kembali.
- Media (gambar/dokumen/voice note) di-handoff ke staf, tidak dibuang diam-diam.
- Log pesan tersimpan di `wa_message_logs`; pesan gagal muncul di tab Pengaturan untuk dijadikan alias menu atau dikirim ke test set.

Jalankan test dan evaluasi:

```bash
npm --workspace @sambal-joelid/api test
cd apps/api
node test/eval/run.js                  # rules + fuzzy, tanpa LLM
node test/eval/run.js --live           # butuh llama-server; target akurasi >=85%
```

Deployment artifacts tersedia dalam `ops/`: systemd API, systemd timer backup, Nginx proxy untuk `api.joelid.hontalk.my.id`, dan skrip backup yang aman untuk SQLite WAL. Frontend production menggunakan `https://joelid.hontalk.my.id`. Salin `.env.vps.example` ke `.env` hanya pada VPS. Konfigurasi ini tidak berlaku untuk Termux; lihat komentar `TERMUX NOTE` pada file tersebut.

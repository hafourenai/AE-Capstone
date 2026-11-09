# Sambal Joelid — Customer Order & Complaint

Monorepo mandiri untuk customer web chat dan pengelolaan order/keluhan admin.

## Jalankan lokal

1. Salin `.env.example` menjadi `.env`, lalu isi `JWT_SECRET` dan password admin.
2. `npm install`
3. Terminal 1: `npm run dev:api`
4. Terminal 2: `npm run dev:web`
5. Buka `http://localhost:5173`. Login admin ada di tab **Admin**.

API membuat SQLite di `CUSTOMER_MODULE_DB_PATH`, menjalankan schema migration aman, dan mengisi seed menu/cabang awal. Seed ini hanya fallback pengembangan; ganti adaptor `catalog` di `apps/api/src/index.js` dengan sumber master production sebelum go-live.

## Production

- Web: deploy `apps/web` ke Vercel dengan `VITE_API_BASE_URL=https://api.example.com/api/v1`.
- API: jalankan `apps/api` di VPS sebagai service, dengan `CUSTOMER_MODULE_DB_PATH=/var/lib/sambal-joelid/customer-module.sqlite`.
- Set `CORS_ORIGINS` ke domain Vercel resmi dan gunakan HTTPS reverse proxy.
- Backup SQLite: gunakan `.backup` SQLite atau `VACUUM INTO` secara terjadwal ke storage berbeda; jangan menyalin file aktif pada mode WAL secara langsung.

Deployment artifacts tersedia dalam `ops/`: systemd API, systemd timer backup, Nginx proxy untuk `api.joelid.hontalk.my.id`, dan skrip backup yang aman untuk SQLite WAL. Frontend production menggunakan `https://joelid.hontalk.my.id`. Salin `.env.vps.example` ke `.env` hanya pada VPS. Konfigurasi ini tidak berlaku untuk Termux; lihat komentar `TERMUX NOTE` pada file tersebut.

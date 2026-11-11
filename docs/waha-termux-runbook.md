# Runbook WAHA VPS + Qwen Termux

Arsitektur: WAHA dan API berjalan di VPS. Qwen 2.5 1.5B Instruct berjalan di HP/Termux melalui endpoint OpenAI-compatible yang ditunnel secara HTTPS.

## 1. Siapkan secret di VPS

Jalankan tiga kali dan simpan hasilnya secara terpisah:

```bash
openssl rand -hex 32
```

Gunakan hasil untuk `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET`, dan `AI_API_KEY`. Jangan kirim nilainya melalui chat atau commit ke Git.

## 2. Siapkan WAHA di VPS

```bash
sudo install -d -m 750 /opt/waha /var/lib/waha
sudo cp /var/www/sambal-joelid/ops/docker-compose.waha.yml /opt/waha/docker-compose.yml
sudo cp /var/www/sambal-joelid/ops/waha.env.example /opt/waha/.env
sudo chmod 600 /opt/waha/.env
sudo nano /opt/waha/.env
cd /opt/waha
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

Isi `/opt/waha/.env` dengan key yang sama seperti `.env` API. Image dipin ke tag Docker `gows-2026.10.1` dan engine `GOWS`, engine WebSocket generasi baru yang direkomendasikan WAHA dan tidak bergantung pada browser/Puppeteer. Sinkronisasi histori dibatasi untuk menjaga penggunaan storage dan data seminimal mungkin. Update image hanya setelah membaca release notes dan membuat backup `/var/lib/waha`.

Walaupun Swagger dinonaktifkan, isi juga `WHATSAPP_SWAGGER_USERNAME` dan `WHATSAPP_SWAGGER_PASSWORD` dengan nilai acak agar WAHA tidak menghasilkan credential baru di log setiap restart. Log production dipatok pada level `warn` agar data pairing tidak tercatat berlebihan.

Pastikan port tidak publik:

```bash
sudo ss -lntp | grep 3000
```

Hasil harus menunjukkan `127.0.0.1:3000`, bukan `0.0.0.0:3000`.

## 3. Login WhatsApp dengan aman

WAHA tidak dipublikasikan. Dari komputer admin, buka SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 USER@IP_VPS
```

Kemudian buka `http://127.0.0.1:3000/dashboard`, login dengan kredensial dashboard dari `/opt/waha/.env`, buat/start session `sambal-joelid`, lalu scan QR memakai nomor bisnis khusus.

Tutup SSH tunnel setelah status session `WORKING`.

## 4. Siapkan API VPS

Edit `/var/www/sambal-joelid/.env` berdasarkan `.env.vps.example`. Nilai berikut harus konsisten:

- `WAHA_API_KEY` sama dengan `/opt/waha/.env`.
- `WAHA_WEBHOOK_SECRET` sama dengan `WHATSAPP_HOOK_HMAC_KEY`.
- `WAHA_SESSION_NAME=sambal-joelid`.
- `AI_BASE_URL` berakhir dengan `/v1`.

Setelah tunnel Termux tersedia:

```bash
sudo systemctl restart sambal-joelid-api
sudo systemctl status sambal-joelid-api --no-pager
curl -fsS http://127.0.0.1:3001/api/v1/health
```

## 5. Siapkan Qwen di Termux

Runtime harus menyediakan API OpenAI-compatible pada `/v1/chat/completions`. Contoh dengan `llama-server` (sesuaikan path model):

```bash
termux-wake-lock

./build/bin/llama-server \
  --model "$HOME/models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf" \
  --alias qwen2.5-1.5b-instruct \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 2048 \
  --parallel 1 \
  --threads 4 \
  --n-predict 300 \
  --api-key "$AI_API_KEY" \
  --no-ui
```

Konfigurasi 2048 context dan 300 output token cukup untuk katalog awal. Backend meminta maksimal 250 output token dan menggunakan timeout 90 detik karena inferensi HP lebih lambat. Naikkan `--ctx-size` ke 4096 jika katalog/cabang bertambah atau respons mulai terpotong; kenaikan context juga menambah penggunaan RAM HP.

Jalankan tunnel HTTPS menuju `http://127.0.0.1:8080`. Jangan membuka `llama-server` langsung pada `0.0.0.0` tanpa autentikasi. Matikan battery optimization untuk Termux dan tunnel, gunakan charger yang aman, serta pantau suhu HP.

Tes dari VPS tanpa mencetak key ke log:

```bash
curl -fsS "$AI_BASE_URL/models" -H "Authorization: Bearer $AI_API_KEY"
```

## 6. Uji end-to-end

1. Kirim `halo` dari nomor uji ke nomor bisnis.
2. Pastikan balasan AI diterima.
3. Kirim `saya mau pesan 2 ayam geprek di cabang pusat`.
4. Pastikan ringkasan memakai harga database, lalu balas `YA`.
5. Pastikan order muncul di dashboard dengan sumber `WHATSAPP`.
6. Kirim `admin`; pastikan state berubah menjadi `WAITING_ADMIN` dan AI berhenti.
7. Balas dari dashboard, lalu aktifkan kembali `AI_ACTIVE`.
8. Matikan tunnel Termux sementara; pastikan pelanggan menerima fallback dan percakapan masuk `WAITING_ADMIN`.
9. Kirim ulang payload webhook yang sama; pastikan transaksi tidak terduplikasi.

## 7. Operasi dan rollback

```bash
# Log WAHA tanpa menampilkan QR (WAHA_PRINT_QR=False)
cd /opt/waha && sudo docker compose logs --tail=100 waha

# Restart
sudo docker compose restart waha

# Rollback image: ubah tag image ke versi sebelumnya, lalu
sudo docker compose pull && sudo docker compose up -d
```

Jangan hapus `/var/lib/waha` saat restart atau rollback. Direktori itu menyimpan session WhatsApp.

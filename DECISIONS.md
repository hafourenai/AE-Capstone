# DECISIONS — Refactor Bot WhatsApp

Catatan keputusan teknis yang tidak ditentukan (atau menyimpang dari) `WA_BOT_SPEC.md`.
Format: tanggal, keputusan, alasan singkat.

## 2026-11-19

### D1. Menu berasal dari Google Sheets (revisi keputusan)
Sesuai permintaan pemilik pada 19 November 2026, `MENU_CSV_URL` adalah sumber
utama menu. SQLite menyimpan salinan terakhir yang valid untuk bot, checkout, dan
web pelanggan. Impor saat startup dan tiap `MENU_SYNC_INTERVAL_MS` (default 5
menit), serta tombol sinkron manual di dashboard. Kegagalan CSV atau penurunan
jumlah item > `MENU_SYNC_MAX_DROP` (default 50%) mempertahankan SQLite lama.
Dashboard menampilkan menu tanpa mengizinkan edit; jam buka, lokasi, dan template
tetap editable. Endpoint edit menu lama dihapus agar tidak membuat dua sumber
kebenaran. Spreadsheet hanya dibaca, tidak ditulis bot.

### D2. Intent `keluhan` ditambahkan
Enum intent LLM mengikuti spec §8.3 ditambah `keluhan` agar alur keluhan yang
sudah berjalan tidak dihapus (spec §14). Penyimpangan ini didokumentasikan di sini.
Intent resmi: `tanya_menu`, `tanya_jam`, `tanya_lokasi`, `pesan`, `ubah_pesanan`,
`konfirmasi`, `batal`, `bicara_admin`, `keluhan`, `lainnya`.

### D3. Migrasi state percakapan non-destruktif
Kolom lama `whatsapp_conversations.state` (CHECK 3 nilai) dipertahankan untuk
kompatibilitas dashboard. State bot baru disimpan di kolom terpisah:
`bot_state`, `draft_order_json`, `fail_count`, `handoff`.
Alasan: SQLite tidak bisa mengubah CHECK constraint tanpa rebuild tabel; rebuild
berisiko pada FK `whatsapp_messages`, `customer_orders`, dan `customer_complaints`.

### D4. Antrian
`p-queue` concurrency 1 dipakai untuk pipeline pesan masuk dan untuk panggilan LLM.
Debounce per nomor 4 detik; pesan beruntun digabung dengan spasi pada `raw`, lalu
`normalize()` dipanggil sekali atas hasil gabungan.

### D5. Timeout LLM
Default `AI_TIMEOUT_MS` di kode diturunkan menjadi 25000 ms (spec §8.2). Nilai env
tetap bisa menimpanya.

### D6. Format response LLM diprobe saat runtime
Urutan percobaan: `/v1/chat/completions` dengan `{"type":"json_object","schema":...}`
→ `{"type":"json_schema","json_schema":{"schema":...}}` → `/completion` dengan
`json_schema` langsung. Format yang berhasil di-cache. Bila tidak ada yang berhasil,
LLM dianggap tidak tersedia dan pipeline memakai fallback.

### D7. Health check LLM dan mode degradasi
`GET {AI_BASE_URL tanpa /v1}/health` dipanggil saat start dan setiap
`LLM_HEALTH_CHECK_MS` (default 120 detik). Bila offline, bot memakai rules + fuzzy
dan langsung handoff saat keduanya tidak cukup. Status tampil di
`GET /api/v1/admin/integrations/health` (`llm`, `degraded`).

### D8. Logging dan pesan gagal
Semua pesan dicatat di `wa_message_logs` (layer, intent, hasil, durasi). Pesan yang
berakhir di fallback/handoff disalin ke `failed_messages` agar bisa dijadikan alias
menu atau dikirim ke `test/eval/testset.jsonl` dari dashboard. Tabel dipangkas
mengikuti retensi pesan WhatsApp (30 hari).

### D9. Voice note tidak ditranskripsi pada refactor ini
Belum ada layanan transkripsi lokal yang disetujui dan menambah layanan berbayar
butuh persetujuan. Semua media, termasuk voice note, di-handoff ke staf dengan
template `media`. Bila nanti tersedia transkripsi lokal, hasil teks dapat masuk ke
pipeline yang sama tanpa mengubah state machine.

### D10. Urutan state operasional
Spec §9 mendaftar state `IDLE → PILIH_MENU → KONFIRMASI → ALAMAT_ATAU_AMBIL → SELESAI`.
Implementasi memakai urutan operasional `PILIH_MENU → ALAMAT_ATAU_AMBIL → KONFIRMASI`
karena cabang dan nama harus lengkap sebelum ringkasan konfirmasi ditampilkan. Nama
state tetap sama dan semuanya dapat dicapai; hanya urutan transisinya yang logis.

### D11. Evaluasi
`node test/eval/run.js` mengukur Lapisan 1–2 tanpa LLM; hasil saat ini 26/32 benar,
0 salah, 6 butuh LLM (coverage 81%, precision 100%). `--live` memanggil llama-server
dan membandingkan intent+item dengan target default 85%; jalankan di VPS/Termux
karena membutuhkan model sungguhan.

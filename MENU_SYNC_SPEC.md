# Spesifikasi: Sinkronisasi Menu dari Google Sheets

Dokumen ini adalah instruksi kerja untuk agent coding. Ini **pengembangan terpisah** dari `WA_BOT_SPEC.md`. Kerjakan hanya cakupan di dokumen ini. Baca seluruhnya sebelum menulis kode.

## 0. Cara kerja agent

1. **Audit dulu.** Cari kode yang saat ini membaca Google Sheets. Catat: library yang dipakai, cara autentikasi, cara data dipakai oleh bot, dan di mana menu dibaca per pesan (jika ada).
2. **Pakai ulang kode baca sheet yang sudah berjalan** sebagai `fetchRows`. Jangan mengganti library atau cara autentikasi tanpa alasan kuat.
3. Tulis rencana singkat (maks 1 halaman) berisi file yang diubah/dibuat, lalu kerjakan per fase (bagian 11).
4. Setelah tiap fase, jalankan `node --test` dan pastikan lulus sebelum lanjut.
5. Keputusan yang tidak ditentukan dokumen ini: pilih opsi paling sederhana, catat di `DECISIONS.md`.
6. Tidak ada dependency baru kecuali benar-benar perlu. Kode ini cukup memakai modul bawaan Node.

## 1. Konteks dan tujuan

- Google Sheets dipakai **hanya sebagai sumber data menu** (dibaca saja; bot tidak menulis ke sheet).
- Pemilik usaha mengedit menu di sheet. Bot harus mengetahui perubahan itu.
- Masalah yang ingin dihindari: membaca sheet pada **setiap pesan masuk** (lambat, kena kuota API Google, dan rusak kalau Google error), serta data sheet yang berantakan (harga berupa teks, spasi nyasar, baris kosong).

**Tujuan:** bot membaca menu dari **snapshot di memori**, yang diperbarui otomatis dari sheet dengan validasi, tanpa pernah membaca data setengah jadi.

## 2. Prinsip (wajib dipatuhi)

1. **Bot tidak pernah membaca sheet saat memproses pesan.** Hanya `getMenu()` dari snapshot.
2. **Snapshot ditukar sekaligus (atomic swap)**, tidak pernah diubah bertahap.
3. **Sinkron gagal tidak boleh merusak data yang sedang dipakai.** Jika Google error, hasil kosong, atau hasil mencurigakan, snapshot lama tetap dipakai.
4. **Baris bermasalah tidak diabaikan diam-diam.** Semuanya dilaporkan ke dashboard.
5. **Sheet hanya dibaca**, tidak pernah ditulis oleh bot.
6. **Rahasia** (token sinkron, kredensial Google) hanya di environment variable.

## 3. Format sheet

Baris 1 adalah header. Kolom (urutan tetap, atau cari berdasarkan nama header, pilih yang paling kecil risikonya terhadap kode yang ada):

| Kolom | Isi | Aturan |
|---|---|---|
| `id` | kode unik menu | opsional; jika kosong dibuat dari `normalize(nama)` |
| `nama` | nama menu | wajib |
| `alias` | sebutan lain, dipisah koma | opsional |
| `harga` | harga | wajib, angka |
| `tersedia` | `TRUE`/`FALSE` | kosong dianggap `TRUE` |
| `kategori` | pengelompokan | opsional |

Saat membaca lewat Google Sheets API, gunakan `valueRenderOption: "UNFORMATTED_VALUE"` bila memungkinkan, sehingga harga datang sebagai angka, bukan teks berformat.

## 4. Kontrak modul `menuSync.js`

Ekspor fungsi berikut. Nama bisa disesuaikan, tapi kontraknya harus sama.

```js
getMenu()          // -> array item snapshot saat ini (read-only)
getStatus()        // -> objek status (bagian 7)
syncMenu(fetchRows)// -> { changed: boolean, errors: string[] }
loadCacheOnStart() // dipanggil sekali saat start
menuEvents         // EventEmitter; emit "changed" (payload: snapshot) setelah swap
```

Bentuk satu item di snapshot:

```json
{
  "id": "nasi-gudeg",
  "nama": "Nasi Gudeg",
  "harga": 15000,
  "tersedia": true,
  "kategori": "makanan",
  "aliases": ["nasi gudeg", "gudeg", "gdg"]
}
```

`aliases` selalu berisi `normalize(nama)` dan semua alias hasil `normalize()`, tanpa duplikat dan tanpa string kosong.

**Ketergantungan:** gunakan `normalize()` dari `src/normalize.js`. Jika file itu belum ada, buat dengan spesifikasi berikut. Jangan membuat versi lain.

```js
const SLANG = { gk: "tidak", ga: "tidak", gak: "tidak", tdk: "tidak",
                bsk: "besok", sm: "sama", yg: "yang", bs: "bisa" };
function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC").toLowerCase()
    .replace(/(\p{L})\1{2,}/gu, "$1")      // hanya huruf, agar "10000" tidak rusak
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim()
    .split(" ").map((w) => SLANG[w] ?? w).join(" ");
}
module.exports = { normalize };
```

**Pemakai snapshot:** modul pencarian menu (fuzzy match) harus membaca dari `getMenu()` dan **membangun ulang indeksnya** setiap kali `menuEvents` memancarkan `"changed"`. Jangan memanggil sheet dari modul lain. Jika modul fuzzy belum ada, cukup sediakan event dan dokumentasikan cara berlangganan.

## 5. Aturan parsing dan validasi (`parseRows`)

Fungsi murni (tanpa I/O) agar mudah dites. Input: array baris. Output: `{ items, errors }`.

- Lewati baris header. Baris yang seluruhnya kosong dilewati tanpa error.
- `trim()` semua sel. Sel `null`/`undefined` jadi string kosong.
- **Harga:** jika sudah bertipe angka, pakai langsung. Jika teks: hapus akhiran desimal `,\d{1,2}$`, lalu hapus semua karakter non-digit (`"Rp 15.000"` → `15000`). Harga harus bilangan bulat > 0; selain itu error.
- **Nama kosong** atau **harga tidak valid** → baris ditolak, catat error: `Baris {n}: {alasan}` (n = nomor baris di sheet, mulai dari 2).
- **`tersedia`:** hanya `FALSE` (tidak peka huruf besar/kecil) yang berarti habis; nilai lain berarti tersedia.
- **Duplikat:** dua baris dengan `id` sama, atau `nama` sama setelah normalisasi → pertahankan yang pertama, baris berikutnya ditolak dengan error `Baris {n}: duplikat dengan baris {m}`.
- **Alias bentrok:** alias yang sama dipakai oleh dua menu berbeda → tidak ditolak, tetapi catat **peringatan** (`Alias "gdg" dipakai oleh Nasi Gudeg dan Gudeg Komplit`), karena ini membuat bot salah menebak.

## 6. Alur sinkron (`syncMenu`)

1. **Mutex:** jika sinkron sedang berjalan, panggilan baru tidak memulai yang kedua (kembalikan hasil "sedang berjalan" atau tunggu yang ada).
2. Panggil `fetchRows()`.
3. `parseRows(rows)`.
4. **Penjaga keamanan** (jika gagal, tolak hasil, pertahankan snapshot lama, catat error):
   - `items.length === 0`.
   - Jumlah item turun lebih dari 50% dari snapshot saat ini (batas dapat diatur lewat `MENU_SYNC_MAX_DROP`, default `0.5`). Ini melindungi dari sheet yang tidak sengaja terhapus. Abaikan penjaga ini jika snapshot saat ini kosong.
5. Hitung `version` = hash SHA-1 dari `JSON.stringify(items)`. Jika sama dengan snapshot sekarang → `changed: false`, tidak ada swap, tidak ada event.
6. Tukar snapshot sekaligus: `snapshot = { version, items, loadedAt }`.
7. **Tulis cache file secara atomik**: tulis ke `menu-cache.json.tmp`, lalu `rename` ke `menu-cache.json`. Kegagalan menulis cache hanya dicatat dan tidak membatalkan swap.
8. Pancarkan `menuEvents.emit("changed", snapshot)`.
9. Perbarui status (waktu percobaan, waktu sukses, daftar error/peringatan).

Pada setiap kegagalan: catat di log, perbarui `lastError` di status, **jangan melempar error** ke pemanggil.

`loadCacheOnStart()`: baca `menu-cache.json` bila ada, validasi bentuknya secukupnya, lalu pasang sebagai snapshot awal dan pancarkan `changed`. Jika file tidak ada atau rusak, mulai dengan snapshot kosong (tidak crash) dan segera panggil sinkron pertama.

## 7. Pemicu sinkron dan endpoint

**Tiga pemicu, satu fungsi `syncMenu`:**

1. **Saat start:** `loadCacheOnStart()` lalu `syncMenu`.
2. **Polling:** setiap `MENU_SYNC_INTERVAL_MS` (default 300000 = 5 menit).
3. **Endpoint push:** `POST /internal/sync-menu`
   - Header wajib `x-sync-token`; bandingkan dengan `process.env.SYNC_TOKEN` memakai `crypto.timingSafeEqual`. Salah/kurang → 401.
   - Balas `202` segera, jalankan sinkron di belakang.
   - **Debounce 10 detik:** beberapa panggilan beruntun hanya memicu satu sinkron.
   - Batasi laju sederhana (misalnya maks 10 panggilan/menit) supaya tidak bisa dipakai membanjiri Google API.

**Endpoint status untuk dashboard:** `GET /internal/menu-status` (dilindungi token/autentikasi yang sama atau yang sudah dipakai dashboard). Respons:

```json
{
  "version": "abc123",
  "itemCount": 24,
  "loadedAt": "2026-11-19T08:00:00Z",
  "lastAttemptAt": "2026-11-19T08:05:00Z",
  "lastSuccessAt": "2026-11-19T08:00:00Z",
  "stale": false,
  "errors": ["Baris 12: harga kosong atau tidak valid"],
  "warnings": ["Alias \"gdg\" dipakai oleh Nasi Gudeg dan Gudeg Komplit"]
}
```

`stale` bernilai `true` jika `lastSuccessAt` lebih lama dari 30 menit (dapat diatur). Dashboard dapat menampilkan peringatan dari field ini. Penambahan tombol "Sinkron sekarang" dan panel error di dashboard Vercel cukup berupa pemanggilan kedua endpoint di atas; kerjakan di Fase 5 dan hanya jika kode dashboard tersedia.

**Push dari Google Sheets (opsional, Fase 4).** Di Sheet: Extensions → Apps Script. Token dan URL disimpan di Script Properties (bukan di kode). Pasang sebagai **installable trigger** (On edit atau On change). Trigger `onEdit` biasa tidak boleh memanggil URL eksternal.

```js
function notifyBot() {
  const p = PropertiesService.getScriptProperties();
  UrlFetchApp.fetch(p.getProperty("BOT_URL") + "/internal/sync-menu", {
    method: "post",
    headers: { "x-sync-token": p.getProperty("SYNC_TOKEN") },
    muteHttpExceptions: true,
  });
}
```

## 8. Konfigurasi (environment variable)

| Variabel | Default | Fungsi |
|---|---|---|
| `SYNC_TOKEN` | wajib | token untuk endpoint sinkron/status |
| `MENU_SYNC_INTERVAL_MS` | `300000` | interval polling |
| `MENU_SYNC_MAX_DROP` | `0.5` | batas penurunan jumlah item yang ditolak |
| `MENU_STALE_MINUTES` | `30` | batas status `stale` |
| `MENU_CACHE_FILE` | `./menu-cache.json` | lokasi cache |

Kredensial Google tetap memakai mekanisme yang sudah ada di proyek.

## 9. Pengujian

Gunakan `node:test`. Tanpa akses jaringan: `fetchRows` selalu berupa fungsi tiruan.

**`parseRows`:**
- `"15.000"`, `"Rp 15.000"`, `15000` (angka), `"15.000,00"` → semuanya `15000`.
- Harga kosong, `"abc"`, `0`, negatif → baris ditolak dengan pesan berisi nomor baris yang benar.
- Nama kosong → ditolak. Baris kosong total → dilewati tanpa error.
- `tersedia`: `"FALSE"`, `"false"` → habis; kosong, `"TRUE"` → tersedia.
- Alias `"gdg, Gudeg , "` → `["nasi gudeg","gdg","gudeg"]` (ternormalisasi, tanpa kosong/duplikat).
- Nama ganda (beda huruf besar/kecil) → baris kedua ditolak.
- Alias bentrok antar menu → ada peringatan, kedua menu tetap masuk.

**`syncMenu`:**
- Sukses pertama → `changed: true`, event `changed` terpancar sekali, file cache ada.
- Data sama dipanggil lagi → `changed: false`, tidak ada event.
- `fetchRows` melempar error → snapshot lama utuh, status menyimpan error, tidak melempar.
- Hasil kosong → ditolak, snapshot lama utuh.
- Jumlah item turun > 50% → ditolak, snapshot lama utuh.
- Dua `syncMenu` bersamaan → `fetchRows` hanya dipanggil sekali.
- `loadCacheOnStart` dengan cache valid → `getMenu()` terisi sebelum sinkron pertama; dengan cache rusak → tidak crash.

**Endpoint:** token salah → 401; token benar → 202; beberapa panggilan dalam 10 detik → `fetchRows` dipanggil sekali.

## 10. Larangan

- Jangan membaca sheet di dalam alur pemrosesan pesan.
- Jangan menulis ke Google Sheets.
- Jangan mengubah snapshot secara parsial; selalu tukar sekaligus.
- Jangan menghapus baris bermasalah tanpa melaporkannya.
- Jangan menaruh token atau kredensial di kode/repo.
- Jangan mengubah logika bot di luar cakupan ini (state percakapan, LLM, template). Itu cakupan `WA_BOT_SPEC.md`.
- Jangan menghapus kode lama yang masih dipakai sebelum penggantinya lulus test.

## 11. Fase pengerjaan

| Fase | Isi | Selesai bila |
|---|---|---|
| 1 | `parseRows` + test | Semua test parsing (bagian 9) lulus |
| 2 | `syncMenu`, snapshot, cache atomik, `loadCacheOnStart`, `menuEvents`, mutex, penjaga keamanan + test | Test `syncMenu` lulus; Google error tidak merusak snapshot |
| 3 | Pasang ke aplikasi: polling, sinkron saat start; **hapus pembacaan sheet dari alur pesan**; modul pencarian menu membaca `getMenu()` dan rebuild saat event | Tidak ada lagi pemanggilan Google API saat pesan masuk (verifikasi lewat log/grep) |
| 4 | Endpoint `/internal/sync-menu` (token, debounce, rate limit) + skrip Apps Script | Edit sel di sheet memunculkan menu baru di bot dalam hitungan detik |
| 5 | Endpoint `/internal/menu-status`; tombol "Sinkron sekarang" dan panel error/peringatan di dashboard (jika kode dashboard tersedia) | Admin melihat daftar baris bermasalah tanpa membuka log server |

## 12. Kriteria selesai keseluruhan

- Mengedit harga di sheet → bot memakai harga baru tanpa restart.
- Mematikan koneksi ke Google → bot tetap menjawab dengan menu terakhir yang valid.
- Menghapus seluruh isi sheet → bot **tidak** ikut kehilangan menu, dan dashboard menampilkan error.
- Restart bot saat Google bermasalah → bot tetap punya menu dari cache.
- Semua test lulus (`node --test`).

# Spesifikasi Refactor Bot WhatsApp Restoran

Dokumen ini adalah instruksi kerja untuk agent coding. Baca seluruhnya sebelum menulis kode.

## 0. Cara kerja agent

1. **Audit dulu.** Baca kode yang sudah ada. Catat: struktur folder, DB yang dipakai, cara webhook WAHA ditangani, di mana jawaban hard-code berada. Jangan menulis ulang semuanya dari nol; refactor bertahap.
2. **Tulis rencana singkat** (maks 1 halaman) berisi file yang akan diubah/dibuat per fase, lalu kerjakan fase demi fase (lihat bagian 12).
3. **Setelah tiap fase**, jalankan `node --test` dan pastikan lulus sebelum lanjut.
4. Jika ada keputusan yang tidak ditentukan dokumen ini, pilih opsi paling sederhana dan catat di `DECISIONS.md`.
5. Jangan menambah dependency berat tanpa alasan. Dependency yang diperbolehkan: `fuse.js`, `p-queue`, dan library DB yang sudah dipakai proyek.

## 1. Konteks

- Bot WhatsApp untuk **usaha tempat makan**. Mayoritas pelanggan **orang tua**: mengetik singkat, banyak singkatan/typo, kadang huruf besar semua, sering kirim beberapa pesan pendek berturut-turut.
- Infrastruktur yang sudah ada:
  - **WAHA** (WhatsApp HTTP API tidak resmi) di VPS.
  - **Model LLM kecil**: `Qwen2.5-1.5B-Instruct` (GGUF) dijalankan dengan **llama.cpp (`llama-server`)** di HP via Termux, diekspos lewat tunnel.
  - **Backend Node.js** (di VPS).
  - **Dashboard admin** di Vercel.
- Masalah sekarang: jawaban AI buruk karena model kecil, lalu diganti kondisi hard-code di backend yang rapuh terhadap singkatan dan variasi tulisan.

## 2. Prinsip utama (wajib dipatuhi)

1. **LLM hanya memahami pesan, tidak pernah menulis jawaban ke pelanggan.** LLM mengeluarkan JSON terstruktur. Semua teks balasan berasal dari **template di backend**.
2. **Fakta dihitung backend**: harga, total, stok, jam buka, alamat. LLM tidak boleh menghitung atau mengarang angka.
3. **Urutan prioritas pemahaman**: aturan pasti (tanpa LLM) → fuzzy match → LLM → tanya balik/handoff. LLM dipanggil hanya jika lapisan sebelumnya ragu.
4. **Tidak membedakan huruf besar/kecil.** Semua pencocokan memakai teks hasil `normalize()`. `.toLowerCase()` tidak boleh tersebar di banyak tempat.
5. **`raw` vs `norm`**: `norm` hanya untuk pencocokan. Data yang disimpan/ditampilkan (nama, alamat, catatan) memakai `raw`.
6. **Tidak menebak.** Jika ragu, tanya balik dengan pilihan sempit.
7. **Pelanggan tidak boleh dibiarkan tanpa respons.** Ada timeout dan fallback ke admin.
8. **Menu, alias, jam buka, dan template editable dari dashboard**, bukan hard-code di kode.

## 3. Arsitektur

```
WAHA webhook
  → filter (abaikan fromMe, grup, event non-message)
  → debounce per nomor (4 detik, gabung pesan beruntun)
  → antrian global (concurrency 1)
  → normalize(raw) → norm
  → cek handoff/mode manusia (jika aktif → stop, jangan balas)
  → Lapisan 1: aturan pasti (norm cocok perintah baku / sesuai state)
  → Lapisan 2: fuzzy match menu (Fuse.js)
  → Lapisan 3: LLM (llama-server, output JSON dipaksa schema)
  → state machine memproses hasil → pilih template balasan
  → kirim via WAHA (dengan jeda natural)
  → log (pesan, intent, sumber lapisan, hasil)
```

## 4. Struktur folder yang disarankan

Sesuaikan dengan struktur yang sudah ada; ini hanya acuan.

```
src/
  webhook.js          # endpoint WAHA, filter, debounce, antrian
  normalize.js        # normalize() (bagian 5)
  rules.js            # perintah baku & fast path (bagian 6)
  menuMatcher.js      # Fuse.js, kandidat menu (bagian 7)
  llm.js              # klien llama-server (bagian 8)
  intents.js          # daftar intent + builder JSON schema
  state.js            # state machine percakapan (bagian 9)
  templates.js        # template balasan (bagian 10)
  handoff.js          # eskalasi ke admin (bagian 11)
  waha.js             # kirim pesan, typing indicator
  logger.js           # log pesan gagal dipahami
test/
  normalize.test.js
  rules.test.js
  menuMatcher.test.js
  state.test.js
  llm.contract.test.js
  eval/
    testset.jsonl     # pesan nyata + label benar
    run-eval.js       # hitung akurasi
```

## 5. `normalize()`

Dipanggil **sekali** di pintu masuk. Spesifikasi:

```js
const SLANG = {
  gk: "tidak", ga: "tidak", gak: "tidak", tdk: "tidak",
  bsk: "besok", sm: "sama", yg: "yang", bs: "bisa",
  // daftar ini harus bisa diperluas; pindahkan ke DB/config bila perlu
};

function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\p{L})\1{2,}/gu, "$1")      // HANYA huruf: "iyaaa" -> "iya"
    .replace(/[^\p{L}\p{N}\s]/gu, " ")     // buang tanda baca & emoji
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => SLANG[w] ?? w)
    .join(" ");
}
```

Catatan penting:
- Pengulangan karakter **hanya untuk huruf** (`\p{L}`). Jangan memakai `(.)` karena "10000" akan rusak menjadi "10".
- "iyaa" (2 huruf) tidak diringkas oleh aturan di atas; tangani dengan daftar `SETUJU` dan/atau fuzzy match.
- Alias menu disimpan **sudah dinormalisasi**: normalisasi dilakukan di server saat dashboard menyimpan, bukan di browser.

Test minimal: `"YA"`, `"Ya."`, `"  IYAAA "` → `"ya"`/`"iya"`; `"Nasi GUDEG 2"` → `"nasi gudeg 2"`; `"GK mau"` → `"tidak mau"`; `"es teh 10000"` tetap mengandung `10000`.

## 6. Lapisan 1: aturan pasti (tanpa LLM)

Bandingkan **`norm`**, bukan `raw`. Daftar berikut berupa `Set`, mudah ditambah:

| Maksud | Contoh norm |
|---|---|
| setuju | `ya`, `iya`, `iyaa`, `y`, `ok`, `oke`, `siap`, `betul`, `benar` |
| batal | `batal`, `gajadi`, `ga jadi`, `tidak jadi`, `cancel` |
| lihat menu | `menu`, `daftar menu`, `list menu` |
| jam buka | `jam buka`, `buka jam berapa`, `jam berapa buka` |
| lokasi | `lokasi`, `alamat`, `dimana`, `di mana` |
| admin | `admin`, `telepon`, `telpon`, `bicara orang`, `cs` |

Aturan berbasis state: jika state sedang menunggu jumlah dan `norm` hanya angka (`"2"`), langsung dipahami sebagai jumlah. Jika state menunggu konfirmasi, `ya`/`batal` langsung diproses.

Pesan yang cocok di lapisan ini **tidak boleh** memanggil LLM.

## 7. Lapisan 2: fuzzy match menu

- Sumber: tabel menu + tabel alias (sudah dinormalisasi). Satu menu bisa punya banyak alias (`gudeg`, `nasi gudeg`, `gdg`).
- Pakai `fuse.js` dengan `threshold: 0.3`, `ignoreLocation: true`. **Bangun instance sekali**; bangun ulang hanya saat menu/alias berubah (invalidate lewat event/versi).
- Query: `norm`, atau potongan `norm` per item (pisah dengan `dan`, `sama`, `sm`, `,`, `+`).
- Keputusan:
  - skor terbaik bagus **dan** jaraknya ke kandidat kedua cukup besar → terima.
  - ada 2+ kandidat berdekatan → **tanya balik** ("Maksud Ibu Es Teh atau Es Jeruk?").
  - tidak ada kandidat → lanjut ke LLM.
- Fungsi ini juga menyediakan **3–5 kandidat teratas** untuk dikirim ke LLM (bagian 8).

## 8. Lapisan 3: LLM via llama.cpp

### 8.1 Menjalankan server (di Termux)

```bash
llama-server \
  -m qwen2.5-1.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 \
  -c 2048 -np 1 \
  --api-key "GANTI_DENGAN_KUNCI_ACAK"
```

- `-np 1`: satu slot saja, HP tidak kuat paralel.
- **Wajib pakai `--api-key`** karena server diekspos lewat tunnel. Backend mengirim header `Authorization: Bearer <kunci>`. Simpan kunci di environment variable, bukan di kode.
- Sesuaikan jumlah thread (`-t`) dengan core HP.

### 8.2 Kontrak pemanggilan

Endpoint `POST {LLAMA_URL}/v1/chat/completions` (OpenAI-compatible). Parameter:

```json
{
  "temperature": 0,
  "max_tokens": 120,
  "cache_prompt": true,
  "messages": [
    { "role": "system", "content": "<SYSTEM_PROMPT>" },
    { "role": "user", "content": "<PESAN + KONTEKS>" }
  ],
  "response_format": {
    "type": "json_object",
    "schema": { }
  }
}
```

- Isi `schema` dengan JSON schema (bagian 8.3). llama.cpp mengonversinya menjadi grammar sehingga output **dijamin valid JSON**.
- **Verifikasi bentuk `response_format` terhadap versi llama-server yang terpasang** (versi baru menerima juga `{"type":"json_schema","json_schema":{"schema":{...}}}`; endpoint `/completion` menerima field `json_schema` langsung). Jika gagal, fallback ke `/completion` dengan `json_schema`. Catat pilihan yang berhasil di `DECISIONS.md`.
- **Timeout 25 detik** (`AbortController`). Pada timeout/error: jangan crash, jalankan fallback (bagian 11).
- Semua panggilan lewat antrian `p-queue` dengan `concurrency: 1`.

### 8.3 JSON schema (dibangun per permintaan)

Intent (enum tetap, jangan ditambah sembarangan):

`tanya_menu`, `tanya_jam`, `tanya_lokasi`, `pesan`, `ubah_pesanan`, `konfirmasi`, `batal`, `bicara_admin`, `lainnya`

```js
function buildSchema(kandidatMenu) {
  return {
    type: "object",
    properties: {
      intent: { type: "string", enum: INTENTS },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            menu: { type: "string", enum: [...kandidatMenu, "TIDAK_ADA"] },
            qty: { type: "integer", minimum: 1, maximum: 50 }
          },
          required: ["menu", "qty"]
        }
      },
      waktu: { type: "string" }   // "" jika tidak disebut
    },
    required: ["intent", "items", "waktu"]
  };
}
```

`enum` pada `menu` diisi **hanya 3–5 kandidat dari fuzzy match**, sehingga model tinggal memilih dan tidak bisa mengarang nama menu. Jangan mengirim seluruh daftar menu ke prompt.

### 8.4 Prompt

System prompt singkat, bahasa Indonesia, berisi: tugas (mengekstrak maksud dan pesanan dari chat pelanggan restoran), daftar intent beserta arti satu baris, aturan ("jika tidak yakin pakai intent `lainnya`", "jangan menebak menu di luar kandidat").

Lalu **8–15 contoh few-shot** dari chat asli, termasuk singkatan, typo, dan kalimat tidak lengkap. Simpan contoh di file terpisah (`prompts/fewshot.json`) agar mudah diperbarui, dan sertakan kandidat menu di tiap contoh agar konsisten dengan format runtime. Contoh format:

```
Kandidat: Nasi Gudeg, Es Teh Manis
Pesan: "pak pesen gdg 2 sm tehnya 1 bsk jam 12"
JSON: {"intent":"pesan","items":[{"menu":"Nasi Gudeg","qty":2},{"menu":"Es Teh Manis","qty":1}],"waktu":"besok 12:00"}
```

### 8.5 Validasi setelah LLM

- `JSON.parse` dalam try/catch; jika gagal → perlakukan sebagai "tidak paham".
- Normalisasi nilai `intent` (`normalize(x).replace(/ /g, "_")`) lalu cek terhadap `INTENTS`.
- Item dengan `menu === "TIDAK_ADA"` atau qty tidak valid → tanya balik.
- **Backend** yang mencari harga dan menghitung total dari DB.

## 9. State percakapan

Simpan per nomor di DB (bukan hanya di memori, supaya aman saat restart). Kolom minimal: `phone`, `state`, `draft_order` (JSON), `fail_count`, `handoff` (bool), `updated_at`.

State: `IDLE` → `PILIH_MENU` → `KONFIRMASI` → `ALAMAT_ATAU_AMBIL` → `SELESAI`, ditambah `HANDOFF`.

Aturan:
- State kedaluwarsa setelah 30 menit tanpa aktivitas → kembali ke `IDLE`.
- `fail_count` naik tiap kali bot tidak paham; reset saat paham. **Jika `fail_count >= 2` → handoff.**
- `batal` dari state mana pun menghapus draft dan kembali ke `IDLE`.
- Pesanan **wajib dikonfirmasi** dengan ringkasan sebelum disimpan final.

## 10. Template balasan

- Disimpan di file/DB yang bisa diedit (idealnya lewat dashboard), bukan tersebar di kode. Pakai placeholder: `{nama}`, `{ringkasan}`, `{total}`.
- Gaya untuk pelanggan orang tua: kalimat pendek, sapaan **Bapak/Ibu**, sopan, **satu pertanyaan per pesan**, emoji minimal.
- Contoh template penting:
  - Konfirmasi: `Pesanan Ibu: {ringkasan}. Total Rp{total}. Sudah benar? Balas YA, atau BATAL jika ingin mengubah.`
  - Klarifikasi menu: `Maaf Bu, maksudnya {opsi1} atau {opsi2}?`
  - Tidak paham (pertama): `Maaf Bu, saya kurang paham. Boleh ditulis ulang pesanannya?`
  - Handoff: `Baik Bu, saya sambungkan ke staf kami ya. Mohon ditunggu sebentar.`
  - Timeout/model mati: `Mohon tunggu sebentar Bu, kami bantu langsung.`
- Format harga: `Rp15.000` (pemisah ribuan titik) lewat satu helper.

## 11. Handoff, timeout, dan keandalan

**Pemicu handoff** (set `handoff = true`, kirim template handoff, tandai di dashboard, **bot berhenti membalas nomor itu** sampai admin melepas):
- norm cocok perintah admin (bagian 6).
- `fail_count >= 2`.
- Timeout/error LLM.
- Pesan berupa gambar/dokumen/lokasi yang belum didukung (kecuali sudah ada fitur khusus).

**Keandalan:**
- **Debounce 4 detik** per nomor; gabung `raw` dengan spasi, normalisasi hasil gabungan.
- **Antrian** global `concurrency: 1` untuk panggilan LLM.
- **Idempotensi**: simpan ID pesan WAHA yang sudah diproses; abaikan duplikat (webhook bisa terkirim ulang).
- **Webhook membalas 200 segera**, pemrosesan berjalan di belakang.
- **Health check** ke `llama-server` (`GET /health`) tiap beberapa menit; bila gagal, jalankan mode degradasi: hanya Lapisan 1–2 + handoff, serta tampilkan peringatan di dashboard.
- **Anti-banned (WAHA tidak resmi)**: panggil typing indicator, beri jeda balasan acak 1–3 detik (sebanding panjang teks), balas hanya pesan masuk, tanpa broadcast massal, abaikan grup.
- Verifikasi format payload webhook dan endpoint kirim pesan di dokumentasi WAHA versi yang terpasang; jangan mengasumsikan dari ingatan.

## 12. Logging dan evaluasi

- Catat tiap pesan: `phone`, `raw`, `norm`, `lapisan_yang_menjawab` (rules/fuzzy/llm/fallback), `intent`, `hasil`, `waktu_proses`.
- Pesan yang berakhir "tidak paham"/handoff disimpan di tabel `failed_messages` dan **ditampilkan di dashboard** dengan tombol cepat: "tambahkan sebagai alias menu" dan "tambahkan sebagai contoh test set".
- **Test set**: `test/eval/testset.jsonl`, satu baris per pesan:
  ```json
  {"pesan":"pak pesen gdg 2 sm tehnya 1","intent":"pesan","items":[{"menu":"Nasi Gudeg","qty":2},{"menu":"Es Teh Manis","qty":1}]}
  ```
  Mulai dengan minimal 30 contoh (buat sintetis dahulu, ganti/tambah dengan chat nyata hingga 50–100). Sertakan variasi huruf besar/kecil, singkatan, typo, dan pesan tidak lengkap.
- `run-eval.js` menjalankan seluruh pipeline dan melaporkan akurasi intent dan akurasi item, serta daftar yang salah.
- **Target**: akurasi ≥ 85–90% di test set. Jika model mentok di bawah itu setelah alias dan few-shot dioptimalkan, **laporkan** (jangan ganti model sendiri); opsi lanjutan: model 3B atau API murah hanya untuk pesan yang gagal di Lapisan 2.

## 13. Fase pengerjaan

Kerjakan berurutan. Jangan lompat fase.

| Fase | Isi | Selesai bila |
|---|---|---|
| 1 | `normalize.js` + test; pasang di webhook; debounce; antrian; filter pesan; idempotensi | Test lulus; `"YA"`/`"ya"`/`"Ya."` diperlakukan sama; 3 pesan beruntun dalam 4 detik diproses sebagai satu |
| 2 | Menu + alias + jam buka pindah ke DB; `menuMatcher.js` (Fuse); `rules.js` | Hard-code menu/jam dihapus dari kode; "gdg 2" cocok ke Nasi Gudeg; kasus ambigu memicu tanya balik |
| 3 | `llm.js` + schema per permintaan + few-shot; timeout; validasi output | Output selalu JSON valid; timeout memicu fallback, bukan crash; contract test lulus (dengan mock server) |
| 4 | `state.js` + template + konfirmasi pesanan | Alur pesan→konfirmasi→simpan jalan; "2"/"ya" dipahami dari konteks |
| 5 | Handoff, `fail_count`, health check, mode degradasi, log `failed_messages` | Dua kali gagal paham → handoff; llama-server dimatikan → bot tetap merespons dengan aman |
| 6 | Test set + `run-eval.js`; laporan akurasi | Laporan akurasi tercetak; daftar kesalahan tersedia |
| 7 (opsional, terakhir) | Dukungan voice note (transkripsi lalu proses seperti teks) | Voice note pendek menghasilkan balasan yang sama dengan teks |

## 14. Larangan

- Jangan membiarkan LLM menulis balasan ke pelanggan.
- Jangan mengirim seluruh menu ke prompt.
- Jangan membandingkan `raw` untuk logika; selalu `norm`.
- Jangan menormalisasi data yang disimpan atau ditampilkan (nama, alamat).
- Jangan memasukkan API key, URL tunnel, atau token ke kode/repo; pakai environment variable.
- Jangan menghapus fitur yang sudah berjalan tanpa penggantinya lolos test.
- Jangan mengubah model atau menambah layanan eksternal berbayar tanpa persetujuan eksplisit.

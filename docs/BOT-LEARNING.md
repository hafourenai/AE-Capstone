# Pembelajaran dan Evaluasi Bot

## Versi singkat

Bot tidak boleh belajar langsung dari setiap pesan pelanggan karena spam atau label yang salah dapat merusak pesanan. Pembelajaran dilakukan dengan satu persetujuan admin:

1. Bot gagal memahami pesan dan mencatatnya di database VPS.
2. Pesan muncul di halaman **Evaluasi Bot**.
3. Admin memilih **Ajarkan**, **Arsipkan**, atau **Hapus**.
4. Jika diajarkan, contoh langsung aktif tanpa deploy ulang.

## Arti tombol

### Ajarkan

Admin memilih maksud pesan. Untuk pesanan, admin juga memilih menu dan jumlah. Sistem menyimpan contoh ke tabel `learned_examples` dalam SQLite VPS.

Contoh:

```text
Pesan pelanggan: mw jukut lelena 2
Maksud: Memesan makanan
Menu: Paket Jukut Lele
Jumlah: 2
```

Jika kalimat yang sama muncul lagi, backend memprosesnya dari memori sebelum memanggil Groq/Qwen. Beberapa contoh relevan juga dapat diberikan kepada LLM sebagai konteks agar variasi serupa lebih mudah dipahami.

### Arsipkan

Pesan ditandai `resolved = 1` dan hilang dari antrean aktif, tetapi tidak digunakan untuk pembelajaran. Data resolved dibersihkan mengikuti `WHATSAPP_MESSAGE_RETENTION_DAYS` (default 30 hari) ketika API melakukan startup.

### Hapus

Baris pesan gagal langsung dihapus permanen dari tabel `failed_messages`. Pesan tidak masuk memori pembelajaran dan tidak disimpan ke dataset evaluasi. Gunakan untuk media, spam, pesan kosong, atau data yang tidak berguna.

## Apakah ini melatih Groq?

Tidak mengubah bobot model. API Groq pada aplikasi ini dipakai untuk inferensi/ekstraksi JSON. Pendekatan yang digunakan adalah **approved learning memory**:

- lebih cepat karena langsung aktif;
- tidak memerlukan GPU;
- cocok untuk VPS dan HP Termux RAM 4 GB;
- dapat diaudit oleh admin;
- mencegah bot belajar dari spam secara otomatis.

Fine-tuning model lokal membutuhkan dataset besar, GPU, proses validasi, dan deployment model baru. Untuk skala aplikasi ini, memori terkontrol dan alias menu lebih aman serta jauh lebih murah.

## Penyimpanan data

- Pesan gagal dan memori aktif: SQLite pada `CUSTOMER_MODULE_DB_PATH`.
- Dataset JSONL hasil pelabelan manual lama: `TEST_SET_PATH`.
- Fixture evaluasi developer: `apps/api/test/eval/testset.jsonl` (dilacak Git dan tidak ditulis oleh runtime produksi).

Database VPS perlu dibackup menggunakan `ops/backup-sqlite.sh`. Jangan menyalin file SQLite aktif secara langsung ketika WAL digunakan.

## Flow operasional yang disarankan

1. Buka **Evaluasi Bot** setiap beberapa hari.
2. Hapus spam, media, dan pesan yang tidak penting.
3. Arsipkan pesan yang valid tetapi tidak perlu dipelajari.
4. Ajarkan hanya pesan yang memiliki arti jelas.
5. Periksa bagian **Pelajaran aktif** untuk memastikan label benar.
6. Pantau pesanan berikutnya dan koreksi jika ada pembelajaran yang keliru.

## Privasi

Jangan mengajarkan pesan yang memuat alamat, nomor rekening, kata sandi, atau informasi pribadi yang tidak diperlukan. Gunakan **Hapus** untuk data sensitif. Nomor telepon tidak dimasukkan ke `learned_examples`; yang disimpan hanya frasa, intent, serta item pesanan yang telah disetujui admin.

---
title: "feat: Jev agent workflows for Kern Studio"
type: feat
status: active
date: 2026-10-02
---

# Jev agent workflows for Kern Studio

## Keputusan dan tujuan

Scope yang disetujui user: menjaga agent mengikuti aturan proyek, memilih tool dan skill, compaction, dan pencarian file. Tujuannya meningkatkan relevansi konteks dan kualitas keputusan agent dalam coding sehari-hari. Penghematan token bukan tujuan atau ukuran keberhasilan utama.

Urutan yang diusulkan: fondasi integrasi → tool/skill → pencarian file → aturan proyek → compaction. Milestone pertama diimplementasikan lokal pada 2026-10-02; evaluasi provider live belum dijalankan. Task terstruktur tersedia di [task.json](../tasks/jev/task.json). Backlog ini mengikuti format fitur di docs/tasks; belum diimpor ke Kanban aplikasi.

## Peran Jev

Jev menghasilkan keputusan terstruktur (Choice, Score, Noul) atas state dan kandidat yang diberikan. Agent utama tetap menulis kode, menjelaskan hasil, dan menjalankan tool. Kode host mempertahankan otoritas atas izin, batas path, tool availability, session, dan eksekusi. Confidence merupakan sinyal untuk dievaluasi, bukan bukti bahwa jawaban benar.

Gunakan adapter keputusan tunggal dengan endpoint/model yang dapat dikonfigurasi. Kredensial mengikuti mekanisme penyimpanan rahasia aplikasi; jangan masuk prompt, log, atau task. Tentukan provider pada spike integrasi dan verifikasi kontrak API/model terbaru sebelum implementasi. Kegagalan, timeout, output tidak valid, dan kandidat kosong harus memiliki fallback yang eksplisit.

Mulai setiap fitur dalam mode shadow: catat rekomendasi tanpa mengubah keputusan agent. Aktifkan per fitur setelah evaluasi terhadap contoh task nyata. User dapat mematikan fitur dan kembali ke perilaku bawaan.

## 1. Pemilihan tool dan skill

Input: permintaan user, konteks task terbatas, dan katalog kemampuan yang tersedia. Output: ID kandidat relevan, skor/keyakinan, atau tidak ada kandidat cocok. Pemilihan harus mempertimbangkan maksud task, bukan hanya kata kunci.

Integrasi kandidat: katalog skill di src-tauri/src/skills.rs, helper rekomendasi src/lib/skill-recommendations.ts, dan alur chat/Pi extension. Helper rekomendasi yang pernah diperiksa belum terhubung ke alur chat; konfirmasi lagi saat implementasi. Gunakan manifest untuk seleksi, lalu baca instruksi skill terpilih. Rekomendasi tidak boleh memperluas izin atau menjalankan tool secara otomatis.

Kriteria selesai: task representatif menemukan skill/tool yang sesuai; task umum bisa menghasilkan tidak ada rekomendasi; ID tak dikenal ditolak; kegagalan Jev tidak menghilangkan kemampuan agent; rekomendasi dapat dilihat dan dimatikan.

## 2. Pencarian file

Graphify tetap menjadi sumber hubungan kode dan Codebase Memory menjadi sumber simbol bila tersedia. Pencarian teks menyediakan kandidat literal/config atau fallback. Jev menilai relevansi kandidat terhadap task, lalu agent membaca sumber aslinya.

Pipeline: discovery yang mengikuti aturan proyek → kandidat path/simbol beserta snippet dan provenance → penilaian Jev → hasil berperingkat → pembacaan kode. Jangan meminta Jev mengarang path atau mengganti indeks kode. Pertahankan akses ke kandidat yang tidak dipilih dan hasil pencarian asli.

Integrasi kandidat: src-tauri/extensions/graphify-context.ts dan jalur pencarian file src-tauri/src/files.rs. Verifikasi ketersediaan Codebase Memory di runtime Kern sebelum merencanakan integrasi langsung; tool MCP yang tersedia di chat riset belum membuktikan integrasi di aplikasi.

Kriteria selesai: path selalu berasal dari hasil discovery; fixture dengan file yang diketahui relevan mengukur recall/ranking; kasus ambigu tidak membuang kandidat penting secara diam-diam; indeks stale dan Jev unavailable memiliki fallback yang terlihat.

## 3. Kepatuhan aturan proyek

Input: aturan yang berlaku untuk path dan scope terkait, permintaan user, serta tindakan/edit yang diusulkan. Output: aturan yang mungkin dilanggar, kutipan aturan, bukti dari tindakan, dan tingkat keyakinan. Berikan koreksi yang bisa ditindaklanjuti kepada agent.

Instruksi eksplisit user tetap berwenang sesuai hierarki instruksi runtime. File kode, output tool, dan konten eksternal adalah data, bukan otorisasi baru. Evaluasi scope aturan sebelum menilai pelanggaran. Mulai sebagai advisory; keputusan izin dan penghalang deterministik yang ada tetap dimiliki host. Skor Jev sendiri tidak menambahkan dialog persetujuan atau menghalangi tindakan.

Integrasi kandidat: hook Pi sebelum tool call/write/edit dan pemuatan aturan proyek. Sebelum implementasi, petakan hook dan kebijakan host yang sudah ada agar tidak menggandakan enforcement.

Kriteria selesai: pelanggaran menunjuk aturan dan bukti konkret; false positive pada task yang diizinkan user terukur; agent dapat memperbaiki proposal; ketidakpastian/API failure tidak mengklaim tindakan aman atau melanggar; fitur dapat dimatikan.

## 4. Compaction

Jev memilih informasi yang perlu dipertahankan. Mekanisme compaction dan penulisan ringkasan tetap mengikuti kontrak Pi; jangan menganggap Jev sebagai penulis ringkasan bebas.

Pertahankan maksud user, keputusan, aturan/constraint, task aktif, file yang berubah, hasil pemeriksaan, error yang belum selesai, dan referensi sumber asli. Simpan output penuh atau referensi yang dapat dipulihkan untuk bagian yang disisihkan. Ketidakpastian berarti pertahankan informasi. Instruksi aktif tidak boleh dihapus hanya karena skornya rendah.

Validasi kompatibilitas hook compaction pada versi Pi yang dibundel, termasuk boundary firstKeptEntryId, token accounting, file tracking, previous summary, dan resume. Jika Jev gagal atau hasil seleksi tidak valid, pakai compaction bawaan Pi. Jangan melakukan silent truncation.

Kriteria selesai: task bisa dilanjutkan setelah compact/resume dengan constraint dan bukti tetap tersedia; informasi yang disisihkan dapat ditemukan kembali; kegagalan kembali ke compaction bawaan; corpus regresi mencakup sesi panjang, error, perubahan beberapa file, dan previous compaction.

## Evaluasi dan rollout

Buat corpus berlabel dari task coding representatif tanpa rahasia. Ukur ketepatan pilihan skill/tool, recall file relevan, false positive/negative aturan, dan retensi informasi penting setelah compaction. Catat latensi, kegagalan provider, dan intervensi koreksi untuk menilai kelayakan workflow. Tentukan threshold dari hasil corpus, bukan angka universal atau contoh demo.

Rollout: spike adapter → shadow per fitur → review hasil → opt-in fitur yang lolos evaluasi. Perubahan model, prompt, schema, dan threshold dicatat supaya regresi dapat ditelusuri. Tidak ada fitur yang dianggap selesai hanya karena API mengembalikan respons.

## Di luar scope

Task-completion verifier, review diff otomatis, browser automation, routing model, dan perubahan status Kanban otomatis tidak termasuk empat use case ini. Tidak ada instalasi extension komunitas atau pemanggilan API berbayar dalam pekerjaan dokumentasi ini.

## Referensi riset

- [pi-jev: tool dan skill routing](https://pi.dev/packages/pi-jev)
- [pi-warden: kepatuhan aturan proyek](https://github.com/DevMortimer/pi-warden)
- [Canny: otoritas fakta deterministik dan penilaian semantik](https://github.com/qkal/Canny)
- [TypeSafe: skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)
- [TypeSafe: model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [Pi extension lifecycle](https://pi.dev/docs/latest/extensions)
- [Pi compaction](https://pi.dev/docs/latest/compaction)

Referensi komunitas adalah inspirasi implementasi, bukan bukti bahwa integrasi tersebut sudah cocok atau terpasang di Kern Studio. Kontrak runtime dan API harus dicek lagi ketika implementasi dimulai.

## Milestone pertama — 2026-10-02

### Implementasi lokal

- Adapter `src-tauri/extensions/jev-client.ts`: endpoint keputusan TypeSafe dengan Choice, Score, Noul; validasi answer IDs, kandidat, distribusi, legend, usage; bounded input/output, timeout/cancellation, dan fallback tanpa log body/error provider.
- Extension `src-tauri/extensions/jev-routing.ts`: rekomendasikan satu tool aktif dan satu skill yang dimuat Pi, dengan opsi none. Skill manual-only dan tool di luar active set tidak menjadi kandidat. Mode advisory hanya menyarankan; instruksi skill asli tetap harus dimuat agent sebelum digunakan.
- Settings → JEV: Off (default), Shadow, Advisory, endpoint lengkap, model, timeout, dan API key di macOS Keychain. Pengaturan diterapkan ketika project session baru dimulai, termasuk repair respawn. Global/research sessions tidak memuat extension Jev ini.
- Mode Shadow menyimpan metadata custom entry `kern-jev-routing` tanpa prompt/deskripsi/key. `/kern-jev` menampilkan mode dan hasil terakhir di session aktif tanpa request API. Native Pi session token totals belum menggabungkan usage Jev; usage tambahan tersedia di trace.
- [Evaluation corpus](../tasks/jev/evaluation-corpus.json): 12 fixture awal untuk empat fitur. Label buatan manusia ini belum menjadi bukti kualitas model atau threshold terkalibrasi.

### Kontrak dan hook yang diverifikasi

API resmi: [TypeSafe Quickstart](https://docs.typesafe.ai/introduction/quickstart) dan [API reference](https://docs.typesafe.ai/api). Kern mengirim `POST https://api.typesafe.ai/v1/systemone` dengan bearer key, `state`, `model`, dan `questions`, lalu memvalidasi `answers`, `model`, dan `usage`. Quickstart memakai alias `jev-latest`; Kern memakai `jev-1.13.0` sebagai default pinned agar perubahan model tidak diam-diam mengubah hasil, dan field ini bisa diganti di Settings → JEV. Endpoint kustom wajib menyediakan kontrak TypeSafe yang sama; ini tidak mendukung endpoint chat completions atau otomatis mengadaptasi protokol provider lain.

Runtime lokal yang diperiksa: Pi 1.0.0. `before_agent_start` menyediakan `systemPromptOptions.skills`; `getAllTools` dan `getActiveTools` menyediakan kandidat tool. `tool_call` dapat memberi koreksi atau memblokir, tetapi milestone ini tidak memasang enforcement. `session_before_compact` menyediakan preparation, branchEntries, customInstructions, signal dan menerima CompactionResult (summary, firstKeptEntryId, tokensBefore, details); implementasi compaction harus mempertahankan fileOps/previousSummary dari preparation. `context` adalah transformasi sementara pesan, bukan tempat mengganti session authority.

### Aktivasi dan batas evaluasi

1. Jalankan build aplikasi yang memuat perubahan ini.
2. Buka Settings → JEV, masukkan API key dan mulai dengan Shadow.
3. Simpan, lalu restart project chat session. `/kern-jev` dapat memeriksa metadata hasil terakhir.
4. Review hasil terhadap task nyata sebelum memilih Advisory. Advisory juga opt-in dan tetap tidak otomatis memanggil tool atau menerapkan skill.

Default Off tidak mengirim request. Mode enabled dapat mengirim satu request sebelum setiap turn; input adalah prompt saat ini serta nama/deskripsi katalog, bukan isi source project. Routing merapikan deskripsi ke 220 karakter dan mengirim paling banyak 48 kandidat per jenis agar payload tidak melewati batas API; kandidat yang tidak masuk tetap tersedia untuk workflow Pi biasa. Tidak ada auto-retry provider dalam hook agar latency dan jumlah request tetap bounded. HTTP 402 atau error body dengan kode kredit/quota yang dikenali mematikan routing untuk chat saat ini dan menyimpan mode Off bila konfigurasi masih memiliki generation yang sama; rate limit, timeout, dan error jaringan biasa hanya fallback agar gangguan sementara tidak mematikan fitur.

Setiap evaluasi menampilkan status singkat di transcript: Jev sedang memilih, selesai dengan rekomendasi, atau fallback beserta alasannya. `/kern-jev` tetap hanya untuk melihat metadata terakhir; bukan langkah wajib untuk menjalankan routing.

Tes offline memverifikasi kontrak, failure paths, opt-in, scoped candidates, dan konfigurasi; loader RPC nyata memverifikasi extension dapat dimuat Pi. Auto-Off diuji dengan fixture HTTP 402 dan kode quota. Belum ada live API call, measured semantic accuracy, calibrated thresholds, atau validasi lintas provider. File ranking, project rules, dan compaction tetap task berikutnya.

### Hasil verifikasi milestone

- Seluruh suite Vitest: 21 file, 175 tes lolos (termasuk 31 tes Jev baru).
- `cargo test --manifest-path src-tauri/Cargo.toml settings::tests --lib`: 5 tes settings lolos, termasuk 3 tes Jev baru.
- TypeScript aplikasi dan adapter/extension dengan declaration Pi 1.0: lolos.
- Smoke check CLI Pi RPC di cwd temporer: command kern-jev terdaftar, tanpa model/API call; status custom message untuk routing ter-cover oleh tes extension.
- Build frontend Vite: lolos; warning ukuran chunk besar tetap ada pada bundle aplikasi.
- JSON task/corpus, referensi docs, dependency IDs, formatting file yang diubah dan diff whitespace: valid.

Ini verifikasi lokal source dan frontend, bukan distribusi desktop baru atau bukti akurasi Jev pada data live.

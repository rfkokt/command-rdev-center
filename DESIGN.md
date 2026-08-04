---
name: command-rdev-center
description: Full pi capability in a technical, bold, controlled visual workflow.
colors:
  canvas: "#111210"
  surface-soft: "#191a17"
  surface-card: "#20211e"
  surface-elevated: "#282925"
  hairline: "#30312c"
  hairline-strong: "#4a4b43"
  on-dark: "#f0f0e8"
  body: "#deded5"
  muted: "#92938a"
  muted-soft: "#66675f"
  runtime-lime: "#d7ff54"
  danger: "#ff7069"
  success: "#8ecf76"
  info: "#82d7ee"
typography:
  title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.12em"
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.12em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sharp: "0"
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.runtime-lime}"
    textColor: "{colors.canvas}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "10px 16px"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.runtime-lime}"
    typography: "{typography.label}"
    rounded: "{rounded.sharp}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.sharp}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.body}"
    rounded: "{rounded.sharp}"
    padding: "16px"
---

# Design System: command-rdev-center

## Overview

**Creative North Star: "The Agent Operations Console"**

Sistem ini adalah ruang kendali operasional untuk agent coding: padat, eksplisit, dan selalu menunjukkan keadaan sistem. Kanvas near-black menjaga fokus selama sesi panjang; Runtime Lime menandai tindakan, seleksi, dan aktivitas hidup. Struktur terasa teknis tanpa berubah menjadi terminal clone.

Desain mengutamakan familiarity alat kerja desktop. Border, tonal layers, sticky regions, dan status labels membentuk hierarki; dekorasi tidak boleh bersaing dengan pekerjaan. Gerak hanya menjelaskan state, berlangsung cepat, dan memiliki reduced-motion fallback.

Sistem ini menolak generic SaaS dashboard, terminal clone, dan gaming cockpit. Tidak ada pastel gradient, card grid dekoratif, kontrol cryptic, neon overload, HUD palsu, atau animasi tanpa fungsi.

**Key Characteristics:**
- Dense tetapi terstruktur.
- Dark restrained palette dengan satu aksen langka dan kuat.
- State selalu eksplisit melalui warna, label, ikon, atau bentuk.
- Sudut dominan tajam; radius dipakai hanya untuk affordance kecil.
- Detail teknis memakai mono; UI utama memakai satu sans yang konsisten.

## Colors

Palet charcoal kehijauan membentuk lapisan kerja; Runtime Lime menjadi sinyal operasional, bukan dekorasi.

### Primary
- **Runtime Lime**: tindakan utama, state aktif, focus internal, progress, dan informasi yang membutuhkan perhatian langsung.

### Secondary
- **Failure Red**: destructive actions dan failure states saja.
- **Pass Green**: hasil sukses dan stage yang lulus.
- **Search Cyan**: aktivitas web/search yang perlu dibedakan dari operasi agent utama.

### Neutral
- **Operations Canvas**: latar aplikasi dan area kerja utama.
- **Soft Console Surface**: sidebar, toolbar, dan lapisan pasif.
- **Working Surface**: card, row, dialog, serta kontainer aktif.
- **Raised Surface**: hover, selection, dan elemen overlay.
- **Primary Ink** dan **Body Ink**: heading serta teks kerja.
- **Muted Telemetry**: metadata dan label sekunder; bukan body copy penting.
- **Structural Hairlines**: pemisah, batas tabel, dan grouping.

### Named Rules

**The One Signal Rule.** Runtime Lime hanya untuk action, active selection, focus, dan live state. Jangan gunakan sebagai ornamen.

**The State Redundancy Rule.** Error, success, running, dan disabled tidak boleh dibedakan melalui warna saja; sertakan teks, ikon, pola, atau bentuk.

## Typography

**Display Font:** Plus Jakarta Sans (system-ui fallback)  
**Body Font:** Plus Jakarta Sans (system-ui fallback)  
**Label/Mono Font:** JetBrains Mono (ui-monospace fallback)

**Character:** Plus Jakarta Sans memberi kepadatan yang bersih dan familiar untuk kontrol desktop. JetBrains Mono hanya menandai data mesin, diff, command, JSON, dan output teknis.

### Hierarchy
- **Headline** (700, 20px, 1.2): judul dashboard atau panel utama.
- **Title** (700, 14–16px, 1.25): heading dialog, kelompok, dan pesan penting.
- **Body** (400, 14px, 1.5): label kontrol, deskripsi, status, dan copy utama; prose panjang maksimal 75ch.
- **Label** (600–700, 13px, letter-spacing 0.08–0.14em): metadata dan navigasi singkat. Uppercase hanya untuk operational labels, bukan setiap heading.
- **Mono** (400, 10–12px, 1.55–1.65): code, diff, JSON, command, dan telemetry teknis.

### Named Rules

**The Interface First Rule.** Jangan gunakan display serif pada label, tombol, data, atau navigasi. Font teknis tidak boleh membuat kontrol sulit dipindai.

**The Earned Uppercase Rule.** Uppercase dan tracking lebar hanya untuk status atau label mesin yang benar-benar singkat.

## Elevation

Sistem flat-by-default dengan depth melalui tonal layering dan border. Hard offset shadows dipakai pada dialog, picker, dan overlay penting agar tumpukan konteks terbaca; shadow bukan dekorasi card. Backdrop blur hanya sah saat memisahkan modal dari workspace aktif.

### Shadow Vocabulary
- **Overlay Offset** (`8px 8px 0 #080906`): picker, toast, dan overlay kecil.
- **Dialog Offset** (`16px 16px 0 #080906`): dialog atau panel modal besar.
- **Live Signal Glow** (`0 0 12px #d7ff5488`): indikator live berukuran kecil; dilarang pada surface luas.

### Named Rules

**The Flat Operations Rule.** Surface tetap datar saat idle. Elevation muncul hanya karena hierarchy atau state.

## Components

### Buttons
- **Shape:** tajam untuk primary operational actions; radius kecil hanya untuk icon controls yang membutuhkan hit-area terpisah.
- **Primary:** Runtime Lime di atas Operations Canvas, bobot 700, tinggi minimum 38–40px.
- **Hover / Focus:** hover mengubah tonal value, bukan layout; focus-visible memakai outline 2px dengan offset 2px.
- **Secondary / Ghost:** border hairline atau Runtime Lime, background transparan, label tetap jelas.
- **Disabled:** opacity turun dan cursor default; state tidak boleh terlihat interaktif.

### Cards / Containers
- **Corner Style:** dominan tajam; radius 6–8px hanya pada compact rows atau surface yang memang interaktif.
- **Background:** Working Surface di atas Operations Canvas.
- **Shadow Strategy:** tanpa shadow saat idle; lihat Elevation untuk overlay.
- **Border:** hairline penuh. Colored side-stripe lebih dari 1px dilarang.
- **Internal Padding:** 8px untuk dense rows, 12–16px untuk controls, 20–24px untuk dialog.

### Inputs / Fields
- **Style:** background gelap, border hairline kuat, teks Primary Ink, minimum hit area sekitar 38px.
- **Focus:** border Runtime Lime atau focus outline yang jelas.
- **Error / Disabled:** error memakai Failure Red plus pesan; disabled tetap terbaca tetapi tidak menyerupai state aktif.

### Navigation
- Sidebar fixed-width memakai tonal layer berbeda dari workspace. Hover memberi surface shift; active state memakai Runtime Lime plus background atau marker bentuk. Label harus tetap terbaca saat nama proyek panjang melalui truncation yang disengaja dan title/accessible name bila perlu.

### Agent Activity
- Running state memakai motion singkat atau pulse terkendali, label status, dan indikator bentuk.
- Tool call, approval, diff, dan pipeline harus berbagi vocabulary status yang sama.
- `prefers-reduced-motion: reduce` mematikan sweep, pulse, dan looping animation tanpa menghilangkan informasi state.

## Do's and Don'ts

### Do:
- **Do** gunakan Runtime Lime hanya untuk action, active selection, focus, dan live state.
- **Do** pertahankan hierarchy melalui tonal layers, border, spacing, dan typography sebelum menambah shadow.
- **Do** sediakan hover, focus-visible, active, disabled, loading, error, dan reduced-motion state untuk kontrol interaktif.
- **Do** pertahankan density desktop; gunakan 8px untuk dense rows, 12–16px untuk controls, dan 20–24px untuk dialog.
- **Do** komunikasikan status dengan label atau ikon selain warna.

### Don't:
- **Don't** membuat generic SaaS dashboard dengan soft card grids, whitespace berlebihan, pastel gradients, atau decorative metrics.
- **Don't** membuat terminal clone dengan kontrol cryptic, raw text density, atau affordance yang hanya bisa dipahami lewat command-line knowledge.
- **Don't** membuat gaming cockpit dengan neon overload, glow dekoratif, HUD palsu, atau constant animation.
- **Don't** memakai colored `border-left` atau `border-right` lebih dari 1px sebagai aksen card, callout, alert, atau list item.
- **Don't** memakai gradient text, decorative glassmorphism, atau nested cards.
- **Don't** menambahkan tiny uppercase tracked eyebrow pada setiap section.
- **Don't** memakai modal sebagai pilihan pertama jika inline atau progressive disclosure cukup.

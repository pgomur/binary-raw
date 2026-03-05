<p align="center" >
  <img src="./public/favicon.png" alt="Binary Raw logo" width="120"/>
</p>

<h1 align="center">Binary Raw</h1>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.4+-3178C6?style=flat&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-7.3+-646CFF?style=flat&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeDoc-0.28.17-0058B0?style=flat&logo=typedoc&logoColor=white" />
  <img src="https://img.shields.io/badge/Vitest-4.0+-729B1B?style=flat&logo=vitest&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-≥18-3C873A?style=flat&logo=node.js&logoColor=white" />
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-8A8A8A?style=flat&logo=github&logoColor=white" />
  </a>
</p>

<br/>
<p align="center" >
  <a href="#key-features">Key Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#module-architecture">Architecture</a> •
  <a href="#api-documentation">Documentation</a> •
  <a href="#testing">Testing</a>
</p>

> ⚠️ **MVP — Minimum Viable Product.** Early functional version.

Web hex editor for technical binary analysis, developed entirely with TypeScript and native browser APIs. It employs a _Zero-Framework_ architecture to minimize execution overhead and utilizes a virtualized rendering system that enables inspection of large buffers without interface latency, integrating signature-based format detection engines and transactional state management.

<p align="center">
  <img src="./public/screen_3.png" alt="Binary Raw — Welcome Screen"/>
</p>

## Key Features

### Automatic Multi-Format Parsing

Dynamically detects and interprets the structure of the following file formats by their byte signature (_magic bytes_):

| Category     | Supported Formats                            |
| ------------ | -------------------------------------------- |
| Executables  | `ELF` (Linux/Unix), `PE` 32/64-bit (Windows) |
| Documents    | `PDF`                                        |
| Archives     | `ZIP`                                        |
| Images       | `PNG`, `JPEG`                                |
| Raw Binaries | `BIN` — block-level entropy analysis         |

Each parser extracts sections, headers, and structured metadata that are presented visually in the sidebar tree of the interface.

### Virtualized Hex View (Zero Lag & Semantic Highlighting)

The `hex-view` component implements **sliding-window virtualized rendering**: only the bytes currently visible on screen are injected into the DOM. This allows inspecting files hundreds of MB in size with smooth scrolling, without UI blocking or memory consumption spikes.

- **Layout:** Three columns per row (hex offset | hex values | ASCII representation).
- **Semantic Highlighting:** Automatically color-codes bytes based on their role:
  - **`Header / Magic` (Purple):** File signatures and critical metadata.
  - **`Structured` (Blue):** Bytes belonging to parsed sections (sections, segments).
  - **`Modified` (Yellow):** Bytes edited during the current session.
  - **`Null` (Dimmed):** Zero bytes for easier structure visualization.

### Real-Time Data Inspector

Clicking or selecting one or more bytes triggers the **`inspector`** side panel to decode them on the fly into:

- **Integers:** `Int8`, `UInt8`, `Int16`, `UInt16`, `Int32`, `UInt32`, `Int64`, `UInt64` — in both `Little Endian` and `Big Endian` variants.
- **Floating Point:** `Float32`, `Float64`.
- **Strings & Encodings:** `ASCII`, `UTF-8`, `UTF-16`, `UTF-32`, and `Latin-1`.
- **Bit view:** individual bit decomposition (`b0` → `b7`) of the byte under the cursor.
- **Time/Date:** Automatic Unix timestamp detection (converts 4/8 byte sequences to ISO dates).
- **Color Preview:** Real-time RGB/RGBA swatch for 3 or 4-byte selections.
- **Data Export:** Instant **Base64** encoding of the active selection.

### Robust History Control (Undo / Redo)

A custom-built exhaustive state machine that seamlessly handles **byte replacements and range edits**. Guarantees complete reversibility of all edit operations via in-memory command stacks with O(1) access. Each command stores the old and new values for every affected byte, enabling precise bidirectional replay.

### Domain-Driven & Type Safe (Branded Types)

Uses _Branded Types_ throughout the type system (`AbsoluteOffset`, `ByteCount`, `VirtualAddress`), preventing semantic mix-ups in numeric operations or index accesses that could result in silent logic errors. All arithmetic on binary offsets is strictly bounded and validated at compile time.

### Byte Pattern Search

Integrated search engine (`search.ts`) that locates arbitrary byte sequences within the active buffer, supporting **hex**, **ASCII**, and **UTF-8** input modes, with visual highlighting of matches in the hex view and toolbar navigation (next / previous result, up to 1,000 matches).

### Recent Files Management

-`recents.ts` module that persists the history of recently opened files via **IndexedDB**, ensuring persistence across browser sessions. Allows quick reopening of previous files from the welcome screen, including file format and size metadata.

### Entropy Analysis

Block-level Shannon entropy calculation (`entropy.ts`), useful for identifying plaintext zones, compressed data, or encrypted segments in arbitrary binaries.

## Installation

### Prerequisites

- **Node.js** `>= 18.0.0` (recommended: current LTS)
- **npm** `>= 9.x`
- Modern browser with native `ESM` support (Chrome 105+, Firefox 110+, Safari 16+)

> **Windows note:** All project scripts use pure Node.js for filesystem operations (e.g. `clean`), making them fully compatible with CMD, PowerShell, Git Bash, and WSL without any additional tools.

### 1. Clone the Repository

```bash
git clone https://github.com/pgomur/binary-raw.git
cd binary-raw
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Available Scripts

The project provides several pre-configured commands for the development lifecycle (defined in `package.json`):

```bash
# Development server with native HMR (port 5173, opens browser automatically)
npm run dev

# Type-check without emitting code — ideal for CI or pre-commit hooks
npm run typecheck

# Build optimized production bundle → /dist
npm run build

# Clean the /dist output directory (cross-platform)
npm run clean

# Preview the production build on localhost
npm run preview

# Run tests in watch mode (interactive development)
npm run test

# Run tests once (ideal for CI/CD pipelines)
npm run test:run

# Generate code coverage report with V8
npm run coverage

# Generate API documentation with TypeDoc → /docs
npm run docs
```

> **Note:** The development server starts at `http://localhost:5173` with `strictPort: true` — if the port is already in use, Vite will throw an error instead of trying another port.

---

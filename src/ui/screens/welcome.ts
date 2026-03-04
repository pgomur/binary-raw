/**
 * @file src/ui/screens/welcome.ts
 * Welcome screen orchestrator.
 *
 * Responsibilities:
 * - Drag-and-drop and file selection (via drop-zone.ts).
 * - Recent files list and management (recents.ts + storage.ts).
 * - File loading, parsing, and dispatching the `file:ready` event.
 * - Loading progress UI and delete-confirmation modal.
 */

import { parseBuffer } from "@core/parsers/index";
import { saveRecent, loadRecents, removeRecent } from "@utils/recents";
import { saveFileBuffer, loadFileBuffer } from "@utils/storage";
import type { LoadedFile, RecentFileEntry, ByteCount, FileFormat } from "@app-types/index";
import { Bytes, Offset, Range } from "@app-types/index";
import { createDropZone, type DropZoneHandle } from "@ui/components/drop-zone";
import template from "./welcome.html?raw";

// Local types

/** Visual state of the welcome screen. */
type WelcomeState = "idle" | "dragging" | "loading";

/**
 * Synthetic file descriptor used to re-open a recent file from IndexedDB
 * through the same {@link processFile} code path as a real `File` object.
 */
interface SyntheticFile {
  readonly name: string;
  readonly size: number;
  readonly buffer: ArrayBuffer;
}

// DOM element references

const el = {
  root: null as HTMLElement | null,
  recentList: null as HTMLUListElement | null,
  recentEmpty: null as HTMLElement | null,
  recentCounter: null as HTMLElement | null,
  fileInput: null as HTMLInputElement | null,
  loadingIcon: null as HTMLElement | null,
  loadingFilename: null as HTMLElement | null,
  loadingBarFill: null as HTMLElement | null,
  loadingStep: null as HTMLElement | null,
  statusbarLeft: null as HTMLElement | null,
  statusbarRight: null as HTMLElement | null,
  dropZone: null as HTMLElement | null,
  deleteModal: null as HTMLElement | null,
  deleteFilename: null as HTMLElement | null,
  deleteConfirmBtn: null as HTMLButtonElement | null,
  deleteCancelBtn: null as HTMLButtonElement | null,
  recentLimitAlert: null as HTMLElement | null,
};

// Internal state

let dropZone: DropZoneHandle | null = null;
let fileToDelete: RecentFileEntry | null = null;

// Public API

/**
 * Mounts the welcome screen into `container`, injects the HTML template,
 * caches DOM references, renders the recents list, and attaches the drop zone.
 *
 * @param container - The host element that receives the welcome template.
 */
export function mountWelcome(container: HTMLElement): void {
  container.innerHTML = template;
  container.style.display = "block";

  el.root = container.querySelector(".welcome");
  el.recentList = container.querySelector("#recent-list");
  el.recentEmpty = container.querySelector("#recent-empty");
  el.recentCounter = container.querySelector("#recent-counter");
  el.fileInput = container.querySelector("#file-input");
  el.loadingIcon = container.querySelector("#loading-icon");
  el.loadingFilename = container.querySelector("#loading-filename");
  el.loadingBarFill = container.querySelector("#loading-bar-fill");
  el.loadingStep = container.querySelector("#loading-step");
  el.statusbarLeft = container.querySelector("#statusbar-left");
  el.statusbarRight = container.querySelector("#statusbar-right");
  el.dropZone = container.querySelector(".drop-zone");
  el.deleteModal = container.querySelector("#delete-modal");
  el.deleteFilename = container.querySelector("#delete-filename");
  el.deleteConfirmBtn = container.querySelector("#delete-confirm");
  el.deleteCancelBtn = container.querySelector("#delete-cancel");
  el.recentLimitAlert = container.querySelector("#recent-limit-alert");

  registerModalEvents();
  void renderRecents();

  if (el.dropZone && el.fileInput) {
    dropZone = createDropZone({
      element: el.dropZone,
      fileInput: el.fileInput,
      onFileSelected: (file: File) => void processFile(file),
      onStateChange: (state: "idle" | "dragging") => setState(state),
    });
  }
}

/**
 * Unmounts the welcome screen, hides the container, and destroys the drop zone.
 *
 * @param container - The host element passed to {@link mountWelcome}.
 */
export function unmountWelcome(container: HTMLElement): void {
  container.style.display = "none";
  dropZone?.destroy();
  dropZone = null;
  setState("idle");
}

/**
 * Attempts to restore the last opened file from IndexedDB.
 * Reuses the internal file-processing flow, which dispatches `file:ready`
 * on success.
 *
 * Called by `main.ts` on startup when `sessionStorage` indicates the user was
 * in the editor before the page was reloaded.
 *
 * @param name - The filename key used to look up the buffer in IndexedDB.
 * @returns `true` if the buffer was found and the load process started;
 *   `false` if it was not found or an error occurred.
 */
export async function restoreLastFile(name: string): Promise<boolean> {
  try {
    const result = await loadFileBuffer(name);
    if (!result) return false;
    void processFile({ name, size: result.buffer.byteLength, buffer: result.buffer });
    return true;
  } catch {
    return false;
  }
}

// State

/**
 * Sets the `data-state` attribute on the root element to drive CSS transitions.
 *
 * @param state - The new visual state.
 */
function setState(state: WelcomeState): void {
  if (el.root) el.root.dataset["state"] = state;
}

// Delete-confirmation modal

/**
 * Registers click and keyboard event listeners for the delete-confirmation modal.
 */
function registerModalEvents(): void {
  el.deleteCancelBtn?.addEventListener("click", () => {
    closeDeleteModal();
  });

  el.deleteConfirmBtn?.addEventListener("click", () => {
    if (!fileToDelete) return;
    const entryToDelete = fileToDelete;
    closeDeleteModal();

    void (async () => {
      const result = await removeRecent(entryToDelete.id, "by-id");
      if (!result.ok) {
        console.error("Failed to remove recent:", result.error);
      }
      void renderRecents();
    })();
  });

  // Click outside the modal closes it
  el.deleteModal?.addEventListener("click", (e) => {
    if (e.target === el.deleteModal) closeDeleteModal();
  });

  // Escape also closes it
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && el.deleteModal && !el.deleteModal.hasAttribute("hidden")) {
      closeDeleteModal();
    }
  });
}

/**
 * Opens the delete-confirmation modal for the given recent entry.
 *
 * @param recent - The recent file entry to potentially delete.
 */
function showDeleteModal(recent: RecentFileEntry): void {
  fileToDelete = recent;
  if (el.deleteFilename) el.deleteFilename.textContent = recent.name;
  el.deleteModal?.removeAttribute("hidden");
}

/** Closes the delete-confirmation modal and clears the pending entry. */
function closeDeleteModal(): void {
  fileToDelete = null;
  el.deleteModal?.setAttribute("hidden", "");
}

// File processing

/**
 * Loads, parses, and persists a file, then dispatches the `file:ready` event.
 *
 * Accepts either a real `File` (from drop or file picker) or a
 * {@link SyntheticFile} (from IndexedDB when reopening a recent entry).
 * Enforces the 20-file recent history limit before proceeding.
 *
 * @param file - The file to process.
 */
async function processFile(file: File | SyntheticFile): Promise<void> {
  const isRealFile = file instanceof File;
  const fileName = file.name;

  // Check the recents limit before loading
  const recentsResult = await loadRecents();
  if (!recentsResult.ok) {
    showError("Could not access recent files");
    return;
  }

  const recents = recentsResult.value;
  const alreadyExists = recents.some((r) => r.name === fileName);

  if (recents.length >= 20 && !alreadyExists) {
    showError("History full. Please remove a file before uploading a new one.");
    setState("idle");
    return;
  }

  setState("loading");
  setLoadingUI(fileName, "Detecting format", 10);

  try {
    const arrayBuffer = isRealFile ? await readFileAsArrayBuffer(file as File) : (file as SyntheticFile).buffer;

    setLoadingUI(fileName, "Parsing structure", 40);

    const parseResult = parseBuffer(arrayBuffer);

    if (!parseResult.ok) {
      throw new Error(`Parse failed: ${parseResult.error.message}`);
    }

    const { structure } = parseResult;
    const format = structure.format;

    setLoadingUI(fileName, "Saving to storage", 70);

    await saveFileBuffer(fileName, arrayBuffer);

    setLoadingUI(fileName, "Done", 100);

    const totalSize = Bytes.create(arrayBuffer.byteLength);
    const fileSize = isRealFile ? Bytes.create((file as File).size) : Bytes.create((file as SyntheticFile).size);

    const newEntry: RecentFileEntry = {
      id: crypto.randomUUID(),
      name: fileName,
      size: fileSize,
      format,
      lastOpened: new Date().toISOString(),
      pinned: false,
      tags: [],
    };

    const saveResult = await saveRecent(newEntry);
    if (!saveResult.ok) {
      console.warn("Could not save to recents:", saveResult.error);
    }

    void renderRecents();

    // Build visibleRange safely — byteLength >= 1 is guaranteed by parseBuffer
    const visibleEnd = Offset.create(Math.min(255, arrayBuffer.byteLength - 1));

    const loadedFile: LoadedFile = {
      handle: {
        id: newEntry.id,
        name: fileName,
        size: totalSize,
        source: "local",
        lastModified: isRealFile ? (file as File).lastModified : Date.now(),
        readable: true,
        writable: !isRealFile,
        read: async (range) => {
          const slice = arrayBuffer.slice(range.start as number, (range.end as number) + 1);
          return new Uint8Array(slice);
        },
        write: async () => {
          throw new Error("Write not implemented for local files");
        },
        close: async () => {
          /* no-op */
        },
      },
      structure,
      history: {
        commands: [],
        currentIndex: -1,
        maxSize: 1000,
        totalBytesAffected: Bytes.create(0),
      },
      selection: { type: "none" },
      viewport: {
        visibleRange: Range.create(Offset.create(0), visibleEnd),
        bytesPerRow: 16,
      },
      dirty: false,
      readOnly: isRealFile,
    };

    setState("idle");

    document.dispatchEvent(new CustomEvent<LoadedFile>("file:ready", { detail: loadedFile }));
  } catch (err) {
    setState("idle");
    showError(err instanceof Error ? err.message : "Could not read file");
  }
}

// Loading UI

/**
 * Updates the loading progress bar and status bar text.
 *
 * @param filename - Name of the file being loaded.
 * @param step     - Human-readable description of the current step.
 * @param progress - Progress percentage (0–100).
 */
function setLoadingUI(filename: string, step: string, progress: number): void {
  if (el.loadingFilename) el.loadingFilename.textContent = filename;
  if (el.loadingStep) el.loadingStep.textContent = step;
  if (el.loadingBarFill) el.loadingBarFill.style.width = `${progress}%`;
  if (el.statusbarLeft) el.statusbarLeft.textContent = `Loading ${filename}`;
  if (el.statusbarRight) el.statusbarRight.textContent = step;
}

/**
 * Displays an error message in the status bar.
 *
 * @param message - The error message to display.
 */
function showError(message: string): void {
  if (el.statusbarLeft) el.statusbarLeft.textContent = "Error";
  if (el.statusbarRight) el.statusbarRight.textContent = message;
}

// Recents

/** Fetches the recent files list from storage and re-renders the `#recent-list` element. */
async function renderRecents(): Promise<void> {
  const recentsResult = await loadRecents();

  if (!el.recentList || !el.recentEmpty) return;

  if (!recentsResult.ok) {
    el.recentEmpty.textContent = "Could not load recents";
    el.recentList.hidden = true;
    el.recentEmpty.hidden = false;
    return;
  }

  const recents = recentsResult.value;

  if (el.recentLimitAlert) {
    el.recentLimitAlert.hidden = recents.length < 20;
  }

  if (el.recentCounter) {
    el.recentCounter.textContent = `${recents.length}/20`;
    el.recentCounter.style.color = recents.length >= 20 ? "var(--accent5)" : "inherit";
  }

  if (recents.length === 0) {
    el.recentList.hidden = true;
    el.recentEmpty.hidden = false;
    return;
  }

  el.recentList.hidden = false;
  el.recentEmpty.hidden = true;
  el.recentList.innerHTML = "";

  recents.forEach((recent, index) => {
    // Visual divider between the 7 most recent entries and older ones
    if (index === 7 && recents.length > 7) {
      const divider = document.createElement("li");
      divider.className = "recent-divider";
      divider.textContent = "Older";
      el.recentList?.appendChild(divider);
    }
    el.recentList?.appendChild(buildRecentItem(recent, index >= 7));
  });
}

/**
 * Builds a `<li>` element for a single recent file entry.
 *
 * @param recent - The recent file entry to render.
 * @param old    - Whether this entry falls in the "Older" section (index ≥ 7).
 * @returns The populated list item element.
 */
function buildRecentItem(recent: RecentFileEntry, old: boolean): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `recent-item${old ? " recent-item--old" : ""}${recent.pinned ? " recent-item--pinned" : ""}`;
  li.innerHTML = `
    <div class="file-icon ${formatToIconClass(recent.format)}">${recent.format}</div>
    <div class="file-info">
      <span class="file-name">${escapeHtml(recent.name)}</span>
      <span class="file-meta">${formatSize(recent.size)} · ${timeAgo(recent.lastOpened)}</span>
    </div>
    ${recent.pinned ? '<span class="recent-item__pin" title="Pinned">📌</span>' : ""}
    <button class="recent-item__remove" title="Remove from list" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/>
      </svg>
    </button>
  `;

  li.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".recent-item__remove")) return;
    void openRecent(recent);
  });

  const removeBtn = li.querySelector(".recent-item__remove");
  removeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    showDeleteModal(recent);
  });

  return li;
}

/**
 * Loads a recent file's buffer from IndexedDB and passes it to {@link processFile}.
 * Displays an error in the status bar if the buffer is no longer available.
 *
 * @param recent - The recent file entry to reopen.
 */
async function openRecent(recent: RecentFileEntry): Promise<void> {
  try {
    const result = await loadFileBuffer(recent.name);
    if (result) {
      void processFile({
        name: recent.name,
        size: recent.size as number,
        buffer: result.buffer,
      });
      return;
    }
  } catch (err) {
    console.error("IndexedDB error:", err);
  }

  showError(`Could not find "${escapeHtml(recent.name)}" in storage. Please reopen the file manually.`);
}

// FileReader as Promise

/**
 * Wraps `FileReader.readAsArrayBuffer` in a `Promise`.
 *
 * @param file - The `File` to read.
 * @returns A promise that resolves with the file's `ArrayBuffer`.
 */
function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsArrayBuffer(file);
  });
}

// Presentation utilities

/**
 * Maps a {@link FileFormat} to its corresponding CSS icon modifier class.
 *
 * @param format - The detected file format.
 * @returns A `file-icon--*` CSS class string.
 */
function formatToIconClass(format: FileFormat): string {
  const map: Record<FileFormat, string> = {
    PDF: "file-icon--pdf",
    PNG: "file-icon--png",
    ZIP: "file-icon--zip",
    ELF: "file-icon--elf",
    PE: "file-icon--pe",
    JPEG: "file-icon--jpeg",
    MACHO: "file-icon--macho",
    BIN: "file-icon--bin",
  };
  return map[format] ?? "file-icon--bin";
}

/**
 * Formats a {@link ByteCount} into a human-readable size string for the
 * recents UI. Intentionally separate from `utils/hex.ts formatSize` — this
 * version also handles GB.
 *
 * @param bytes - The byte count to format.
 * @returns A string such as `"1.4 MB"` or `"512 B"`.
 */
function formatSize(bytes: ByteCount): string {
  const n = bytes as number;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Returns a human-readable relative time string for an ISO timestamp.
 *
 * @param iso - ISO 8601 date string.
 * @returns A string such as `"3h ago"` or `"just now"`.
 */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  const weeks = Math.floor(diff / 604_800_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return `${weeks}w ago`;
}

/**
 * Escapes HTML special characters to prevent XSS when injecting user-supplied
 * filenames into innerHTML.
 *
 * @param str - The raw string to escape.
 * @returns The HTML-safe string.
 */
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

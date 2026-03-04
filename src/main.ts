/**
 * @file src/main.ts
 * Application entry point. Imports global styles and mounts the initial screen.
 *
 * Session flow:
 * - `sessionStorage` persists across reloads of the same tab (F5, Ctrl+R) but
 *   is destroyed when the tab is closed — exactly the desired scope.
 * - When a file is ready, `file:ready` is dispatched (by `welcome.ts` for new
 *   files, or by `restoreLastFile` on reload). The listener here mounts the
 *   editor and saves the filename to `sessionStorage`.
 * - When the editor is closed, `editor:close` is dispatched. The key is removed
 *   from `sessionStorage` before reloading so the next load starts on the
 *   welcome screen instead of restoring the editor.
 */

import "./styles/base.css";
import "./styles/welcome.css";
import "./styles/editor.css";

import { mountWelcome, unmountWelcome, restoreLastFile } from "./ui/screens/welcome";
import { mountEditor } from "./ui/screens/editor";
import type { LoadedFile } from "./types/index";

/**
 * `sessionStorage` key used to remember the last opened filename across
 * page reloads within the same browser tab.
 */
const SESSION_FILE = "binary-raw:last-file";

const welcomeEl = document.getElementById("screen-welcome")!;
const editorEl = document.getElementById("screen-editor")!;

// Hide the editor container immediately.
// index.html does not set display:none on either div, so without this line
// #screen-editor would be briefly visible (empty) while the JS bundle loads.
editorEl.style.display = "none";

// Listener: file ready → mount the editor.
// Both welcome.ts (new file) and restoreLastFile (reload) dispatch 'file:ready'.
// { once: true } is correct because 'editor:close' triggers window.location.reload(),
// so there is at most one 'file:ready' event per page lifetime.
document.addEventListener(
  "file:ready",
  async (e) => {
    const loadedFile = (e as CustomEvent<LoadedFile>).detail;

    // Persist the filename BEFORE mounting: if the user presses F5 during mount,
    // sessionStorage already holds the name for the next reload.
    sessionStorage.setItem(SESSION_FILE, loadedFile.handle.name);

    unmountWelcome(welcomeEl);

    try {
      await mountEditor(editorEl, loadedFile);
    } catch (err) {
      // mountEditor fails if the file structure is invalid (e.g. parser returns
      // root=null) or if a component cannot find its DOM container.
      // Clear sessionStorage and restore the welcome screen so the user can retry.
      console.error("[main] mountEditor failed:", err);
      sessionStorage.removeItem(SESSION_FILE);
      editorEl.style.display = "none";
      mountWelcome(welcomeEl);
    }
  },
  { once: true },
);

// Listener: editor close/open button → clear state and reload.
// editor.ts dispatches 'editor:close' instead of calling reload() directly.
// The key is removed BEFORE reload so the next load starts on the welcome screen.
// If reload() were called from editor.ts without clearing first, sessionStorage
// would persist and main.ts would restore the editor again on the next load.
document.addEventListener("editor:close", () => {
  sessionStorage.removeItem(SESSION_FILE);
  window.location.reload();
});

// Startup
// If a file was open before the last reload, restore it directly.
// restoreLastFile() does: loadFileBuffer → processFile → dispatches 'file:ready'.
// The listener above receives that event and mounts the editor normally,
// without the welcome screen appearing at any point.
// If the buffer is no longer in IndexedDB (storage cleared), fall back to welcome.
const lastName = sessionStorage.getItem(SESSION_FILE);

if (lastName) {
  restoreLastFile(lastName).then((ok) => {
    if (!ok) {
      // Buffer lost (IndexedDB cleared, etc.) — clean up and start on welcome
      sessionStorage.removeItem(SESSION_FILE);
      mountWelcome(welcomeEl);
    }
    // ok=true → 'file:ready' already dispatched → the listener above takes over
  });
} else {
  // New session or user was on the welcome screen → start on welcome
  mountWelcome(welcomeEl);
}

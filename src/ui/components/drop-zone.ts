/**
 * @file src/ui/components/drop-zone.ts
 * Drag-and-drop and file-browse zone component.
 */

/** Configuration options passed to {@link createDropZone}. */
export interface DropZoneOptions {
  /** The host element that acts as the visual drop target. */
  element: HTMLElement;
  /** The hidden `<input type="file">` used for the browse-to-open flow. */
  fileInput: HTMLInputElement;
  /** Called with the selected or dropped. */
  onFileSelected: (file: File) => void;
  /** Called whenever the drag state transitions between `'idle'` and `'dragging'`. */
  onStateChange: (state: "idle" | "dragging") => void;
}

/** Handle returned by {@link createDropZone} for cleanup. */
export interface DropZoneHandle {
  /** Removes all event listeners attached by this instance. */
  destroy: () => void;
}

/**
 * Creates a new drop zone bound to the given element and file input.
 *
 * Attaches global `dragenter` / `dragover` / `dragleave` / `drop` listeners
 * on `document` (matching the pattern used in `welcome.ts`) so the entire
 * page surface acts as a valid drop target. A click on `element` delegates
 * to `fileInput.click()` to open the system file picker.
 *
 * The `dragCounter` tracks nested `dragenter`/`dragleave` pairs to avoid
 * flickering when the pointer moves over child elements.
 *
 * @param options - Configuration; see {@link DropZoneOptions}.
 * @returns A {@link DropZoneHandle} whose `destroy` method removes all listeners.
 */
export function createDropZone(options: DropZoneOptions): DropZoneHandle {
  const { element, fileInput, onFileSelected, onStateChange } = options;
  let dragCounter = 0;

  // Drag & Drop events

  const onDragEnter = (e: DragEvent): void => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) onStateChange("dragging");
  };

  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (_e: DragEvent): void => {
    dragCounter--;
    if (dragCounter === 0) onStateChange("idle");
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    dragCounter = 0;
    onStateChange("idle");
    const file = e.dataTransfer?.files[0];
    if (file) onFileSelected(file);
  };

  // Click & browse events

  const handleClick = (e: MouseEvent): void => {
    // Prevent clicks on interactive child elements from propagating
    if (e.target instanceof HTMLInputElement) return;
    fileInput.click();
  };

  const handleInputChange = (): void => {
    const file = fileInput.files?.[0];
    if (file) onFileSelected(file);
  };

  // Initialization

  // Global listeners for drag & drop (same pattern as welcome.ts)
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);

  // Local listener for click-to-browse
  element.addEventListener("click", handleClick);
  fileInput.addEventListener("change", handleInputChange);

  return {
    destroy: () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      element.removeEventListener("click", handleClick);
      fileInput.removeEventListener("change", handleInputChange);
    },
  };
}

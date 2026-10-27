/**
 * Local draft storage for long forms.
 *
 * Drafts live in IndexedDB (not localStorage) so they survive reloads and tab
 * closes without bloating the small synchronous key/value store. Everything
 * stays on the applicant's own device — nothing is uploaded.
 */

export type DraftValues = Record<string, string | string[]>;

export interface ApplicationDraft {
  values: DraftValues;
  openSections: number[];
  savedAt: number;
}

const DB_NAME = "slit-form-drafts";
const STORE_NAME = "drafts";
const DB_VERSION = 1;

/** The anti-spam honeypot must never be persisted or restored. */
const SKIP_NAMES = new Set(["website_alt"]);

function hasIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open draft storage."));
  });
}

function withStore<T>(mode: "readonly" | "readwrite", run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, mode);
          const request = run(tx.objectStore(STORE_NAME));
          request.onsuccess = () => resolve((request.result as T) ?? null);
          request.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
        } catch {
          resolve(null);
        }
      }),
  );
}

export function loadApplicationDraft(key: string): Promise<ApplicationDraft | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return withStore<ApplicationDraft>("readonly", (store) => store.get(key) as IDBRequest<ApplicationDraft>);
}

export function saveApplicationDraft(key: string, draft: ApplicationDraft): Promise<void> {
  if (!hasIndexedDb()) return Promise.resolve();
  return withStore("readwrite", (store) => store.put(draft, key) as IDBRequest<unknown>).then(() => undefined);
}

export function clearApplicationDraft(key: string): Promise<void> {
  if (!hasIndexedDb()) return Promise.resolve();
  return withStore("readwrite", (store) => store.delete(key) as IDBRequest<undefined>).then(() => undefined);
}

/** Reads every text, select, textarea, radio and checkbox value out of the live form. */
export function collectFormValues(form: HTMLFormElement): DraftValues {
  const out: DraftValues = {};
  for (const element of Array.from(form.elements)) {
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLSelectElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      continue;
    }
    const name = element.name;
    if (!name || SKIP_NAMES.has(name)) continue;

    if (element instanceof HTMLInputElement) {
      if (element.type === "file" || element.type === "submit" || element.type === "button") continue;
      if (element.type === "checkbox") {
        if (element.checked) {
          const key = name.endsWith("[]") ? name.slice(0, -2) : name;
          const list = Array.isArray(out[key]) ? (out[key] as string[]) : [];
          list.push(element.value);
          out[key] = list;
        }
        continue;
      }
      if (element.type === "radio") {
        if (element.checked) out[name] = element.value;
        continue;
      }
      if (element.value.trim() === "") continue;
      out[name] = element.value;
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      if (element.value) out[name] = element.value;
      continue;
    }

    if (element.value.trim() !== "") out[name] = element.value;
  }
  return out;
}

function fire(element: HTMLElement): void {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Writes saved values back into the live form. Conditional fields that are not in
 * the DOM yet (because a radio answer controls their visibility) are retried once
 * on the next tick, after React has re-rendered.
 */
export function applyFormValues(form: HTMLFormElement, values: DraftValues, retry = true): void {
  const missed: DraftValues = {};

  for (const [name, value] of Object.entries(values)) {
    const nodes = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      `[name="${name}"], [name="${name.endsWith("[]") ? name.slice(0, -2) : name + "[]"}"]`,
    );
    if (nodes.length === 0) {
      missed[name] = value;
      continue;
    }

    const first = nodes[0];

    if (first instanceof HTMLSelectElement) {
      const wanted = String(value).toLowerCase();
      const option = Array.from(first.options).find((item) => item.value.toLowerCase() === wanted);
      if (option) {
        first.value = option.value;
        fire(first);
      }
      continue;
    }

    if (first instanceof HTMLInputElement && first.type === "checkbox") {
      const wanted = Array.isArray(value) ? value : [String(value)];
      nodes.forEach((node) => {
        if (!(node instanceof HTMLInputElement)) return;
        const shouldCheck = wanted.includes(node.value);
        if (node.checked !== shouldCheck) {
          node.checked = shouldCheck;
          fire(node);
        }
      });
      continue;
    }

    if (first instanceof HTMLInputElement && first.type === "radio") {
      const wanted = String(value).toLowerCase();
      const match = Array.from(nodes).find(
        (node) => node instanceof HTMLInputElement && node.value.toLowerCase() === wanted,
      );
      if (match instanceof HTMLInputElement) {
        match.checked = true;
        fire(match);
      }
      continue;
    }

    if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) {
      first.value = String(value);
      fire(first);
    }
  }

  if (retry && Object.keys(missed).length > 0) {
    window.setTimeout(() => applyFormValues(form, missed, false), 150);
  }
}

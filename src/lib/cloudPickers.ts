/**
 * DOCUMENT-FINDER cloud sources (owner 2026-11-28: "ask consent for all who allow AI to scan": Google Drive and Photos, Microsoft
 * OneDrive, Dropbox). No cloud service lets a website search someone's account by itself: each opens its own window, the student signs
 * in there and chooses the files (Google Drive opens with their name already searched). The chosen files are downloaded into the page
 * and go through the same scan as any other: their type, whether they are the student's, then attached to their document.
 * A source shows only when SLIT has set its public key (Vercel environment, VITE_*): Google needs an OAuth client ID, an API key and the
 * Cloud project number; OneDrive an Azure app (client) ID; Dropbox an app key. iCloud has no web access: on a Mac or a Windows PC with
 * iCloud installed it is a folder ("This computer"), and on an iPhone the phone's own picker shows iCloud Photos and iCloud Drive.
 */
export type CloudSource = "google-drive" | "google-photos" | "onedrive" | "dropbox";

const env = import.meta.env as Record<string, string | undefined>;
const GOOGLE_CLIENT_ID = (env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const GOOGLE_API_KEY = (env.VITE_GOOGLE_API_KEY ?? "").trim();
const GOOGLE_APP_ID = (env.VITE_GOOGLE_APP_ID ?? "").trim(); // the Google Cloud project number (Drive gives the app the picked files)
const ONEDRIVE_CLIENT_ID = (env.VITE_ONEDRIVE_CLIENT_ID ?? "").trim();
const DROPBOX_APP_KEY = (env.VITE_DROPBOX_APP_KEY ?? "").trim();

export const CLOUD_SOURCES: ReadonlyArray<{ id: CloudSource; label: string; icon: string; ready: boolean }> = [
  { id: "google-drive", label: "Google Drive", icon: "ri-google-line", ready: !!(GOOGLE_CLIENT_ID && GOOGLE_API_KEY && GOOGLE_APP_ID) },
  { id: "google-photos", label: "Google Photos", icon: "ri-image-2-line", ready: !!GOOGLE_CLIENT_ID },
  { id: "onedrive", label: "OneDrive", icon: "ri-microsoft-line", ready: !!ONEDRIVE_CLIENT_ID },
  { id: "dropbox", label: "Dropbox", icon: "ri-dropbox-line", ready: !!DROPBOX_APP_KEY },
];

const MAX_BYTES = 10 * 1024 * 1024;
const DOC_NAME = /\.(pdf|png|jpe?g)$/i;
const MIME_OF: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
/** A downloaded file as the upload expects it: a PDF / JPG / PNG name and type, 10 MB at most (anything else is skipped). */
function asDocument(blob: Blob, name: string, mime?: string): File | null {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const type = MIME_OF[ext] ?? (mime && Object.values(MIME_OF).includes(mime) ? mime : "");
  if (!type || blob.size <= 0 || blob.size > MAX_BYTES) return null;
  const fileName = DOC_NAME.test(name) ? name : `${name || "document"}.${type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg"}`;
  return new File([blob], fileName, { type });
}
async function download(url: string, name: string, headers?: Record<string, string>, mime?: string): Promise<File | null> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return asDocument(await response.blob(), name, mime);
  } catch { return null; }
}

/** Loads a provider's script once (a test can put a stand-in in place first: then nothing is loaded). */
function loadScript(src: string, ready: () => boolean, attributes: Record<string, string> = {}): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("The service could not be opened. Check the connection and try again.")), { once: true });
    if (!existing) { script.src = src; script.async = true; for (const [k, v] of Object.entries(attributes)) script.setAttribute(k, v); document.head.appendChild(script); }
  });
}

/* ----------------------------------------------------------------------------------------------------------------- Google */

type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
type GoogleWindow = {
  google?: { accounts?: { oauth2?: { initTokenClient: (o: { client_id: string; scope: string; callback: (r: { access_token?: string; error?: string }) => void; error_callback?: (e: unknown) => void }) => TokenClient } };
    picker?: Record<string, any> };
  gapi?: { load: (name: string, cb: () => void) => void };
};
const g = () => window as unknown as GoogleWindow;

/** A Google access token for one scope, after the student agrees in Google's own window. */
async function googleToken(scope: string): Promise<string> {
  await loadScript("https://accounts.google.com/gsi/client", () => !!g().google?.accounts?.oauth2);
  return new Promise((resolve, reject) => {
    const client = g().google!.accounts!.oauth2!.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope,
      callback: (r) => (r.access_token ? resolve(r.access_token) : reject(new Error("Google access was not given."))),
      error_callback: () => reject(new Error("Google access was not given.")),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function pickGoogleDrive(person?: { firstName: string; lastName: string }): Promise<File[]> {
  // drive.file: the app sees only the files the student picks.
  const token = await googleToken("https://www.googleapis.com/auth/drive.file");
  await loadScript("https://apis.google.com/js/api.js", () => !!g().gapi);
  if (!g().google?.picker) await new Promise<void>((resolve) => g().gapi!.load("picker", () => resolve()));
  const picker = g().google!.picker!;
  const picked = await new Promise<Array<{ id: string; name: string; mimeType: string }>>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setMimeTypes("application/pdf,image/jpeg,image/png").setIncludeFolders(true);
    if (person && typeof view.setQuery === "function") view.setQuery(`${person.firstName} ${person.lastName}`);
    new picker.PickerBuilder().setAppId(GOOGLE_APP_ID).setOAuthToken(token).setDeveloperKey(GOOGLE_API_KEY).addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED).setTitle("Choose your documents")
      .setCallback((data: { action: string; docs?: Array<{ id: string; name: string; mimeType: string }> }) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs ?? []);
        else if (data.action === picker.Action.CANCEL) resolve([]);
      }).build().setVisible(true);
  });
  const files = await Promise.all(picked.map((doc) => download(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`, doc.name, { Authorization: `Bearer ${token}` }, doc.mimeType)));
  return files.filter((f): f is File => !!f);
}

async function pickGooglePhotos(): Promise<File[]> {
  // The window is opened at once (a browser blocks one opened after a wait), then pointed at Google's picker.
  const popup = window.open("about:blank", "slit-google-photos", "width=1000,height=760");
  try {
    const token = await googleToken("https://www.googleapis.com/auth/photospicker.mediaitems.readonly");
    const auth = { Authorization: `Bearer ${token}` };
    const created = await fetch("https://photospicker.googleapis.com/v1/sessions", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
    if (!created.ok) throw new Error("Google Photos could not be opened.");
    const session = await created.json() as { id: string; pickerUri: string; pollingConfig?: { pollInterval?: string } };
    if (popup) popup.location.href = `${session.pickerUri}/autoclose`; else window.open(`${session.pickerUri}/autoclose`, "slit-google-photos");
    const every = Math.max(2000, Math.min(10000, Number.parseFloat(session.pollingConfig?.pollInterval ?? "3") * 1000 || 3000));
    const until = Date.now() + 15 * 60 * 1000;
    let chosen = false;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, every));
      const state = await fetch(`https://photospicker.googleapis.com/v1/sessions/${session.id}`, { headers: auth }).then((r) => r.json()).catch(() => ({})) as { mediaItemsSet?: boolean };
      if (state.mediaItemsSet) { chosen = true; break; }
      if (popup && popup.closed) { await new Promise((r) => setTimeout(r, every)); continue; }
    }
    if (!chosen) return [];
    const files: File[] = [];
    let pageToken = "";
    do {
      const list = await fetch(`https://photospicker.googleapis.com/v1/mediaItems?sessionId=${session.id}&pageSize=50${pageToken ? `&pageToken=${pageToken}` : ""}`, { headers: auth }).then((r) => r.json()) as
        { mediaItems?: Array<{ mediaFile?: { baseUrl: string; mimeType: string; filename: string } }>; nextPageToken?: string };
      for (const item of list.mediaItems ?? []) {
        if (!item.mediaFile) continue;
        const file = await download(`${item.mediaFile.baseUrl}=d`, item.mediaFile.filename, auth, item.mediaFile.mimeType);
        if (file) files.push(file);
      }
      pageToken = list.nextPageToken ?? "";
    } while (pageToken && files.length < 40);
    void fetch(`https://photospicker.googleapis.com/v1/sessions/${session.id}`, { method: "DELETE", headers: auth }).catch(() => undefined);
    return files;
  } finally {
    if (popup && !popup.closed) popup.close();
  }
}

/* ---------------------------------------------------------------------------------------------------------------- OneDrive */

type OneDriveWindow = { OneDrive?: { open: (o: Record<string, unknown>) => void } };
async function pickOneDrive(): Promise<File[]> {
  await loadScript("https://js.live.net/v7.2/OneDrive.js", () => !!(window as unknown as OneDriveWindow).OneDrive);
  const picked = await new Promise<Array<{ name: string; url: string; mime?: string }>>((resolve, reject) => {
    (window as unknown as OneDriveWindow).OneDrive!.open({
      clientId: ONEDRIVE_CLIENT_ID, action: "download", multiSelect: true,
      advanced: { filter: ".pdf,.jpg,.jpeg,.png", redirectUri: window.location.origin },
      success: (result: { value?: Array<{ name: string; file?: { mimeType?: string }; "@microsoft.graph.downloadUrl"?: string }> }) =>
        resolve((result.value ?? []).flatMap((f) => (f["@microsoft.graph.downloadUrl"] ? [{ name: f.name, url: f["@microsoft.graph.downloadUrl"]!, mime: f.file?.mimeType }] : []))),
      cancel: () => resolve([]),
      error: () => reject(new Error("OneDrive could not be opened.")),
    });
  });
  const files = await Promise.all(picked.map((f) => download(f.url, f.name, undefined, f.mime)));
  return files.filter((f): f is File => !!f);
}

/* ----------------------------------------------------------------------------------------------------------------- Dropbox */

type DropboxWindow = { Dropbox?: { choose: (o: Record<string, unknown>) => void } };
async function pickDropbox(): Promise<File[]> {
  await loadScript("https://www.dropbox.com/static/api/2/dropins.js", () => !!(window as unknown as DropboxWindow).Dropbox, { id: "dropboxjs", "data-app-key": DROPBOX_APP_KEY });
  const picked = await new Promise<Array<{ name: string; link: string }>>((resolve) => {
    (window as unknown as DropboxWindow).Dropbox!.choose({
      linkType: "direct", multiselect: true, extensions: [".pdf", ".jpg", ".jpeg", ".png"], sizeLimit: MAX_BYTES,
      success: (files: Array<{ name: string; link: string }>) => resolve(files),
      cancel: () => resolve([]),
    });
  });
  const files = await Promise.all(picked.map((f) => download(f.link, f.name)));
  return files.filter((f): f is File => !!f);
}

/** Opens the source's own window; resolves with the documents the student chose (empty when they cancelled). */
export async function pickFromCloud(source: CloudSource, person?: { firstName: string; lastName: string }): Promise<File[]> {
  switch (source) {
    case "google-drive": return pickGoogleDrive(person);
    case "google-photos": return pickGooglePhotos();
    case "onedrive": return pickOneDrive();
    case "dropbox": return pickDropbox();
  }
}

import { useEffect, useRef, useState } from "react";
import { FolderOpen, ShieldCheck, FilePlus2, Smartphone, AlertTriangle, Loader2, RefreshCw, FilterX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { backupISODate, filterBackups, scanCatalog, storageIssue, storageWarning, type Catalog, type StorageIssue } from "@/lib/backup-catalog";
import { ROOT_FOLDER, createBackup, dateCode, defaultBackupName, ensurePermission, hasSameDate, listBackups, loadSetting, localIdentity, registerProfile, safeSegment, saveSetting, verifyProfile, type BackupEntry, type BackupFile, type BackupKind, type Enrollment, type LocalDirectory } from "@/lib/local-backup";

type DirectoryWindow = Window & { showDirectoryPicker?: (options: { mode: "readwrite"; id: string }) => Promise<LocalDirectory> };

export function LocalBackupWorkspace() {
  const [profile, setProfile] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [saved, setSaved] = useState<Enrollment | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [kind, setKind] = useState<BackupKind>("Full");
  const [name, setName] = useState("");
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [today, setToday] = useState<Date | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [catalog, setCatalog] = useState<Catalog>({ entries: [], profiles: [], warnings: [] });
  const [filterProfile, setFilterProfile] = useState("");
  const [filterKind, setFilterKind] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [storageProblem, setStorageProblem] = useState<StorageIssue | null>(null);
  const [checkingStorage, setCheckingStorage] = useState(false);
  const scanVersion = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const date = new Date();
    setToday(date); setName(defaultBackupName("Full", date));
    setSupported(Boolean((window as DirectoryWindow).showDirectoryPicker));
    folderInput.current?.setAttribute("webkitdirectory", "");
    let active = true;
    void loadSetting<Enrollment>("enrollment").then(async previous => {
      if (!previous || !active) return;
      setSaved(previous); setProfile(previous.profile);
      if (await previous.root.queryPermission({ mode: "readwrite" }) !== "granted") { setStorageProblem("permission"); return; }
      const folder = await verifyProfile(previous);
      const backups = await listBackups(folder);
      if (active) { setEnrollment(previous); setEntries(backups); }
    }).catch(e => { if (active) { setStorageProblem(storageIssue(e)); setError(e instanceof Error ? e.message : "Saved location could not be opened. Locate HomeSafeBckup to reconnect."); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!enrollment) return;
    let active = true;
    async function check() {
      if (!enrollment) return;
      const version = ++scanVersion.current;
      try {
        const next = await scanCatalog(enrollment.root);
        if (active && version === scanVersion.current) { setCatalog(next); setStorageProblem(problem => problem === "space" ? problem : null); }
      } catch (e) {
        if (active && version === scanVersion.current) { setStorageProblem(storageIssue(e)); setCatalog({ entries: [], profiles: [], warnings: [] }); }
      }
    }
    void check();
    const timer = setInterval(() => { if (!busy) void check(); }, 15000);
    const onFocus = () => { if (!busy) void check(); };
    window.addEventListener("focus", onFocus);
    return () => { active = false; scanVersion.current++; clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [enrollment, busy]);

  async function refreshStorage() {
    if (!enrollment) return;
    setCheckingStorage(true);
    const version = ++scanVersion.current;
    try {
      await ensurePermission(enrollment.root);
      const next = await scanCatalog(enrollment.root);
      if (version === scanVersion.current) { setCatalog(next); setStorageProblem(problem => problem === "space" ? problem : null); }
    } catch (e) {
      if (version === scanVersion.current) { setStorageProblem(storageIssue(e)); setCatalog({ entries: [], profiles: [], warnings: [] }); }
    } finally { setCheckingStorage(false); }
  }

  async function action(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); }
    catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        const issue = storageIssue(e);
        if (issue !== "unreadable") setStorageProblem(issue);
        setError(e instanceof Error ? e.message : "The storage operation could not be completed.");
      }
    } finally { setBusy(false); }
  }
  async function connect(create: boolean, reuse = false) {
    await action(async () => {
      if (!consent && create) throw new Error("Allow local device identity storage before creating a profile.");
      const selectedProfile = safeSegment(profile);
      const picker = (window as DirectoryWindow).showDirectoryPicker;
      if (!picker) throw new Error("Local folder access needs desktop Chrome or Edge. Phone enrollment requires the HomeSafe companion app.");
      let root = reuse && saved ? saved.root : await picker({ mode: "readwrite", id: "homesafe-storage" });
      await ensurePermission(root);
      if (create && root.name !== ROOT_FOLDER) root = await root.getDirectoryHandle(ROOT_FOLDER, { create: true });
      if (root.name !== ROOT_FOLDER) throw new Error(`Select ${ROOT_FOLDER} itself to reconnect.`);
      const identity = await localIdentity();
      if (create) await registerProfile(root, selectedProfile, identity);
      const next = { root, profile: selectedProfile, identity };
      const folder = await verifyProfile(next);
      const backups = await listBackups(folder);
      await saveSetting("enrollment", next);
      setEnrollment(next); setSaved(next); setEntries(backups); setFiles([]); setStorageProblem(null); setFilterProfile("");
      setMessage(create ? "Local browser profile created. Identity encrypted with AES-256-GCM." : "Profile and encrypted device identity matched. Storage reconnected.");
    });
  }
  function selectFiles(list: FileList | null) {
    setFiles(Array.from(list ?? []).map(file => ({ file, path: file.webkitRelativePath || file.name })));
    setMessage(""); setError("");
  }
  async function backup() {
    await action(async () => {
      if (!enrollment) throw new Error("Connect and verify your profile first.");
      const date = new Date();
      if (!today || dateCode(date) !== dateCode(today)) {
        setToday(date); setName(defaultBackupName(kind, date));
        throw new Error("The date has changed. Review today’s backup name and try again.");
      }
      await ensurePermission(enrollment.root);
      const result = await createBackup(enrollment, kind, name, files, date, name !== defaultBackupName(kind, date));
      setEntries(await listBackups(await verifyProfile(enrollment)));
      setCatalog(await scanCatalog(enrollment.root)); setStorageProblem(null);
      setMessage(`${result.files} files saved in ${ROOT_FOLDER}/${enrollment.profile}/${result.name}.`);
      setFiles([]);
    });
  }
  const duplicate = today && hasSameDate(entries, today);
  const locked = busy || checkingStorage || !enrollment || storageProblem === "disconnected" || storageProblem === "permission" || storageProblem === "unreadable";
  const filtered = filterBackups(catalog.entries, { profile: filterProfile, kind: filterKind, date: filterDate });
  const changeKind = (next: BackupKind) => { setKind(next); if (today) setName(defaultBackupName(next, today)); setFiles([]); };

  return (
    <section className="space-y-5 border-y border-border py-6" aria-labelledby="local-backup-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="local-backup-heading" className="flex items-center gap-2 font-display text-2xl"><FolderOpen className="h-5 w-5 text-primary" />Profile backups</h2>
        <span className="text-xs text-muted-foreground">Local files · no cloud transfer</span>
      </div>
      <div className="border-l-2 border-warning pl-3 text-sm">
        <p className="font-medium">Phone connection is not installed</p>
        <p className="mt-1 text-muted-foreground">This workspace backs up files you select on this computer. Its encrypted identity belongs to this browser, not your phone. Android and iPhone enrollment and automatic LAN transfer need companion software.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center gap-2 font-medium"><Smartphone className="h-4 w-4 text-primary" />Profile &amp; storage</div>
          <label className="block text-sm">Profile name
            <input value={profile} onChange={e => { setProfile(e.target.value); setEnrollment(null); setEntries([]); setFiles([]); setCatalog({ entries: [], profiles: [], warnings: [] }); setStorageProblem(null); }} disabled={busy} placeholder="Your profile name" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1 accent-primary" />
            <span>I allow an app-generated device identity and non-exportable encryption key to be stored in this browser, and an encrypted identity in my profile folder. No IMEI is read. Clearing browser storage loses this identity and prevents future verification.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="min-h-11" disabled={busy || !consent || !profile.trim() || !supported} onClick={() => void connect(true)}><FilePlus2 />Create local profile</Button>
            <Button variant="outline" className="min-h-11" disabled={busy || !profile.trim() || !supported} onClick={() => void connect(false)}><FolderOpen />Locate HomeSafeBckup</Button>
            {saved && !enrollment && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void connect(false, true)}>Reconnect saved profile</Button>}
          </div>
          {supported === false && <p className="text-sm text-warning">Folder access is unavailable here. Open this page in desktop Chrome or Edge to use local storage.</p>}
          {enrollment && <div className="space-y-1 text-sm"><p className="flex items-center gap-2 text-primary"><ShieldCheck className="h-4 w-4" />Encrypted identity verified</p><p className="break-all font-mono text-xs text-muted-foreground">{ROOT_FOLDER}/{enrollment.profile}/</p></div>}
        </div>
        <div className="space-y-4">
          <h3 className="font-medium">New backup</h3>
          <fieldset disabled={locked} className="flex flex-wrap gap-5 text-sm">
            <legend className="sr-only">Backup type</legend>
            <label className="flex items-center gap-2"><input type="radio" name="backup-kind" checked={kind === "Full"} onChange={() => changeKind("Full")} className="accent-primary" />Full backup</label>
            <label className="flex items-center gap-2"><input type="radio" name="backup-kind" checked={kind === "Custom"} onChange={() => changeKind("Custom")} className="accent-primary" />Custom folders</label>
          </fieldset>
          <p className="text-sm text-muted-foreground">{kind === "Full" ? "Full means all accessible files, not a whole-phone recovery image. In this browser, only files you explicitly select are copied; nothing is automatically discovered." : "Select the folders you want to include. Folder names and subfolders are preserved."}</p>
          <input ref={fileInput} type="file" multiple hidden onChange={e => { selectFiles(e.target.files); e.target.value = ""; }} />
          <input ref={folderInput} type="file" multiple hidden onChange={e => { selectFiles(e.target.files); e.target.value = ""; }} />
          <div className="flex flex-wrap gap-2">
            {kind === "Full" && <Button variant="outline" className="min-h-11" disabled={locked} onClick={() => fileInput.current?.click()}><FilePlus2 />Select files</Button>}
            <Button variant="outline" className="min-h-11" disabled={locked} onClick={() => folderInput.current?.click()}><FolderOpen />Select folder</Button>
          </div>
          <p className="text-xs text-muted-foreground">{files.length} files selected · {(files.reduce((sum, item) => sum + item.file.size, 0) / 1024 / 1024).toFixed(2)} MB</p>
          <label className="block text-sm">Backup folder name
            <input value={name} onChange={e => setName(e.target.value)} disabled={locked} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring" />
          </label>
          {duplicate && <p className="flex items-start gap-2 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />A backup already exists for today. Add a unique suffix, such as _2, before saving another.</p>}
          <Button disabled={locked || !files.length} className="min-h-11" onClick={() => void backup()}>{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Verify identity &amp; save files</Button>
        </div>
      </div>
      {storageProblem && <div role="alert" className="flex items-start gap-2 border-l-2 border-warning pl-3 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p>{storageWarning(storageProblem)}</p></div>}
      {enrollment && <p className="text-xs text-muted-foreground">Available drive space cannot be measured in this browser. Check free space on the selected drive before backing up; a failed write will show a space warning.</p>}
      {error && <p role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="break-words text-sm text-primary">{message}</p>}
      {busy && <p role="status" className="text-sm text-muted-foreground">Accessing local storage… Keep this page open.</p>}
      <details className="border-t border-border pt-4 text-sm" open>
        <summary className="cursor-pointer font-medium">What Android &amp; iPhone can back up</summary>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <div><dt className="font-medium text-primary">Available with permission</dt><dd className="mt-1 text-muted-foreground">Photos and videos you grant access to, selected documents, and other readable files. Android can grant access to shared folders; iPhone offers permitted photos and files selected through its file picker.</dd></div>
          <div><dt className="font-medium text-warning">Not included</dt><dd className="mt-1 text-muted-foreground">Other apps’ private data, passwords, protected messages, operating-system files and a complete phone recovery image. Contacts and calendars need separate permissions and export support; they are not backed up by this page.</dd></div>
        </dl>
      </details>
      {enrollment && <div className="space-y-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">Saved backups</h3><Button variant="outline" className="min-h-11" disabled={busy || checkingStorage} onClick={() => void refreshStorage()}>{checkingStorage ? <Loader2 className="animate-spin" /> : <RefreshCw />}Check storage</Button></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">Filter profile<select aria-label="Filter profile" value={filterProfile} onChange={e => setFilterProfile(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3"><option value="">All profiles</option>{catalog.profiles.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label className="text-sm">Filter backup type<select aria-label="Filter backup type" value={filterKind} onChange={e => setFilterKind(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3"><option value="">All types</option><option value="Full">Full backup</option><option value="Custom">Custom backup</option></select></label>
          <label className="text-sm">Filter backup date<input aria-label="Filter backup date" type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3" /></label>
        </div>
        <div className="flex items-center justify-between gap-3"><p role="status" className="text-xs text-muted-foreground">{filtered.length} of {catalog.entries.length} backups</p><Button variant="ghost" disabled={!filterProfile && !filterKind && !filterDate} onClick={() => { setFilterProfile(""); setFilterKind(""); setFilterDate(""); }}><FilterX />Clear filters</Button></div>
        {catalog.warnings.length > 0 && <ul role="alert" className="space-y-2 border-l-2 border-warning pl-3 text-sm text-warning">{catalog.warnings.map(w => <li key={w} className="break-words">{w}</li>)}</ul>}
        {filtered.length === 0 ? <p className="text-sm text-muted-foreground">{storageProblem && storageProblem !== "space" ? "Backups are unavailable until storage access is restored." : catalog.entries.length ? "No backups match these filters." : "No readable backups found on this storage."}</p> : <ul aria-label="Saved backup results" className="divide-y divide-border">{filtered.map(entry => <li key={`${entry.profile}/${entry.name}`} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><div className="min-w-0"><p className="break-all font-mono">{entry.name}</p><p className="mt-1 text-xs text-muted-foreground">{entry.profile} · {entry.kind} · {backupISODate(entry.date)}</p></div><span className={entry.complete ? "text-muted-foreground" : "text-warning"}>{entry.files} files · {entry.complete ? "Saved" : "Incomplete"}</span></li>)}</ul>}
      </div>}
    </section>
  );
}
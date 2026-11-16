import { useEffect, useRef, useState } from "react";
import { FolderOpen, ShieldCheck, FilePlus2, Smartphone, AlertTriangle, Loader2, RefreshCw, FilterX, Plus, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransferStatus } from "@/components/transfer-status";
import { StorageHealth } from "@/components/storage-health";
import { backupISODate, filterBackups, scanCatalog, storageIssue, storageWarning, type Catalog, type StorageIssue } from "@/lib/backup-catalog";
import { ROOT_FOLDER, createBackup, dateCode, defaultBackupName, ensurePermission, hasSameDate, listBackups, loadSetting, localIdentity, registerPhone, safeSegment, saveSetting, verifyProfile, type BackupEntry, type BackupFile, type BackupKind, type Enrollment, type LocalDirectory } from "@/lib/local-backup";

type DirectoryWindow = Window & { showDirectoryPicker?: (options: { mode: "readwrite"; id: string }) => Promise<LocalDirectory> };

export function LocalBackupWorkspace() {
  const [profile, setProfile] = useState("");
  const [phone, setPhone] = useState("");
  const [addingPhone, setAddingPhone] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [filterPhone, setFilterPhone] = useState("");
  const [phoneNames, setPhoneNames] = useState<string[]>([]);
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
      setSaved(previous); setProfile(previous.profile); setPhone(previous.phone ?? "");
      setAddingPhone(!previous.phone);
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
      if (!consent && create) throw new Error("Allow local device identity storage before creating a phone folder.");
      const selectedProfile = safeSegment(profile);
      const selectedPhone = safeSegment(phone);
      const picker = (window as DirectoryWindow).showDirectoryPicker;
      if (!picker) throw new Error("Local folder access needs desktop Chrome or Edge. Phone enrollment requires the HomeSafe companion app.");
      let root = reuse && saved ? saved.root : await picker({ mode: "readwrite", id: "homesafe-storage" });
      await ensurePermission(root);
      if (create && root.name !== ROOT_FOLDER) root = await root.getDirectoryHandle(ROOT_FOLDER, { create: true });
      if (root.name !== ROOT_FOLDER) throw new Error(`Select ${ROOT_FOLDER} itself to reconnect.`);
      const identity = await localIdentity();
      if (create) await registerPhone(root, selectedProfile, selectedPhone, identity);
      const next = { root, profile: selectedProfile, phone: selectedPhone, identity };
      const folder = await verifyProfile(next);
      const backups = await listBackups(folder);
      await saveSetting("enrollment", next);
      const names: string[] = [];
      const profileFolder = await root.getDirectoryHandle(selectedProfile);
      for await (const child of profileFolder.values()) if (child.kind === "directory" && !/^(Full|Custom)_Bckup_/i.test(child.name)) names.push(child.name);
      setPhoneNames(names.sort()); setAddingPhone(false); setConfirmed(false);
      setEnrollment(next); setSaved(next); setEntries(backups); setFiles([]); setStorageProblem(null); setFilterProfile(selectedProfile); setFilterPhone(selectedPhone);
      setMessage(create ? "Named phone folder created for browser-selected files. This does not enroll or pair a phone." : "Profile, phone folder and encrypted browser identity matched. Confirm the destination before saving.");
    });
  }
  function selectFiles(list: FileList | null) {
    setFiles(Array.from(list ?? []).map(file => ({ file, path: file.webkitRelativePath || file.name })));
    setMessage(""); setError("");
  }
  async function backup() {
    await action(async () => {
      if (!enrollment || !confirmed) throw new Error("Connect and confirm your profile and phone folder first.");
      const date = new Date();
      if (!today || dateCode(date) !== dateCode(today)) {
        setToday(date); setName(defaultBackupName(kind, date));
        throw new Error("The date has changed. Review today’s backup name and try again.");
      }
      await ensurePermission(enrollment.root);
      const result = await createBackup(enrollment, kind, name, files, date, name !== defaultBackupName(kind, date));
      setEntries(await listBackups(await verifyProfile(enrollment)));
      setCatalog(await scanCatalog(enrollment.root)); setStorageProblem(null);
      setMessage(`${result.files} files saved in ${ROOT_FOLDER}/${enrollment.profile}/${enrollment.phone}/${result.name}.`);
      setFiles([]);
    });
  }
  const duplicate = today && hasSameDate(entries, today);
  const locked = busy || checkingStorage || !enrollment?.phone || !confirmed || storageProblem === "disconnected" || storageProblem === "permission" || storageProblem === "unreadable";
  const filtered = filterBackups(catalog.entries, { profile: filterProfile, phone: filterPhone, kind: filterKind, date: filterDate });
  const clearDestination = () => { setEnrollment(null); setEntries([]); setFiles([]); setConfirmed(false); };
  const changeKind = (next: BackupKind) => { setKind(next); if (today) setName(defaultBackupName(next, today)); setFiles([]); };

  return (
    <section className="space-y-5 border-y border-border py-6" aria-labelledby="local-backup-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="local-backup-heading" className="flex items-center gap-2 font-display text-2xl"><FolderOpen className="h-5 w-5 text-primary" />Local file workspace</h2>
        <span className="text-xs text-muted-foreground">Local files · no cloud transfer</span>
      </div>
      <div className="border-l-2 border-warning pl-3 text-sm">
        <p className="font-medium">Phone connection is not installed</p>
        <p className="mt-1 text-muted-foreground">This workspace backs up files you select on this computer. Its encrypted identity belongs to this browser, not your phone. Android and iPhone enrollment and automatic LAN transfer need companion software.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 font-medium"><Smartphone className="h-4 w-4 text-primary" />Profile &amp; phone folder</h3><Button variant="outline" size="icon" className="h-11 w-11" title="Set up a new phone folder" aria-label="Set up a new phone folder" disabled={busy} onClick={() => { clearDestination(); setPhone(""); setAddingPhone(true); }}><Plus /></Button></div>
          <label className="block text-sm">Profile name
            <input value={profile} onChange={e => { setProfile(e.target.value); clearDestination(); setPhoneNames([]); setCatalog({ entries: [], profiles: [], warnings: [] }); setStorageProblem(null); }} disabled={busy} placeholder="Your profile name" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="block text-sm">Phone name
            <input value={phone} onChange={e => { setPhone(e.target.value); clearDestination(); }} disabled={busy} placeholder="A memorable name, e.g. My Pixel" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring" />
          </label>
          {addingPhone && <p className="text-sm text-muted-foreground">Choose a phone name you will remember. Each phone needs a different name within your profile; existing folders will never be replaced.</p>}
          {phoneNames.length > 0 && <div className="space-y-2"><p className="text-xs text-muted-foreground">Phone folders on selected storage · not verified phone connections</p><div className="flex flex-wrap gap-2">{phoneNames.map(p => <Button key={p} variant="outline" disabled={busy} onClick={() => { clearDestination(); setPhone(p); setAddingPhone(false); }}><Smartphone />{p}</Button>)}</div></div>}
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1 accent-primary" />
            <span>I allow an app-generated device identity and non-exportable encryption key to be stored in this browser, and an encrypted identity in my phone folder. No IMEI is read. Clearing browser storage loses this identity and prevents future verification.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="min-h-11" disabled={busy || !consent || !profile.trim() || !phone.trim() || !supported} onClick={() => void connect(true)}><Plus />Create phone folder</Button>
            <Button variant="outline" className="min-h-11" disabled={busy || !profile.trim() || !phone.trim() || !supported} onClick={() => void connect(false)}><FolderOpen />Locate HomeSafeBckup</Button>
            {saved && !enrollment && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void connect(false, true)}>Reconnect saved profile</Button>}
          </div>
          {supported === false && <p className="text-sm text-warning">Folder access is unavailable here. Open this page in desktop Chrome or Edge to use local storage.</p>}
          {enrollment && <div className="space-y-3 text-sm"><p className="flex items-center gap-2 text-primary"><ShieldCheck className="h-4 w-4" />Encrypted browser identity verified</p><p className="break-all font-mono text-xs text-muted-foreground">{ROOT_FOLDER}/{enrollment.profile}/{enrollment.phone ?? "Legacy profile-level backups"}/</p>{enrollment.phone ? <Button variant={confirmed ? "secondary" : "outline"} disabled={busy || confirmed} onClick={() => { setConfirmed(true); window.__lovableEvents?.track?.("project.backup_profile_selected", {}); }}><Check />{confirmed ? "Destination confirmed" : "Confirm profile & phone folder"}</Button> : <p className="text-warning">Existing profile-level backups are read-only here. Create or reconnect a named phone folder for new backups; existing files stay untouched.</p>}</div>}
        </div>
        <div>
          {enrollment?.phone && confirmed ? <p className="text-sm text-primary">Transfer dashboard is open below.</p> : <p className="text-sm text-muted-foreground">Confirm your profile and phone folder to open the transfer dashboard.</p>}
        </div>
      </div>
      {storageProblem && <div role="alert" className="flex items-start gap-2 border-l-2 border-warning pl-3 text-sm text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p>{storageWarning(storageProblem)}</p></div>}
      {error && <p role="alert" className="border-l-2 border-destructive pl-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="break-words text-sm text-primary">{message}</p>}
      {busy && <p role="status" className="text-sm text-muted-foreground">Accessing local storage… Keep this page open.</p>}
      {enrollment?.phone && confirmed ? (
        <TransferStatus profile={enrollment.profile} phone={enrollment.phone} />
      ) : null}
      <StorageHealth catalog={catalog} connected={Boolean(enrollment)} problem={storageProblem} />
      <details className="border-t border-border pt-4 text-sm" open>
        <summary className="cursor-pointer font-medium">What Android &amp; iPhone can back up</summary>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <div><dt className="font-medium text-primary">Available with permission</dt><dd className="mt-1 text-muted-foreground">Photos and videos you grant access to, selected documents, and other readable files. Android can grant access to shared folders; iPhone offers permitted photos and files selected through its file picker.</dd></div>
          <div><dt className="font-medium text-warning">Not included</dt><dd className="mt-1 text-muted-foreground">Other apps’ private data, passwords, protected messages, operating-system files and a complete phone recovery image. Contacts and calendars need separate permissions and export support; they are not backed up by this page.</dd></div>
        </dl>
      </details>
      {enrollment && <div className="space-y-4 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">Saved backups</h3><Button variant="outline" className="min-h-11" disabled={busy || checkingStorage} onClick={() => void refreshStorage()}>{checkingStorage ? <Loader2 className="animate-spin" /> : <RefreshCw />}Check storage</Button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">Filter profile<select aria-label="Filter profile" value={filterProfile} onChange={e => setFilterProfile(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3"><option value="">All profiles</option>{catalog.profiles.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label className="text-sm">Filter phone<select aria-label="Filter phone" value={filterPhone} onChange={e => setFilterPhone(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3"><option value="">All phones &amp; legacy backups</option>{Array.from(new Set(catalog.entries.flatMap(e => e.phone ? [e.phone] : []))).sort().map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label className="text-sm">Filter backup type<select aria-label="Filter backup type" value={filterKind} onChange={e => setFilterKind(e.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3"><option value="">All types</option><option value="Full">Full backup</option><option value="Custom">Custom backup</option></select></label>
          <label className="text-sm">Filter backup date<input aria-label="Filter backup date" type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3" /></label>
        </div>
        <div className="flex items-center justify-between gap-3"><p role="status" className="text-xs text-muted-foreground">{filtered.length} of {catalog.entries.length} backups</p><Button variant="ghost" disabled={!filterProfile && !filterPhone && !filterKind && !filterDate} onClick={() => { setFilterProfile(""); setFilterPhone(""); setFilterKind(""); setFilterDate(""); }}><FilterX />Clear filters</Button></div>
        {catalog.warnings.length > 0 && <ul role="alert" className="space-y-2 border-l-2 border-warning pl-3 text-sm text-warning">{catalog.warnings.map(w => <li key={w} className="break-words">{w}</li>)}</ul>}
        {filtered.length === 0 ? <p className="text-sm text-muted-foreground">{storageProblem && storageProblem !== "space" ? "Backups are unavailable until storage access is restored." : catalog.entries.length ? "No backups match these filters." : "No readable backups found on this storage."}</p> : <ul aria-label="Saved backup results" className="divide-y divide-border">{filtered.map(entry => <li key={`${entry.profile}/${entry.phone ?? ""}/${entry.name}`} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><div className="min-w-0"><p className="break-all font-mono">{entry.name}</p><p className="mt-1 text-xs text-muted-foreground">{entry.profile} · {entry.phone ?? "Legacy profile-level backup"} · {entry.kind} · {backupISODate(entry.date)}</p></div><span className={entry.complete ? "text-muted-foreground" : "text-warning"}>{entry.files} files · {entry.complete ? "Saved" : "Incomplete"}</span></li>)}</ul>}
      </div>}
    </section>
  );
}
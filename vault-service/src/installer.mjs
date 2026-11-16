import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
const run = promisify(execFile);
export async function driveReady(root, expected) {
 const real = await fs.realpath(root), stat = await fs.lstat(root);
 if (stat.isSymbolicLink() || !stat.isDirectory() || path.basename(real)!=='HomeSafeBckup') throw new Error('Choose an existing real HomeSafeBckup folder on the connected drive');
 if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) throw new Error('Original configured drive is not connected; no verification file was written');
 const probe = path.join(real, `.homesafe-check-${randomBytes(12).toString('hex')}`), payload=randomBytes(32);
 const h=await fs.open(probe, constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
 try { await h.writeFile(payload); await h.sync(); if (!(await fs.readFile(probe)).equals(payload)) throw new Error('Drive readback failed'); } finally { await h.close(); await fs.unlink(probe); }
 const space=await fs.statfs(real); return {root:real,dev:stat.dev,ino:stat.ino,availableBytes:space.bavail*space.bsize,totalBytes:space.blocks*space.bsize};
}
export function privateIP(ip) { return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) && ip.split('.').length===4 && ip.split('.').every(p=>/^\d+$/.test(p)&&Number(p)<=255); }
const quote = s => '"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%')+'"';
export function systemdUnit({node,cli,state,root}) {
 for(const s of [node,cli,state,root]) if(/[\r\n\0]/.test(s)) throw new Error('Invalid startup path');
 return `[Unit]\nDescription=HomeSafe Vault local service\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${quote(node)} ${quote(cli)} start --state ${quote(state)}\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n`;
}
export function xmlEscape(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
export function windowsTask({node,cli,state,sid}) {
 for(const s of [node,cli,state,sid]) if(/[\r\n\0]/.test(s)) throw new Error('Invalid startup path');
 return `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(sid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Owner"><UserId>${xmlEscape(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings><Actions Context="Owner"><Exec><Command>${xmlEscape(node)}</Command><Arguments>${xmlEscape(`"${cli}" start --state "${state}"`)}</Arguments><WorkingDirectory>${xmlEscape(path.dirname(cli))}</WorkingDirectory></Exec></Actions></Task>`;
}
export async function guidedInstall(stateDir) {
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try {
  console.log('HomeSafe Vault setup — Node 22+ and OpenSSL must be installed. Nothing is uploaded.');
  if(Number(process.versions.node.split('.')[0])<22) throw new Error('Install Node 22 or newer');
  if(!['linux','win32'].includes(process.platform)) throw new Error('Guided startup supports Windows PC and Linux/Raspberry Pi; use manual setup on macOS');
  const rootInput=(await rl.question('Existing HomeSafeBckup folder on your drive: ')).trim(), drive=await driveReady(rootInput);
  console.log(`Drive write/read check passed; ${(drive.availableBytes/1024**3).toFixed(1)} GiB free. Confirm this is your intended USB drive.`);
  if((await rl.question('Use this drive? (yes/no): ')).trim()!=='yes') return;
  const origin=new URL((await rl.question('Vault dashboard HTTPS address: ')).trim()); if(origin.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(origin.hostname)) throw new Error('HTTPS dashboard required');
  const ip=(await rl.question('This PC/Pi home Wi-Fi IPv4 address: ')).trim(); if(!privateIP(ip)) throw new Error('Use a private home-network IPv4 address');
  const startup=(await rl.question('Configure automatic startup at login? (yes/no): ')).trim()==='yes';
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  if(process.platform==='win32') { const user=os.userInfo().username; await run('icacls.exe',[stateDir,'/inheritance:r','/grant:r',`${user}:(OI)(CI)F`]); }
  const configPath=path.join(stateDir,'config.json'); try {await fs.access(configPath);throw new Error('Already configured; existing keys will not be replaced');} catch(e) {if(e.code!=='ENOENT') throw e;}
  const cert=path.join(stateDir,'vault.crt'),key=path.join(stateDir,'vault.key'); for(const f of [cert,key]) {try {await fs.access(f);throw new Error('Certificate exists; use manual recovery');}catch(e){if(e.code!=='ENOENT')throw e;}}
  await run('openssl',['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','365','-keyout',key,'-out',cert,'-subj','/CN=HomeSafe Vault','-addext',`subjectAltName=IP:${ip}`]); await fs.chmod(key,0o600);
  await driveReady(drive.root, drive);
  const config={root:drive.root,driveIdentity:{dev:drive.dev,ino:drive.ino},instanceId:randomBytes(16).toString('hex'),origins:[origin.origin],adminToken:randomBytes(32).toString('base64url'),identityKey:randomBytes(32).toString('base64'),cert,key,lanHost:ip};
  await fs.writeFile(configPath,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
  const cli=path.resolve(import.meta.dirname,'cli.mjs');
  if(startup) {
   if(process.platform==='linux') { const unitDir=path.join(os.homedir(),'.config/systemd/user'); await fs.mkdir(unitDir,{recursive:true}); const unit=path.join(unitDir,'homesafe-vault.service'); await fs.writeFile(unit,systemdUnit({node:process.execPath,cli,state:stateDir,root:drive.root}),{flag:'wx'}); await run('systemctl',['--user','daemon-reload']); await run('systemctl',['--user','enable','--now','homesafe-vault.service']); }
   else {const who=await run('whoami.exe',['/user','/fo','csv','/nh']);const sid=who.stdout.match(/S-1-5-[\d-]+/)?.[0];if(!sid)throw new Error('Cannot identify Windows startup user');const xml=path.join(stateDir,'startup.xml');await fs.writeFile(xml,'\ufeff'+windowsTask({node:process.execPath,cli,state:stateDir,sid}),'utf16le');await run('schtasks.exe',['/Create','/TN','HomeSafe Vault','/XML',xml]);await run('schtasks.exe',['/Run','/TN','HomeSafe Vault']);}
   let ready=false; for(let i=0;i<30;i++){try {const r=await fetch('http://127.0.0.1:7878/v1/ready', {signal:AbortSignal.timeout(2000)});const b=await r.json();if(r.ok&&b.driveReady&&b.instanceId===config.instanceId){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));} if(!ready)throw new Error('Startup configured, but this service did not become ready; run doctor and check the drive/startup logs');
  }
  const fingerprint=createHash('sha256').update(new X509Certificate(await fs.readFile(cert)).raw).digest('hex');
  console.log(`Setup complete. Phone address: https://${ip}:7879\nCertificate fingerprint: ${fingerprint}\n${startup?'Startup registered and drive/service verified.':'Run node src/cli.mjs start to start Vault.'}\nAllow port 7879 only on the private home network. Run node src/cli.mjs access for your private dashboard key.`);
  if(process.platform==='linux') console.log('Starts at login. For Raspberry Pi boot before login, explicitly enable user lingering with: sudo loginctl enable-linger '+os.userInfo().username);
 } finally {rl.close();}
}

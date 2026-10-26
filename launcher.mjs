import {readFile,writeFile,mkdir,open,unlink} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {importBackupFile} from './portable/import-backup.mjs';
const ROOT=resolve(import.meta.dirname);
const DATA=join(ROOT,'data');
const RECORD=join(DATA,'server-process.json');
const LOCK=join(DATA,'launcher.lock');
const SCRIPT=join(ROOT,'portable/server.mjs');
const PASSWORD=join(ROOT,'管理密码.txt');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const normalize=s=>resolve(s).toLowerCase();
async function readJSON(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function processInfo(pid){
 if(!Number.isInteger(pid)||pid<1)return null;
 const code="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"' | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
 try{return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:10000}).trim()||'null');}catch{return null;}
}
function matches(record,info){
 if(!record||!info||!record.created||info.Created!==record.created||normalize(info.ExecutablePath||'')!==normalize(process.execPath))return false;
 const expected=SCRIPT.replaceAll('/','\\').toLowerCase();
 const command=String(info.CommandLine||'').replaceAll('/','\\').toLowerCase();
 return command.includes('"'+expected+'"')||command.endsWith(' '+expected);
}
function openBrowser(url){
 const child=spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'});
 child.on('error',()=>{});child.unref();
}
async function healthy(port){
 try{const res=await fetch('http://127.0.0.1:'+port+'/api/session',{signal:AbortSignal.timeout(1500)});const s=await res.json();return res.ok&&s.loginUrl==='/owner-login';}catch{return false;}
}
async function freePort(port){
 return new Promise(r=>{const s=createServer();s.once('error',()=>r(false));s.listen(port,'127.0.0.1',()=>s.close(()=>r(true)));});
}
async function lock(){
 for(let i=0;i<70;i++){
  try{const handle=await open(LOCK,'wx');await handle.writeFile(JSON.stringify({pid:process.pid}));return async()=>{await handle.close();const p=await readJSON(LOCK);if(p?.pid===process.pid)await unlink(LOCK);};}
  catch(e){if(e.code!=='EEXIST')throw e;const held=await readJSON(LOCK);if(held&&!alive(held.pid)){try{await unlink(LOCK);}catch{}}else await wait(200);}
 }
 throw new Error('小窝正在启动或停止，请稍后再双击。');
}
async function password(){
 try{const value=(await readFile(PASSWORD,'utf8')).trim();if(value.length<12)throw new Error('管理密码至少需要12位，请检查管理密码.txt。');return value;}
 catch(e){if(e.code!=='ENOENT')throw e;const value=randomBytes(18).toString('base64url');await writeFile(PASSWORD,value+'\n',{flag:'wx',mode:0o600});return value;}
}
await mkdir(DATA,{recursive:true});
const release=await lock();
try{
 const action=process.argv[2]||'start';
 const record=await readJSON(RECORD);
 const info=record?processInfo(record.pid):null;
 const owned=matches(record,info);
 if(action==='stop'){
  if(!owned){console.log('小窝没有运行，无需停止。');}
  else{process.kill(record.pid,'SIGTERM');for(let i=0;i<30&&alive(record.pid);i++)await wait(100);if(alive(record.pid))throw new Error('进程尚未停止，请稍后再试。');await unlink(RECORD);console.log('小窝已停止，照片和手账仍保存在data文件夹。');}
 }else if(action==='status'){
  console.log(JSON.stringify({running:owned&&await healthy(record.port),url:owned?'http://127.0.0.1:'+record.port:null,dataDir:DATA}));
 }else{
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('需要Node.js 24或更新版本。');
  if(owned){
   if(!await healthy(record.port))throw new Error('小窝进程尚未就绪，请稍后再打开。');
   const url='http://127.0.0.1:'+record.port;
   console.log('小窝正在运行：'+url);
   if(!process.argv.includes('--no-open'))openBrowser(url);
  }else{
   const adminPassword=await password();
   await importBackupFile(join(ROOT,'seed-backup.json'),{dataDir:DATA,once:true});
   let port;for(let candidate=4175;candidate<=4185;candidate++){if(await freePort(candidate)){port=candidate;break;}}
   if(!port)throw new Error('本机预留端口正在使用，请稍后重试。');
   const log=openSync(join(DATA,'server.log'),'a');
   const child=spawn(process.execPath,[SCRIPT],{cwd:ROOT,env:{...process.env,ADMIN_PASSWORD:adminPassword,DATA_DIR:DATA,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:''},windowsHide:true,detached:true,stdio:['ignore',log,log]});
   closeSync(log);
   await new Promise((ok,bad)=>{child.once('spawn',ok);child.once('error',bad);});
   child.unref();
   let created;for(let i=0;i<20;i++){created=processInfo(child.pid);if(created)break;await wait(100);}
   if(!created){child.kill();throw new Error('无法记录启动进程，请查看data/server.log。');}
   const next={pid:child.pid,port,created:created.Created,nodePath:process.execPath,scriptPath:SCRIPT};
   await writeFile(RECORD,JSON.stringify(next,null,2));
   let ready=false;for(let i=0;i<35;i++){if(!alive(child.pid))break;if(await healthy(port)){ready=true;break;}await wait(200);}
   if(!ready)throw new Error('小窝没有启动成功，请查看data/server.log。');
   const url='http://127.0.0.1:'+port;
   console.log('小窝已启动：'+url);
   console.log('照片和手账保存在：'+DATA);
   console.log('主人登录密码保存在本文件夹的 管理密码.txt。');
   if(!process.argv.includes('--no-open'))openBrowser(url);
  }
 }
}finally{await release();}


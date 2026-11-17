#!/usr/bin/env node
'use strict';
// macOS installer SIMULATION on Linux: actual generated shell with mocked Darwin uname
// and test-signed POSIX executable stand-ins; never claim native Mach-O/launchd QA.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {macInstallerScript} = require('../dist/src/routes/workerRoutes');

const inventory = [
  'worker_mcp-darwin-amd64', 'worker_mcp-darwin-arm64',
  'worker_mcp-linux-386', 'worker_mcp-linux-amd64',
  'worker_mcp-linux-arm64', 'worker_mcp-linux-armv7',
  'worker_mcp-windows-amd64.exe', 'worker_mcp-windows-arm64.exe',
  'WORKER_RELEASE',
];
const arch = process.env.MACOS_QA_ARCH === 'arm64' ? 'arm64' : 'amd64';
const asset = 'worker_mcp-darwin-' + arch;
const versions = [
  {version:'2.0.0', commit:'a'.repeat(40)},
  {version:'2.0.1', commit:'b'.repeat(40)},
  {version:'2.0.2', commit:'c'.repeat(40)}
];
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function executable(version, commit, failStart = false) {
  return Buffer.from('#!/bin/sh\ncase "$1" in\n'+
    '  version) printf "%s\\n" "worker_mcp '+version+' commit='+commit+' runtime=go-macos-simulation darwin/'+arch+'";;\n'+
    '  status) if [ "$MACOS_QA_RUNNING" = 1 ]; then echo "status: RUNNING"; else echo "status: STOPPED"; fi;;\n'+
    '  stop) exit 0;;\n'+
    '  start) '+(failStart?'exit 1':'exit 0')+';;\n'+
    '  *) exit 0;;\n'+
    'esac\n');
}
function signedBundle(pair, release, failStart = false) {
  const meta = Buffer.from('version='+release.version+'\ncommit='+release.commit+'\n');
  const binary = executable(release.version,release.commit,failStart);
  const files = Object.fromEntries(inventory.map(n=>[n, n==='WORKER_RELEASE'?meta:n===asset?binary:Buffer.from('test-only-placeholder:'+n)]));
  const sums=Buffer.from(inventory.map(n=>digest(files[n])+'  '+n+'\n').join(''));
  return {...files, SHA256SUMS:sums,'SHA256SUMS.sig':crypto.sign('sha256',sums,pair.privateKey)};
}
function run(command,args,env,timeout=18000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});
    let out='';
    child.stdout.on('data',x=>out+=x.toString());
    child.stderr.on('data',x=>out+=x.toString());
    const guard=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.once('error',e=>{clearTimeout(guard);reject(e)});
    child.once('exit',code=>{clearTimeout(guard);resolve({code,out:out.slice(-2500)})});
  });
}
async function main() {
  if(process.platform!=='linux')throw Error('Simulation must run on disposable Linux PC');
  const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const publicPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  const approval=r=>({version:r.version,commit:r.commit,publicKeyBase64:Buffer.from(publicPem).toString('base64'),publicKeySha256:digest(pair.publicKey.export({type:'spki',format:'der'}))});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'worker-sim-macos-'));
  const home=path.join(temp,'home'),install=path.join(temp,'install'),bin=path.join(temp,'bin'),shims=path.join(temp,'shims');
  [home,shims].forEach(x=>fs.mkdirSync(x,{recursive:true,mode:0o700}));
  const fakeUname=path.join(shims,'uname');
  fs.writeFileSync(fakeUname,'#!/bin/sh\ncase "$1" in\n  -s) echo Darwin;;\n  -m) echo '+(arch==='arm64'?'arm64':'x86_64')+';;\n  *) exit 40;;\nesac\n',{mode:0o700});
  const env={...process.env,PATH:shims+':'+process.env.PATH,HOME:home,
    MCP_WORKER_WORKER_INSTALL_ROOT:install,
    MCP_WORKER_WORKER_BIN_DIR:bin,
    MCP_WORKER_WORKER_HOME:path.join(home,'.worker_mcp'),
    MCP_WORKER_WORKER_SKIP_SERVICE:'1',MCP_WORKER_WORKER_SYSTEMD:'0'};
  let selected=0,tamper='';
  const allowed=new Set(['SHA256SUMS','SHA256SUMS.sig','WORKER_RELEASE',asset]);
  const bundles=versions.map((v,i)=>signedBundle(pair,v,i===2));
  const server=http.createServer((req,res)=>{
    const name=(req.url||'').replace(/^\/worker\/dist\//,'');
    if(!req.url.startsWith('/worker/dist/')||!allowed.has(name)){res.writeHead(404);res.end();return;}
    let data=bundles[selected][name];
    if(tamper==='signature' && name==='SHA256SUMS.sig')data=Buffer.from('invalid QA signature');
    if(tamper==='binary' && name===asset)data=Buffer.from('modified file');
    res.writeHead(200,{'Content-Length':data.length});res.end(data);
  });
  try{
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const runInstaller=async n=>{
      const file=path.join(temp,'mac-'+n+'.sh');
      fs.writeFileSync(file,macInstallerScript(base,approval(versions[n])),{mode:0o700});
      return run('sh',[file],env);
    };
    const target=path.join(install,'current','worker_mcp');
    let result=await runInstaller(0);
    assert.equal(result.code,0,result.out);
    assert.equal(fs.readFileSync(path.join(env.MCP_WORKER_WORKER_HOME,'release-version'),'utf8').trim(),'2.0.0');
    assert(fs.lstatSync(path.join(bin,'mcp_worker')).isSymbolicLink());
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_MACOS_'+arch+'_FRESH_SIGNED_INSTALL_PASS');
    result=await runInstaller(0);
    assert.equal(result.code,0,result.out);
    assert.match(result.out,/already current/);
    console.log('SIMULATED_MACOS_SAME_VERSION_IDEMPOTENT_PASS');
    selected=1;tamper='signature';
    result=await runInstaller(1);
    assert.notEqual(result.code,0);
    assert.match(result.out,/signature verification failed/);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_MACOS_BAD_SIGNATURE_FAIL_CLOSED_PASS');
    tamper='binary';result=await runInstaller(1);
    assert.notEqual(result.code,0);
    assert.match(result.out,/checksum verification failed/);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_MACOS_BINARY_CHECKSUM_FAIL_CLOSED_PASS');
    tamper='';result=await runInstaller(1);
    assert.equal(result.code,0,result.out);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]1/);
    assert.match(fs.readFileSync(path.join(install,'previous','worker_mcp'),'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_MACOS_SIGNED_UPGRADE_AND_PRIOR_BINARY_PASS');
    selected=0;result=await runInstaller(0);
    assert.notEqual(result.code,0);
    assert.match(result.out,/rollback rejected/);
    console.log('SIMULATED_MACOS_DOWNGRADE_REFUSED_PASS');
    env.MACOS_QA_RUNNING='1';selected=2;
    result=await runInstaller(2);
    assert.notEqual(result.code,0);
    assert.match(result.out,/previous binary restored/);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]1/);
    assert.equal(fs.readFileSync(path.join(env.MCP_WORKER_WORKER_HOME,'release-version'),'utf8').trim(),'2.0.1');
    console.log('SIMULATED_MACOS_FAILED_START_RESTORES_OLD_BINARY_PASS');
    console.log('SIMULATED_MACOS_ARCH='+arch+'; MACOS_NATIVE_QA=NOT_TESTED; MACH_O_AND_LAUNCHD=NOT_TESTED');
  }finally{
    server.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('SIMULATED_MACOS_FAIL',e);process.exitCode=1});

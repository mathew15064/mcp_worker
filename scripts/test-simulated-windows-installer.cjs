#!/usr/bin/env node
'use strict';
// PowerShell-based WINDOWS INSTALLER SIMULATION on Linux. PowerShell Core runs
// the generated installer with POSIX executable stand-ins in a disposable root.
// No Windows PE runtime, Windows ACLs, elevation, services or native UI tested.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {windowsInstallerPayloadScript} = require('../dist/src/routes/workerRoutes');
const pwsh = process.env.PWSH_BIN || 'pwsh';
const inventory = [
  'worker_mcp-darwin-amd64','worker_mcp-darwin-arm64',
  'worker_mcp-linux-386','worker_mcp-linux-amd64',
  'worker_mcp-linux-arm64','worker_mcp-linux-armv7',
  'worker_mcp-windows-amd64.exe','worker_mcp-windows-arm64.exe','WORKER_RELEASE'
];
const arch = process.env.WINDOWS_QA_ARCH === 'arm64' ? 'arm64' : 'amd64';
const asset = 'worker_mcp-windows-' + arch + '.exe';
const versions = [
  {version:'2.0.0',commit:'a'.repeat(40)},
  {version:'2.0.1',commit:'b'.repeat(40)},
  {version:'2.0.2',commit:'c'.repeat(40)}
];
function digest(bytes) {return crypto.createHash('sha256').update(bytes).digest('hex');}
function executable(version,commit,failStart=false) {
  return Buffer.from('#!/bin/sh\ncase "$1" in\n'+
    ' version) printf "%s\\n" "worker_mcp '+version+' commit='+commit+' runtime=go-windows-simulation windows/'+arch+'";;\n'+
    ' status) if [ "$WINDOWS_QA_RUNNING" = 1 ]; then echo "status: RUNNING"; else echo "status: STOPPED"; fi;;\n'+
    ' stop) exit 0;;\n'+
    ' start) '+(failStart?'exit 1':'exit 0')+';;\n'+
    ' *) exit 0;;\nesac\n');
}
function signedBundle(pair,release,failStart=false) {
  const metadata=Buffer.from('version='+release.version+'\ncommit='+release.commit+'\n');
  const binary=executable(release.version,release.commit,failStart);
  const files=Object.fromEntries(inventory.map(n=>[n,n==='WORKER_RELEASE'?metadata:n===asset?binary:Buffer.from('windows QA placeholder: '+n)]));
  const sums=Buffer.from(inventory.map(n=>digest(files[n])+'  '+n+'\n').join(''));
  return {...files, SHA256SUMS:sums, 'SHA256SUMS.sig':crypto.sign('sha256',sums,pair.privateKey)};
}
function runPowerShell(script,env,timeout=24000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(pwsh,['-NoLogo','-NoProfile','-NonInteractive','-File',script],{env,stdio:['ignore','pipe','pipe']});
    let out='';
    child.stdout.on('data',chunk=>out+=chunk.toString());
    child.stderr.on('data',chunk=>out+=chunk.toString());
    const guard=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.once('error',e=>{clearTimeout(guard);reject(e)});
    child.once('close',code=>{clearTimeout(guard);resolve({code,out:out.slice(-4000)})});
  });
}
async function main() {
  if(process.platform!=='linux')throw Error('PowerShell Windows simulation runs only on disposable Linux PC');
  const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const publicPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  const approve=r=>({version:r.version,commit:r.commit,publicKeyBase64:Buffer.from(publicPem).toString('base64'),publicKeySha256:digest(pair.publicKey.export({type:'spki',format:'der'}))});
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'worker-sim-windows-'));
  const install=path.join(tmp,'install'),home=path.join(tmp,'worker-home');
  const env={...process.env, HOME:path.join(tmp,'home'),
    MCP_WORKER_WORKER_INSTALL_ROOT:install,MCP_WORKER_WORKER_HOME:home,
    MCP_WORKER_WORKER_SKIP_PATH:'1',MCP_WORKER_WORKER_ACTION:'install'};
  fs.mkdirSync(env.HOME,{recursive:true,mode:0o700});
  const bundles=versions.map((v,i)=>signedBundle(pair,v,i===2));
  let selected=0,tamper='';
  const allowed=new Set(['SHA256SUMS','SHA256SUMS.sig','WORKER_RELEASE',asset]);
  const server=http.createServer((req,res)=>{
    const name=(req.url||'').replace(/^\/worker\/dist\//,'');
    if(!req.url.startsWith('/worker/dist/')||!allowed.has(name)){res.writeHead(404);res.end();return;}
    let body=bundles[selected][name];
    if(tamper==='signature'&&name==='SHA256SUMS.sig')body=Buffer.from('bad signature');
    if(tamper==='binary'&&name===asset)body=Buffer.from('changed binary');
    res.writeHead(200,{'Content-Length':body.length});res.end(body);
  });
  try{
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    async function installVersion(i) {
      const file=path.join(tmp,'installer-'+i+'.ps1');
      let source=windowsInstallerPayloadScript(base,approve(versions[i]));
      // Linux-only fixture adaptation: a downloaded POSIX script ending in
      // .exe needs chmod to be executable before PowerShell can invoke it.
      // The rest of the production PowerShell installer stays unmodified.
      const place='  $BinaryVersionOutput = @(& $Downloaded version)';
      assert(source.includes(place));
      source=source.replace(place,'  & chmod +x $Downloaded | Out-Null\n'+place);
      // On the Linux host RuntimeInformation.OSArchitecture is x64;
      // override only the architecture probe in this test-only copy.
      if (arch === 'arm64') {
        const probe = '[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()';
        assert(source.includes(probe));
        source = source.replace(probe, "'arm64'");
      }
      fs.writeFileSync(file,source);
      return runPowerShell(file,env);
    }
    const target=path.join(install,'current','worker_mcp.exe');
    let r=await installVersion(0);
    assert.equal(r.code,0,r.out);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]0/);
    assert.equal(fs.readFileSync(path.join(home,'release-version'),'utf8').trim(),'2.0.0');
    assert(fs.existsSync(path.join(install,'current','mcp_worker.exe')));
    console.log('SIMULATED_WINDOWS_'+arch+'_SIGNED_FRESH_INSTALL_AND_ALIAS_PASS');
    r=await installVersion(0);
    assert.equal(r.code,0,r.out);
    assert.match(r.out,/already current/);
    console.log('SIMULATED_WINDOWS_SAME_VERSION_IDEMPOTENT_PASS');
    selected=1;tamper='signature';
    r=await installVersion(1);
    assert.notEqual(r.code,0);
    assert.match(r.out,/Manifest signature verification failed/);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_WINDOWS_BAD_SIGNATURE_FAIL_CLOSED_PASS');
    tamper='binary';
    r=await installVersion(1);
    assert.notEqual(r.code,0);
    assert.match(r.out,/Checksum verification failed/);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_WINDOWS_BAD_CHECKSUM_FAIL_CLOSED_PASS');
    tamper='';r=await installVersion(1);
    assert.equal(r.code,0,r.out);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]1/);
    assert.match(fs.readFileSync(path.join(install,'previous','worker_mcp.exe'),'utf8'),/2[.]0[.]0/);
    console.log('SIMULATED_WINDOWS_SIGNED_UPGRADE_PRIOR_BINARY_PASS');
    selected=0;r=await installVersion(0);
    assert.notEqual(r.code,0);
    assert.match(r.out,/Signed release rollback rejected/);
    console.log('SIMULATED_WINDOWS_DOWNGRADE_REFUSED_PASS');
    selected=2;env.WINDOWS_QA_RUNNING='1';
    r=await installVersion(2);
    assert.notEqual(r.code,0);
    assert.match(r.out,/Replacement failed; previous binary restored/);
    assert.match(fs.readFileSync(target,'utf8'),/2[.]0[.]1/);
    assert.equal(fs.readFileSync(path.join(home,'release-version'),'utf8').trim(),'2.0.1');
    console.log('SIMULATED_WINDOWS_FAILED_START_RESTORES_PRIOR_BINARY_PASS');
    console.log('SIMULATED_WINDOWS_ARCH='+arch+'; WINDOWS_NATIVE_PE_EXECUTION=NOT_TESTED; WINDOWS_SERVICE_ACL=NOT_TESTED');
  }finally{
    server.close();
    fs.rmSync(tmp,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error('SIMULATED_WINDOWS_FAIL',e.message||String(e));process.exitCode=1});

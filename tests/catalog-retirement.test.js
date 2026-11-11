const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setupEnv, cleanup, initDb, issueToken, parseMcpResponse } = require('./helper');

const env = setupEnv('catalog-retirement');
initDb();
const app = require('../src/app');
const { TOOLS } = require('../src/mcp/toolRegistry');
const retired = ['game_start','game_restart','game_status','game_look','game_move','game_attack','game_pickup','game_use_item','game_inventory','game_unlock','game_escape'];
const expected = [
  'runtime_info','terminal_list','terminal_status','terminal_read','terminal_send',
  'workspace_exec','terminal_interrupt','artifact_collect','file_read','file_write',
  'file_patch','process_start','process_status','process_stop','process_logs',
  'repo_snapshot','git_diff','code_search','check_run'
];
let server, base, token, id=0;
test.before(async()=>{
  server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
  token=(await issueToken()).token.access_token;
});
test.after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  cleanup(env.dir);
});
async function rpc(method,params){
  const res=await fetch(base+'/mcp',{method:'POST',headers:{
    'content-type':'application/json',accept:'application/json, text/event-stream',
    authorization:'Bearer '+token
  },body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
  assert.equal(res.status,200);
  return parseMcpResponse(res);
}

test('exact 19 technical tools remain advertised and runtime_info agrees',async()=>{
  assert.deepEqual(TOOLS.map(t=>t.name),expected);
  const list=await rpc('tools/list',{});
  assert.deepEqual(list.result.tools.map(t=>t.name),expected);
  const info=await rpc('tools/call',{name:'runtime_info',arguments:{}});
  assert.equal(info.result.structuredContent.tool_count,19);
  assert.equal(info.result.structuredContent.tool_schema_hash,'77fec371229586b76437ab2dd0b8bff3101c89d13baa5a223795a8a68d11fdb6');
});

test('all 11 retired game tools reject direct authenticated MCP calls',async()=>{
  assert.equal(retired.length,11);
  for(const name of retired){
    const response=await rpc('tools/call',{name:name,arguments:{}});
    assert.ok(response.error || response.result?.isError,name+' must not execute');
    const description=JSON.stringify(response.error||response.result);
    assert.match(description,/not found|unknown tool|not registered/i,name);
  }
});

test('retired game web routes are absent',async()=>{
  const page=await fetch(base+'/dungeon');
  assert.equal(page.status,404);
  const games=await fetch(base+'/api/dungeon/games');
  assert.equal(games.status,404);
  const health=await fetch(base+'/healthz');
  assert.equal(health.status,200);
});

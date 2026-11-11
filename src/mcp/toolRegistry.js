const runtimeInfo = require('./tools/runtimeInfo');
const {
  listTerminals,
  terminalStatus,
  terminalRead,
  terminalSend,
  workspaceExec,
  terminalInterrupt,
  artifactCollect
} = require('./tools/terminalTools');
const {
  fileRead, fileWrite, filePatch,
  processStart, processStatus, processStop, processLogs,
  repoSnapshot, gitDiff, codeSearch, checkRun
} = require('./tools/localCodingTools');

runtimeInfo.domain = 'System';
runtimeInfo.requiredScope = 'bot_report.read';

const TOOLS = [
  runtimeInfo,
  listTerminals,
  terminalStatus,
  terminalRead,
  terminalSend,
  workspaceExec,
  terminalInterrupt,
  artifactCollect,
  fileRead,
  fileWrite,
  filePatch,
  processStart,
  processStatus,
  processStop,
  processLogs,
  repoSnapshot,
  gitDiff,
  codeSearch,
  checkRun
];

function registerAllTools(mcpServer) {
  for (const tool of TOOLS) {
    if (tool.annotations) {
      mcpServer.tool(tool.name, tool.description, tool.schema, tool.annotations, async args => tool.handler(args));
    } else {
      mcpServer.tool(tool.name, tool.description, tool.schema, async args => tool.handler(args));
    }
  }
}

module.exports = { TOOLS, registerAllTools };

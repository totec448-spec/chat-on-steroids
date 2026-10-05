// Full production renderer, with only its main-process API replaced by in-memory simulation.
const { buildSync } = require('esbuild');
const compiled = buildSync({ stdin: { contents: "export { SURFACES } from './src/main/mcp/surfaces.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'error' });
const definitions = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, definitions, definitions.exports);
module.exports = defaults => `
${defaults}
const surfaceDefinitions = ${JSON.stringify(definitions.exports.SURFACES)};
localStorage.setItem('cos.ui.language', 'pt-BR');
const surface = {...surfaceDefinitions.core,optional:false,available:true,
  localUrl:null,publicUrl:null,tools:['read'],state:'off',detail:'',lastRequestAt:null,lastToolCallAt:null};
window.fixture = {config:fixtureConfig({roots:[],ui:{theme:'dark'},tunnel:{kind:'openai',tunnelId:''}}),
  hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,cosBrowserSignedIn:false,
  secureStorage:{available:true},
  status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[surface,
    {...surface,...surfaceDefinitions.desktop,optional:true}]},
  bridge:{running:true,paired:true,present:false,port:8765,lastSeenAt:null,extensionVersion:null,externalExtension:null},
  update:{current:'2.1.26',latest:null,stage:'idle',error:null,checkedAt:null}};
const ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
let listener=()=>{};
window.paint=()=>listener(structuredClone(fixture));
const update=()=>{paint();return ok(fixture)};
window.simulate = kind => {
  if(kind==='extension') { fixture.bridge.present=true;fixture.bridge.extensionVersion=fixture.update.current;
    fixture.bridge.externalExtension={present:true,version:fixture.update.current,lastSeenAt:Date.now(),signedIn:false}; }
  if(kind==='login') { fixture.cosBrowserSignedIn=true;
    if(fixture.bridge.externalExtension) fixture.bridge.externalExtension.signedIn=true; }
  if(kind==='tunnel') fixture.config.tunnel.tunnelId='tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  if(kind==='key') fixture.hasApiKey=true;
  if(kind==='plugin') {const now=Date.now();fixture.status.lastRequestAt=now;fixture.status.lastToolCallAt=now;
    fixture.status.surfaces[0].lastRequestAt=now;fixture.status.surfaces[0].lastToolCallAt=now;}
  return update();
};
window.api=new Proxy({
  getState:()=>ok(fixture),onStateChanged:fn=>{listener=fn;return ()=>{}},getLog:()=>ok([]),
  listProjects:()=>ok([]),listSessions:()=>ok({sessions:[],total:0,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
  getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
  getChatModels:()=>ok({state:'unknown',models:[]}),
  saveSettings:patch=>{fixture.config=fixtureMerge(fixture.config,patch);return update()},
  addRoot:()=>{fixture.config.roots=[{name:'projeto-demo',path:'C:/Demo/Projeto'}];return update()},
  addRootPath:()=>{fixture.config.roots=[{name:'projeto-demo',path:'C:/Demo/Projeto'}];return update()},
  setApiKey:value=>{fixture.hasApiKey=!!value;return update()},
  openExtensionFolder:()=>ok('C:/Demo/CoS/extension'),extensionPath:()=>ok('C:/Demo/CoS/extension'),
  openSetupBrowser:(_browser,page)=>{if(page==='chatgpt')simulate('extension');return ok(true)},
  openChatGpt:()=>{simulate('extension');return ok(true)},showCosBrowser:()=>{simulate('login');return ok(true)},
  unpairExtension:()=>{fixture.bridge.paired=false;fixture.bridge.present=false;fixture.bridge.externalExtension=null;return update()},
  connect:()=>{fixture.status.state='connected';fixture.status.publicUrl='https://demo.invalid/mcp';
    fixture.status.surfaces[0].state='live';fixture.status.surfaces[0].publicUrl='https://demo.invalid/mcp';return update()},
  disconnect:()=>{fixture.status.state='disconnected';return update()},
  openLink:url=>{if(url.includes('tunnels'))simulate('tunnel');if(url.includes('api-keys'))simulate('key');if(url.includes('plugins'))simulate('plugin');return ok(true)},
  writeClipboard:()=>ok(true)
},{get:(target,key)=>key in target?target[key]:String(key).startsWith('on')?()=>()=>{}:()=>ok(null)});
await import('/main.ts');
const {setLanguage}=await import('/i18n.ts');window.setLanguage=setLanguage;
await new Promise(resolve=>setTimeout(resolve,100));
document.querySelector('[data-tab="setup"]').click();
window.fixtureReady=true;
`;

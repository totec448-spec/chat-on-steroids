// In-memory IPC fixture only. Actual UI/controller modules come from upstream.
(() => {
 const ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const listeners=new Map();
 const emit=(name,value)=>{for(const f of listeners.get(name)||[])f(structuredClone(value));};
 const now=Date.now(), id='composer-preview';
 const config={
  roots:[{name:'preview',path:'C:/preview'}],readOnly:true,
  capabilities:{browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
  commandAllowlist:{enabled:false,mode:'allow',rules:[]},
  tunnel:{kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
  ui:{minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark',language:'en',finishTool:true,planBackend:'chatgpt'},
  sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},compaction:{auto:true,autoTokens:300000},
  multiAgent:{enabled:true,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
  goal:{enabled:false,model:'sample',reasoning:'default',prompt:''}
 };
 const appState={config,status:{state:'connected',detail:'Local preview',publicUrl:null,localUrl:null,handshakeAt:now,lastRequestAt:now,lastToolCallAt:null,health:null,surfaces:[]},
  platform:{family:'windows',name:'Windows',desktopAutomation:false},hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
  bridge:{running:true,port:0,paired:true,present:true,lastSeenAt:now,extensionVersion:'2.1.18'},
  update:{current:'2.1.18',latest:null,stage:'idle',error:null,checkedAt:null}};
 const models={state:'ready',requestedAt:now,observedAt:now,models:[
  {id:'gpt-6-sol',label:'GPT-6 Sol',efforts:['low','medium','high','xhigh','max','ultra']},
  {id:'gpt-6-astra',label:'GPT-6 Astra',efforts:['low','medium','high','xhigh','max','ultra']},
  {id:'gpt-6-luna',label:'GPT-6 Luna',efforts:['low','medium','high','xhigh','max']},
  {id:'gpt-5.6-sol',label:'GPT-5.6 Sol',efforts:['low','medium','high','xhigh','max','ultra']},
  {id:'gpt-5.5',label:'GPT-5.5',efforts:['low','medium','high','xhigh']}
 ]};
 const summary={id,title:'Composer · isolated preview',conversationId:'preview-chat',chatIds:['preview-chat'],startedAt:now,updatedAt:now,endedAt:null,events:2,userMessages:1,toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,estimatedTokens:152000,contextTokens:152000,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:'completed',activeTurnId:null,agents:[],origin:null,selectedModel:{conversationId:'preview-chat',model:'gpt-6-sol',reasoningEffort:'high',observedAt:now}};
 const message=text=>({text,truncated:false,chars:text.length});
 const events=[{seq:1,time:now,source:'extension',kind:'user_message',messageId:'u-1',turnId:'t-1',message:message('Review the dashboard layout. Keep the existing behavior.')},
  {seq:2,time:now+1,source:'extension',kind:'assistant_message',messageId:'a-1',turnId:'t-1',message:message('The layout can be adjusted while preserving the controls and interactions.'),state:'final',final:true}];
 const controls={sessionId:id,conversationId:'preview-chat',automation:'off',objective:'Polish the dashboard without changing its behavior.',activeTurnId:null,finishHeld:false,finishWaiting:false,queueAtFinish:false,canInject:false,canSendDirectly:true,blocked:'',job:null,plan:null};
 let inputs=[];
 const notify=()=>emit('onSessionChanged',id);
 const fixture={
  getState:()=>ok(appState),getLog:()=>ok([]),getChatModels:()=>ok(models),requestChatModels:()=>{emit('onChatModelsChanged',models);return ok(models);},
  getZoom:()=>ok(1),pluginsSnapshot:()=>ok(null),listManagedSkills:()=>ok([]),listRecommendedSkills:()=>ok([]),extensionPath:()=>ok('Isolated preview — no extension connection'),
  getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
  petsList:()=>ok({pets:[]}),petsOverlayState:()=>ok({visible:false,ready:true,activeCount:0,activityCount:0}),
  listSessions:()=>ok({sessions:[{...summary,events:events.length,activeTurnId:controls.activeTurnId}],activeId:id,pressure:[]}),
  listProjects:()=>ok([]),listPausedHelpers:()=>ok([]),listInputs:()=>ok(inputs),
  getSession:()=>ok({summary:{...summary,events:events.length,activeTurnId:controls.activeTurnId},events,total:events.length,nextFrom:events.length+1}),
  getSessionControls:()=>ok(controls),getHandoff:()=>ok(null),
  setSessionAutomation:(_id,mode)=>{controls.automation=mode;notify();return ok(controls);},
  setSessionObjective:(_id,text,mode)=>{controls.objective=text;controls.automation=mode;notify();return ok(controls);},
  compactSession:()=>{controls.job={busy:true,phase:'requesting',reason:'manual'};notify();return ok(controls);},
  cancelSessionCompaction:()=>{controls.job=null;notify();return ok(controls);},
  releaseSessionFinish:()=>{controls.finishHeld=false;controls.finishWaiting=false;notify();return ok(true);},
  stopSessionTurn:()=>{controls.activeTurnId=null;controls.canInject=false;summary.lastTurnOutcome='stopped';notify();return ok({requested:true});},
  cancelInput:inputId=>{inputs=inputs.filter(e=>e.id!==inputId);notify();return ok(true);},
  sendInput:input=>{const entry={...input,sessionId:id,conversationId:'preview-chat',state:'queued',owner:null,createdAt:Date.now()};inputs.push(entry);notify();return ok(entry);},
  draftGoalOpening:text=>ok({reply:text,model:'sample'}),
  draftTaskPlan:()=>ok(['Inspect the current layout and behavior.','Implement the focused adjustment.','Verify keyboard and narrow layout.']),
  editQueuedInput:(inputId,text)=>{const entry=inputs.find(e=>e.id===inputId);if(entry)entry.text=text;notify();return ok(entry);},
  reorderQueuedInputs:(_id,order)=>{inputs.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));return ok(true);},
  skillLibrary:()=>ok({skills:['frontend-design','code-review','test-driven-development'].map((name,i)=>({id:name,name,displayName:name,description:['Build and polish frontend interfaces.','Review changes for bugs and regressions.','Write tests before implementing changes.'][i],path:'/sample/'+name+'/SKILL.md',scope:'user',source:'local'})),roots:[],warnings:[]}),
  chooseFiles:()=>ok([{id:'fixture-file',name:'layout.txt',mimeType:'text/plain',size:32}]),
  chooseFolder:()=>ok(null),
  saveSettings:patch=>{Object.assign(config,patch.patch||patch);emit('onStateChanged',appState);return ok(appState);},
  ready:()=>ok(true)
 };
 window.api=new Proxy(fixture,{get(target,prop){
  if(prop in target)return target[prop];
  if(String(prop).startsWith('on'))return fn=>{const set=listeners.get(prop)||new Set();listeners.set(prop,set);set.add(fn);return()=>set.delete(fn);};
  return ()=>{console.warn('Fixture method not provided: '+String(prop));return Promise.resolve({ok:false,error:'Not connected in this isolated UI preview: '+String(prop)});};
 }});
 window.composerFixture={controls,summary,events,notify,emit,scenario(name){
  if(name==='complete'){
   if(controls.plan){
    controls.plan={...controls.plan,plan:controls.plan.plan.map(step=>({...step,status:'completed'}))};
    notify();
   }
   return;
  }
  controls.activeTurnId=['working','queue','hold'].includes(name)?'sample-turn':null;
  controls.canInject=!!controls.activeTurnId;controls.finishWaiting=name==='hold';controls.finishHeld=name==='hold';controls.queueAtFinish=!!controls.activeTurnId;
  controls.automation=name==='empty'?'off':'goal';
  controls.plan=controls.activeTurnId?{explanation:'Preserve existing behavior.',plan:[{step:'Inspect the current layout',status:'completed'},{step:'Align filters and results',status:'in_progress'},{step:'Verify keyboard and narrow layout',status:'pending'}]}:null;
  inputs=name==='queue'?[{id:'queued-sample',sessionId:id,text:'Verify keyboard navigation and narrow layout.',mode:'after-turn',afterTurn:true,state:'queued',owner:null,createdAt:Date.now(),dueAt:Date.now(),conversationId:'preview-chat',model:'gpt-6-sol',reasoningEffort:'high'}]:[];
  notify();
 }};
})();

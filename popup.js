const $=id=>document.getElementById(id);
const DEFAULTS=DW_DEFAULTS;
let uiLang='fa',keys=[],keyState={},running=false,active=-1,busy=false,last={code:'s_idle',params:{}};let confirmTimer=null,msgTimer=null;
const t=(c,p={})=>{const s=(I18N[uiLang]&&I18N[uiLang][c])??I18N.en[c]??c;return s.replace(/\{(\w+)\}/g,(_,k)=>p[k]??'')};
const mask=k=>k.slice(0,4)+'…'+k.slice(-4),pct=v=>Math.round(Number(v)*100)+'%';
function renderStatus(){const txt=t(last.code,last.params||{});$('status').textContent=txt;if($('mainStatus'))$('mainStatus').textContent=txt}
function renderKeyVis(){const h=$('keyInput').type==='password';$('toggleKey').textContent=h?t('showKey'):t('hideKey');$('getKeyTxt').textContent=keys.length?t('getKeyRepl'):t('getKeyNew')}
function renderKeys(){
 renderKeyVis();$('keyCount').textContent=t('keysCount',{n:keys.length});$('delAll').classList.toggle('hidden',keys.length<2);
 const list=$('keyList');list.innerHTML='';if(!keys.length){list.innerHTML='<div class="hint">'+t('empty')+'</div>';return}
 const now=Date.now();keys.forEach((k,i)=>{const s=keyState[k],row=document.createElement('div');row.className='key';const code=document.createElement('code');code.textContent=mask(k);const badge=document.createElement('span');badge.className='badge';badge.textContent=t('stReady');if(running&&i===active){badge.className+=' activeKey';badge.textContent=t('stActive')}else if(s&&s.until>now){badge.textContent=s.status==='limited'?t('stLimited',{m:Math.ceil((s.until-now)/60000)}):s.status==='invalid'?t('stInvalid'):t('stError')};const x=document.createElement('button');x.className='x';x.textContent='×';x.onclick=()=>removeKey(i);row.append(code,badge,x);list.appendChild(row)})
}
function renderRunning(){$('dot').classList.toggle('on',running);$('liveText').textContent=running?'LIVE':'OFF';$('toggle').textContent=running?'■ '+t('stop'):'▶ '+t('start');$('toggle').classList.toggle('stop',running);renderKeys()}
function renderLabels(){
 $('v1').textContent=pct($('origBefore').value);$('v2').textContent=pct($('origAfter').value);$('v3').textContent=pct($('dubVol').value);$('v4').textContent=$('subsSize').value+'px';$('v5').textContent=Math.round(Number($('subsOpacity').value)*100)+'%';
 document.querySelectorAll('.range.fill').forEach(r=>{const mn=+r.min,mx=+r.max;r.style.setProperty('--p',((+r.value-mn)/(mx-mn)*100)+'%')});
 const g=$('subsGlass').checked,op=Number($('subsOpacity').value),pv=$('subPreviewText');
 pv.style.background=g?'rgba(5,10,20,'+op+')':'transparent';pv.style.borderColor=g?'rgba(255,255,255,.12)':'transparent';pv.style.boxShadow=g?'':'none';
 pv.style.backdropFilter=pv.style.webkitBackdropFilter=g?'blur(10px) saturate(1.3)':'none';
 pv.style.textShadow=g?'':'0 1px 3px #000, 0 0 6px rgba(0,0,0,.7)';
 pv.style.fontSize=(8.5+(Number($('subsSize').value)-16)/32*6.5)+'px';
 const pos=['top','center','bottom'].includes($('subsPos').value)?$('subsPos').value:'bottom';$('pvFrame').dataset.pos=pos;
 document.querySelectorAll('#posSeg button').forEach(b=>b.classList.toggle('active',b.dataset.pos===pos));
}
const subsCfg=()=>({on:$('subsOn').checked,orig:$('subsOrig').checked,size:Number($('subsSize').value),pos:$('subsPos').value,glass:$('subsGlass').checked,opacity:Number($('subsOpacity').value)});
function applyUiLang(){document.documentElement.lang=uiLang;document.documentElement.dir=RTL_LANGS.includes(uiLang)?'rtl':'ltr';document.querySelectorAll('[data-i]').forEach(e=>e.textContent=t(e.dataset.i));$('keyInput').placeholder=t('addPh');$('addBtn').textContent=t('addBtn');renderKeyVis();renderStatus();renderRunning()}
function flash(x){$('keyMsg').textContent=x;clearTimeout(msgTimer);msgTimer=setTimeout(()=>$('keyMsg').textContent='',2500)}
async function persistKeys(){const ks={};for(const k of keys)if(keyState[k])ks[k]=keyState[k];keyState=ks;await chrome.storage.local.set({keys,keyState});if(running)chrome.runtime.sendMessage({target:'offscreen',type:'SET_KEYS',keys}).catch(()=>{});renderKeys()}
function addKeys(text){let added=0,dup=0,bad=0;for(const k of text.split(/[\s,;]+/).map(s=>s.trim().replace(/^["'`]+|["'`]+$/g,'' )).filter(Boolean)){if(k.length<16){bad++;continue}if(keys.includes(k)){dup++;continue}keys.push(k);added++}if(added){persistKeys();flash(t('kAdded',{n:added}))}else if(dup)flash(t('kDup'));else if(bad)flash(t('kBad'));return added+dup>0}
function removeKey(i){keys.splice(i,1);persistKeys()}
let pasteTimer=null;function commitInput(){clearTimeout(pasteTimer);const v=$('keyInput').value.trim();if(!v)return;const r=addKeys(v);if(r)$('keyInput').value='';$('keyInput').focus()}
$('keyInput').addEventListener('paste',e=>{e.preventDefault();const text=(e.clipboardData||window.clipboardData).getData('text');$('keyInput').value=text.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean).join(' ');clearTimeout(pasteTimer);pasteTimer=setTimeout(commitInput,500)});
$('keyInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commitInput()}});$('addBtn').onclick=commitInput;
$('delAll').onclick=()=>{if(!confirmTimer){$('delAll').textContent=t('confirmDeleteAll');confirmTimer=setTimeout(()=>{confirmTimer=null;$('delAll').textContent=t('deleteAll')},3000);return}clearTimeout(confirmTimer);confirmTimer=null;keys=[];persistKeys();$('delAll').textContent=t('deleteAll')};
async function saveSettings(){await chrome.storage.local.set({lang:$('lang').value,uiLang,origBefore:+$('origBefore').value,origAfter:+$('origAfter').value,dubVol:+$('dubVol').value,subsOn:$('subsOn').checked,subsOrig:$('subsOrig').checked,subsSize:+$('subsSize').value,subsPos:$('subsPos').value,subsGlass:$('subsGlass').checked,subsOpacity:+$('subsOpacity').value,autoMute:$('autoMute').checked,syncPlayback:$('syncPlayback').checked,lagComp:$('lagComp').checked,rotate:$('rotate').checked,autoStopMin:+$('autoStopMin').value,model:$('model').value.trim()||DW_MODEL})}
for(const id of ['subsOn','subsOrig','subsSize','subsPos','subsGlass','subsOpacity'])$(id).addEventListener('input',async()=>{renderLabels();await saveSettings();chrome.runtime.sendMessage({target:'offscreen',type:'SET_SUBS',...subsCfg()}).catch(()=>{})});
$('lang').onchange=saveSettings;$('uiLang').onchange=()=>{uiLang=$('uiLang').value;saveSettings();applyUiLang()};
const sendVolumes=()=>chrome.runtime.sendMessage({target:'offscreen',type:'SET_VOLUMES',origBefore:+$('origBefore').value,origAfter:+$('origAfter').value,dubVol:+$('dubVol').value,autoMute:$('autoMute').checked}).catch(()=>{});
for(const id of ['origBefore','origAfter','dubVol'])$(id).addEventListener('input',()=>{renderLabels();saveSettings();sendVolumes()});
$('autoMute').addEventListener('change',()=>{saveSettings();sendVolumes()});
const optsCfg=()=>({syncPlayback:$('syncPlayback').checked,lagComp:$('lagComp').checked,autoStopMin:+$('autoStopMin').value,rotate:$('rotate').checked});
for(const id of ['syncPlayback','lagComp','rotate','autoStopMin'])$(id).addEventListener('input',()=>{saveSettings();chrome.runtime.sendMessage({target:'offscreen',type:'SET_OPTS',...optsCfg()}).catch(()=>{})});
$('model').addEventListener('change',()=>{$('model').value=$('model').value.trim();saveSettings()});
const curSettings=()=>({keys,lang:$('lang').value,origBefore:+$('origBefore').value,origAfter:+$('origAfter').value,dubVol:+$('dubVol').value,autoMute:$('autoMute').checked,...optsCfg(),model:$('model').value.trim()||DW_MODEL,subs:subsCfg(),toasts:{ready:t('toastReady'),none:t('toastNone')}});

$('toggleKey').onclick=()=>{$('keyInput').type=$('keyInput').type==='password'?'text':'password';renderKeyVis();$('keyInput').focus()};
document.querySelectorAll('#posSeg button').forEach(b=>b.onclick=()=>{$('subsPos').value=b.dataset.pos;$('subsPos').dispatchEvent(new Event('input'))});
document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.pane').forEach(x=>x.classList.remove('active'));tab.classList.add('active');$('pane-'+tab.dataset.tab).classList.add('active')});
const PRESETS={dubonly:{b:0,a:0,d:1.15},doc:{b:.18,a:.15,d:1.25},balanced:{b:.3,a:0,d:1}};
document.querySelectorAll('.preset-btn').forEach(btn=>btn.onclick=async()=>{const p=PRESETS[btn.dataset.preset];if(!p)return;$('origBefore').value=p.b;$('origAfter').value=p.a;$('dubVol').value=p.d;$('autoMute').checked=true;document.querySelectorAll('.preset-btn').forEach(x=>x.classList.toggle('active',x===btn));renderLabels();await saveSettings();sendVolumes()});
async function start(){
 if(busy)return;
 busy=true;$('toggle').disabled=true;
 try{
  if(running){
   const r=await chrome.runtime.sendMessage({type:'STOP'});
   running=false;active=-1;
   last=r?.ok?{code:'s_stopped'}:{code:r?.code||'e_generic',params:r?.params};
  }else{
   if(!keys.length){last={code:'e_noKeys'};return;}
   await saveSettings();
   last={code:'s_connecting',params:{i:1,n:keys.length,key:mask(keys[0])}};
   renderStatus();
   const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
   if(!tab?.id){last={code:'e_noTab'};return;}
   const r=await chrome.runtime.sendMessage({type:'START',tabId:tab.id,settings:curSettings()});
   if(r?.ok){running=true;last={code:$('subsOn').checked&&r.subsOk===false?'w_subsFail':'s_started'};}
   else last={code:r?.code||'e_generic',params:r?.params||{}};
  }
 }catch(e){
  last={code:'e_generic',params:{msg:e?.message||String(e)}};
 }finally{
  busy=false;$('toggle').disabled=false;renderStatus();renderRunning();
 }
}
$('toggle').onclick=start;if($('stop2'))$('stop2').onclick=()=>{if(running)start()};$('reconnect').onclick=async()=>{if(running){await start();setTimeout(start,250)}else start()};
$('checkKeys').onclick=async()=>{if(!keys.length){flash(t('e_noKeys'));return}clearTimeout(msgTimer);$('keyMsg').textContent=t('checking');$('checkKeys').disabled=true;try{const r=await chrome.runtime.sendMessage({type:'CHECK_KEYS',keys});if(r?.keyState){keyState=r.keyState;renderKeys();flash(t('checkDone'))}else flash(r?.error||t('e_generic',{msg:'check failed'}))}catch(e){flash(e.message||String(e))}finally{$('checkKeys').disabled=false}};
const srtTime=sec=>{const ms=Math.max(0,Math.round(sec*1000)),p=(n,l=2)=>String(n).padStart(l,'0');return p(Math.floor(ms/3600000))+':'+p(Math.floor(ms%3600000/60000))+':'+p(Math.floor(ms%60000/1000))+','+p(ms%1000,3)};
function flashMain(x){$('status').textContent=x;clearTimeout(msgTimer);msgTimer=setTimeout(renderStatus,2500)}
$('exportSrt').onclick=async()=>{let r;try{r=await chrome.runtime.sendMessage({target:'offscreen',type:'GET_TRANSCRIPT'})}catch{}const log=r?.log||[];if(!log.length){flashMain(t('noTranscript'));return}let o='\ufeff';log.forEach((x,i)=>{const nx=log[i+1];let end=Math.max(x.end+.7,x.start+1.2);if(nx&&end>nx.start-.05)end=Math.max(x.start+.3,nx.start-.05);o+=(i+1)+'\n'+srtTime(x.start)+' --> '+srtTime(end)+'\n'+(x.out||'').trim()+(x.inn?'\n'+x.inn.trim():'')+'\n\n'});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([o],{type:'text/plain;charset=utf-8'}));a.download='dubwave-'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')+'.srt';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)};
chrome.runtime.onMessage.addListener(m=>{if(m?.type==='STATUS'){last={code:m.code,params:m.params||{}};if(typeof m.running==='boolean')running=m.running;if(typeof m.active==='number')active=m.active;renderStatus();renderRunning()}});chrome.storage.onChanged.addListener(ch=>{if(ch.keyState){keyState=ch.keyState.newValue||{};renderKeys()}});
(async()=>{const s=await chrome.storage.local.get(DEFAULTS);keys=[...new Set(Array.isArray(s.keys)?s.keys:(s.key?[s.key]:[]))];keyState=s.keyState||{};uiLang=I18N[s.uiLang]?s.uiLang:'fa';$('uiLang').innerHTML=UI_LANGS.map(([c,n])=>`<option value="${c}">${n}</option>`).join('');$('uiLang').value=uiLang;$('lang').value=s.lang;$('origBefore').value=s.origBefore;$('origAfter').value=s.origAfter;$('dubVol').value=s.dubVol;$('subsOn').checked=!!s.subsOn;$('subsOrig').checked=!!s.subsOrig;$('subsSize').value=s.subsSize;$('subsPos').value=s.subsPos||'bottom';$('subsGlass').checked=s.subsGlass!==false;$('subsOpacity').value=s.subsOpacity??.46;$('autoMute').checked=s.autoMute!==false;$('syncPlayback').checked=s.syncPlayback!==false;$('lagComp').checked=!!s.lagComp;$('rotate').checked=s.rotate!==false;$('autoStopMin').value=String(s.autoStopMin);$('model').value=s.model&&s.model!==DW_MODEL?s.model:DW_MODEL;renderLabels();applyUiLang();try{const r=await chrome.runtime.sendMessage({type:'GET_STATUS'});if(r?.ok){running=!!r.running;active=r.active??-1;if(r.code)last={code:r.code,params:r.params||{}}}}catch{}applyUiLang()})();

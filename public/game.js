'use strict';

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const W = canvas.width, H = canvas.height;
  const menu = document.getElementById('menu');
  const craftPanel = document.getElementById('craft');
  const mapPanel = document.getElementById('map-panel');
  const pausePanel = document.getElementById('pause');
  const roomTag = document.getElementById('room-tag');
  const objective = document.getElementById('objective');
  const toasts = document.getElementById('toasts');
  const chatLog = document.getElementById('chat-log');
  const chatInput = document.getElementById('chat-input');
  const voiceChip = document.getElementById('voice-chip');
  const touch = document.getElementById('touch');
  const endScreen = document.getElementById('end-screen');
  const bigMap = document.getElementById('big-map');
  const bctx = bigMap.getContext('2d');
  bctx.imageSmoothingEnabled = false;
  const recipesEl = document.getElementById('recipes');
  const installBtn = document.getElementById('install');

  const TILE = { GRASS:0, FOREST:1, WATER:2, PATH:3, BRIDGE:4, RUINS:5 };
  const PAL = {
    ink:'#0e1628', ink2:'#212634', deep:'#0f2a42', pine:'#134750', pine2:'#1c525e',
    leaf:'#2c6651', leaf2:'#4d7149', moss:'#889543', grass:'#8c9548', grass2:'#6f8749',
    water:'#2771b0', water2:'#3d8cc0', water3:'#78b9d8', path:'#d89c5b', path2:'#bf8a60',
    cream:'#ddbb86', tan:'#bf8a60', rust:'#ac6e4f', brown:'#5d4148', darkBrown:'#3e2935',
    red:'#db4f4d', gold:'#f6c34a', white:'#f5e7c6', stone:'#716f73', stone2:'#8a8e8d', purple:'#695178'
  };

  let socket = null;
  let connected = false;
  let game = null;
  let map = null;
  let lastFrame = performance.now();
  let nowTime = 0;
  let camera = {x:0,y:0};
  let shake = 0;
  let recentHit = 0;
  let paused = false;
  let mapCache = null;
  let deferredInstall = null;
  let lastAttackSend = 0;
  let lastInteractSend = 0;
  let lastInputSend = 0;
  let titleSeed = Math.random()*9999;
  const lightCanvas = document.createElement('canvas'); lightCanvas.width=W; lightCanvas.height=H;
  const lightCtx = lightCanvas.getContext('2d');

  const input = {up:false,down:false,left:false,right:false,sprint:false};
  const hotbar = ['spear','hatchet','torch','berry','bandage'];
  const itemNames = {spear:'Spear',hatchet:'Hatchet',torch:'Torch',berry:'Berries',bandage:'Bandage'};
  const costs = {
    torch:{wood:2,herb:1}, bandage:{herb:3}, spear:{wood:4,stone:2},
    campfire:{wood:6,stone:4}, shelter:{wood:12,herb:4}
  };

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}`);
    socket.addEventListener('open', () => { connected = true; });
    socket.addEventListener('close', () => {
      connected = false;
      if (game) toast('Connection lost. Refresh to re-enter the woods.', 10000);
    });
    socket.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      onMessage(m);
    });
  }
  function send(obj) { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); }
  function onMessage(m) {
    if (m.t === 'init') {
      game = m;
      map = m.map;
      mapCache = buildMiniMap(map);
      camera.x = m.self.x; camera.y = m.self.y;
      menu.classList.add('hidden');
      roomTag.textContent = `GROVE ${m.code}`;
      roomTag.classList.remove('hidden');
      objective.classList.remove('hidden');
      voiceChip.classList.remove('hidden');
      if (matchMedia('(pointer: coarse)').matches) touch.classList.remove('hidden');
      updateObjective();
      toast(m.message || 'Find the Moon Shards.');
      ensureAudio();
      refreshRecipes();
      sendInput(true);
      return;
    }
    if (m.t === 'state') {
      if (!game) return;
      const oldHp = game.self?.hp ?? 100;
      const hadVictory = game.victory;
      game = {...game, ...m};
      if (game.self && game.self.hp < oldHp) { shake = 5; recentHit = performance.now(); sfx('hurt'); }
      updateObjective();
      refreshRecipes();
      updateVoiceVolumes();
      if (!hadVictory && game.victory) showVictory();
      return;
    }
    if (m.t === 'toast') toast(m.message);
    else if (m.t === 'chat') addChat(m.from, m.text);
    else if (m.t === 'hit') { shake = 2; sfx('hit'); }
    else if (m.t === 'victory') showVictory();
    else if (m.t === 'error') toast(m.message || 'Could not enter that grove.', 7000);
    else if (m.t === 'peer-joined') { if (voice.enabled) ensurePeer(m.id); }
    else if (m.t === 'peer-left') closePeer(m.id);
    else if (m.t === 'signal') handleSignal(m.from, m.data);
    else if (m.t === 'voice-state') {
      if (voice.enabled && m.enabled && m.id !== game?.selfId && String(game.selfId) < String(m.id)) { closePeer(m.id); ensurePeer(m.id); }
      updateVoiceVolumes();
    }
  }

  function nameValue(){ return document.getElementById('name').value.trim() || 'Ranger'; }
  document.getElementById('solo').addEventListener('click', () => { ensureAudio(); send({t:'create',name:nameValue(),solo:true}); });
  document.getElementById('host').addEventListener('click', () => { ensureAudio(); send({t:'create',name:nameValue(),solo:false}); });
  document.getElementById('join').addEventListener('click', () => {
    ensureAudio(); const code = document.getElementById('room').value.trim().toUpperCase();
    if (code.length !== 5) return toast('Enter the 5-character grove code.');
    send({t:'join',name:nameValue(),code});
  });
  document.getElementById('room').addEventListener('input', e => e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
  document.getElementById('continue').addEventListener('click', () => endScreen.classList.add('hidden'));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => document.getElementById(b.dataset.close).classList.add('hidden')));

  function toast(text, duration=3200) {
    if (!text) return;
    const el = document.createElement('div'); el.className='toast'; el.textContent=text; toasts.appendChild(el);
    while (toasts.children.length > 4) toasts.firstChild.remove();
    setTimeout(() => el.remove(), duration);
  }
  function addChat(from,text) {
    chatLog.classList.remove('hidden');
    const el=document.createElement('div');el.className='chat-line';el.textContent=`${from}: ${text}`;chatLog.appendChild(el);
    while(chatLog.children.length>7)chatLog.firstChild.remove();
    setTimeout(()=>{ if(chatLog.children.length===0)chatLog.classList.add('hidden'); },10000);
  }

  function updateObjective() {
    if (!game) return;
    let text = game.message || `Moon Shards ${game.shards}/3`;
    if (game.gateDefense) {
      const s = Math.ceil(game.gateDefense.remaining/1000);
      text = game.gateDefense.bossAlive ? `OLD GATE • ${Math.max(0,s)}s • DEFEAT THE HOLLOW STAG` : `OLD GATE • SURVIVE ${Math.max(0,s)}s`;
    }
    objective.textContent = text;
  }
  function showVictory(){ endScreen.classList.remove('hidden'); sfx('win'); }

  function sendInput(force=false) {
    if (!game || paused || !connected) return;
    const n=performance.now(); if(!force && n-lastInputSend<45)return; lastInputSend=n;
    send({t:'input',...input});
  }
  function setKey(k,v) { if (input[k]===v) return; input[k]=v; sendInput(true); }

  window.addEventListener('keydown', e => {
    if (chatInput.classList.contains('hidden') === false) {
      if (e.key === 'Enter') {
        const text=chatInput.value.trim(); if(text)send({t:'chat',text});
        chatInput.value='';chatInput.classList.add('hidden');canvas.focus();e.preventDefault();
      } else if (e.key === 'Escape') { chatInput.value='';chatInput.classList.add('hidden');e.preventDefault(); }
      return;
    }
    const k=e.key.toLowerCase();
    if (k==='w'||e.key==='ArrowUp') setKey('up',true);
    else if (k==='s'||e.key==='ArrowDown') setKey('down',true);
    else if (k==='a'||e.key==='ArrowLeft') setKey('left',true);
    else if (k==='d'||e.key==='ArrowRight') setKey('right',true);
    else if (e.key==='Shift') setKey('sprint',true);
    else if (e.code==='Space') { attack(); e.preventDefault(); }
    else if (k==='e') interact();
    else if (k==='q') useSelected();
    else if (k==='c') toggleCraft();
    else if (k==='m') toggleMap();
    else if (k==='v') toggleVoice();
    else if (e.key==='Enter' && game) { chatInput.classList.remove('hidden');chatInput.focus();e.preventDefault(); }
    else if (e.key==='Escape' && game) togglePause();
    else if (/^[1-5]$/.test(e.key)) selectSlot(Number(e.key)-1);
  });
  window.addEventListener('keyup', e => {
    const k=e.key.toLowerCase();
    if (k==='w'||e.key==='ArrowUp') setKey('up',false);
    else if (k==='s'||e.key==='ArrowDown') setKey('down',false);
    else if (k==='a'||e.key==='ArrowLeft') setKey('left',false);
    else if (k==='d'||e.key==='ArrowRight') setKey('right',false);
    else if (e.key==='Shift') setKey('sprint',false);
  });
  window.addEventListener('blur',()=>{ for(const k of Object.keys(input)) input[k]=false; sendInput(true); });

  function attack(){ if(!game||paused)return;const n=performance.now();if(n-lastAttackSend<160)return;lastAttackSend=n;send({t:'attack'});sfx('swing'); }
  function interact(){ if(!game||paused)return;const n=performance.now();if(n-lastInteractSend<220)return;lastInteractSend=n;send({t:'interact'});sfx('tap'); }
  function useSelected(){ if(!game||paused)return;send({t:'use',item:game.self.selected});sfx('use'); }
  function selectSlot(i){ if(!game)return;const item=hotbar[i];if((game.self.inventory[item]||0)>0){send({t:'select',item});sfx('select');} }
  function toggleCraft(){ if(!game)return;mapPanel.classList.add('hidden');pausePanel.classList.add('hidden');craftPanel.classList.toggle('hidden');paused=!craftPanel.classList.contains('hidden'); stopMovement(); }
  function toggleMap(){ if(!game)return;craftPanel.classList.add('hidden');pausePanel.classList.add('hidden');mapPanel.classList.toggle('hidden');paused=!mapPanel.classList.contains('hidden'); if(!mapPanel.classList.contains('hidden'))drawBigMap(); stopMovement(); }
  function togglePause(){ if(!game)return; craftPanel.classList.add('hidden');mapPanel.classList.add('hidden');pausePanel.classList.toggle('hidden');paused=!pausePanel.classList.contains('hidden');stopMovement(); }
  function stopMovement(){ for(const k of Object.keys(input)) input[k]=false;sendInput(true); }

  function refreshRecipes(){
    if(!game?.self)return;
    const labels={torch:'Torch',bandage:'Bandage',spear:'Spear',campfire:'Campfire',shelter:'Shelter'};
    recipesEl.innerHTML='';
    for(const key of Object.keys(costs)){
      const b=document.createElement('button');b.className='recipe';
      const c=Object.entries(costs[key]).map(([k,v])=>`${v} ${k}`).join(' • ');
      b.innerHTML=`<b>${labels[key]}</b><span>${c}</span>`;
      const can=Object.entries(costs[key]).every(([k,v])=>(game.self.inventory[k]||0)>=v);b.style.opacity=can?'1':'.48';
      b.addEventListener('click',()=>{send({t:'craft',recipe:key});sfx('craft');});recipesEl.appendChild(b);
    }
  }

  document.querySelectorAll('#touch [data-key]').forEach(b=>{
    const key=b.dataset.key;
    const down=e=>{e.preventDefault();setKey(key,true)}; const up=e=>{e.preventDefault();setKey(key,false)};
    b.addEventListener('pointerdown',down);b.addEventListener('pointerup',up);b.addEventListener('pointercancel',up);b.addEventListener('pointerleave',up);
  });
  document.querySelectorAll('#touch [data-action]').forEach(b=>b.addEventListener('pointerdown',e=>{e.preventDefault();const a=b.dataset.action;if(a==='attack')attack();else if(a==='interact')interact();else useSelected();}));
  canvas.addEventListener('pointerdown', e => { if(game && !matchMedia('(pointer: coarse)').matches && e.button===0) attack(); });

  // ---- audio ----
  let audioCtx=null, musicTimer=null, musicStep=0;
  function ensureAudio(){
    if(!audioCtx){ audioCtx=new (window.AudioContext||window.webkitAudioContext)(); startMusic(); }
    if(audioCtx.state==='suspended')audioCtx.resume();
  }
  function tone(freq,dur=.08,type='square',vol=.025,delay=0){ if(!audioCtx)return;const t=audioCtx.currentTime+delay,o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type=type;o.frequency.setValueAtTime(freq,t);g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.0001,t+dur);o.connect(g);g.connect(audioCtx.destination);o.start(t);o.stop(t+dur); }
  function sfx(name){
    if(!audioCtx)return;
    if(name==='swing'){tone(180,.05,'square',.018);tone(120,.06,'square',.012,.04)}
    else if(name==='hit'){tone(90,.08,'sawtooth',.025);tone(70,.11,'square',.015,.03)}
    else if(name==='hurt'){tone(120,.13,'sawtooth',.03);tone(80,.18,'square',.02,.06)}
    else if(name==='select'){tone(520,.045,'square',.015)}
    else if(name==='tap'){tone(340,.05,'square',.012)}
    else if(name==='use'){tone(420,.08,'triangle',.02);tone(620,.11,'triangle',.012,.05)}
    else if(name==='craft'){tone(260,.05,'square',.018);tone(390,.06,'square',.018,.05);tone(520,.09,'square',.018,.1)}
    else if(name==='win'){[261,329,392,523,659].forEach((f,i)=>tone(f,.35,'triangle',.03,i*.12));}
  }
  function startMusic(){
    if(musicTimer)return;
    musicTimer=setInterval(()=>{
      if(!audioCtx||!game||document.hidden)return;
      const phase=((game.clock||0)/(game.daySeconds||300))%1; const night=phase>.65||phase<.1;
      const day=[196,247,294,330,294,247,220,247], dark=[110,131,147,165,147,131,98,131];
      const seq=night?dark:day; const f=seq[musicStep++%seq.length];
      tone(f,.24,'triangle',.006); if(musicStep%4===0)tone(f/2,.35,'sine',.004);
    },420);
  }

  // ---- proximity voice ----
  const voice={enabled:false,stream:null,peers:new Map(),audios:new Map()};
  async function toggleVoice(){
    if(!game)return;
    if(voice.enabled){
      voice.enabled=false; if(voice.stream)voice.stream.getTracks().forEach(t=>t.stop());voice.stream=null;
      for(const id of [...voice.peers.keys()])closePeer(id);send({t:'voice',enabled:false});voiceChip.textContent='VOICE OFF [V]';toast('Proximity voice off.');return;
    }
    try{
      ensureAudio();
      voice.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      voice.enabled=true;send({t:'voice',enabled:true});voiceChip.textContent='VOICE ON [V]';toast('Proximity voice on. Walk closer to hear teammates.');
      for(const p of game.players||[])if(p.id!==game.selfId)ensurePeer(p.id);
    }catch(err){toast('Microphone permission was not granted.');}
  }
  function ensurePeer(remoteId){
    if(!voice.enabled||!remoteId||remoteId===game.selfId||voice.peers.has(remoteId))return voice.peers.get(remoteId);
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});
    voice.peers.set(remoteId,pc);
    if(voice.stream)for(const tr of voice.stream.getTracks())pc.addTrack(tr,voice.stream);
    pc.onicecandidate=e=>{if(e.candidate)send({t:'signal',to:remoteId,data:{candidate:e.candidate}})};
    pc.ontrack=e=>{
      let a=voice.audios.get(remoteId);if(!a){a=document.createElement('audio');a.autoplay=true;a.playsInline=true;document.body.appendChild(a);voice.audios.set(remoteId,a);}a.srcObject=e.streams[0];a.play().catch(()=>{});updateVoiceVolumes();
    };
    pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)&&pc.connectionState!=='disconnected')closePeer(remoteId)};
    if(String(game.selfId)<String(remoteId)){
      pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>send({t:'signal',to:remoteId,data:{sdp:pc.localDescription}})).catch(()=>{});
    }
    return pc;
  }
  async function handleSignal(from,data){
    if(!voice.enabled)return;
    const pc=ensurePeer(from);if(!pc)return;
    try{
      if(data.sdp){
        const desc=new RTCSessionDescription(data.sdp);
        if(desc.type==='offer'){
          await pc.setRemoteDescription(desc);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);send({t:'signal',to:from,data:{sdp:pc.localDescription}});
        }else await pc.setRemoteDescription(desc);
      }else if(data.candidate)await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }catch{}
  }
  function closePeer(id){const pc=voice.peers.get(id);if(pc)pc.close();voice.peers.delete(id);const a=voice.audios.get(id);if(a){a.remove();voice.audios.delete(id)}}
  function updateVoiceVolumes(){
    if(!game?.self)return;for(const [id,a] of voice.audios){const p=(game.players||[]).find(v=>v.id===id);if(!p){a.volume=0;continue;}const d=Math.hypot(p.x-game.self.x,p.y-game.self.y);a.volume=Math.max(0,Math.min(1,1-d/300));}
  }

  // ---- rendering helpers ----
  function hash(x,y,s=0){let n=(x*374761393+y*668265263+s*69069)>>>0;n=(n^(n>>>13))*1274126177>>>0;return((n^(n>>>16))>>>0)/4294967295}
  function worldToScreen(x,y){return{x:Math.round(x-camera.x+W/2),y:Math.round(y-camera.y+H/2)}}
  function rect(x,y,w,h,c){ctx.fillStyle=c;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h))}
  function outlineRect(x,y,w,h,fill,border=PAL.ink){rect(x-1,y-1,w+2,h+2,border);rect(x,y,w,h,fill)}
  function pixelText(text,x,y,size=8,color=PAL.white,align='left'){
    ctx.font=`bold ${size}px "Courier New",monospace`;ctx.textAlign=align;ctx.textBaseline='top';ctx.fillStyle=PAL.ink;ctx.fillText(text,x+1,y+1);ctx.fillStyle=color;ctx.fillText(text,x,y);
  }
  function shadow(x,y,w=14){ctx.fillStyle='rgba(6,13,20,.35)';ctx.fillRect(Math.round(x-w/2),Math.round(y-2),w,4)}

  function drawGroundTile(type,sx,sy,tx,ty,t){
    if(type===TILE.WATER){
      rect(sx,sy,16,16,PAL.water);rect(sx,sy+11,16,5,PAL.water2);
      const wave=((tx*7+ty*3+Math.floor(t*3))%10);if(wave<3){rect(sx+2,sy+4+wave,6,1,PAL.water3);rect(sx+10,sy+10-wave,4,1,'#a7d7e4')}
    } else if(type===TILE.PATH){
      rect(sx,sy,16,16,PAL.path);if(hash(tx,ty,2)>.45)rect(sx+3+(tx%5),sy+4+(ty%7),2,1,PAL.path2);if(hash(tx,ty,3)>.66)rect(sx+11,sy+12,1,1,PAL.cream);
    } else if(type===TILE.BRIDGE){
      rect(sx,sy,16,16,PAL.darkBrown);for(let yy=1;yy<16;yy+=4){rect(sx+1,sy+yy,14,3,'#9b6948');rect(sx+2,sy+yy,12,1,'#c18b58')}rect(sx+3,sy,2,16,'#5d4148');rect(sx+12,sy,2,16,'#5d4148');
    } else if(type===TILE.RUINS){
      rect(sx,sy,16,16,'#748348'); if(hash(tx,ty,9)>.35){rect(sx+2,sy+3,6,3,PAL.stone);rect(sx+3,sy+4,5,1,PAL.stone2)}
    } else {
      rect(sx,sy,16,16,PAL.grass);if(hash(tx,ty,5)>.44){rect(sx+2+(tx%6),sy+3+(ty%8),1,3,PAL.grass2);rect(sx+3+(tx%6),sy+3+(ty%8),1,1,'#b1b35d')}if(hash(tx,ty,8)>.84){rect(sx+11,sy+8,1,1,'#f0d690');rect(sx+10,sy+9,3,1,'#c96f73')}
    }
  }
  function drawTree(sx,sy,v=0){
    // Chunky trunks and layered canopies closely match the reference's rounded 16-bit tree language.
    shadow(sx+8,sy+17,14);rect(sx+6,sy+7,5,12,'#70473b');rect(sx+7,sy+7,3,12,'#a56a49');rect(sx+8,sy+7,1,12,'#c48655');
    const dark=v%2?PAL.deep:'#143b4b', mid=v%3?PAL.pine:'#1b5156', lite=v%2?'#32705a':'#3f7658';
    rect(sx-3,sy-5,22,13,dark);rect(sx-6,sy-1,28,9,dark);rect(sx,sy-9,16,19,dark);
    rect(sx-1,sy-5,18,8,mid);rect(sx-4,sy,12,7,mid);rect(sx+7,sy-2,13,8,mid);rect(sx+3,sy-8,10,7,mid);
    rect(sx+2,sy-5,6,3,lite);rect(sx+10,sy-1,5,3,lite);rect(sx-2,sy+1,5,3,lite);rect(sx+6,sy-8,4,2,'#5a8659');
  }
  function drawForestTile(sx,sy,tx,ty){drawGroundTile(TILE.GRASS,sx,sy,tx,ty,nowTime);drawTree(sx,sy+1,Math.floor(hash(tx,ty,12)*4));}

  function drawBush(sx,sy,berry=false){shadow(sx,sy+7,13);rect(sx-7,sy-2,14,8,PAL.deep);rect(sx-8,sy,16,6,PAL.leaf);rect(sx-4,sy-5,8,11,'#3d7857');rect(sx-2,sy-3,5,3,'#5a8d5c');if(berry){for(const [x,y] of [[-4,0],[3,-1],[0,3]])rect(sx+x,sy+y,2,2,PAL.red)}}
  function drawRock(sx,sy){shadow(sx,sy+7,14);rect(sx-7,sy+1,14,7,'#555b64');rect(sx-5,sy-3,10,10,PAL.stone);rect(sx-3,sy-2,7,3,PAL.stone2);rect(sx+3,sy+2,3,3,'#5b5c62')}
  function drawWood(sx,sy){shadow(sx,sy+7,15);rect(sx-7,sy-2,14,4,'#70473b');rect(sx-5,sy+2,14,4,'#8d5a42');rect(sx-6,sy-1,3,3,'#c18354');rect(sx+5,sy+3,3,3,'#d09558');rect(sx-1,sy-3,8,2,'#a86c48')}
  function drawHerb(sx,sy){rect(sx-1,sy,2,7,'#315f48');rect(sx-5,sy+1,5,3,'#5c925a');rect(sx+1,sy-2,5,4,'#6ba45f');rect(sx-3,sy-4,4,4,'#4f8554');rect(sx,sy-3,1,1,'#e7d49b')}
  function drawCampfire(sx,sy){shadow(sx,sy+7,19);rect(sx-9,sy+4,18,3,PAL.stone);rect(sx-7,sy+3,3,4,PAL.stone2);rect(sx+4,sy+3,3,4,PAL.stone2);rect(sx-6,sy+1,12,3,'#744132');const f=Math.floor(nowTime*8)%3;rect(sx-4,sy-6+f,8,10,PAL.red);rect(sx-3,sy-9+(2-f),6,9,'#f28d3e');rect(sx-1,sy-7+f,3,7,'#ffd95a');rect(sx,sy-3,2,4,'#fff0a3')}
  function drawTent(sx,sy){shadow(sx,sy+10,28);rect(sx-14,sy+4,28,8,'#6f4e40');rect(sx-12,sy-6,24,15,'#d6a16d');rect(sx-8,sy-11,16,20,'#e2b17a');rect(sx+1,sy-9,3,18,'#704438');rect(sx+4,sy-4,7,13,'#51313a');rect(sx-9,sy-5,7,2,'#efc590')}
  function drawAltar(sx,sy,status){shadow(sx,sy+9,20);rect(sx-8,sy+4,16,5,'#4d4f58');rect(sx-6,sy-1,12,7,PAL.stone);rect(sx-4,sy-7,8,8,PAL.stone2);rect(sx-2,sy-11,4,5,'#62676f');const active=status!=='claimed';if(active){const c=status==='cleansed'?PAL.gold:'#b082c0';rect(sx-1,sy-13,3,3,c);if(Math.floor(nowTime*4)%2===0){rect(sx-5,sy-12,1,1,c);rect(sx+5,sy-8,1,1,c)}}if(status==='claimed')rect(sx-2,sy-4,4,2,'#394a44')}
  function drawGate(sx,sy){shadow(sx,sy+12,35);rect(sx-17,sy-8,6,23,'#54535b');rect(sx+11,sy-8,6,23,'#54535b');rect(sx-15,sy-12,30,6,PAL.stone);rect(sx-13,sy-10,26,2,PAL.stone2);rect(sx-9,sy-4,18,19,'#1a2731');if(game?.shards>=3){const pulse=(Math.sin(nowTime*4)+1)/2;ctx.fillStyle=`rgba(118,185,216,${.25+.25*pulse})`;ctx.fillRect(sx-8,sy-3,16,18);rect(sx-1,sy,2,12,'#d9eff1')}}

  function drawPlayer(p,isSelf=false){
    const s=worldToScreen(p.x,p.y);const bob=p.downed?0:Math.floor((Math.sin(nowTime*8+(p.id?.length||0))+1)*.5);shadow(s.x,s.y+7,14);
    if(p.downed){rect(s.x-8,s.y+2,16,5,'#6d493f');rect(s.x-6,s.y-1,8,6,'#d7a36f');rect(s.x+2,s.y,5,4,PAL.ink);return;}
    const cols=[['#745447','#d7a36f'],['#3e5b62','#d0a06d'],['#6c4b5a','#d3a173'],['#485c3e','#d8a16d'],['#6d5b3d','#d2a071'],['#454b6b','#d4a36e']][p.color||0];
    const x=s.x,y=s.y-bob;const step=Math.floor(nowTime*9)%2;
    rect(x-5,y+7,4,5,step?'#2f2931':'#3e3035');rect(x+1,y+7,4,5,step?'#3e3035':'#2f2931');
    rect(x-6,y-1,12,10,cols[0]);rect(x-5,y-2,10,6,cols[1]);rect(x-5,y-6,10,4,'#c39a69');rect(x-7,y-7,14,3,'#725343');rect(x-4,y-9,8,3,'#9c744d');
    rect(x-8,y,3,8,'#3e2935');rect(x-9,y+1,3,5,'#795640'); // backpack
    if(p.dir==='left')rect(x-5,y-2,2,2,PAL.ink);else if(p.dir==='right')rect(x+3,y-2,2,2,PAL.ink);else {rect(x-3,y-2,2,2,PAL.ink);rect(x+2,y-2,2,2,PAL.ink)}
    drawHeldItem(p.selected,p.dir,x,y);
    if(!isSelf)pixelText(p.name,x,y-16,6,PAL.white,'center');
    if(isSelf&&voice.enabled)rect(x+6,y-12,2,2,'#69c27d');
  }
  function drawHeldItem(item,dir,x,y){
    let dx=dir==='left'?-8:dir==='right'?8:4,dy=dir==='up'?-8:dir==='down'?6:1;
    if(item==='spear'){rect(x+dx-1,y+dy-7,2,12,'#8c5e43');rect(x+dx-2,y+dy-10,4,4,'#d9d0b0');rect(x+dx-1,y+dy-11,2,2,PAL.white)}
    else if(item==='hatchet'){rect(x+dx-1,y+dy-5,2,10,'#8c5e43');rect(x+dx-3,y+dy-8,6,4,'#8f9291')}
    else if(item==='torch'){rect(x+dx-1,y+dy-4,2,9,'#8c5e43');rect(x+dx-3,y+dy-9,6,6,'#f47e38');rect(x+dx-1,y+dy-11,3,5,'#ffd05a')}
  }
  function drawEnemy(e){
    const s=worldToScreen(e.x,e.y);shadow(s.x,s.y+7,e.type==='stag'?34:14);
    if(e.type==='spider'){
      rect(s.x-4,s.y-3,8,8,'#241d27');rect(s.x-2,s.y-5,4,4,'#4f3549');for(const yy of [-3,2]){rect(s.x-8,s.y+yy,5,1,'#261d27');rect(s.x+3,s.y+yy,5,1,'#261d27')}rect(s.x-2,s.y-3,1,1,'#d56d55');rect(s.x+1,s.y-3,1,1,'#d56d55');
    }else if(e.type==='wolf'){
      rect(s.x-7,s.y-4,14,10,'#545a61');rect(s.x+4,s.y-7,7,8,'#6c7375');rect(s.x+5,s.y-10,3,5,'#646a6e');rect(s.x+9,s.y-9,2,5,'#646a6e');rect(s.x+9,s.y-4,1,1,PAL.red);rect(s.x-5,s.y+5,2,5,'#3c4148');rect(s.x+3,s.y+5,2,5,'#3c4148');rect(s.x-11,s.y-5,5,2,'#474b52');
    }else if(e.type==='stag'){
      rect(s.x-12,s.y-2,24,18,'#241f2b');rect(s.x-8,s.y-12,16,15,'#342538');rect(s.x-6,s.y-17,12,9,'#251b28');rect(s.x-5,s.y-16,2,2,'#f4cc56');rect(s.x+3,s.y-16,2,2,'#f4cc56');
      rect(s.x-11,s.y-26,2,14,'#4b3a42');rect(s.x+9,s.y-26,2,14,'#4b3a42');rect(s.x-16,s.y-25,7,2,'#4b3a42');rect(s.x+9,s.y-25,7,2,'#4b3a42');rect(s.x-18,s.y-31,2,8,'#4b3a42');rect(s.x+16,s.y-31,2,8,'#4b3a42');rect(s.x-7,s.y+14,4,9,'#1e1c25');rect(s.x+5,s.y+14,4,9,'#1e1c25');
    }else{
      const guardian=e.type==='guardian';const base=guardian?'#2b2135':'#101827',mid=guardian?'#5a3e62':'#1d2d3b';
      rect(s.x-6,s.y-8,12,16,base);rect(s.x-8,s.y-3,16,8,base);rect(s.x-4,s.y-10,8,8,mid);rect(s.x-3,s.y-6,2,2,guardian?'#db88d7':'#f1d36b');rect(s.x+2,s.y-6,2,2,guardian?'#db88d7':'#f1d36b');if(guardian){rect(s.x-8,s.y-15,2,8,base);rect(s.x+6,s.y-15,2,8,base);rect(s.x-11,s.y-16,5,2,base);rect(s.x+6,s.y-16,5,2,base)}
    }
    if(e.hp<e.maxHp){const w=e.type==='stag'?34:16;rect(s.x-w/2,s.y-(e.type==='stag'?38:15),w,3,PAL.ink);rect(s.x-w/2+1,s.y-(e.type==='stag'?37:14),Math.max(0,(w-2)*e.hp/e.maxHp),1,e.type==='stag'?PAL.red:'#d46f50')}
  }

  function drawResource(r){const s=worldToScreen(r.x,r.y);if(r.kind==='wood')drawWood(s.x,s.y);else if(r.kind==='stone')drawRock(s.x,s.y);else if(r.kind==='berry')drawBush(s.x,s.y,true);else drawHerb(s.x,s.y)}
  function drawStructure(s){const p=worldToScreen(s.x,s.y);if(s.type==='campfire')drawCampfire(p.x,p.y);else if(s.type==='shelter')drawTent(p.x,p.y)}
  function drawLandmarks(){if(!game)return;for(const a of game.altars||[]){const p=worldToScreen(a.x*map.ts+8,a.y*map.ts+8);if(p.x>-40&&p.x<W+40&&p.y>-40&&p.y<H+40)drawAltar(p.x,p.y,a.status)}const g=worldToScreen(game.gate.x*map.ts+8,game.gate.y*map.ts+8);drawGate(g.x,g.y)}

  function renderWorld(){
    const self=game.self;if(!self||!map)return;
    const targetX=self.x,targetY=self.y;camera.x+=(targetX-camera.x)*.18;camera.y+=(targetY-camera.y)*.18;
    if(shake>0){camera.x+=(Math.random()-.5)*shake;camera.y+=(Math.random()-.5)*shake;shake*=.82;if(shake<.2)shake=0;}
    const ts=map.ts;const minX=Math.floor((camera.x-W/2)/ts)-2,maxX=Math.ceil((camera.x+W/2)/ts)+2;const minY=Math.floor((camera.y-H/2)/ts)-3,maxY=Math.ceil((camera.y+H/2)/ts)+3;
    rect(0,0,W,H,PAL.deep);
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      if(x<0||y<0||x>=map.w||y>=map.h)continue;const type=map.terrain[y*map.w+x];const sx=Math.round(x*ts-camera.x+W/2),sy=Math.round(y*ts-camera.y+H/2);
      if(type===TILE.FOREST)drawForestTile(sx,sy,x,y);else drawGroundTile(type,sx,sy,x,y,nowTime);
    }
    // World objects sorted by y for readable top-down overlap.
    const drawables=[];
    for(const r of game.resources||[])drawables.push({y:r.y,fn:()=>drawResource(r)});
    for(const s of game.structures||[])drawables.push({y:s.y,fn:()=>drawStructure(s)});
    for(const a of game.altars||[])drawables.push({y:a.y*ts+8,fn:()=>{const p=worldToScreen(a.x*ts+8,a.y*ts+8);drawAltar(p.x,p.y,a.status)}});
    drawables.push({y:game.gate.y*ts+8,fn:()=>{const p=worldToScreen(game.gate.x*ts+8,game.gate.y*ts+8);drawGate(p.x,p.y)}});
    for(const e of game.enemies||[])drawables.push({y:e.y,fn:()=>drawEnemy(e)});
    for(const p of game.players||[])drawables.push({y:p.y,fn:()=>drawPlayer(p,p.id===game.selfId)});
    drawables.sort((a,b)=>a.y-b.y);for(const d of drawables)d.fn();
    drawWeather();drawLighting();drawHUD();drawContextHint();
  }

  function phaseInfo(){const phase=((game?.clock||0)/(game?.daySeconds||300))%1;let alpha=0;if(phase>.65)alpha=Math.min(.58,(phase-.65)/.18*.58);else if(phase<.1)alpha=(.1-phase)/.1*.58;return{phase,night:phase>.65||phase<.1,alpha}}
  function drawLighting(){
    const p=phaseInfo();if(p.alpha<=.01)return;
    const o=lightCtx;o.globalCompositeOperation='source-over';o.clearRect(0,0,W,H);o.fillStyle=`rgba(7,12,31,${p.alpha})`;o.fillRect(0,0,W,H);o.globalCompositeOperation='destination-out';
    function light(x,y,r,a=.92){const g=o.createRadialGradient(x,y,2,x,y,r);g.addColorStop(0,`rgba(0,0,0,${a})`);g.addColorStop(.55,`rgba(0,0,0,${a*.65})`);g.addColorStop(1,'rgba(0,0,0,0)');o.fillStyle=g;o.fillRect(x-r,y-r,r*2,r*2)}
    if(game.self.selected==='torch'&&(game.self.inventory.torch||0)>0)light(W/2,H/2,88,1);
    for(const s of game.structures||[])if(s.type==='campfire'&&s.lit){const p=worldToScreen(s.x,s.y);light(p.x,p.y,105,.95)}
    o.globalCompositeOperation='source-over';ctx.drawImage(lightCanvas,0,0);
    if(p.night){for(let i=0;i<14;i++){const x=(i*47+Math.floor(game.clock*2))%W,y=(i*31)%90;if((i+Math.floor(game.clock))%5===0)rect(x,y,1,1,'rgba(223,231,219,.55)')}}
  }
  function drawWeather(){
    if(!game)return;const phase=((game.clock||0)/(game.daySeconds||300))%1;const rain=(game.day%3===0&&phase>.28&&phase<.45)||(game.day%5===0&&phase>.55&&phase<.62);if(!rain)return;
    ctx.fillStyle='rgba(185,219,224,.34)';for(let i=0;i<42;i++){const x=(i*41+Math.floor(nowTime*180))%(W+30)-15;const y=(i*73+Math.floor(nowTime*240))%(H+30)-15;ctx.fillRect(x,y,1,5)}
  }

  function drawHeart(x,y,filled){const c=filled?PAL.red:'#3a3540';rect(x+2,y,5,4,c);rect(x+8,y,5,4,c);rect(x,y+2,15,5,c);rect(x+2,y+7,11,3,c);rect(x+4,y+10,7,3,c);rect(x+6,y+13,3,2,c);rect(x+3,y+1,3,1,filled?'#ff8b71':'#49424b')}
  function drawHUD(){
    const p=game.self;const hpRatio=p.hp/p.maxHp;const hearts=5;
    for(let i=0;i<hearts;i++){const frac=hpRatio*hearts-i;drawHeart(13+i*19,11,frac>.35)}
    pixelText(`LV ${p.level}`,13,31,8,PAL.white);drawBar(55,31,78,8,p.xp/(p.level*100),'#4ba5d6','#10233a');
    drawBar(13,44,120,8,p.stamina/100,'#69b8dd','#163346');drawTinyIcon('stamina',4,43);
    drawBar(13,57,120,8,p.hunger/100,'#58aa56','#254331');drawTinyIcon('hunger',4,56);
    drawMiniMap();drawHotbar();
    const {phase}=phaseInfo();let time='DAY';if(phase<.1||phase>.65)time='NIGHT';else if(phase>.55)time='DUSK';else if(phase<.2)time='DAWN';pixelText(`${time} ${game.day}`,W-15,104,7,PAL.cream,'right');
    pixelText('v1.0.0',7,H-10,6,'#b9c1b0');
    if(performance.now()-recentHit<220){ctx.fillStyle='rgba(180,35,40,.12)';ctx.fillRect(0,0,W,H)}
  }
  function drawBar(x,y,w,h,r,fill,bg){outlineRect(x,y,w,h,bg,PAL.ink);rect(x+2,y+2,Math.max(0,(w-4)*Math.min(1,r)),h-4,fill);if(r>.08)rect(x+3,y+2,Math.max(0,(w-6)*Math.min(1,r)),1,'rgba(255,255,255,.22)')}
  function drawTinyIcon(k,x,y){if(k==='stamina'){rect(x,y+2,4,7,'#5d9950');rect(x+2,y,4,7,'#8ebc60')}else{rect(x,y+1,7,7,'#4d8a43');rect(x+2,y-1,4,3,'#87b857')}}
  function drawHotbar(){
    const p=game.self;const size=37,total=size*5,ox=Math.round(W/2-total/2),oy=H-47;
    for(let i=0;i<5;i++){const item=hotbar[i],sel=p.selected===item;rect(ox+i*size,oy,size-3,35,sel?PAL.gold:'#303643');rect(ox+i*size+2,oy+2,size-7,31,'#202733');if(sel){rect(ox+i*size+2,oy+2,size-7,2,'#ffe09b');rect(ox+i*size+2,oy+29,size-7,2,'#a96a45')}drawItemIcon(item,ox+i*size+17,oy+17);pixelText(String(i+1),ox+i*size+3,oy+3,6,'#aab3ae');const n=p.inventory[item]||0;if(item==='berry'||item==='bandage'||item==='torch')pixelText(String(n),ox+i*size+29,oy+24,7,PAL.white,'right');}
  }
  function drawItemIcon(item,x,y){if(item==='spear'){rect(x-1,y-11,2,20,'#956343');rect(x-3,y-13,6,5,'#dbd2b6');rect(x-1,y-15,2,3,PAL.white)}else if(item==='hatchet'){rect(x-1,y-8,3,18,'#8f5d41');rect(x-7,y-11,11,6,'#8c9091');rect(x-5,y-10,7,2,'#b3b5ab')}else if(item==='torch'){rect(x-1,y-6,3,15,'#8f5d41');rect(x-4,y-12,9,8,'#eb6d36');rect(x-2,y-15,5,8,'#ffbd45')}else if(item==='berry'){drawBush(x,y+2,true)}else if(item==='bandage'){rect(x-8,y-5,16,10,'#e5d7b4');rect(x-3,y-7,6,14,'#c9bd9f');rect(x-6,y-1,12,2,'#efe3c5')}}
  function buildMiniMap(m){const c=document.createElement('canvas');c.width=m.w;c.height=m.h;const x=c.getContext('2d');for(let yy=0;yy<m.h;yy++)for(let xx=0;xx<m.w;xx++){const t=m.terrain[yy*m.w+xx];x.fillStyle=t===TILE.WATER?PAL.water:t===TILE.FOREST?PAL.deep:t===TILE.PATH?PAL.path:t===TILE.BRIDGE?'#8b5e46':t===TILE.RUINS?PAL.stone:PAL.grass;x.fillRect(xx,yy,1,1)}return c}
  function drawMiniMap(){const x=W-108,y=10,w=98,h=90;rect(x-3,y-3,w+6,h+6,PAL.ink);rect(x-1,y-1,w+2,h+2,PAL.cream);rect(x,y,w,h,PAL.deep);ctx.drawImage(mapCache,x+8,y+5,80,80);for(const a of game.altars||[]){const c=a.status==='claimed'?'#6a6a62':PAL.red;rect(x+8+a.x-1,y+5+a.y-1,3,3,c)}rect(x+8+game.gate.x-1,y+5+game.gate.y-1,3,3,PAL.gold);for(const p of game.players||[]){rect(x+8+p.x/map.ts-1,y+5+p.y/map.ts-1,3,3,p.id===game.selfId?PAL.white:'#e07e65')}pixelText('N',x+w/2,y-1,7,PAL.white,'center')}

  function contextTarget(){
    if(!game)return null;const p=game.self;
    for(const q of game.players||[])if(q.id!==p.id&&q.downed&&Math.hypot(q.x-p.x,q.y-p.y)<34)return `E • REVIVE ${q.name.toUpperCase()}`;
    for(const a of game.altars||[]){if(Math.hypot(a.x*map.ts+8-p.x,a.y*map.ts+8-p.y)<42){if(a.status==='dormant')return `E • AWAKEN ${a.label.toUpperCase()}`;if(a.status==='cleansed')return 'E • TAKE MOON SHARD';if(a.status==='awakened')return 'DEFEAT THE ALTAR GUARDIANS';return 'THE ALTAR IS EMPTY';}}
    if(Math.hypot(game.gate.x*map.ts+8-p.x,game.gate.y*map.ts+8-p.y)<46)return game.shards<3?`OLD GATE • SHARDS ${game.shards}/3`:(game.gateDefense?'THE GATE IS OPENING':'E • OPEN THE OLD GATE');
    let best=null,bd=30;for(const r of game.resources||[]){const d=Math.hypot(r.x-p.x,r.y-p.y);if(d<bd){bd=d;best=r}}if(best)return `E • GATHER ${best.kind.toUpperCase()}`;
    return null;
  }
  function drawContextHint(){const t=contextTarget();if(!t)return;const w=Math.min(260,t.length*6+20),x=W/2-w/2,y=H-73;rect(x-2,y-2,w+4,16,PAL.ink);rect(x,y,w,12,'rgba(33,43,48,.9)');pixelText(t,W/2,y+2,7,PAL.cream,'center')}

  function drawBigMap(){if(!game||!mapCache)return;bctx.clearRect(0,0,320,320);bctx.imageSmoothingEnabled=false;bctx.drawImage(mapCache,0,0,320,320);for(const a of game.altars||[]){bctx.fillStyle=a.status==='claimed'?'#77776d':'#db4f4d';bctx.fillRect(a.x*4-4,a.y*4-4,9,9)}bctx.fillStyle='#f6c34a';bctx.fillRect(game.gate.x*4-4,game.gate.y*4-4,9,9);for(const p of game.players||[]){bctx.fillStyle=p.id===game.selfId?'#fff2c8':'#ef8f70';bctx.fillRect(p.x/map.ts*4-3,p.y/map.ts*4-3,7,7)}}

  function drawTitleScene(){
    rect(0,0,W,H,'#15384a');
    // meadow
    rect(0,0,W,H,PAL.grass);for(let y=0;y<H;y+=16)for(let x=0;x<W;x+=16)drawGroundTile(TILE.GRASS,x,y,x/16,y/16,nowTime);
    // river at right and waterfall suggestion
    for(let y=0;y<H;y+=16){drawGroundTile(TILE.WATER,490,y,30,y/16,nowTime);drawGroundTile(TILE.WATER,506,y,31,y/16,nowTime);drawGroundTile(TILE.WATER,522,y,32,y/16,nowTime)}
    rect(486,0,4,85,'#604b50');rect(538,0,5,86,'#604b50');rect(490,0,48,72,PAL.water2);for(let i=0;i<6;i++)rect(493+i*8,8+(i%2)*5,4,50,'#8bd0e5');
    // dense tree ring
    for(let x=-6;x<W;x+=20){drawTree(x,20,Math.floor(hash(x,1,titleSeed)*4));drawTree(x,330,Math.floor(hash(x,2,titleSeed)*4))}
    for(let y=55;y<330;y+=23){drawTree(0,y,2);drawTree(20,y+8,1);if(y>80)drawTree(580,y,3);drawTree(610,y+4,1)}
    // campsite
    drawTent(330,128);drawCampfire(326,210);drawBush(245,175,true);drawRock(420,230);drawWood(390,160);drawGate(140,175);
    const fake={id:'title',x:0,y:0,dir:'down',downed:false,color:0,selected:'torch'};const oldCam={...camera};camera.x=0;camera.y=0;const ox=W/2,oy=H/2; // manual player at scene center
    shadow(290,210,14);rect(286,210,4,5,'#2f2931');rect(292,210,4,5,'#3e3035');rect(285,202,12,10,'#745447');rect(286,198,10,6,'#d7a36f');rect(284,195,14,3,'#725343');rect(287,192,8,3,'#9c744d');
    // watcher in the treeline
    rect(128,94,10,22,'#101827');rect(125,98,16,10,'#101827');rect(130,98,2,2,'#f1d36b');rect(136,98,2,2,'#f1d36b');
    camera=oldCam;
    const g=ctx.createLinearGradient(0,0,0,H);g.addColorStop(0,'rgba(5,15,25,.05)');g.addColorStop(1,'rgba(5,15,25,.42)');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
    pixelText('v1.0.0',7,H-10,6,'#b9c1b0');
  }

  // installable app prompt
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;installBtn.classList.remove('hidden')});
  installBtn.addEventListener('click',async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;installBtn.classList.add('hidden')});
  if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('/sw.js').catch(()=>{});

  function loop(t){
    nowTime=t/1000;const dt=Math.min(.05,(t-lastFrame)/1000);lastFrame=t;
    if(!game)drawTitleScene();else renderWorld();
    requestAnimationFrame(loop);
  }

  connect(); requestAnimationFrame(loop);
})();

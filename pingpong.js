autowatch = 1;
inlets = 1;
outlets = 0;

var live_api = null;
var live_path = "live_set";
var running = false;
var recordingActive = false;
var hostIndex = -1, partnerIndex = -1;
var hostPath = "", partnerPath = "";
var slotA = -1, slotB = -1;
var tA = 0, tB = 0, cntA = 0, cntB = 0;
var taskA = null, taskB = null, taskBInit = null;
var transportPoll = null, lastIsPlaying = -1;

// recording length in BARS (1–32)
var recordBars = 8;

/*** logging ***/
function log() {
  try {
    var a = Array.prototype.slice.call(arguments).join(" ");
    post("[pingpong] " + a + "\n");
  } catch (e) {}
}

/*** helpers: safer LiveAPI usage ***/
function sp(p) { // set path safely; returns true if valid
  try {
    if (!live_api) return false;
    live_api.path = p;
    var id = live_api.id;
    if (id === null || id === undefined) return false;
    if (typeof id === "string") return id !== "0";
    return id !== 0;
  } catch (e) { return false; }
}
function getInt(prop) {
  try {
    var v = live_api.get(prop);
    if (Array.isArray(v)) v = v[v.length - 1];
    if (typeof v === "string") {
      var parts = v.trim().split(/\s+/);
      v = parts[parts.length - 1];
    }
    var n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  } catch (e) { return null; }
}
function getFloat(prop) {
  try {
    var v = live_api.get(prop);
    if (Array.isArray(v)) v = v[v.length - 1];
    if (typeof v === "string") {
      var parts = v.trim().split(/\s+/);
      v = parts[parts.length - 1];
    }
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  } catch (e) { return null; }
}
function setSafe(prop, val) {
  try {
    if (val === null || typeof val === "undefined") return;
    if (typeof val === "boolean") val = val ? 1 : 0;
    if (typeof val === "number" && isNaN(val)) return;
    live_api.set(prop, val);
  } catch (e) {}
}
function callSafe(msg) { try { live_api.call(msg); } catch (e) {} }

/*** quantization override helpers (stack-safe) ***/
// Temporarily force clip-trigger quantization to None while we fire, then restore.
var _qtStack = 0;
var _qtSaved = null;

function hasProp(prop) {
  try {
    var v = live_api.get(prop);
    return typeof v !== "undefined" && v !== null;
  } catch (e) { return false; }
}
function getClipTrigQuant() {
  if (!sp(live_path)) return null;
  if (hasProp("clip_trigger_quantization")) return getInt("clip_trigger_quantization");
  if (hasProp("quantization")) return getInt("quantization");
  return null;
}
function setClipTrigQuant(v) {
  if (!sp(live_path)) return;
  if (hasProp("clip_trigger_quantization")) setSafe("clip_trigger_quantization", v); // 0=None
  if (hasProp("quantization")) setSafe("quantization", v);
}
function pushNoQuant() {
  if (!sp(live_path)) return;
  if (_qtStack === 0) {
    _qtSaved = { ctq: hasProp("clip_trigger_quantization") ? getInt("clip_trigger_quantization") : null,
                 q:   hasProp("quantization") ? getInt("quantization") : null };
    setClipTrigQuant(0);
  }
  _qtStack++;
}
function popNoQuant() {
  if (!sp(live_path)) return;
  _qtStack = Math.max(0, _qtStack - 1);
  if (_qtStack === 0 && _qtSaved) {
    if (_qtSaved.ctq !== null && hasProp("clip_trigger_quantization")) setSafe("clip_trigger_quantization", _qtSaved.ctq);
    if (_qtSaved.q   !== null && hasProp("quantization"))             setSafe("quantization", _qtSaved.q);
    _qtSaved = null;
  }
}

/*** timing helpers (bars → milliseconds) ***/
function getTempo() {
  try {
    if (!sp(live_path)) return 120.0;
    var t = getFloat("tempo");
    return (t && t > 0) ? t : 120.0;
  } catch (e) { return 120.0; }
}
function getSigNum() {
  try {
    if (!sp(live_path)) return 4;
    var n = getInt("signature_numerator");
    return n || 4;
  } catch (e) { return 4; }
}
function getSigDen() {
  try {
    if (!sp(live_path)) return 4;
    var d = getInt("signature_denominator");
    return d || 4;
  } catch (e) { return 4; }
}
function ms_per_bar() {
  var tempo = getTempo();
  var num = getSigNum();
  var den = getSigDen();
  var beatsPerBar = num * (4.0 / den);
  var secPerBeat = 60.0 / tempo;
  var secPerBar = secPerBeat * beatsPerBar;
  return Math.max(1, Math.round(secPerBar * 1000.0));
}
function get_record_ms() {
  return Math.max(1, Math.round(ms_per_bar() * clampBars(recordBars)));
}
function clampBars(b) {
  b = (b|0);
  if (b < 1) b = 1;
  if (b > 32) b = 32;
  return b;
}

/*** public API ***/
function init(){ if(!live_api) live_api=new LiveAPI(); if(!live_api) return; sp(live_path); log("init"); }

function record(v){ v=v|0; if(v===1) start(); else stop_and_delete(); }

// Set recording length in bars (1–32). Messages: "bars 8", "length 8", "record_bars 8", "setbars 8"
function bars(v){
  var nv = clampBars(v|0);
  recordBars = nv;
  log("bars", nv);
  if (running && recordingActive) {
    if (taskA) { taskA.cancel(); taskA = null; }
    if (taskB) { taskB.cancel(); taskB = null; }
    if (taskBInit) { taskBInit.cancel(); taskBInit = null; }
    scheduleA(get_record_ms());
    scheduleBInit(Math.max(1, Math.round(get_record_ms()/2)));
  }
}
function length(v){ bars(v); }
function record_bars(v){ bars(v); }
function setbars(v){ bars(v); }

function keep(){
  if(!running) return;
  var now=Date.now();
  var aAge=(slotA>=0)?(now-tA):-1;
  var bAge=(slotB>=0)?(now-tB):-1;
  if(aAge>=bAge) keep_on("A"); else keep_on("B");
}

function start(){
  if(running) return;
  if(!live_api) init();
  if(!resolve_tracks()) { log("resolve_tracks failed"); return; }

  running=true;
  recordingActive=false;
  slotA=-1; slotB=-1; cntA=0; cntB=0; tA=0; tB=0;

  start_transport_watch();
  if(get_is_playing()===1) onTransportStarted();
}

/*** transport-aware scheduler ***/
function scheduleA(ms){
  if(taskA) taskA.cancel();
  var delay = (typeof ms === "number" && ms > 0) ? ms : get_record_ms();
  taskA=new Task(function(){
    if(!running||!recordingActive) return;
    relaunch_same_slot("A");
    scheduleA(get_record_ms());
  },this);
  taskA.schedule(delay);
}
function scheduleB(ms){
  if(taskB) taskB.cancel();
  var delay = (typeof ms === "number" && ms > 0) ? ms : get_record_ms();
  taskB=new Task(function(){
    if(!running||!recordingActive) return;
    relaunch_same_slot("B");
    scheduleB(get_record_ms());
  },this);
  taskB.schedule(delay);
}
function scheduleBInit(ms){
  if(taskBInit) taskBInit.cancel();
  var delay = (typeof ms === "number" && ms > 0) ? ms : Math.max(1, Math.round(get_record_ms()/2));
  taskBInit=new Task(function(){
    if(!running||!recordingActive) return;
    relaunch_same_slot("B");   // first stagger at L/2
    scheduleB(get_record_ms()); // then steady cadence of L
  },this);
  taskBInit.schedule(delay);
}

/*** core logic ***/
function resolve_tracks(){
  try{
    var dev=new LiveAPI("this_device");
    var devId=dev.id;
    sp(live_path);
    var n=parseInt(live_api.getcount("tracks"),10);
    var found=-1;
    for(var i=0;i<n;i++){
      var tp=live_path+" tracks "+i;
      if(!sp(tp)) continue;
      var nd=parseInt(live_api.getcount("devices"),10);
      for(var d=0;d<nd;d++){
        if(!sp(tp+" devices "+d)) continue;
        if(Number(live_api.id)===Number(devId)){found=i;break;}
      }
      if(found!==-1) break;
    }
    if(found===-1 || found+1>=n) return false;
    hostIndex=found; partnerIndex=found+1;
    hostPath=live_path+" tracks "+hostIndex;
    partnerPath=live_path+" tracks "+partnerIndex;
    log("host",hostIndex,"partner",partnerIndex);
    return true;
  }catch(e){ return false; }
}

function relaunch_same_slot(which){
  var tp=(which==="A")?hostPath:partnerPath;
  ensure_armed(tp);
  var idx=(which==="A")?slotA:slotB;

  if(idx<0){
    var nidx=next_empty_slot(tp);
    if(nidx<0){ abort_failure(); return; }
    var spath=tp+" clip_slots "+nidx;
    log("launch first", which, "slot", nidx);
    fire_now(spath, which);
    if(which==="A"){ slotA=nidx; tA=Date.now(); cntA+=1; tag_clip(spath,"A",cntA); }
    else { slotB=nidx; tB=Date.now(); cntB+=1; tag_clip(spath,"B",cntB); }
    return;
  }

  var spath2=tp+" clip_slots "+idx;
  if(sp(spath2)){
    callSafe("stop");
    var hc=getInt("has_clip");
    if(hc===1) callSafe("delete_clip");
  }
  log("relaunch", which, "slot", idx);
  fire_now(spath2, which);
  if(which==="A"){ tA=Date.now(); cntA+=1; tag_clip(spath2,"A",cntA); }
  else { tB=Date.now(); cntB+=1; tag_clip(spath2,"B",cntB); }
}

function keep_on(which){
  var tp=(which==="A")?hostPath:partnerPath;
  var idx=(which==="A")?slotA:slotB;
  if(idx<0) return;

  if(sp(tp+" clip_slots "+idx)) callSafe("stop");

  var next=next_empty_slot(tp);
  if(next<0) return;

  if(which==="A") slotA=next; else slotB=next;

  var spath=tp+" clip_slots "+next;
  log("keep→launch", which, "slot", next);
  fire_now(spath, which);
  if(which==="A"){ tA=Date.now(); cntA+=1; tag_clip(spath,"A",cntA); scheduleA(get_record_ms()); }
  else { tB=Date.now(); cntB+=1; tag_clip(spath,"B",cntB); if(taskBInit) taskBInit.cancel(); scheduleB(get_record_ms()); }
}

function ensure_armed(tp){
  try{
    if(!sp(tp)) return;
    var cba=getInt("can_be_armed");
    if(cba===1 && getInt("arm")===0) { setSafe("arm",1); log("armed", tp); }
  }catch(e){}
}

function next_empty_slot(tp){
  try{
    if(!sp(tp)) return -1;
    var n=parseInt(live_api.getcount("clip_slots"),10);
    for(var i=0;i<n;i++){
      var spath=tp+" clip_slots "+i;
      if(!sp(spath)) continue;
      if(getInt("has_clip")===0) return i;
    }
  }catch(e){}
  return -1;
}

// IMMEDIATE fire with temporary no-quant + one retry if Live ignores the first fire
function fire_now(slotPath, which){
  try{
    if(!sp(slotPath)) return;

    pushNoQuant();

    var doFire = function(){
      if (!sp(slotPath)) { popNoQuant(); return; }
      callSafe("fire");
      log("fire", which||"", "→", slotPath);

      var restore = new Task(function(){ popNoQuant(); }, this);
      restore.schedule(10);

      var verify = new Task(function(){
        if(!sp(slotPath)) return;
        var rec = getInt("is_recording");
        var hc  = getInt("has_clip");
        if(rec!==1 && hc===0){
          log("retry fire", which||"", "→", slotPath);
          pushNoQuant();
          callSafe("fire");
          var restore2 = new Task(function(){ popNoQuant(); }, this);
          restore2.schedule(10);
        }
      }, this);
      verify.schedule(40);
    };

    var def = new Task(doFire, this);
    def.schedule(1);

  }catch(e){}
}

function tag_clip(slotPath,which,count){
  var tries=0;
  var t=new Task(function(){
    try{
      if(!sp(slotPath)) return;

      var hc=getInt("has_clip");         // on ClipSlot
      var rec=getInt("is_recording");    // on ClipSlot

      if(hc===1 && sp(slotPath+" clip")){
        var nm=(which==="A"?"Ping A ":"Ping B ")+("000"+count).slice(-3);
        setSafe("name", nm);

        if(rec===0 || rec===null){
          setSafe("looping", 0);             // on Clip
          setSafe("launch_quantization", 0); // make manual relaunches immediate too
          return;
        }
      }

      tries += 1;
      if(tries < 80) t.schedule(50);
    }catch(e){}
  }, this);
  t.schedule(50);
}

function stop_and_delete(){
  running=false;
  recordingActive=false;
  cancel_all_tasks();
  stop_transport_watch();

  if(slotA>=0 && sp(hostPath+" clip_slots "+slotA)){
    var hcA=getInt("has_clip");
    var recA=getInt("is_recording");
    if(hcA===1){
      callSafe("stop");
      if(recA===1) callSafe("delete_clip");
    }
  }
  if(slotB>=0 && sp(partnerPath+" clip_slots "+slotB)){
    var hcB=getInt("has_clip");
    var recB=getInt("is_recording");
    if(hcB===1){
      callSafe("stop");
      if(recB===1) callSafe("delete_clip");
    }
  }
  slotA=-1; slotB=-1;
  log("stopped");
}

function abort_failure(){
  running=false;
  recordingActive=false;
  cancel_all_tasks();
  if(slotA>=0 && sp(hostPath+" clip_slots "+slotA)) callSafe("stop");
  if(slotB>=0 && sp(partnerPath+" clip_slots "+slotB)) callSafe("stop");
  slotA=-1; slotB=-1;
  log("abort_failure");
}

/*** transport watch ***/
function get_is_playing(){ try{ return (sp(live_path) ? (getInt("is_playing")|0) : 0); }catch(e){ return 0; } }

function start_transport_watch(){
  if(transportPoll) return;
  lastIsPlaying=get_is_playing();
  transportPoll=new Task(function watch(){
    var p=get_is_playing();
    if(p!==lastIsPlaying){
      lastIsPlaying=p;
      if(!running){ /* ignore */ }
      else if(p===1){ onTransportStarted(); }
      else { onTransportStopped(); }
    }
    if(running){ transportPoll.schedule(100); } else { transportPoll=null; }
  },this);
  transportPoll.schedule(1);
}

function stop_transport_watch(){ if(transportPoll){ transportPoll.cancel(); transportPoll=null; } }

// *** CHANGE HERE: launch BOTH lanes immediately, then stagger B by L/2 ***
function onTransportStarted(){
  if(!running) return;
  if(recordingActive){ log("transport started (already active)"); return; }
  recordingActive=true;
  log("transport started → immediate launch A+B");

  // Start both now so they're always recording
  relaunch_same_slot("A"); // t = 0
  relaunch_same_slot("B"); // t = 0

  // Then restart B at half interval and A at full interval
  scheduleBInit(Math.max(1, Math.round(get_record_ms()/2))); // t = L/2, then every L
  scheduleA(get_record_ms());                                 // t = L, then every L
}

function onTransportStopped(){
  if(!running) return;
  if(slotA>=0 && sp(hostPath+" clip_slots "+slotA)) callSafe("stop");
  if(slotB>=0 && sp(partnerPath+" clip_slots "+slotB)) callSafe("stop");
  recordingActive=false;
  cancel_all_tasks();
  log("transport stopped");
}

function cancel_all_tasks(){
  if(taskA){ taskA.cancel(); taskA=null; }
  if(taskB){ taskB.cancel(); taskB=null; }
  if(taskBInit){ taskBInit.cancel(); taskBInit=null; }
}

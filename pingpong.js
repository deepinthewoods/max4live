autowatch = 1;
inlets = 1;
outlets = 1;

// -------------------------
// State
// -------------------------
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

var recordBars = 8;

var mapMode = false;
var mappedDeviceId = -1;
var mappedDevicePath = "";
var mappedTrackKey = "";
var selectionPoll = null;

var DBG = 1;

// -------------------------
// Logging
// -------------------------
function log(){try{var a=[].slice.call(arguments).join(" ");post("[pingpong] "+a+"\n");}catch(e){}}
function dlog(){if(!DBG)return;try{var a=[].slice.call(arguments).join(" ");post("[pingpong][dbg] "+a+"\n");}catch(e){}}

// -------------------------
// LiveAPI helpers
// -------------------------
function sp(p){
    try{
        if(!live_api) return false;
        live_api.path = p;
        var id = live_api.id;
        return !(id===null||id===undefined||(typeof id==="string"?id==="0":id===0));
    }catch(e){ return false; }
}
function getInt(prop){
    try{
        var v = live_api.get(prop);
        if(Array.isArray(v)) v = v[v.length-1];
        if(typeof v==="string"){
            var parts = v.trim().split(/\s+/);
            v = parts[parts.length-1];
        }
        var n = parseInt(v,10);
        return isNaN(n)?null:n;
    }catch(e){ return null; }
}
function getFloat(prop){
    try{
        var v = live_api.get(prop);
        if(Array.isArray(v)) v = v[v.length-1];
        if(typeof v==="string"){
            var parts = v.trim().split(/\s+/);
            v = parts[parts.length-1];
        }
        var n = parseFloat(v);
        return isNaN(n)?null:n;
    }catch(e){ return null; }
}
function setSafe(prop,val){
    try{
        if(val===null||typeof val==="undefined") return;
        if(typeof val==="boolean") val = val?1:0;
        if(typeof val==="number"&&isNaN(val)) return;
        live_api.set(prop,val);
    }catch(e){}
}
function callSafe(msg){ try{ live_api.call(msg); }catch(e){} }
function hasProp(prop){ try{ var v=live_api.get(prop); return typeof v!=="undefined"&&v!==null; }catch(e){ return false; } }

// -------------------------
// Safe child counting (no getcount)
// -------------------------
function countChildren(basePath, collection, max){
    var limit = Math.max(1, (max|0) || 512);
    var c = 0;
    for(; c<limit; c++){
        if(!sp(basePath + " " + collection + " " + c)) break;
    }
    sp(basePath); // restore
    return c;
}

// -------------------------
// Quantization helpers (Song.clip_trigger_quantization ONLY)
// -------------------------
function getClipTrigQuant(){
    if(!sp(live_path)) return null;
    return getInt("clip_trigger_quantization");
}
function setClipTrigQuant(v){
    if(!sp(live_path)) return;
    setSafe("clip_trigger_quantization", v);
}
var _qtStack = 0;
var _qtSaved = null;
function pushNoQuant(){
    if(!sp(live_path)) return;
    if(_qtStack===0){
        _qtSaved = { ctq: getInt("clip_trigger_quantization") };
        setClipTrigQuant(0);
    }
    _qtStack++;
}
function popNoQuant(){
    if(!sp(live_path)) return;
    _qtStack = Math.max(0,_qtStack-1);
    if(_qtStack===0 && _qtSaved){
        if(_qtSaved.ctq!==null) setClipTrigQuant(_qtSaved.ctq);
        _qtSaved = null;
    }
}

// -------------------------
// Time / bars
// -------------------------
function getTempo(){ try{ if(!sp(live_path))return 120.0; var t=getFloat("tempo"); return (t&&t>0)?t:120.0; }catch(e){ return 120.0; } }
function getSigNum(){ try{ if(!sp(live_path))return 4; var n=getInt("signature_numerator"); return n||4; }catch(e){ return 4; } }
function getSigDen(){ try{ if(!sp(live_path))return 4; var d=getInt("signature_denominator"); return d||4; }catch(e){ return 4; } }

function ms_per_bar(){
    var tempo=getTempo();
    var num=getSigNum();
    var den=getSigDen();
    var beatsPerBar = num*(4.0/den);
    var secPerBeat = 60.0/tempo;
    var secPerBar  = secPerBeat*beatsPerBar;
    return Math.max(1, Math.round(secPerBar*1000.0));
}
function clampBars(b){ b=(b|0); if(b<1)b=1; if(b>32)b=32; return b; }
function get_record_ms(){ return Math.max(1, Math.round(ms_per_bar()*clampBars(recordBars))); }

// -------------------------
// Public API
// -------------------------
function init(){
    if(!live_api) live_api = new LiveAPI();
    if(!live_api) return;
    sp(live_path);
    outlet(0,"mapped",0);
    outlet(0,"mapping",0);
    outlet(0,"mapped_name","—");
    log("init","tempo",getTempo(),"sig",getSigNum()+"/"+getSigDen(),"bars",recordBars);
}
function record(v){ v=v|0; if(v===1) start(); else stop_and_delete(); }
function bars(v){
    var nv = clampBars(v|0);
    recordBars = nv;
    log("bars",nv);
    if(running && recordingActive){
        if(taskA){ taskA.cancel(); taskA=null; }
        if(taskB){ taskB.cancel(); taskB=null; }
        if(taskBInit){ taskBInit.cancel(); taskBInit=null; }
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
    dlog("keep ages A",aAge,"B",bAge);
    if(aAge>=bAge) keep_on("A"); else keep_on("B");
}

// -------------------------
// Engine
// -------------------------
function start(){
    if(running) return;
    if(!live_api) init();
    if(!resolve_tracks()){ log("resolve_tracks failed"); return; }
    running=true; recordingActive=false;
    slotA=-1; slotB=-1; cntA=0; cntB=0; tA=0; tB=0;
    start_transport_watch();
    if(get_is_playing()===1) onTransportStarted();
}

function scheduleA(ms){
    if(taskA) taskA.cancel();
    var delay = (typeof ms==="number"&&ms>0)?ms:get_record_ms();
    dlog("scheduleA",delay,"ms");
    taskA = new Task(function(){
        if(!running||!recordingActive) return;
        relaunch_same_slot("A");
        scheduleA(get_record_ms());
    }, this);
    taskA.schedule(delay);
}
function scheduleB(ms){
    if(taskB) taskB.cancel();
    var delay = (typeof ms==="number"&&ms>0)?ms:get_record_ms();
    dlog("scheduleB",delay,"ms");
    taskB = new Task(function(){
        if(!running||!recordingActive) return;
        relaunch_same_slot("B");
        scheduleB(get_record_ms());
    }, this);
    taskB.schedule(delay);
}
function scheduleBInit(ms){
    if(taskBInit) taskBInit.cancel();
    var delay = (typeof ms==="number"&&ms>0)?ms:Math.max(1,Math.round(get_record_ms()/2));
    dlog("scheduleBInit",delay,"ms");
    taskBInit = new Task(function(){
        if(!running||!recordingActive) return;
        relaunch_same_slot("B");
        scheduleB(get_record_ms());
    }, this);
    taskBInit.schedule(delay);
}

function resolve_tracks(){
    try{
        var dev = new LiveAPI("this_device");
        var devId = dev.id|0;
        sp(live_path);

        var nTracks = countChildren(live_path, "tracks", 1024);
        var found = -1;

        // Find the track that contains this device
        for (var i = 0; i < nTracks; i++) {
            var tp = live_path + " tracks " + i;
            var nDev = countChildren(tp, "devices", 256);
            for (var d = 0; d < nDev; d++) {
                var dp = tp + " devices " + d;
                if (!sp(dp)) continue;
                if ((live_api.id|0) === devId) { found = i; break; }
            }
            if (found !== -1) break;
        }

        // Device is on its own track at index `found`
        // Use the following two tracks as the ping/pong tracks
        if (found === -1 || (found + 2) >= nTracks) return false;

        hostIndex = found + 1;     // first ping/pong track
        partnerIndex = found + 2;  // second ping/pong track

        hostPath = live_path + " tracks " + hostIndex;
        partnerPath = live_path + " tracks " + partnerIndex;

        log("tracks device", found, "host", hostIndex, "partner", partnerIndex);
        return true;
    } catch(e) { 
        return false; 
    }
}


function relaunch_same_slot(which){
    var tp = (which==="A")?hostPath:partnerPath;
    ensure_armed(tp);
    var idx = (which==="A")?slotA:slotB;

    if(idx<0){
        var nidx = next_empty_slot(tp);
        if(nidx<0){ abort_failure(); return; }
        var spath = tp+" clip_slots "+nidx;
        log("launch first",which,"slot",nidx);
        fire_now(spath,which);
        if(which==="A"){ slotA=nidx; tA=Date.now(); cntA+=1; tag_clip(spath,"A",cntA); }
        else           { slotB=nidx; tB=Date.now(); cntB+=1; tag_clip(spath,"B",cntB); }
        return;
    }

    var spath2 = tp+" clip_slots "+idx;
    if(sp(spath2)){
        sp(spath2); callSafe("stop");
        sp(spath2); var hc = getInt("has_clip")|0;
        if(hc===1){ sp(spath2); callSafe("delete_clip"); }
    }
    log("relaunch",which,"slot",idx);
    fire_now(spath2,which);
    if(which==="A"){ tA=Date.now(); cntA+=1; tag_clip(spath2,"A",cntA); }
    else           { tB=Date.now(); cntB+=1; tag_clip(spath2,"B",cntB); }
}

function keep_on(which){
    var tp = (which==="A")?hostPath:partnerPath;
    var idx = (which==="A")?slotA:slotB;
    if(idx<0) return;

    var cur = tp+" clip_slots "+idx;
    if(sp(cur)) { sp(cur); callSafe("stop"); }

    var next = next_empty_slot(tp);
    if(next<0) return;

    if(which==="A") slotA=next; else slotB=next;

    var spath = tp+" clip_slots "+next;
    log("keep→launch",which,"slot",next);
    fire_now(spath,which);
    if(which==="A"){
        tA=Date.now(); cntA+=1; tag_clip(spath,"A",cntA); scheduleA(get_record_ms());
    }else{
        tB=Date.now(); cntB+=1; tag_clip(spath,"B",cntB);
        if(taskBInit) taskBInit.cancel();
        scheduleB(get_record_ms());
    }
}

function ensure_armed(tp){
    try{
        if(!sp(tp)) return;
        var cba = getInt("can_be_armed");
        if(cba===1 && getInt("arm")===0){
            setSafe("arm",1);
            log("armed",tp);
        }
    }catch(e){}
}
function next_empty_slot(tp){
    try{
        if(!sp(tp)) return -1;
        var n = countChildren(tp, "clip_slots", 4096);
        for(var i=0;i<n;i++){
            var spath = tp+" clip_slots "+i;
            if(!sp(spath)) continue;
            var hc = getInt("has_clip");
            if(hc===0) return i;
        }
    }catch(e){}
    return -1;
}

function push_then(fn){
    try{
        pushNoQuant();
        var t = new Task(function(){
            try{ fn(); }
            finally{
                var r = new Task(function(){ popNoQuant(); }, this);
                r.schedule(10);
            }
        }, this);
        t.schedule(1);
    }catch(e){}
}

function fire_now(slotPath,which){
    try{
        if(!sp(slotPath)) return;
        push_then(function(){
            if(!sp(slotPath)) return;
            callSafe("fire");
            log("fire",which||"","→",slotPath);
            var verify = new Task(function(){
                if(!sp(slotPath)) return;
                sp(slotPath);
                var rec = getInt("is_recording");
                var hc  = getInt("has_clip");
                if(rec!==1 && hc===0){
                    log("retry fire",which||"","→",slotPath);
                    push_then(function(){ if(sp(slotPath)) callSafe("fire"); });
                }
            }, this);
            verify.schedule(40);
        });
    }catch(e){}
}

function tag_clip(slotPath,which,count){
    var tries=0;
    var t = new Task(function(){
        try{
            if(!sp(slotPath)) return;
            var hc  = getInt("has_clip");
            var rec = getInt("is_recording");
            if(hc===1 && sp(slotPath+" clip")){
                var nm=(which==="A"?"Ping A ":"Ping B ")+("000"+count).slice(-3);
                setSafe("name", nm);
                if(rec===0 || rec===null){
                    setSafe("looping", 0);
                    // do not touch launch_quantization here
                    return;
                }
            }
            tries+=1;
            if(tries<80) t.schedule(50);
        }catch(e){}
    }, this);
    t.schedule(50);
}

function stop_and_delete(){
    running=false; recordingActive=false;
    cancel_all_tasks(); stop_transport_watch();

    if(slotA>=0){
        var pa = hostPath+" clip_slots "+slotA;
        if(sp(pa)){
            sp(pa); callSafe("stop");
            sp(pa); var hcA=getInt("has_clip"); var recA=getInt("is_recording");
            if(hcA===1 && recA===1){ sp(pa); callSafe("delete_clip"); }
        }
    }
    if(slotB>=0){
        var pb = partnerPath+" clip_slots "+slotB;
        if(sp(pb)){
            sp(pb); callSafe("stop");
            sp(pb); var hcB=getInt("has_clip"); var recB=getInt("is_recording");
            if(hcB===1 && recB===1){ sp(pb); callSafe("delete_clip"); }
        }
    }
    slotA=-1; slotB=-1;
    log("stopped");
}
function abort_failure(){
    running=false; recordingActive=false;
    cancel_all_tasks();
    if(slotA>=0 && sp(hostPath+" clip_slots "+slotA)) { sp(hostPath+" clip_slots "+slotA); callSafe("stop"); }
    if(slotB>=0 && sp(partnerPath+" clip_slots "+slotB)) { sp(partnerPath+" clip_slots "+slotB); callSafe("stop"); }
    slotA=-1; slotB=-1;
    log("abort_failure");
}

// -------------------------
// Transport watch
// -------------------------
function get_is_playing(){ try{ return (sp(live_path)?(getInt("is_playing")|0):0); }catch(e){ return 0; } }

function start_transport_watch(){
    if(transportPoll) return;
    lastIsPlaying = get_is_playing();
    transportPoll = new Task(function(){
        var p = get_is_playing();
        if(p!==lastIsPlaying){
            lastIsPlaying=p;
            if(!running){} else if(p===1){ onTransportStarted(); } else { onTransportStopped(); }
        }
        if(running){ transportPoll.schedule(100); } else { transportPoll=null; }
    }, this);
    transportPoll.schedule(1);
}
function stop_transport_watch(){
    if(transportPoll){ transportPoll.cancel(); transportPoll=null; }
}
function onTransportStarted(){
    if(!running) return;
    if(recordingActive){ log("transport started (already active)"); return; }
    recordingActive=true;
    log("transport started → launch A+B");
    relaunch_same_slot("A");
    relaunch_same_slot("B");
    scheduleBInit(Math.max(1,Math.round(get_record_ms()/2)));
    scheduleA(get_record_ms());
}
function onTransportStopped(){
    if(!running) return;
    if(slotA>=0 && sp(hostPath+" clip_slots "+slotA)) { sp(hostPath+" clip_slots "+slotA); callSafe("stop"); }
    if(slotB>=0 && sp(partnerPath+" clip_slots "+slotB)) { sp(partnerPath+" clip_slots "+slotB); callSafe("stop"); }
    recordingActive=false;
    cancel_all_tasks();
    log("transport stopped");
}
function cancel_all_tasks(){
    if(taskA){ taskA.cancel(); taskA=null; }
    if(taskB){ taskB.cancel(); taskB=null; }
    if(taskBInit){ taskBInit.cancel(); taskBInit=null; }
}

// -------------------------
// Mapping helpers (Sampler/Simpler targeting)
// -------------------------
function map(v){ v=v|0; if(v===1) enter_map_mode(); else unmap(); }
function unmap(){
    mapMode=false;
    stop_selection_watch();
    mappedDeviceId=-1;
    mappedDevicePath="";
    mappedTrackKey="";
    outlet(0,"mapping",0);
    outlet(0,"mapped",0);
    outlet(0,"mapped_name","—");
    log("unmapped");
}
function enter_map_mode(){
    mapMode=true;
    outlet(0,"mapping",1);
    outlet(0,"mapped",0);
    outlet(0,"mapped_name","Select a device on the current track…");
    log("map mode on");
    start_selection_watch();
}

function start_selection_watch(){
    if(selectionPoll) return;
    selectionPoll = new Task(function(){
        try{
            if(!mapMode){ stop_selection_watch(); return; }
            var did = get_selected_device_id_via_track_view();
            dlog("poll selected device id", did===null?"null":did);
            if(did && did>0){
                var thisId = (new LiveAPI("this_device")).id|0;
                if(did !== thisId){
                    var pinfo = find_device_path_by_id(did);
                    if(pinfo){
                        if(is_sampler_like(pinfo.path)){
                            mappedDeviceId = did;
                            mappedDevicePath = pinfo.path;
                            mappedTrackKey = pinfo.track;
                            outlet(0,"mapping",0);
                            outlet(0,"mapped",1);
                            outlet(0,"mapped_name",device_label(mappedDevicePath));
                            log("mapped", device_label(mappedDevicePath));
                            mapMode = false;
                            stop_selection_watch();
                        }else{
                            outlet(0,"mapped_name","Not a Sampler/Simpler");
                        }
                    }else{
                        outlet(0,"mapped_name","Device not found");
                    }
                }
            }
        }catch(e){
            log("selection error", e);
            outlet(0,"mapped_name","Selection error");
        }
        if(mapMode) selectionPoll.schedule(150);
    }, this);
    selectionPoll.schedule(1);
}
function stop_selection_watch(){
    if(selectionPoll){ selectionPoll.cancel(); selectionPoll=null; dlog("selection watch stopped"); }
}

function get_selected_device_id_via_track_view(){
    try{
        var sv = new LiveAPI("live_set view");
        var st = sv.get("selected_track");
        var tid = parse_id(st);
        if(!tid || tid<=0) return null;

        var t = new LiveAPI("id " + tid);
        var viewId = parse_id(t.get("view"));
        if(!viewId || viewId<=0) return null;

        var tv = new LiveAPI("id " + viewId);
        var sd = tv.get("selected_device");
        var did = parse_id(sd);
        return (did && did>0) ? did : null;
    }catch(e){
        dlog("get_selected_device_id_via_track_view error", e);
        return null;
    }
}

function parse_id(val){
    try{
        if(val===null||typeof val==="undefined") return null;
        if(Array.isArray(val)){
            for(var i=0;i<val.length;i++){
                var s=(""+val[i]).toLowerCase();
                if(s==="id"&&i+1<val.length) return parseInt(val[i+1],10);
            }
        }
        var n=parseInt(val,10);
        return isNaN(n)?null:n;
    }catch(e){ return null; }
}
function getName(path){ try{ if(!sp(path))return""; var v=live_api.get("name"); return(""+v).toString(); }catch(e){ return""; } }
function getClassName(path){ try{ if(!sp(path))return""; var v=live_api.get("class_name"); return(""+v).toString(); }catch(e){ return""; } }
function is_sampler_like(path){
    var n=getName(path);
    var c=getClassName(path);
    var s=(n+" "+c).toLowerCase();
    dlog("is_sampler_like?",n,"class",c);
    return /sampler|simpler/.test(s);
}
function device_label(path){
    var n=getName(path)||"(unnamed)";
    return n+" ["+path+"]";
}

function find_device_path_by_id(id){
    if(!sp(live_path)) return null;
    dlog("search device id",id);
    var nT = countChildren(live_path, "tracks", 1024);
    for(var t=0;t<nT;t++){
        var base=live_path+" tracks "+t;
        var res=find_in_container_for_id(base,id);
        if(res){ dlog("found in track",t); return{track:"track:"+t,path:res}; }
    }
    var nR = countChildren(live_path, "return_tracks", 256);
    for(var r=0;r<nR;r++){
        var baseR=live_path+" return_tracks "+r;
        var resR=find_in_container_for_id(baseR,id);
        if(resR){ dlog("found in return",r); return{track:"return:"+r,path:resR}; }
    }
    var baseM=live_path+" master_track";
    var resM=find_in_container_for_id(baseM,id);
    if(resM){ dlog("found in master"); return{track:"master",path:resM}; }
    return null;
}
function find_in_container_for_id(containerPath,id){
    try{
        if(!sp(containerPath)) return null;
        var nD = countChildren(containerPath, "devices", 256);
        for(var i=0;i<nD;i++){
            var dp=containerPath+" devices "+i;
            if(!sp(dp)) continue;
            if((live_api.id|0)===(id|0)) return dp;
            var deep=find_in_device_children_for_id(dp,id);
            if(deep) return deep;
        }
    }catch(e){ log("container search error",e); }
    return null;
}
function find_in_device_children_for_id(devicePath,id){
    try{
        if(!sp(devicePath)) return null;
        if((live_api.id|0)===(id|0)) return devicePath;

        // Only probe collections that actually exist, via safe counting
        var nC = countChildren(devicePath, "chains", 128);
        for(var c=0;c<nC;c++){
            var cp=devicePath+" chains "+c;
            var resC=find_in_container_for_id(cp,id);
            if(resC) return resC;
        }

        var nPads = countChildren(devicePath, "drum_pads", 128);
        for(var p=0;p<nPads;p++){
            var pp=devicePath+" drum_pads "+p;
            if(!sp(pp)) continue;
            var nPC = countChildren(pp, "chains", 128);
            for(var k=0;k<nPC;k++){
                var pcp=pp+" chains "+k;
                var resP=find_in_container_for_id(pcp,id);
                if(resP) return resP;
            }
        }
    }catch(e){ log("device children search error",e); }
    return null;
}

// -------------------------
// Targeted parameter set
// -------------------------
function target_set_param_by_name(paramName,value){
    if(!mappedDevicePath||!sp(mappedDevicePath)){ log("no mapped device"); return; }
    var n = countChildren(mappedDevicePath, "parameters", 512);
    for(var i=0;i<n;i++){
        var pp=mappedDevicePath+" parameters "+i;
        if(!sp(pp)) continue;
        var nm=(""+live_api.get("name")).toLowerCase();
        if(nm.indexOf(paramName.toLowerCase())!==-1){
            setSafe("value",value);
            log("set",paramName,"→",value);
            return;
        }
    }
    log("param not found",paramName);
}

// -------------------------
// Debug / status
// -------------------------
function debug(v){ v=(v|0); DBG=v?1:0; log("debug",DBG); }
function status(){
    log("status","running",running,"recordingActive",recordingActive,"bars",recordBars);
    log("host",hostIndex,"partner",partnerIndex,"slotA",slotA,"slotB",slotB);
    log("mapped",mappedDeviceId, mappedDevicePath||"(none)");
}

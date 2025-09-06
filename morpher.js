autowatch = 1;
inlets = 1;
outlets = 2;

var CHUNK_SIZE = 32;
var CHUNK_INTERVAL_MS = 2;
var MAX_SLOTS = 128;
var OBS_INTERVAL_MS = 300;
var EPS = 1e-6;

function toNum(x){ if(Array.isArray(x)) x = x[0]; var f = parseFloat(x); return (isFinite(f)?f:null); }
function shallowClone(o){ var x={}; for(var k in o){ if(o.hasOwnProperty(k)) x[k]=o[k]; } return x; }
function markDirty(){ try { notifyclients(); } catch(e){} }

var NAME_EXCLUDE=["Program","Program Change","Preset","Init","Category","Bank"];
function shouldSkipName(n){
    n = (n||"").toString();
    for(var k=0;k<NAME_EXCLUDE.length;k++){
        if(n.toLowerCase()===NAME_EXCLUDE[k].toLowerCase()) return true;
    }
    return false;
}

var LINK_ON = 0;
var linkParamId = 0;
var linkDeviceId = 0;

var target = {
    id: 0,
    path: "",
    name: "",
    className: "",
    paramIds: [],
    paramNames: [],
    quant: [],
    byName: {}
};
var sets = new Array(MAX_SLOTS); for(var i=0;i<MAX_SLOTS;i++) sets[i]=null;

var currentSlot = 0;
var PARTIAL_MODE = 0;
var partialIdxs = null;
var partialVersion = 0;

function sigKeyOf(t){
    if(!t) return "";
    return String(t.className||"") + "||" + (t.paramNames||[]).join("\x1f");
}
var lastSigKey = "";

var paramCache = {};
var lastWrite  = {};
function resetCaches(){ paramCache = {}; lastWrite = {}; }
function getParamObj(id){
    var o = paramCache[id];
    if(!o || o.id!==id){
        o = new LiveAPI("id "+id);
        paramCache[id] = o;
    }
    return o;
}

var POWER_NAMES = ["Device On","On/Off","Active","Power","Enabled","Bypass"];
var powerIdx = -1;
var powerId  = 0;
var powerOverride = null;

function locatePower(){
    powerIdx = -1; powerId = 0;
    if(!(target && target.paramNames)) return;
    for(var i=0;i<target.paramNames.length;i++){
        var nm = String(target.paramNames[i]||"");
        for(var j=0;j<POWER_NAMES.length;j++){
            if(nm.toLowerCase()===POWER_NAMES[j].toLowerCase()){
                powerIdx = i; powerId = target.paramIds[i]; recomputePowerGate(); return;
            }
        }
    }
    if(target.paramNames.length>0){
        var nm0 = String(target.paramNames[0]||"").toLowerCase();
        if(nm0.indexOf("device on")>=0 || nm0.indexOf("on/off")>=0 || nm0.indexOf("active")>=0){
            powerIdx = 0; powerId = target.paramIds[0];
        }
    }
    recomputePowerGate();
}

var writeQueue = [];
var queueIndex = 0;
var writerActive = false;

var writerTask = new Task(processQueue, this);
writerTask.interval = CHUNK_INTERVAL_MS;

function startWriter(){ if(writerActive) return; writerActive = true; writerTask.repeat(); }
function stopWriter(){ writerTask.cancel(); writerActive = false; }

function processQueue(){
    var n = 0;
    while(n < CHUNK_SIZE && queueIndex < writeQueue.length){
        var id = writeQueue[queueIndex][0];
        var v  = writeQueue[queueIndex][1];
        var force = (writeQueue[queueIndex][2] === 1);
        queueIndex++;
        if (typeof v !== "number" || !isFinite(v)) {
            continue;
        }
        try{
            var p = getParamObj(id);
            if(force || lastWrite[id]===undefined || Math.abs(lastWrite[id] - v) > EPS){
                p.set("value", v);
                lastWrite[id] = v;
            }
        }catch(e){}
        n++;
    }
    if(queueIndex >= writeQueue.length) stopWriter();
}

function emitWriteQueueFromBuffer(buf, count){
    writeQueue.length = count;
    for(var i=0;i<count;i++) writeQueue[i] = buf[i];
    queueIndex = 0;
    if(count>0) startWriter();
}

var fullBufs = [[],[]], fullCap = [0,0], fullActive = 0;
var partBufs = [[],[]], partCap = [0,0], partActive = 0;

function ensureFullBuf(which, need){
    if(fullCap[which] < need){
        for(var i=fullCap[which]; i<need; i++) fullBufs[which][i] = [0,0,0];
        fullCap[which] = need;
    }
}
function ensurePartBuf(which, need){
    if(partCap[which] < need){
        for(var i=partCap[which]; i<need; i++) partBufs[which][i] = [0,0,0];
        partCap[which] = need;
    }
}

function sendLabel(text){ outlet(1, String(text||"")); }
function labelDevice(){
    var cnt = target && target.paramIds ? target.paramIds.length : 0;
    var nm  = (target && target.name && String(target.name).length) ? String(target.name) : "Device";
    sendLabel(nm + "(" + cnt + ")");
}
function labelMissing(){ sendLabel("Target not found"); }

function parseParentAndIndexFromPath(unquotedPath){
    try{
        var toks=(unquotedPath||"").trim().split(/\s+/), last=-1;
        for(var i=0;i<toks.length-1;i++){ if(toks[i]==="devices" && /^\d+$/.test(toks[i+1])) last=i; }
        if(last<0) return null;
        return { parentPath: toks.slice(0,last).join(" ").trim(), index: parseInt(toks[last+1],10) };
    }catch(e){ return null; }
}
function getDeviceCountForParentPath(parentPath){
    try{ var parent=new LiveAPI(); parent.path=parentPath; var gc=parent.getcount("devices"); if(typeof gc==="number" && isFinite(gc)) return gc; }catch(e){}
    var count=0;
    try{ for(var i=0;i<512;i++){ var d=new LiveAPI(); d.path=parentPath+" devices "+i; if(!d || d.id===0) break; count++; } }catch(e){}
    return count;
}

function buildTargetFromDevice(dev){
    if(!dev || dev.id===0) return null;
    var dname = "";
    try{ dname = dev.get("name"); if(Array.isArray(dname)) dname = dname[0] || ""; }catch(e){ dname=""; }
    if(!dname){ try{ dname = dev.get("class_display_name"); if(Array.isArray(dname)) dname = dname[0] || ""; }catch(e){} }
    var cdn = "";
    try{ cdn = dev.get("class_display_name"); if(Array.isArray(cdn)) cdn = cdn[0] || ""; }catch(e){ cdn = ""; }

    var total=0; try{ total = dev.getcount("parameters"); }catch(e){}
    var ids=[], names=[], byName={}, quant=[];

    for(var i=0;i<total;i++){
        var p = new LiveAPI(); p.path = (dev.unquotedpath||dev.path) + " parameters " + i;
        if(!p || p.id===0) continue;
        var pname = p.get("name"); if(Array.isArray(pname)) pname = pname[0] || "";
        if(shouldSkipName(pname)) continue;
        var isq = 0; try{ isq = p.get("is_quantized"); if(Array.isArray(isq)) isq=isq[0]||0; }catch(e){ isq=0; }
        var idx = ids.length;
        ids.push(p.id);
        names.push(pname);
        quant.push(isq?1:0);
        byName[pname] = { id:p.id, index: idx };
    }

    return { id: dev.id, path: dev.unquotedpath || dev.path, name: dname, className: cdn, paramIds: ids, paramNames: names, quant: quant, byName: byName };
}

function isMorphlingTarget(t){
    if(!t) return false;
    var nm = String(t.name||"").toLowerCase();
    if(nm.indexOf("morphling") >= 0) return true;
    var pn = t.paramNames || [];
    var hasMorph = false, hasSlot = false;
    for(var i=0;i<pn.length;i++){
        var s = String(pn[i]||"").toLowerCase();
        if(s === "morph") hasMorph = true;
        if(s === "slot")  hasSlot  = true;
    }
    return hasMorph && hasSlot;
}
function findParamIdByNameOnTarget(t, want){
    if(!t) return 0;
    want = String(want||"").toLowerCase();
    for(var i=0;i<(t.paramNames||[]).length;i++){
        if(String(t.paramNames[i]||"").toLowerCase() === want) return t.paramIds[i];
    }
    return 0;
}

function candidateToRightOfThisDevice(){
    try{
        var me = new LiveAPI("this_device");
        var parsed = parseParentAndIndexFromPath(me.unquotedpath);
        if(!parsed) return null;
        var parentPath = parsed.parentPath;
        var myIndex    = parsed.index;
        var count      = getDeviceCountForParentPath(parentPath);
        var i = myIndex + 1;
        for(; i<count; i++){
            var d = new LiveAPI(); d.path = parentPath + " devices " + i;
            var t = buildTargetFromDevice(d);
            if(!isMorphlingTarget(t)) break;
        }
        if(i >= count) return null;
        var dev = new LiveAPI(); dev.path = parentPath + " devices " + i;
        if(!dev || dev.id===0) return null;
        return buildTargetFromDevice(dev);
    }catch(e){ return null; }
}

function findLinkPartner(){
    try{
        var me = new LiveAPI("this_device");
        var parsed = parseParentAndIndexFromPath(me.unquotedpath);
        if(!parsed) return null;
        var parentPath = parsed.parentPath;
        var myIndex    = parsed.index;
        var count      = getDeviceCountForParentPath(parentPath);
        var i = myIndex + 1;
        for(; i<count; i++){
            var dA = new LiveAPI(); dA.path = parentPath + " devices " + i;
            var tA = buildTargetFromDevice(dA);
            if(!isMorphlingTarget(tA)) break;
        }
        if(i >= count) return null;
        i++;
        for(; i<count; i++){
            var dB = new LiveAPI(); dB.path = parentPath + " devices " + i;
            var tB = buildTargetFromDevice(dB);
            if(isMorphlingTarget(tB)){
                var pid = findParamIdByNameOnTarget(tB, "morph");
                if(pid){
                    return { deviceId: dB.id, morphParamId: pid };
                }
            }
        }
        return null;
    }catch(e){ return null; }
}

function resolveLinkPartner(){
    linkParamId = 0; linkDeviceId = 0;
    var info = findLinkPartner();
    if(info){
        linkParamId = info.morphParamId|0;
        linkDeviceId = info.deviceId|0;
    }
}

function updateLinkToggleUI(){
    try{
        var t = this.patcher.getnamed("linkbtn");
        if(t){
            var on = LINK_ON ? 1 : 0;
            t.message("set", on);
            if(on){ t.message("bgcolor", 0.24, 0.55, 0.28, 1.0); }
            else  { t.message("bgcolor", 0.23, 0.23, 0.23, 1.0); }
        }
    }catch(e){}
}

function sigOf(t){
    if(!t) return null;
    var names = (t.paramNames||[]).slice().sort();
    return { className: String(t.className||""), names: names };
}
function isSigSupersetOrEqual(candSig, refSig){
    if(!candSig || !refSig) return false;
    if(String(candSig.className||"") !== String(refSig.className||"")) return false;
    var need = {}; for(var i=0;i<refSig.names.length;i++) need[refSig.names[i]] = 1;
    for(var j=0;j<candSig.names.length;j++) if(need[candSig.names[j]]) delete need[candSig.names[j]];
    for(var k in need) if(need.hasOwnProperty(k)) return false;
    return true;
}

function bindTo(newTarget){
    target = newTarget || { id:0, path:"", name:"", className:"", paramIds:[], paramNames:[], quant:[], byName:{} };
    resetCaches();
    stopWriter(); writeQueue=[]; queueIndex=0;
    locatePower();
    if(target.id) labelDevice(); else labelMissing();
    updateSetButtonColor();
    invalidatePartial();
    updatePartialToggleUI();
    if(target.id){
        reindexAllSnapshots();
        rebuildUsedSlots();
        recomputePowerGate();
        ensureFullBuf(0, target.paramIds.length);
        ensureFullBuf(1, target.paramIds.length);
        try {
            for (var i=0;i<target.paramIds.length;i++){
                var pid = target.paramIds[i];
                var p = getParamObj(pid);
                var cur = toNum(p.get("value"));
                if (cur !== null) lastWrite[pid] = cur;
            }
        } catch(e){}
    }
}

function outStoreV2(n, map){
    var flat=["store", n, "v2"];
    for(var k in map){ if(map.hasOwnProperty(k)){
        var v = map[k];
        flat.push(k);
        flat.push(isFinite(v)?v:"nan");
    }}
    outlet(0, flat);
}
function outClearAll(){ outlet(0, ["clear"]); }

function loadset(){
    if(arguments.length < 2) return;
    var n = parseInt(arguments[0],10);
    if(!isFinite(n) || n<0 || n>=MAX_SLOTS) return;
    if(arguments.length>=3 && (""+arguments[1]).toLowerCase()==="v2"){
        var map = {};
        for(var i=2;i<arguments.length;i+=2){
            var name = arguments[i];
            var v    = (i+1<arguments.length)? arguments[i+1] : "nan";
            if(name===undefined || name===null) continue;
            name = String(name);
            if(v === "nan") continue;
            var f = parseFloat(v); if(!isFinite(f)) continue;
            map[name] = f;
        }
        sets[n] = { "__v":3, map: map, arr: null, arrSigKey: "", pvals: null, pver: 0 };
    }else{
        var arr=[];
        for(var j=1;j<arguments.length;j++){
            var s = arguments[j];
            if(s === "nan") arr.push(undefined);
            else { var f=parseFloat(s); arr.push(isFinite(f)?f:undefined); }
        }
        sets[n] = arr;
    }
    if(n===currentSlot) updateSetButtonColor();
    rebuildUsedSlots();
    recomputePowerGate();
    markDirty();
}

function snapshot(n){
    if(!isBound()) return;
    n = parseInt(n,10); if(!isFinite(n) || n<0 || n>=MAX_SLOTS) return;
    var names = target.paramNames, ids = target.paramIds, L = names.length;
    var map = {}, arr = new Array(L);
    for(var i=0;i<L;i++){
        try{
            var p = getParamObj(ids[i]);
            var v = toNum(p.get("value"));
            if(v!==null && v!==undefined){ map[names[i]] = v; arr[i] = v; }
            else { arr[i] = NaN; }
        }catch(e){ arr[i] = NaN; }
    }
    sets[n] = { "__v":3, map: map, arr: arr, arrSigKey: sigKeyOf(target), pvals: null, pver: 0 };
    outStoreV2(n, map);
    if(n===currentSlot) updateSetButtonColor();
    rebuildUsedSlots();
    recomputePowerGate();
    markDirty();
}

function reindexSnapshotToCurrentOrder(S){
    if(!S) return;
    if(S.__v===3 && S.map){
        var L = target.paramNames.length;
        var arr = new Array(L);
        for(var i=0;i<L;i++){
            var name = target.paramNames[i];
            var v = S.map.hasOwnProperty(name) ? S.map[name] : NaN;
            arr[i] = (isFinite(v)?v:NaN);
        }
        S.arr = arr;
        S.arrSigKey = sigKeyOf(target);
        S.pvals = null; S.pver = 0;
        return;
    }
    if(Array.isArray(S)){
        var Lmin = Math.min(S.length, target.paramNames.length);
        var arr2 = new Array(target.paramNames.length);
        for(var j=0;j<target.paramNames.length;j++){
            arr2[j] = (j<Lmin && isFinite(S[j])) ? S[j] : NaN;
        }
        var map = {};
        for(var k=0;k<Lmin;k++){ var vv=S[k]; if(isFinite(vv)) map[target.paramNames[k]]=vv; }
        var upgraded = { "__v":3, map: map, arr: arr2, arrSigKey: sigKeyOf(target), pvals: null, pver: 0 };
        return upgraded;
    }
}

function reindexAllSnapshots(){
    var key = sigKeyOf(target);
    for(var k=0;k<MAX_SLOTS;k++){
        var S = sets[k];
        if(!S) continue;
        if(S.__v===3){
            if(!(S.arr && S.arrSigKey === key)) reindexSnapshotToCurrentOrder(S);
        }else if(Array.isArray(S)){
            var up = reindexSnapshotToCurrentOrder(S);
            if(up) sets[k] = up;
        }
    }
    rebuildUsedSlots();
    recomputePowerGate();
}

function invalidatePartial(){
    partialIdxs = null;
    partialVersion++;
    for(var k=0;k<MAX_SLOTS;k++){
        var S = sets[k];
        if(S && S.__v===3){ S.pvals = null; S.pver = 0; }
    }
    partBufs[0].length = 0; partCap[0] = 0;
    partBufs[1].length = 0; partCap[1] = 0;
    partActive = 0;
}

function computePartialInfo(){
    invalidatePartial();
    if(!target || !target.paramNames) return;
    var L = target.paramNames.length;
    var key = sigKeyOf(target);
    var arrs = [];
    for(var k=0;k<MAX_SLOTS;k++){
        var S = sets[k]; if(!S) continue;
        if(S.__v===3){
            if(!(S.arr && S.arrSigKey===key)) reindexSnapshotToCurrentOrder(S);
            if(S.arr) arrs.push(S.arr);
        }else if(Array.isArray(S)){
            var up = reindexSnapshotToCurrentOrder(S);
            if(up){ sets[k]=up; if(up.arr) arrs.push(up.arr); }
        }
    }
    if(arrs.length <= 1){ return; }
    var idxs = [];
    for(var i=0;i<L;i++){
        var seen = NaN, have=false, changed=false;
        for(var a=0;a<arrs.length;a++){
            var v = arrs[a][i];
            if(!isFinite(v)) continue;
            if(!have){ seen=v; have=true; }
            else if(Math.abs(v - seen) > EPS){ changed=true; break; }
        }
        if(changed) idxs.push(i);
    }
    if(powerIdx >= 0 && idxs.indexOf(powerIdx) === -1){ idxs.push(powerIdx); }
    if(!idxs.length) return;
    partialIdxs = idxs;
    partialVersion++;
    for(var k2=0;k2<MAX_SLOTS;k2++){
        var S2 = sets[k2]; if(!S2 || S2.__v!==3 || !S2.arr) continue;
        var M = partialIdxs.length;
        var pv = new Array(M);
        for(var m=0;m<M;m++){
            var idx = partialIdxs[m];
            var v = S2.arr[idx];
            pv[m] = (isFinite(v)?v:NaN);
        }
        S2.pvals = pv;
        S2.pver = partialVersion;
    }
    ensurePartBuf(0, partialIdxs.length);
    ensurePartBuf(1, partialIdxs.length);
}

function ensurePvals(S){
    if(!S || S.__v!==3) return null;
    if(!(S.arr && Array.isArray(S.arr))) return null;
    if(!partialIdxs || !partialIdxs.length) return null;
    if(S.pvals && S.pver === partialVersion && S.pvals.length === partialIdxs.length) return S.pvals;
    var M = partialIdxs.length;
    var pv = new Array(M);
    for(var m=0;m<M;m++){
        var idx = partialIdxs[m];
        var v = S.arr[idx];
        pv[m] = (isFinite(v)?v:NaN);
    }
    S.pvals = pv;
    S.pver = partialVersion;
    return pv;
}

function ensureArrObj(idx){
    var S = sets[idx];
    if(!S) return null;
    if(S.__v===3){
        if(!(S.arr && S.arrSigKey===sigKeyOf(target))) reindexSnapshotToCurrentOrder(S);
        return S;
    }else if(Array.isArray(S)){
        var up = reindexSnapshotToCurrentOrder(S);
        if(up){ sets[idx]=up; return up; }
    }
    return null;
}

function isSnapshotPowered(idx){
    if(powerIdx<0) return false;
    var S = ensureArrObj(idx); if(!S || !S.arr) return false;
    var v = S.arr[powerIdx];
    return isFinite(v) && v > EPS;
}

function touchSnapshotsChanged(){ rebuildUsedSlots(); recomputePowerGate(); }

var usedSlots = [];
function rebuildUsedSlots(){
    usedSlots.length = 0;
    for (var i=0;i<MAX_SLOTS;i++) if (sets[i]) usedSlots.push(i);
}
function neighborsOf(pos){
    if (!usedSlots.length) return [-1,-1];
    var lo=0, hi=usedSlots.length-1;
    while (lo<=hi){
        var mid=(lo+hi)>>1;
        if (usedSlots[mid] < pos) lo=mid+1; else hi=mid-1;
    }
    var Ri = (lo < usedSlots.length) ? usedSlots[lo] : -1;
    var Li = (lo > 0) ? usedSlots[lo-1] : -1;
    return [Li, Ri];
}

var pGate = { firstOn:-1, lastOff:-1, T: Infinity };
function recomputePowerGate(){
    var F=-1, L=-1;
    for (var i=0;i<MAX_SLOTS;i++){ var S=sets[i]; if(S && isSnapshotPowered(i)){ F=i; break; } }
    if (F>=0){ for (var j=0;j<F;j++){ if(sets[j] && !isSnapshotPowered(j)) L=j; } }
    pGate.firstOn = F; pGate.lastOff = L; pGate.T = (F<0 ? Infinity : (L+1));
}
function remapPosForPowerCached(pos){
    if(powerIdx < 0) { powerOverride = null; return pos; }
    var g = pGate;
    if(!(isFinite(g.T))){ powerOverride = 0; return pos; }
    if(g.lastOff < 0){ powerOverride = 1; return pos; }
    var L = g.lastOff, T = g.T;
    if(pos < T){
        powerOverride = 0;
        return pos;
    }
    powerOverride = 1;
    var denom = (127 - T);
    if(denom <= 0) return pos;
    var mapped = L + (pos - T) * ((127 - L) / denom);
    if(mapped < 0) mapped = 0; else if(mapped > 127) mapped = 127;
    return mapped;
}

function maybePushPair(id, val, buf, k, force){
    if (typeof val !== "number" || !isFinite(val)) return k;
    if (!force && lastWrite[id] !== undefined && Math.abs(lastWrite[id]-val) <= EPS) return k;
    buf[k][0]=id; buf[k][1]=val; buf[k][2]=force?1:0; return k+1;
}

function emitFullFromArray(arr){
    if(!arr || !target) return;
    var ids=target.paramIds;
    var N = Math.min(arr.length, ids.length);
    var which = fullActive;
    ensureFullBuf(which, ids.length);
    var buf = fullBufs[which];
    var k=0;
    var force = (PARTIAL_MODE===0);
    for(var i=0;i<N;i++){
        var v = arr[i];
        if(powerOverride!==null && i===powerIdx) v = powerOverride;
        k = maybePushPair(ids[i], v, buf, k, force);
    }
    emitWriteQueueFromBuffer(buf, k);
    fullActive = 1 - fullActive;
}

function emitFullInterp(A, B, t){
    var ids=target.paramIds;
    var N = Math.min(A.length, B.length, ids.length);
    var which = fullActive;
    ensureFullBuf(which, ids.length);
    var buf = fullBufs[which];
    var k=0;
    var force = (PARTIAL_MODE===0);
    for(var i=0;i<N;i++){
        var a=A[i], b=B[i], val;
        if(!isFinite(a) || !isFinite(b)) val = isFinite(a) ? a : (isFinite(b) ? b : NaN);
        else{
            if(target.quant && target.quant[i]) val = (t<0.5)?a:b;
            else val = a + (b - a) * t;
        }
        if(powerOverride!==null && i===powerIdx) val = powerOverride;
        k = maybePushPair(ids[i], val, buf, k, force);
    }
    emitWriteQueueFromBuffer(buf, k);
    fullActive = 1 - fullActive;
}

function emitPartialFromPvals(Ap, Bp, t){
    var M = Math.min(Ap.length, Bp.length, partialIdxs.length);
    var which = partActive;
    ensurePartBuf(which, M);
    var buf = partBufs[which];
    var k=0;
    var force = false;
    for(var m=0;m<M;m++){
        var idx = partialIdxs[m];
        var a=Ap[m], b=Bp[m];
        if(!isFinite(a) || !isFinite(b)) continue;
        var val;
        if(target.quant && target.quant[idx]) val = (t<0.5)?a:b;
        else val = a + (b - a) * t;
        if(powerOverride!==null && idx===powerIdx) val = powerOverride;
        var id = target.paramIds[idx];
        k = maybePushPair(id, val, buf, k, force);
    }
    emitWriteQueueFromBuffer(buf, k);
    partActive = 1 - partActive;
}

function emitPartialStatic(Pp){
    var M = Math.min(Pp.length, partialIdxs.length);
    var which = partActive;
    ensurePartBuf(which, M);
    var buf = partBufs[which];
    var k=0;
    var force = false;
    for(var m=0;m<M;m++){
        var idx = partialIdxs[m];
        var v=Pp[m];
        if(powerOverride!==null && idx===powerIdx) v = powerOverride;
        var id = target.paramIds[idx];
        k = maybePushPair(id, v, buf, k, force);
    }
    emitWriteQueueFromBuffer(buf, k);
    partActive = 1 - partActive;
}

var morphTask = new Task(_morphExec, this);
var lastMorphV = -9999;
var pendingMorph = -1;
var morphScheduled = 0;

function morph(v){
    if(Array.isArray(v)) v=v[0];
    var f = parseFloat(v);
    if(!isFinite(f)) return;
    if (f === lastMorphV) return;
    pendingMorph = f;
    if(!morphScheduled){ morphTask.schedule(0); morphScheduled=1; }
}

function _morphExec(){
    var v = pendingMorph; pendingMorph = -1; morphScheduled=0; lastMorphV = v;
    if(LINK_ON && linkParamId){
        try{
            if (lastWrite[linkParamId]===undefined || Math.abs(lastWrite[linkParamId]-v)>EPS){
                var lp = getParamObj(linkParamId);
                lp.set("value", v);
                lastWrite[linkParamId] = v;
            }
        }catch(e){
            resolveLinkPartner();
        }
    }
    if(!isBound()) return;
    var t = v / 127.0;
    var pos = t * (MAX_SLOTS - 1);
    pos = remapPosForPowerCached(pos);
    var Lidx  = Math.floor(pos);
    var Ridx  = Math.ceil(pos);
    function ensureArrObj_local(idx){ return ensureArrObj(idx); }
    if(usedSlots.length===0) return;

    var pair = neighborsOf(pos);
    var Li = (pair[0]>=0)?pair[0]:-1;
    var Ri = (pair[1]>=0)?pair[1]:-1;

    if(Li<0 && Ri<0) return;
    if(Li>=0 && Ri<0){
        var SA = ensureArrObj_local(Li); if(!SA) return;
        if(PARTIAL_MODE && partialIdxs && partialIdxs.length){
            var Ap = ensurePvals(SA); if(Ap){ emitPartialStatic(Ap); return; }
        }
        emitFullFromArray(SA.arr); return;
    }
    if(Ri>=0 && Li<0){
        var SB = ensureArrObj_local(Ri); if(!SB) return;
        if(PARTIAL_MODE && partialIdxs && partialIdxs.length){
            var Bp = ensurePvals(SB); if(Bp){ emitPartialStatic(Bp); return; }
        }
        emitFullFromArray(SB.arr); return;
    }
    var SA = ensureArrObj_local(Li);
    var SB = ensureArrObj_local(Ri);
    if(!SA && !SB) return;
    if(SA && !SB){
        if(PARTIAL_MODE && partialIdxs && partialIdxs.length){
            var Ap2=ensurePvals(SA); if(Ap2){ emitPartialStatic(Ap2); return; }
        }
        emitFullFromArray(SA.arr); return;
    }
    if(SB && !SA){
        if(PARTIAL_MODE && partialIdxs && partialIdxs.length){
            var Bp2=ensurePvals(SB); if(Bp2){ emitPartialStatic(Bp2); return; }
        }
        emitFullFromArray(SB.arr); return;
    }
    if(Li===Ri){
        if(PARTIAL_MODE && partialIdxs && partialIdxs.length){
            var P=ensurePvals(SA); if(P){ emitPartialStatic(P); return; }
        }
        emitFullFromArray(SA.arr); return;
    }
    var segt = (pos - Li) / (Ri - Li);
    if(PARTIAL_MODE && partialIdxs && partialIdxs.length){
        var Ap3 = ensurePvals(SA);
        var Bp3 = ensurePvals(SB);
        if(Ap3 && Bp3){ emitPartialFromPvals(Ap3, Bp3, segt); return; }
    }
    emitFullInterp(SA.arr, SB.arr, segt);
}

function setSlot(v){
    var f = parseFloat(Array.isArray(v)?v[0]:v);
    if(!isFinite(f)) return;
    var idx = Math.round(f);
    if(idx > (MAX_SLOTS-1)) idx = Math.round((f/127)*(MAX_SLOTS-1));
    idx = (idx<0?0:(idx>MAX_SLOTS-1?MAX_SLOTS-1:idx)) | 0;
    currentSlot = idx;
    updateSetButtonColor();
    markDirty();
}

function haveSnapshotAt(idx){
    var S = sets[idx];
    if(!S) return false;
    if(S.__v===3){
        var arr = S.arr;
        if(arr && arr.length){ for(var i=0;i<arr.length;i++){ if(isFinite(arr[i])) return true; } }
        if(S.map){ for(var nm in S.map){ if(S.map.hasOwnProperty(nm) && isFinite(S.map[nm])) return true; } }
        return false;
    }
    if(Array.isArray(S)){
        for(var j=0;j<S.length;j++){ if(isFinite(S[j])) return true; }
        return false;
    }
    return false;
}

function updateSetButtonColor(){
    try{
        var has = haveSnapshotAt(currentSlot);
        var t = this.patcher.getnamed("setbtn");
        if (!t) return;
        var r = has ? 0.04 : 0.23;
        var g = has ? 0.25 : 0.23;
        var b = has ? 0.04 : 0.23;
        t.message("bgcolor", r, g, b, 1.0);
        t.message("activebgcolor", r, g, b, 1.0);
        try { t.message("bgoncolor", r, g, b, 1.0); } catch(e){}
        try { t.message("activebgoncolor", r, g, b, 1.0); } catch(e){}
    }catch(e){}
}

function resetSetTextMomentary(){
    try{
        var t = this.patcher.getnamed("setbtn");
        if(t){
            t.message("set", 0);
            updateSetButtonColor();
        }
    }catch(e){}
}

var obsTask = new Task(observe, this);
obsTask.interval = OBS_INTERVAL_MS;
var lastMissing = false;

function startObserver(){ obsTask.repeat(); }
function stopObserver(){ obsTask.cancel(); }

function observe(){
    if(!isBound()){
        var cand = candidateToRightOfThisDevice();
        if(cand){
            bindTo(cand);
            lastMissing = false;
            return;
        }
        if(!lastMissing){ labelMissing(); lastMissing = true; }
        return;
    }
    if(lastMissing){ labelDevice(); lastMissing = false; }
    var key = sigKeyOf(target);
    if(key !== lastSigKey){
        lastSigKey = key;
        reindexAllSnapshots();
        ensureFullBuf(0, target.paramIds.length);
        ensureFullBuf(1, target.paramIds.length);
        invalidatePartial();
        locatePower();
    }
    if(LINK_ON){
        if(!linkDeviceId || !linkParamId){
            resolveLinkPartner();
        }else{
            try{
                var dchk = new LiveAPI("id "+linkDeviceId);
                if(!dchk || dchk.id===0) resolveLinkPartner();
            }catch(e){ resolveLinkPartner(); }
        }
    }
}

function outClearAllAndRAM(){
    for(var i=0;i<MAX_SLOTS;i++) sets[i]=null;
    outClearAll();
    updateSetButtonColor();
    invalidatePartial();
    touchSnapshotsChanged();
    markDirty();
}

function handleSetPressed(){
    var cand = candidateToRightOfThisDevice();
    if(!cand){
        updateSetButtonColor();
        resetSetTextMomentary();
        return;
    }
    if(!target || !target.id){
        bindTo(cand);
        snapshot(currentSlot);
        computePartialInfo();
        resetSetTextMomentary();
        return;
    }
    var candSig = sigOf(cand);
    var curSig  = sigOf(target);
    if(isSigSupersetOrEqual(candSig, curSig)){
        bindTo(cand);
        snapshot(currentSlot);
        computePartialInfo();
        resetSetTextMomentary();
        return;
    }
    bindTo(cand);
    outClearAllAndRAM();
    snapshot(currentSlot);
    computePartialInfo();
    resetSetTextMomentary();
}

function updatePartialToggleUI(){
    try{
        var t = this.patcher.getnamed("partialbtn");
        if(t){
            var on = PARTIAL_MODE ? 1 : 0;
            t.message("set", on);
            if(on){ t.message("bgcolor", 0.24, 0.55, 0.28, 1.0); }
            else  { t.message("bgcolor", 0.23, 0.23, 0.23, 1.0); }
        }
    }catch(e){}
}

function pushAllParamsImmediatelyInFull(){
    if(!isBound()) return;
    if(isFinite(lastMorphV) && lastMorphV >= 0){
        pendingMorph = lastMorphV;
        _morphExec();
        return;
    }
    powerOverride = null;
    var S = ensureArrObj(currentSlot);
    if(S && S.arr){ emitFullFromArray(S.arr); }
}

function find(){ var cand = candidateToRightOfThisDevice(); if(cand) bindTo(cand); else labelMissing(); }
function msg_float(v){ morph(v); }
function list(){ if(arguments.length>0) morph(arguments[0]); }

function clearSlot(idx){
    idx = (isFinite(idx) ? (idx|0) : (currentSlot|0));
    if (idx < 0 || idx >= MAX_SLOTS) return;
    if (!sets[idx]) return;
    sets[idx] = null;
    outlet(0, ["delete", idx]);
    if (idx === currentSlot) updateSetButtonColor();
    invalidatePartial();
    touchSnapshotsChanged();
    markDirty();
}

function anything(){
    var a = arrayfromargs(messagename, arguments);
    if(a.length>0){
        var cmd = (""+a[0]).toLowerCase();
        if(cmd==="morph" && a.length>1)        morph(a[1]);
        else if(cmd==="slot" && a.length>1)    setSlot(a[1]);
        else if(cmd==="set")                   handleSetPressed();
        else if(cmd==="partial" && a.length>1){
            var prev = PARTIAL_MODE;
            PARTIAL_MODE = (parseInt(a[1],10)?1:0);
            updatePartialToggleUI();
            markDirty();
            if(prev===1 && PARTIAL_MODE===0){
                pushAllParamsImmediatelyInFull();
            }
        }
        else if(cmd==="chunksize" && a.length>1){
            var n = parseInt(a[1],10); if(isFinite(n) && n>0) CHUNK_SIZE = n;
        } else if(cmd==="chunkms" && a.length>1){
            var ms = parseInt(a[1],10); if(isFinite(ms) && ms>0){ CHUNK_INTERVAL_MS = ms; writerTask.interval = CHUNK_INTERVAL_MS; }
        } else if(cmd==="clear"){
            clearSlot(currentSlot);
        } else if(cmd==="clearall"){
            outClearAllAndRAM();
        } else if(cmd==="clear_slot"){
            var idx = (a.length > 1) ? parseInt(a[1],10) : currentSlot;
            clearSlot(idx);
        } else if(cmd==="link" && a.length>1){
            LINK_ON = (parseInt(a[1],10)?1:0);
            updateLinkToggleUI();
            if(LINK_ON) resolveLinkPartner(); else { linkParamId=0; linkDeviceId=0; }
            markDirty();
        }
    }
}

function bang(){
    init();
    find();
}
function msg_int(v){ if(v) find(); }

function init(){
    updateSetButtonColor();
    lastSigKey = sigKeyOf(target);
    startObserver();
    invalidatePartial();
    ensureFullBuf(0, target.paramIds.length||0);
    ensureFullBuf(1, target.paramIds.length||0);
    updatePartialToggleUI();
    updateLinkToggleUI();
    locatePower();
    if(LINK_ON) resolveLinkPartner();
}

// The "Clear" button sends 'clear' – make it per-slot.
function clear(){
    clearSlot(currentSlot);
}

// Optional: make "Clear All" explicit (your Clear All button sends 'clearall').
function clearall(){
    outClearAllAndRAM();
}


function isBound(){
    try{
        if(!target || !target.id) return false;
        var dev = new LiveAPI(); dev.path = target.path;
        if(!dev || dev.id===0) return false;
        if(dev.id !== target.id) return false;
        return true;
    }catch(e){ return false; }
}

function dump(){}

function getvalueof(){
    var out = { v:1, currentSlot: currentSlot|0, partial: !!PARTIAL_MODE, link: !!LINK_ON, sets:{} };
    for (var i=0; i<MAX_SLOTS; i++){
        var S = sets[i];
        if(!S) continue;
        if(S.__v===3 && S.map){
            out.sets[i] = { v:3, map: shallowClone(S.map) };
        } else if (Array.isArray(S)) {
            out.sets[i] = { v:2, arr: S.slice(0) };
        }
    }
    return JSON.stringify(out);
}

function setvalueof(payload){
    try{
        var obj = (typeof payload === "string") ? JSON.parse(payload) : payload;
        outClearAllAndRAM();
        if(obj && obj.sets){
            for (var k in obj.sets){
                var idx = parseInt(k,10);
                if(!isFinite(idx)) continue;
                var ent = obj.sets[k];
                if(ent && ent.v===3 && ent.map){
                    sets[idx] = { __v:3, map: ent.map, arr:null, arrSigKey:"", pvals:null, pver:0 };
                } else if (ent && ent.v===2 && Array.isArray(ent.arr)){
                    sets[idx] = ent.arr.slice(0);
                }
            }
        }
        currentSlot   = isFinite(obj && obj.currentSlot) ? (obj.currentSlot|0) : 0;
        PARTIAL_MODE  = (obj && obj.partial) ? 1 : 0;
        LINK_ON       = (obj && obj.link) ? 1 : 0;
        reindexAllSnapshots();
        computePartialInfo();
        updatePartialToggleUI();
        updateSetButtonColor();
        updateLinkToggleUI();
        if(LINK_ON) resolveLinkPartner();
    }catch(e){}
}

var live_api = null;
var live_path = "live_set";
var startTrack = 0;
var endTrack = -1;

function init() {
    try {
        if (!live_api) {
            live_api = new LiveAPI();
            if (!live_api) return;
        }
        live_api.path = live_path;
    } catch (e) {}
}

function setStartTrack(index) {
    if (typeof index === 'number' && index >= 0) startTrack = index;
}

function setEndTrack(index) {
    if (typeof index === 'number' && (index >= 0 || index === -1)) endTrack = index;
}

function endRecordPlay() {
    processRecordingClips("play");
}

function endRecordStop() {
    processRecordingClips("stop");
}

function endRecordRecord() {
    if (!live_api) return;
    live_api.path = live_path;
    var numTracks = 0;
    try { numTracks = parseInt(live_api.getcount("tracks")); } catch (e) { return; }
    var actualEndTrack = (endTrack === -1 || endTrack >= numTracks) ? numTracks - 1 : endTrack;
    if (startTrack > actualEndTrack) return;
    for (var i = startTrack; i <= actualEndTrack; i++) {
        try {
            var trackPath = live_path + " tracks " + i;
            live_api.path = trackPath;
            if (live_api.id === "0") continue;
            var numClipSlots = parseInt(live_api.getcount("clip_slots"));
            var recIndex = -1;
            for (var j = 0; j < numClipSlots; j++) {
                live_api.path = trackPath + " clip_slots " + j;
                var hasClip = parseInt(live_api.get("has_clip"));
                if (hasClip) {
                    live_api.path = trackPath + " clip_slots " + j + " clip";
                    var isRecording = parseInt(live_api.get("is_recording"));
                    if (isRecording === 1) { recIndex = j; break; }
                }
            }
            if (recIndex === -1) continue;
            var freeIndex = -1;
            for (var k = recIndex + 1; k < numClipSlots; k++) {
                live_api.path = trackPath + " clip_slots " + k;
                if (parseInt(live_api.get("has_clip")) === 0) { freeIndex = k; break; }
            }
            if (freeIndex === -1) {
                for (var k2 = 0; k2 < numClipSlots; k2++) {
                    live_api.path = trackPath + " clip_slots " + k2;
                    if (parseInt(live_api.get("has_clip")) === 0) { freeIndex = k2; break; }
                }
            }
            if (freeIndex === -1) continue;
            live_api.path = trackPath;
            var canArmed = parseInt(live_api.get("can_be_armed"));
            if (canArmed === 1 && parseInt(live_api.get("arm")) === 0) live_api.set("arm", 1);
            live_api.path = trackPath + " clip_slots " + freeIndex;
            live_api.call("fire");
        } catch (e) {}
    }
}

function undoRecord() {
    if (!live_api) return;
    live_api.path = live_path;
    var numTracks = 0;
    try { numTracks = parseInt(live_api.getcount("tracks")); } catch (e) { return; }
    var actualEndTrack = (endTrack === -1 || endTrack >= numTracks) ? numTracks - 1 : endTrack;
    if (startTrack > actualEndTrack) return;
    for (var i = startTrack; i <= actualEndTrack; i++) {
        try {
            var trackPath = live_path + " tracks " + i;
            live_api.path = trackPath;
            if (live_api.id === "0") continue;
            var numClipSlots = parseInt(live_api.getcount("clip_slots"));
            for (var j = 0; j < numClipSlots; j++) {
                live_api.path = trackPath + " clip_slots " + j;
                var hasClip = parseInt(live_api.get("has_clip"));
                if (hasClip) {
                    live_api.path = trackPath + " clip_slots " + j + " clip";
                    var isRecording = parseInt(live_api.get("is_recording"));
                    if (isRecording === 1) {
                        live_api.path = trackPath;
                        var canArmed = parseInt(live_api.get("can_be_armed"));
                        if (canArmed === 1 && parseInt(live_api.get("arm")) === 0) live_api.set("arm", 1);
                        live_api.path = trackPath + " clip_slots " + j;
                        live_api.call("delete_clip");
                        live_api.call("fire");
                    }
                }
            }
        } catch (e) {}
    }
}

function processRecordingClips(action) {
    if (!live_api) return;
    try {
        live_api.path = live_path;
        var numTracks = 0;
        try { numTracks = parseInt(live_api.getcount("tracks")); } catch (e) { return; }
        var actualEndTrack = (endTrack === -1 || endTrack >= numTracks) ? numTracks - 1 : endTrack;
        if (startTrack > actualEndTrack) return;
        for (var i = startTrack; i <= actualEndTrack; i++) {
            try {
                processTrack(i, action);
            } catch (e) {}
        }
    } catch (e) {}
}

function processTrack(trackIndex, action) {
    try {
        var trackPath = live_path + " tracks " + trackIndex;
        live_api.path = trackPath;
        var numClipSlots = parseInt(live_api.getcount("clip_slots"));
        for (var j = 0; j < numClipSlots; j++) {
            try {
                live_api.path = trackPath + " clip_slots " + j;
                var hasClip = parseInt(live_api.get("has_clip"));
                if (hasClip) {
                    live_api.path = trackPath + " clip_slots " + j + " clip";
                    var isRecording = parseInt(live_api.get("is_recording"));
                    if (isRecording === 1) {
                        if (action === "play") {
                            live_api.call("fire");
                        } else if (action === "stop") {
                            live_api.call("stop");
                        }
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
}

function anything() {
    var args = arrayfromargs(arguments);
    var msgName = args[0];
    if (msgName === "init") {
        init();
    } else if (msgName === "endRecordPlay") {
        endRecordPlay();
    } else if (msgName === "endRecordStop") {
        endRecordStop();
    } else if (msgName === "setStartTrack" && args.length > 1) {
        setStartTrack(parseInt(args[1]));
    } else if (msgName === "setEndTrack" && args.length > 1) {
        setEndTrack(parseInt(args[1]));
    } else if (msgName === "endRecordRecord") {
        endRecordRecord();
    } else if (msgName === "undoRecord") {
        undoRecord();
    }
}

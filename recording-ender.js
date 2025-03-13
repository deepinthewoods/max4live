// recording-ender.js
// Script for automatically ending loop recordings in Ableton Live 12
// This script will find any tracks currently recording and either play or stop them

// Declaring global variables
var live_api = null;
var live_path = "live_set";
var startTrack = 0;  // Default start track index
var endTrack = -1;   // Default end track index (-1 means all tracks)

// Called when the script is loaded
function init() {
    post("Recording Ender script initializing...\n");
    
    try {
        // Initialize Live API
        if (!live_api) {
            live_api = new LiveAPI();
            if (!live_api) {
                post("Error: Could not create Live API object\n");
                return;
            }
            post("Live API initialized\n");
        }
        
        // Set the initial path to the live_set
        live_api.path = live_path;
        post("Live set accessed successfully\n");
    } catch (e) {
        post("Error in initialization: " + e + "\n");
    }
    
    post("Recording Ender script initialized and ready\n");
    post("Current track range: " + startTrack + " to " + (endTrack === -1 ? "all" : endTrack) + "\n");
}

// Function to set the start track index
function setStartTrack(index) {
    if (typeof index === 'number' && index >= 0) {
        startTrack = index;
        post("Start track set to: " + startTrack + "\n");
    } else {
        post("Invalid start track index: " + index + ". Must be a non-negative number.\n");
    }
}

// Function to set the end track index
function setEndTrack(index) {
    if (typeof index === 'number') {
        if (index >= 0 || index === -1) {
            endTrack = index;
            post("End track set to: " + (endTrack === -1 ? "all" : endTrack) + "\n");
        } else {
            post("Invalid end track index: " + index + ". Must be a non-negative number or -1 for all tracks.\n");
        }
    } else {
        post("Invalid end track type. Must be a number.\n");
    }
}

// Function to end recording and play the clips
function endRecordPlay() {
    post("End and Play button pressed\n");
    processRecordingClips("play");
}

// Function to end recording and stop the clips
function endRecordStop() {
    post("End and Stop button pressed\n");
    processRecordingClips("stop");
}

// Shared function to process recording clips with the specified action
function processRecordingClips(action) {
    if (!live_api) {
        post("Error: Live API not initialized\n");
        return;
    }
    
    try {
        // Navigate to the live_set
        live_api.path = live_path;
        
        // Get the number of tracks
        var numTracks = 0;
        try {
            numTracks = parseInt(live_api.getcount("tracks"));
            post("Number of tracks: " + numTracks + "\n");
        } catch (e) {
            post("Error getting track count: " + e + "\n");
            return;
        }
        
        // Determine actual end track index
        var actualEndTrack = (endTrack === -1 || endTrack >= numTracks) ? numTracks - 1 : endTrack;
        
        // Validate track range
        if (startTrack > actualEndTrack) {
            post("Error: Start track (" + startTrack + ") is greater than end track (" + actualEndTrack + ")\n");
            return;
        }
        
        post("Processing tracks from " + startTrack + " to " + actualEndTrack + "\n");
        
        // Iterate through specified track range
        for (var i = startTrack; i <= actualEndTrack; i++) {
            try {
                // Navigate to the current track
                live_api.path = live_path + " tracks " + i;
                
                // Check if track exists and handle it
                if (live_api.id !== "0") {
                    processTrack(i, action);
                }
            } catch (e) {
                post("Error processing track " + i + ": " + e + "\n");
            }
        }
    } catch (e) {
        post("Error in processRecordingClips: " + e + "\n");
    }
}

// Process a single track to find recording clips
function processTrack(trackIndex, action) {
    try {
        // Set path to the track
        var trackPath = live_path + " tracks " + trackIndex;
        live_api.path = trackPath;
        
        // Get track name for better logging
        var trackName = live_api.get("name");
        
        // Get the number of clip slots in the track
        var numClipSlots = parseInt(live_api.getcount("clip_slots"));
        post("Track " + trackIndex + " (" + trackName + ") has " + numClipSlots + " clip slots\n");
        
        // Iterate through all clip slots in the track
        for (var j = 0; j < numClipSlots; j++) {
            try {
                // Navigate to the current clip slot
                live_api.path = trackPath + " clip_slots " + j;
                
                // Check if there's a clip in this slot
                var hasClip = parseInt(live_api.get("has_clip"));
                
                if (hasClip) {
                    // Navigate to the clip
                    live_api.path = trackPath + " clip_slots " + j + " clip";
                    
                    // Check if the clip is currently recording
                    var isRecording = parseInt(live_api.get("is_recording"));
                    
                    if (isRecording === 1) {
                        post("Found recording clip at track " + trackIndex + " (" + trackName + "), clip slot " + j + "\n");
                        
                        // Perform the appropriate action based on the parameter
                        if (action === "play") {
                            live_api.call("fire");
                            post("Ended recording and started playback for clip at track " + trackIndex + ", clip slot " + j + "\n");
                        } else if (action === "stop") {
                            live_api.call("stop");
                            post("Ended recording and stopped playback for clip at track " + trackIndex + ", clip slot " + j + "\n");
                        }
                    }
                }
            } catch (e) {
                post("Error processing clip slot " + j + " in track " + trackIndex + ": " + e + "\n");
            }
        }
    } catch (e) {
        post("Error in processTrack: " + e + "\n");
    }
}

// This is Max's message handling mechanism
function anything() {
    var args = arrayfromargs(arguments);
    var msgName = args[0];
    
    post("Received message: " + msgName + "\n");
    
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
    }
}
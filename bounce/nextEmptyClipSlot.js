/**
 * nextEmptyClipSlot.js
 * 
 * This script finds the next empty clip slot in the track this device is on and fires it.
 * If a clip is currently recording, it adjusts its start point based on dial setting.
 * For use in a Max for Live device.
 */
autowatch = 1;
// Outlets
// 0: next slot index (for display)
outlets = 1;

// Global variables
var originalQuantization = 0;
var startTimeOffset = 2; // Default to 2 seconds offset
var autoLaunch = false; // Whether to automatically launch clips

/**
 * When a bang is received, find and fire the next empty clip slot
 * If a clip is already recording, also adjust its start point
 */
function bang() {
    try {
        post("\n--- Next Empty Clip Slot Triggered ---\n");
        
        // Get the device's parent track
        var thisDevice = new LiveAPI("this_device");
        var track = new LiveAPI("this_device canonical_parent");
        var trackName = track.get("name");
        
        post("Device on track: " + trackName + "\n");
        
        // Check if any clip is currently recording on this track
        var recordingClipIndex = findRecordingClip(track);

		// Always find and fire the next empty clip slot, regardless of auto-launch setting
        post("Finding and firing next empty clip slot...\n");
        findAndFireNextEmptyClipSlot(track);
        
        // If a clip is recording, adjust its start point
        if (recordingClipIndex >= 0) {
            post("Adjusting start point for recording clip at index " + recordingClipIndex + "\n");
            adjustRecordingClipStartPoint(track, recordingClipIndex);
        } else {
            post("No recording clips found to adjust\n");
        }
        
        
    } catch (e) {
        post("Error in bang(): " + e.message + "\n");
        outlet(0, "Error");
    }
}

/**
 * Find if any clip is currently recording on the track
 * @param {LiveAPI} track - The track object
 * @returns {number} The index of the recording clip, or -1 if none found
 */
function findRecordingClip(track) {
    try {
        post("Checking for recording clips...\n");
        
        // Get the clip slots
        var clipSlots = track.get("clip_slots");
        var numClipSlots = clipSlots.length / 2;
        
        if (numClipSlots === 0) {
            post("No clip slots found on this track\n");
            return -1;
        }
        
        for (var i = 0; i < numClipSlots; i++) {
            // Create a path for each clip slot
            var clipSlotPath = "this_device canonical_parent clip_slots " + i;
            var clipSlot = new LiveAPI(clipSlotPath);
            
            // Check if this slot has a clip
            var hasClip = parseInt(clipSlot.get("has_clip"));
            
            if (hasClip === 1) {
                // Check if the clip is recording
                var clipPath = clipSlotPath + " clip";
                var clip = new LiveAPI(clipPath);
                var isRecording = parseInt(clip.get("is_recording"));
                
                post("Clip " + i + " recording status: " + isRecording + "\n");
                
                if (isRecording === 1) {
                    post("Found recording clip at index " + i + "\n");
                    return i;
                }
            }
        }
        
        post("No recording clips found\n");
        return -1; // No recording clip found
    } catch (e) {
        post("Error in findRecordingClip(): " + e.message + "\n");
        return -1;
    }
}

/**
 * Adjust the start point of a recording clip using beats instead of seconds
 * @param {LiveAPI} track - The track object
 * @param {number} clipIndex - The index of the recording clip
 */
function adjustRecordingClipStartPoint(track, clipIndex) {
    try {
        var clipPath = "this_device canonical_parent clip_slots " + clipIndex + " clip";
        var clip = new LiveAPI(clipPath);
		post("Clip index" + clipIndex);
        
        // Get the clip sample length (in samples)
        var sampleLength = parseFloat(clip.get("sample_length"));
        // Get the clip's sample rate
        var sampleRate = parseFloat(clip.get("sample_rate"));
        
        post("Clip sample length: " + sampleLength + " samples\n");
        post("Clip sample rate: " + sampleRate + " samples/second\n");
        
        // Get the tempo (in BPM)
        var song = new LiveAPI("live_set");
        var tempo = parseFloat(song.get("tempo"));
        post("Current tempo: " + tempo + " BPM\n");
        
        // Calculate beats per second
        var beatsPerSecond = tempo / 60;
        post("Beats per second: " + beatsPerSecond + "\n");
        
        // Convert offset in seconds to samples
        var offsetInSamples = startTimeOffset * sampleRate;
        post("Offset in samples: " + offsetInSamples + " (from " + startTimeOffset + " seconds)\n");
        
        // Calculate new start point in samples
        var startPointInSamples = Math.max(0, sampleLength - offsetInSamples);
        
        // Convert start point in samples to seconds
        var startPointInSeconds = startPointInSamples / sampleRate;
        
        // Calculate total clip length in seconds
        var totalClipTimeInSeconds = sampleLength / sampleRate;
        
        // Convert seconds to beats
        var startPointInBeats = startPointInSeconds * beatsPerSecond;
        var totalClipTimeInBeats = totalClipTimeInSeconds * beatsPerSecond;
        
        post("Total clip time: " + totalClipTimeInBeats.toFixed(2) + " beats\n");
        post("Setting clip start point to: " + startPointInBeats.toFixed(2) + " beats\n");
        
        // Set the start marker position in beats
        clip.set("start_marker", startPointInBeats);
        
        // Output the slot number (1-based for display)
        outlet(0, clipIndex + 1);
    } catch (e) {
        post("Error in adjustRecordingClipStartPoint(): " + e.message + "\n");
    }
}

/**
 * Find the next empty clip slot and fire it
 * @param {LiveAPI} track - The track object
 */
function findAndFireNextEmptyClipSlot(track) {
    try {
        // Get the clip slots
        var clipSlots = track.get("clip_slots");
        var numClipSlots = clipSlots.length / 2;
        
        // Check if there are any clip slots at all
        if (numClipSlots === 0) {
            post("Warning: No clip slots found in this track\n");
            outlet(0, "No slots");
            return;
        }
        
        post("Found " + numClipSlots + " clip slots\n");
        
        // Find the first empty clip slot
        var nextEmptyIndex = -1;
        
        for (var i = 0; i < numClipSlots; i++) {
            // We need to create a specific path for each clip slot
            var clipSlotPath = "this_device canonical_parent clip_slots " + i;
            var clipSlot = new LiveAPI(clipSlotPath);
            
            // Check if this slot has a clip
            var hasClip = clipSlot.get("has_clip");
            post("Slot " + i + " has_clip: " + hasClip + "\n");
            
            if (parseInt(hasClip) === 0) {
                nextEmptyIndex = i;
                post("Found empty slot at index " + i + "\n");
                break;
            }
        }
        
        if (nextEmptyIndex >= 0) {
            // Create a direct reference to the clip slot
            var clipSlotPath = "this_device canonical_parent clip_slots " + nextEmptyIndex;
            var clipSlotToFire = new LiveAPI(clipSlotPath);
            
            // Handle quantization settings (disable quantization temporarily)
            handleQuantization(clipSlotToFire);
            
            post("Firing clip slot " + (nextEmptyIndex + 1) + " using path: " + clipSlotPath + "\n");
            
            // Try different methods to ensure the clip firing works
            try {
                clipSlotToFire.call("fire");
                post("Fired clip slot using standard fire method\n");
            } catch (e) {
                post("Error with standard fire method: " + e.message + "\n");
                try {
                    // Alternative approach using just the slot index
                    var track = new LiveAPI("this_device canonical_parent");
                    track.call("fire_clip_slot", nextEmptyIndex);
                    post("Fired clip slot using track.fire_clip_slot method\n");
                } catch (e2) {
                    post("Error with fire_clip_slot method: " + e2.message + "\n");
                }
            }
            
            // Output the slot number (1-based for display)
            outlet(0, nextEmptyIndex + 1);
        } else {
            post("No empty clip slots found\n");
            outlet(0, "--");
        }
    } catch (e) {
        post("Error in findAndFireNextEmptyClipSlot(): " + e.message + "\n");
    }
}

/**
 * Set the start time offset value (received from the dial)
 * @param {number} timeInSeconds - Time offset in seconds
 */
function set_start_time(timeInSeconds) {
    // Only update if the value has changed
    if (startTimeOffset !== timeInSeconds) {
        startTimeOffset = timeInSeconds;
        post("Start time offset set to " + startTimeOffset + " seconds\n");
    }
}

/**
 * Set the auto-launch flag
 * @param {number} value - 1 to enable, 0 to disable
 */
function set_auto_launch(value) {
    autoLaunch = (value === 1);
    post("Auto-launch " + (autoLaunch ? "enabled" : "disabled") + "\n");
}

/**
 * Temporarily disables clip trigger quantization before firing a clip
 * @param {LiveAPI} clipSlot - The clip slot to fire
 */
function handleQuantization(clipSlot) {
    try {
        post("Temporarily disabling clip trigger quantization...\n");
        
        // Get the current global quantization setting
        var liveSet = new LiveAPI("live_set");
        originalQuantization = parseInt(liveSet.get("clip_trigger_quantization"));
        post("Current quantization setting: " + originalQuantization + "\n");
        
        // Disable quantization temporarily (set to None = 0)
        liveSet.set("clip_trigger_quantization", 0);
        post("Quantization disabled\n");
        
        // Schedule restoration of the original setting
        restoreQuantizationAfterDelay();
    } catch (e) {
        post("Error in handleQuantization: " + e.message + "\n");
    }
}

/**
 * Restores the original quantization setting after a delay
 */
function restoreQuantizationAfterDelay() {
    // Use the Max task object to schedule the restoration
    var task = new Task(function() {
        try {
            var liveSet = new LiveAPI("live_set");
            liveSet.set("clip_trigger_quantization", originalQuantization);
            post("Restored original quantization setting: " + originalQuantization + "\n");
        } catch (e) {
            post("Error restoring quantization: " + e.message + "\n");
        }
    }, this);
    
    // Schedule the task to run after 50ms
    task.schedule(50);
}

/**
 * Initialize the script
 */
function loadbang() {
    post("Next Empty Clip Slot device loaded\n");
    
    // Get and display the track name
    try {
        var track = new LiveAPI("this_device canonical_parent");
        var trackName = track.get("name");
        if (trackName) {
            outlet(0, trackName);
        }
        
        // Initialize with default settings
        post("Initializing with default settings\n");
        
        // Initialize the start time offset to 2 seconds
        startTimeOffset = 2;
        post("Initial start time offset: " + startTimeOffset + " seconds\n");
        
        // Initialize auto-launch to disabled
        autoLaunch = false;
        post("Initial auto-launch setting: " + (autoLaunch ? "enabled" : "disabled") + "\n");
    } catch (e) {
        post("Error in loadbang: " + e.message + "\n");
    }
}

// Initialize on load
loadbang();
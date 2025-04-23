/*
 * Instrument Switcher
 * This script toggles power buttons for instruments in a rack based on user selection
 * Fixed to properly observe rack changes
 */

inlets = 1;
outlets = 1;

var devicePath;
var rack;
var selectedInstrument = 0;
var previousInstrument = -1;
var totalInstruments = 0;
var instruments = [];
var maxObj = null;
var live_api = null;
var live_observer = null;
var isInitialized = false;
var isRefreshing = false;

// Initialize when the script loads
function loadbang() {
    post("Script loaded\n");
    // Try to find the comment object
    try {
        maxObj = this.patcher.getnamed("status_display");
    } catch (e) {
        post("Cannot get status_display object: " + e.message + "\n");
    }
    
    displayStatus("Ready. Press Refresh after modifying the rack.");
    
    // Initialize the LiveAPI
    initializeLiveAPI();
}

// Initialize the Live API
function initializeLiveAPI() {
    try {
        if (!live_api) {
            live_api = new LiveAPI();
            post("LiveAPI initialized\n");
        }
    } catch (e) {
        post("Error initializing LiveAPI: " + e.message + "\n");
    }
}

// The callback function that gets triggered when the rack changes
// This must be a named function to work properly with the LiveAPI observer
function liveApiCallback(args) {
    // Filter out id and path change notifications
    if (args[0] === "id" || args[0] === "path") {
        return;
    }
    
    post("LiveAPI callback received: " + args.join(" ") + "\n");
    
    if (!isRefreshing) {
        post("Change detected in rack, refreshing...\n");
        
        // Use a small delay to avoid immediate refresh during API operations
        // which can cause crashes or race conditions
        var task = new Task(function() {
            refreshRack();
        });
        task.schedule(100); // 100ms delay
    }
}

// Display status messages
function displayStatus(msg) {
    post("Status: " + msg + "\n");
    if (maxObj) {
        try {
            maxObj.message("set", msg);
        } catch (e) {
            post("Error setting status message: " + e.message + "\n");
        }
    }
}

// Handle incoming messages
function anything() {
    var a = arrayfromargs(messagename, arguments);
    post("Received message: " + a.join(" ") + "\n");
    
    // Make sure LiveAPI is initialized
    initializeLiveAPI();
    
    if (a[0] === "getpath" && a[1] === "this_device") {
        post("Setting up rack control\n");
        setupRackControl();
    } else if (a[0] === "select" && a.length > 1) {
        // Handle instrument selection
        var index = parseInt(a[1]);
        if (!isNaN(index) && index >= 0) {
            selectInstrument(index);
        }
    } else {
        // Treat as refresh button press
        post("Refreshing rack\n");
        setupRackControl(); // First make sure we have the rack
        refreshRack();
    }
    
    // Send a bang out to confirm processing
    outlet(0, "bang");
}

// Set up control of the rack
function setupRackControl() {
    try {
        if (!live_api) {
            initializeLiveAPI();
            if (!live_api) {
                displayStatus("Error: Could not initialize Live API");
                return;
            }
        }
        
        // Get this device's path
        live_api.path = "this_device";
        devicePath = live_api.path;
        post("This device path: " + devicePath + "\n");
        
        // Look for the instrument rack that follows this device
        live_api.goto("canonical_parent");
        var trackPath = live_api.path;
        post("Track path: " + trackPath + "\n");
        
        var deviceCount = live_api.getcount("devices");
        post("Total devices in track: " + deviceCount + "\n");
        
        // Reset to track
        live_api.path = trackPath;
        
        // Find this device's index
        var thisDeviceId = -1;
        for (var i = 0; i < deviceCount; i++) {
            live_api.path = trackPath;
            live_api.goto("devices", i);
            post("Checking device " + i + ": " + live_api.path + "\n");
            
            if (live_api.path === devicePath) {
                thisDeviceId = i;
                post("Found this device at index: " + thisDeviceId + "\n");
                break;
            }
        }
        
        if (thisDeviceId >= 0 && thisDeviceId < deviceCount - 1) {
            // Go to the next device which should be the instrument rack
            live_api.path = trackPath;
            live_api.goto("devices", thisDeviceId + 1);
            
            var nextDeviceClass = live_api.get("class_name");
            post("Next device class: " + nextDeviceClass + "\n");
            
            // Check if it's an instrument rack
            if (nextDeviceClass[0] === "InstrumentGroupDevice" || 
                nextDeviceClass[0] === "RackDevice" || 
                nextDeviceClass[0] === "InstrumentRack") {
                rack = live_api.path;
                
                // Now we've found the rack - set up observation
                setupRackObserver();
                
                displayStatus("Found instrument rack. Press Refresh to initialize.");
                isInitialized = true;
            } else {
                displayStatus("Error: Device after this one is not an instrument rack!");
            }
        } else {
            displayStatus("Error: This device must be directly before an instrument rack!");
        }
    } catch (e) {
        post("Setup error: " + e.message + "\n");
        displayStatus("Setup error: " + e.message);
    }
}

// Set up observation of the rack
function setupRackObserver() {
    // First clean up any existing observer
    if (live_observer) {
        delete live_observer;
        live_observer = null;
    }
    
    try {
        // Create a new LiveAPI object specifically for observing
        live_observer = new LiveAPI(liveApiCallback);
        
        if (rack) {
            // Set the path to the rack we want to observe
            live_observer.path = rack;
            post("Observer set to path: " + live_observer.path + "\n");
            
            // Make sure this is indeed a rack
            var canHaveChains = live_observer.get("can_have_chains");
            if (canHaveChains && canHaveChains[0] === 1) {
                // Setup the actual observer for two key properties
                // that might change when rack instruments change
                live_observer.property = "chains"; // Will fire when chains are added/removed
                post("Observing chains property\n");
                
                // The observer is now active and will call liveApiCallback
                // when changes occur to the observed properties
            } else {
                post("Warning: Selected device cannot have chains\n");
            }
        } else {
            post("Cannot setup observer - no rack path available\n");
        }
    } catch (e) {
        post("Error setting up rack observer: " + e.message + "\n");
    }
}

// Get the number of chains in the rack
function getChainCount() {
    try {
        live_api.path = rack;
        var count = live_api.getcount("chains");
        post("Chain count: " + count + "\n");
        return count;
    } catch (e) {
        post("Error getting chain count: " + e.message + "\n");
        return 0;
    }
}

// Refresh the rack information
function refreshRack() {
    if (!rack) {
        displayStatus("Error: No instrument rack found!");
        return;
    }
    
    // Prevent recursive refreshes
    if (isRefreshing) {
        post("Already refreshing, ignoring request\n");
        return;
    }
    
    isRefreshing = true;
    
    try {
        // Go to the rack
        live_api.path = rack;
        
        // Get all chains in the rack
        instruments = [];
        try {
            var chainCount = getChainCount();
            totalInstruments = chainCount;
            post("Found " + chainCount + " chains in the rack\n");
            displayStatus("Found " + chainCount + " instruments in the rack");
            
            // For each chain, get its devices
            for (var i = 0; i < chainCount; i++) {
                try {
                    live_api.path = rack;
                    live_api.goto("chains", i);
                    
                    var chainDevices = [];
                    var deviceCount = live_api.getcount("devices");
                    post("Chain " + i + " has " + deviceCount + " devices\n");
                    
                    for (var j = 0; j < deviceCount; j++) {
                        try {
                            live_api.path = rack;
                            live_api.goto("chains", i);
                            live_api.goto("devices", j);
                            
                            // Store device info
                            var deviceInfo = {
                                path: live_api.path,
                                name: "Device " + j
                            };
                            
                            try {
                                var nameResult = live_api.get("name");
                                if (nameResult && nameResult.length > 0) {
                                    deviceInfo.name = nameResult[0];
                                }
                                post("Device name: " + deviceInfo.name + "\n");
                            } catch (e) {
                                post("Warning: Couldn't get device name: " + e.message + "\n");
                            }
                            
                            chainDevices.push(deviceInfo);
                        } catch (e) {
                            post("Warning: Error processing device: " + e.message + "\n");
                        }
                    }
                    
                    instruments.push({
                        index: i,
                        devices: chainDevices
                    });
                } catch (e) {
                    post("Error processing chain " + i + ": " + e.message + "\n");
                }
            }
            
            // Initially turn off all instruments except the selected one
            if (instruments.length > 0) {
                // Reset the selected instrument if it's out of range
                if (selectedInstrument >= instruments.length) {
                    selectedInstrument = 0;
                }
                
                // Turn all instruments off first
                turnAllInstrumentsOff();
                
                // Then turn on the selected one
                turnInstrumentOn(selectedInstrument);
                
                // Set the previously selected instrument
                previousInstrument = selectedInstrument;
                
                // Output the total number of instruments
                outlet(0, "count", totalInstruments);
            } else {
                displayStatus("No instruments found in the rack");
            }
        } catch (e) {
            post("Error getting chains: " + e.message + "\n");
            displayStatus("Error: Unable to access chains in the rack");
        }
    } catch (e) {
        displayStatus("Refresh error: " + e.message);
    }
    
    // Make sure to reset the flag
    isRefreshing = false;
}

// Turn all instruments off
function turnAllInstrumentsOff() {
    post("Turning all instruments off\n");
    
    for (var i = 0; i < instruments.length; i++) {
        toggleInstrumentPower(i, false);
    }
}

// Turn a specific instrument on
function turnInstrumentOn(index) {
    post("Turning instrument " + index + " on\n");
    
    if (index >= 0 && index < instruments.length) {
        toggleInstrumentPower(index, true);
    }
}

// Select an instrument and update power states
function selectInstrument(index) {
    if (!isInitialized || index < 0 || index >= totalInstruments) {
        post("Invalid instrument selection: " + index + "\n");
        return;
    }
    
    post("Selecting instrument: " + index + "\n");
    
    // Store the previous instrument for efficiency
    previousInstrument = selectedInstrument;
    selectedInstrument = index;
    
    // Turn off the previously selected instrument
    if (previousInstrument >= 0 && previousInstrument < instruments.length) {
        toggleInstrumentPower(previousInstrument, false);
    }
    
    // Turn on the newly selected instrument
    toggleInstrumentPower(selectedInstrument, true);
    
    // Update status display
    displayStatus("Instrument " + (selectedInstrument + 1) + " of " + totalInstruments + " active");
}

// Toggle power for a specific instrument
function toggleInstrumentPower(instrumentIndex, shouldBeOn) {
    if (instrumentIndex < 0 || instrumentIndex >= instruments.length) {
        post("Invalid instrument index: " + instrumentIndex + "\n");
        return;
    }
    
    var instrument = instruments[instrumentIndex];
    post("Setting instrument " + instrumentIndex + " to " + (shouldBeOn ? "ON" : "OFF") + "\n");
    
    // For each device in the chain
    for (var j = 0; j < instrument.devices.length; j++) {
        var device = instrument.devices[j];
        
        try {
            // Set the path to the device
            live_api.path = device.path;
            
            // Find the device's parameters
            var paramCount = 0;
            
            try {
                paramCount = live_api.getcount("parameters");
            } catch (e) {
                post("Error getting parameter count: " + e.message + "\n");
            }
            
            var toggled = false;
            
            // Find the power parameter
            for (var k = 0; k < paramCount; k++) {
                try {
                    live_api.path = device.path;
                    live_api.goto("parameters", k);
                    
                    var paramName = "";
                    try {
                        var nameResult = live_api.get("name");
                        if (nameResult && nameResult.length > 0) {
                            paramName = nameResult[0];
                        }
                        
                        // Check for any parameter that could be the power button
                        if (paramName === "Device On") {
                            
                            try {
                                live_api.set("value", shouldBeOn ? 1 : 0);
                                post("Set parameter " + paramName + " to " + (shouldBeOn ? "ON" : "OFF") + "\n");
                                toggled = true;
                                break;
                            } catch (e) {
                                post("Error setting parameter value: " + e.message + "\n");
                            }
                        }
                    } catch (e) {
                        post("Error getting parameter name: " + e.message + "\n");
                    }
                } catch (e) {
                    post("Error accessing parameter " + k + ": " + e.message + "\n");
                }
            }
            
            if (!toggled) {
                // Try the activated property as fallback
                try {
                    live_api.path = device.path;
                    live_api.set("activated", shouldBeOn ? 1 : 0);
                    post("Set activated property to " + (shouldBeOn ? "ON" : "OFF") + "\n");
                } catch (e) {
                    post("Could not toggle device " + device.name + "\n");
                }
            }
        } catch (e) {
            post("Error accessing device: " + e.message + "\n");
        }
    }
}

// Initialize on load
loadbang();
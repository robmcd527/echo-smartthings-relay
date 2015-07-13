/**
 * This is a gateway that allows Alexa to interact with and control SmartThings
 * devices.
 * 
 * https://developer.amazon.com/appsandservices/solutions/alexa/alexa-skills-kit/getting-started-guide
 */


// Libraries
var fs = require('fs');
var AWS = require('aws-sdk');
var kms = new AWS.KMS();
var dynamoDB = new AWS.DynamoDB();
var request = require('request');
var FuzzySet = require('fuzzyset.js');
var async = require('async');
var uuid = require('uuid');

// SmartThings SmartApp connection info
var smartthingsBaseURL = 'https://graph.api.smartthings.com/api/smartapps/installations';
var smartAppId = '723ac07e-f252-4040-8cde-80edcef05518';
var authenticationHeaderPrefix = "Bearer ";
var encryptedTokenPath = './smartthings_encrypted_token';


// Route the incoming request based on type (LaunchRequest, IntentRequest,
// etc.) The JSON body of the request is provided in the event parameter.
exports.handler = function (event, context) {
    try {
        console.log("event.session.application.applicationId=" + event.session.application.applicationId);

        /**
         * Uncomment this if statement and populate with your skill's application ID to
         * prevent someone else from configuring a skill that sends requests to this function.
         */
        /*
        if (event.session.application.applicationId !== "amzn1.echo-sdk-ams.app.[unique-value-here]") {
             context.fail("Invalid Application ID");
         }
        */

        if (event.session.new) {
            onSessionStarted({requestId: event.request.requestId}, event.session);
        }

        if (event.request.type === "LaunchRequest") {
            onLaunch(event.request,
                     event.session,
                     function callback(sessionAttributes, speechletResponse) {
                        context.succeed(buildResponse(sessionAttributes, speechletResponse));
                     });
        }  else if (event.request.type === "IntentRequest") {
            onIntent(event.request,
                     event.session,
                     function callback(sessionAttributes, speechletResponse) {
                         context.succeed(buildResponse(sessionAttributes, speechletResponse));
                     });
        } else if (event.request.type === "SessionEndedRequest") {
            onSessionEnded(event.request, event.session);
            context.succeed();
        }
    } catch (e) {
        context.fail("Exception: " + e);
    }
};

/**
 * Called when the session starts.
 */
function onSessionStarted(sessionStartedRequest, session) {
    console.log("onSessionStarted requestId=" + sessionStartedRequest.requestId
                + ", sessionId=" + session.sessionId);
}

/**
 * Called when the user launches the skill without specifying what they want.
 */
function onLaunch(launchRequest, session, callback) {
    console.log("onLaunch requestId=" + launchRequest.requestId
                + ", sessionId=" + session.sessionId);

    // Dispatch to your skill's launch.
    getWelcomeResponse(callback);
}

/**
 * Called when the user specifies an intent for this skill.
 */
function onIntent(intentRequest, session, callback) {
    console.log("onIntent requestId=" + intentRequest.requestId
                + ", sessionId=" + session.sessionId);

    var intent = intentRequest.intent,
        intentName = intentRequest.intent.name;

    // Dispatch to your skill's intent handlers
    if ("ToggleSwitch" === intentName) {
        setSwitchStatus(intent, session, callback);
    } else if ("CreateGroup" === intentName) {
        createGroup(intent, session, callback);
    } else if ("AddDeviceToGroup" === intentName) {
        addDeviceToGroup(intent, session, callback);
    } else {
        throw "Invalid intent";
    }
}

/**
 * Called when the user ends the session.
 * Is not called when the skill returns shouldEndSession=true.
 */
function onSessionEnded(sessionEndedRequest, session) {
    console.log("onSessionEnded requestId=" + sessionEndedRequest.requestId
                + ", sessionId=" + session.sessionId);
    // Add cleanup logic here
}

// --------------- Functions that control the skill's behavior -----------------------

function getWelcomeResponse(callback) {
    // If we wanted to initialize the session to have some attributes we could add those here.
    var sessionAttributes = {};
    var cardTitle = "Welcome";
    var speechOutput = "Welcome to your Smart Things integration.  It should allow you "
                + "to control devices in your home using Echo.";
    // If the user either does not reply to the welcome message or says something that is not
    // understood, they will be prompted again with this text.
    var repromptText = '';
    var shouldEndSession = true;

    callback(sessionAttributes,
             buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
}

/**
 * Create a new SmartThings device group
 */
function createGroup(intent, session, alexaCB) {
    var cardTitle = "SmartThings Group Creation";
    var groupNameSlot = intent.slots.Group;
    var repromptText = "";
    var sessionAttributes = {};
    var shouldEndSession = true;
    var speechOutput = '';
    
    console.log("Detected intent to create a new device group: " + groupNameSlot.value);
    
    async.waterfall(
        [
            // FIrst grab the existing list of groups
            getSmartThingsGroups,
            // Next see if we have a conflict
            function(data, callback) {
                console.log("Checking to see if " + groupNameSlot.value + " or something similar is already a group " +
                    "name");
                var group = findClosestMatch(data.Items, groupNameSlot.value, 0.9, function(il) { return il.GroupName.S; });
                
                if (group != null) {
                    callback('WARN', "A group called " + groupNameSlot.value + " already exists!");
                }
                else {
                    callback(null, groupNameSlot.value);
                }
            },
            // Go ahead and create the new group
            function(groupName, callback) {
                console.log("Proceeding to create new group: " + groupName);
                
                var groupId = uuid.v4();
                console.log("Created UUID " + groupId);
                
                var params = {
                  'Item': {
                      'GroupID': {'S': groupId},
                      'GroupName': {'S': groupName},
                  },
                  'TableName': 'SmartThingsGroups'
                };
                
                dynamoDB.putItem(params, function(err, data) {
                   if (err) {
                       console.log("Error creating new group in DYnamoDB: " + err);
                       speechOutput = "Sorry, I was unable to create a new group called " + groupName + " in dynamo";
                   }
                   else {
                       console.log("Successfully created new group " + groupName);
                       speechOutput = "I have created a new Smart Things group called " + groupName + ". You can now " +
                            "add devices to it.";
                   }
                   
                   alexaCB(sessionAttributes,
                            buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
                });
            }
        ],
        function(err, data) {
            if (err) {
                console.log(err + ": " + data);
                speechOutput = data;
            }
            else {
                console.log("Successfully finished processing - Initiating callback to Alexa.");
                speechOutput = data;
            }
            alexaCB(sessionAttributes,
                buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
        }
    );
}


/**
 * Add a device to a group
 */
function addDeviceToGroup(intent, session, alexaCB) {
    var cardTitle = "SmartThings Add Device to Group";
    var deviceNameSlot = intent.slots.Device;
    var groupNameSlot = intent.slots.Group;
    var repromptText = "";
    var sessionAttributes = {};
    var shouldEndSession = true;
    var speechOutput = '';
    
    console.log("Detected intent to add device " + deviceNameSlot.value + " to group " + groupNameSlot.value);
    
    async.waterfall(
        [
            // FIrst grab the existing list of groups
            getSmartThingsGroups,
            // Next see if we have a conflict
            function(data, callback) {
                console.log("Searching for group called " + groupNameSlot.value + "...");
                var group = findClosestMatch(data.Items, groupNameSlot.value, 0.9, 
                    function(il) { return il.GroupName.S; });
                
                if (group == null) {
                    callback('WARN', "Sorry, I can't find a group called " + groupNameSlot.value);
                }
                else {
                    console.log(group);
                    console.log("Found group " + group.GroupName.S + " with ID " + group.GroupID.S);
                    callback(null, group.GroupID.S);
                }
            },
            // Grab the oAuth token
            function(groupId, callback) {
                getSmartThingsToken(function(err, data) {
                    callback(err, groupId, data);
                });
            },
            // Get the list of devices
            function(groupId, oauthToken, callback) {
                getSwitchInformation(oauthToken, function(err, data) {
                    callback(err, groupId, data);
                });
            },
            // Figure out which device we want to add
            function(groupId, deviceList, callback) {
                var device = findClosestMatch(deviceList, deviceNameSlot.value, 0.7, function(il) { return il.name; });
                
                // Null return value means none of the devices we loaded were similar enough
                if (null == device) {
                    callback('WARN', "Unable to locate device with a name similar to " + deviceNameSlot.value + 
                        ". Please try again.");
                    return;
                }
                
                callback(null, groupId, device.id);
                
            },
            // Go ahead and add the device to the group
            function(groupId, deviceId, callback) {
                console.log("Proceeding to add " + deviceId + " to group id " + groupId);
                
                var params = {
                  'Item': {
                      'DeviceID': {'S': deviceId},
                      'GroupID': {'S': groupId},
                  },
                  'TableName': 'SmartThingsDeviceMappings'
                };
                
                dynamoDB.putItem(params, function(err, data) {
                   if (err) {
                       console.log("Error creating new device mapping in dynamo: " + err);
                       callback('ERROR', "Sorry, I was unable to add your device to dynamo.");
                   }
                   else {
                       console.log("Successfully created new group.");
                       callback(null, "I have successfully added your device.");;
                   }
                });
            }
        ],
        function(err, data) {
            if (err) {
                console.log(err + ": " + data);
                speechOutput = data;
            }
            else {
                console.log("Successfully finished processing - Initiating callback to Alexa.");
                speechOutput = data;
            }
            alexaCB(sessionAttributes,
                buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
        }
    );
}


/**
 * Turn a switch on or off
 */
function setSwitchStatus(intent, session, alexaCB) {
    var cardTitle = "SmartThings Action";
    var actionSlot = intent.slots.Action;
    var switchNameSlot = intent.slots.Switch;
    var repromptText = "";
    var sessionAttributes = {};
    var shouldEndSession = true;
    var speechOutput = '';  //"Action is " + actionSlot.value + " and switch name is " + switchNameSlot.value;
    
    console.log("Detected intent to toggle a switch - switch: " + switchNameSlot.value + " action: " + 
        actionSlot.value);
    
    // Use async to tame some of the nested callbacks
    async.waterfall(
        [
            // First do some basic error checking
            function(callback) {
                if (! (actionSlot.value === 'on' || actionSlot.value === 'off') ) {
                    callback(true, "Sorry, I can only turn devices on or off.  It sounds like you asked me to turn " + 
                        "something " + actionSlot.value);
                    return;
                }
                
                if (! switchNameSlot.value) {
                    callback(true, "Sorry, I didn't understand which device you want to control.  Please try again.");
                    return;
                }
                
                callback(null);
            },
            // Grab the oAuth token
            getSmartThingsToken,
            // Go grab the list of devices and pass that down
            function(oauthToken, callback) {
                getSwitchInformation(oauthToken, function(err, data) {
                    callback(err, oauthToken, data);
                });
            },
            // Try to figure out which device we want to work with
            function(oauthToken, data, callback) {
                // Load the device that is the closest match to the requested name
                var device = findClosestMatch(data, switchNameSlot.value, 0.5, function(il) { return il.name; });
                    
                // Null return value means none of the devices we loaded were similar enough
                if (null == device) {
                    callback('WARN', "Unable to locate device with a name similar to " + switchNameSlot.value + 
                        ". Please try again.");
                    return;
                }
                    
                // Don't try to turn on a device that is already on
                if (device.name === actionSlot.value) {
                    callback('INFO', "Looks like the " + device.name + " is already " + actionSlot.value);
                    return;
                }
                
                callback(null, oauthToken, device.id, actionSlot.value);
            },
            // Finally actually flip the switch
            toggleSwitch
        ],
        function(err, data) {
            if (err) {
                console.log(err + ": " + data);
                speechOutput = data;
            }
            else {
                console.log("Successfully finished processing - Initiating callback to Alexa.");
            }
            alexaCB(sessionAttributes,
                buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
        }
    );  
}

/**
 * This method takes the structured list of data and tries to find the item
 * that matches most clostly.  It first looks for any exact matches and then 
 * tries to do a fuzzy string match in case Echo interpreted something a 
 * little off.  Returns null if we don't find a good match.
 * 
 * Reference: https://www.npmjs.com/package/fuzzyset.js
 */
function findClosestMatch(sourceList, target, fuzzyThreshold, accessor) {
    console.log("Attempting to find source string matching " + target + "...");
    
    accessor = (accessor == null) ? function(li) { return li; } : accessor;
    
    var collapsedList = [];
    
    for (var i = 0; i < sourceList.length; i++) {
        var item = accessor(sourceList[i]);
        collapsedList.push(item);
        if (item.toLocaleLowerCase() === target.toLocaleLowerCase()) {
            console.log("Returning exact match of " + item);
            return sourceList[i];
        }
    }
    
    console.log("No exact match found - proceeding to fuzzy matching...");
    
    var fuzzy = FuzzySet(collapsedList);
    var matchData = fuzzy.get(target);
    
    if (! matchData) {
        console.log("FUzzy match failed!");
        return null;
    }
    
    console.log(matchData);
    
    var matchName = matchData[0][1];
    var matchScore = matchData[0][0];
    
    if (matchScore > fuzzyThreshold) {
        for (var i = 0; i < sourceList.length; i++) {
            if (accessor(sourceList[i]) === matchName) {
                console.log("Returning fuzzy match of " + matchName + " that had score of " + matchScore);
                return sourceList[i];
            }
        }
    }
    else {
        console.log("Fuzzy matching found " + matchName + " but score of " + matchScore + " is below threshold of " + 
            fuzzyThreshold);
    }
    
    return null;
}


/**
 * Get the list of groups from Dynamo
 */
function getSmartThingsGroups(callback) {
    var params = {
        'TableName': 'SmartThingsGroups'
    };
    
    dynamoDB.scan(params, function(err, data) {
       if (err) {
           console.log("Error loading groups from DYnamoDB: " + err);
           callback('ERROR', "Sorry, I was unable to load existing group list from Dynamo.");
       }
       else {
           console.log("Successfully loaded groups from DynamoDB.");
           callback(null, data);
       }
    });
}

/**
 * Gets the SmartThings oAuth token from KMS
 */
function getSmartThingsToken(callback) {
    console.log("Reading encrypted smartthings API token from local file " + encryptedTokenPath);
    var encryptedToken = fs.readFileSync(encryptedTokenPath);

    var params = {
        CiphertextBlob: encryptedToken
    };
    
    console.log("Decrypting token using KMS...");
    kms.decrypt(params, function(err, data) {
        if (err) {
            console.log("Error decrypting token: " + data);
            callback('ERROR', "Unable to decrypt token using KMS");
        }
        else {
            var smartThingsToken = data['Plaintext'].toString();
            console.log("Successfully decrypted smartthings API token.");
            callback(null, smartThingsToken);
        }
    });
}


/**
 * Makes async HTTPS GET request to SmartThings web service to get list of 
 * devices that are accessible by the smart app.
 */
function getSwitchInformation(oauthToken, callback) {
    var url = smartthingsBaseURL + '/' + smartAppId + '/switches';
    
    request.get(
        {
            url: url,
            headers: { "Authorization" : authenticationHeaderPrefix + oauthToken }
        },
        function (error, response, body) {
            if (error) {
                console.log("Error getting SmartThings switches from service! Response: " + response + "\n" + body);
                callback(error, "Error getting SmartThings switches from service");
            }
            else {
                console.log("Successfully loaded switch details from web service: " + body);
                callback(null, JSON.parse(body));
            }
        }
    );
}


/**
 * Makes HTTPS PUT request to update the state of a given device
 */
function toggleSwitch(oauthToken, deviceId, action, callback) {
    var url = smartthingsBaseURL + '/' + smartAppId + '/switches/' + deviceId + '/' + action;
    
    request.put(   
        {
            url : url,
            headers : { "Authorization" : authenticationHeaderPrefix + oauthToken }  
        },
        function (error, response, body) {
            if (error) {
                console.log("Error changing switch status for deviceId " + deviceId + " to status " + action + 
                    "! Response: " + response + "\n" + body);
                callback(error, "Error changing status of switch through service");
            }
            else {
                console.log("Successfully changed status of " + deviceId + " to " + action + ": " + body);
                callback(null, null);
            }
        }
    );
}


// --------------- Helpers that build all of the responses -----------------------

function buildSpeechletResponse(title, output, repromptText, shouldEndSession) {
    return {
        outputSpeech: {
            type: "PlainText",
            text: output
        },
        card: {
            type: "Simple",
            title: title,
            content: output
        },
        reprompt: {
            outputSpeech: {
                type: "PlainText",
                text: repromptText
            }
        },
        shouldEndSession: shouldEndSession
    }
}

function buildResponse(sessionAttributes, speechletResponse) {
    return {
        version: "1.0",
        sessionAttributes: sessionAttributes,
        response: speechletResponse
    }
}

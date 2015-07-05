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
var request = require('request');
var FuzzySet = require('fuzzyset.js');
//var async = require('async');

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
 * Turn a switch on or off
 */
function setSwitchStatus(intent, session, callback) {
    var cardTitle = intent.name;
    var actionSlot = intent.slots.Action;
    var switchNameSlot = intent.slots.Switch;
    var repromptText = "";
    var sessionAttributes = {};
    var shouldEndSession = true;
    var speechOutput = '';  //"Action is " + actionSlot.value + " and switch name is " + switchNameSlot.value;
    
    console.log("Detected intent to toggle a switch - switch: " + switchNameSlot.value + " action: " + actionSlot.value);
    
    if (! (actionSlot.value === 'on' || actionSlot.value === 'off') ) {
        speechOutput = "Sorry, I can only turn devices on or off.  It sounds like you asked me to turn something " + actionSlot.value;
        callback(sessionAttributes,
                        buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
    }
    
    if (! switchNameSlot.value) {
        speechOutput = "Sorry, I didn't understand which device you want to control.  Please try again.";
        callback(sessionAttributes,
                        buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
    }
    
    console.log("Reading encrypted smartthings API token from local file " + encryptedTokenPath);
    var encryptedToken = fs.readFileSync(encryptedTokenPath);
    
    var params = {
        CiphertextBlob: encryptedToken
    };

    console.log("Decrypting token using KMS...");
    kms.decrypt(params, function(err, data) {
        if (err) {
            console.log(err, err.stack);
        }
        else {
            var smartThingsToken = data['Plaintext'].toString();
            console.log("Successfully decrypted smartthings API token.");
            
            getSwitchInformation(smartThingsToken, function(error, data) {
                // First check if the call to get the list of devices failed
                if (error) {
                    speechOutput = data;
                    callback(sessionAttributes,
                                buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
                    return;
                }
        
                // Load the device that is the closest match to the requested name
                var device = findClosestMatchingDevice(data, switchNameSlot.value);
                
                // Null return value means none of the devices we loaded were similar enough
                if (null == device) {
                    speechOutput = "Unable to locate device with a name similar to " + switchNameSlot.value + ". Please try again.";
                    console.log(speechOutput);
                    callback(sessionAttributes, 
                        buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
                    return;
                }
                
                // Don't try to turn on a device that is already on
                if (device.value === actionSlot.value) {
                    speechOutput = "Looks like the " + device.name + " is already " + actionSlot.value;
                    console.log(speechOutput);
                    callback(sessionAttributes, 
                        buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
                    return;
                }
                
                // Looks like we have everything we need to turn the switch on/off
                toggleSwitch(smartThingsToken, device.id, actionSlot.value, function(error, data) {
                        if (error) {
                            speechOutput = data;
                        }
                        else {
                            console.log("Successfully finished processing. Initiating callback to Alexa...");
                        }
                        callback(sessionAttributes,
                            buildSpeechletResponse(cardTitle, speechOutput, repromptText, shouldEndSession));
                    }  
                );
                
            });
        }
    });

}

/**
 * This method takes the structured list of devices retrieved from SmartThings
 * and tries to identify which one we want to interact with.  It first looks for
 * any exact matches and then tries to do a fuzzy string match in case Echo 
 * interpreted something a little off.  Returns null if we don't find a good 
 * match.
 * 
 * Reference: https://www.npmjs.com/package/fuzzyset.js
 */
function findClosestMatchingDevice(deviceList, deviceName) {
    console.log("Attempting to find device matching " + deviceName + "...");
    
    var nameList = [];
    var fuzzyThreshold = 0.5;
    
    for (var i = 0; i < deviceList.length; i++) {
        nameList.push(deviceList[i].name);
        if (deviceList[i].name.toLocaleLowerCase() === deviceName.toLocaleLowerCase()) {
            console.log("Returning exact match of " + deviceList[i].name);
            return deviceList[i];
        }
    }
    
    console.log("No exact match found - proceeding to fuzzy matching...");
    
    var fuzzy = FuzzySet(nameList);
    var matchData = fuzzy.get(deviceName);
    
    if (! matchData) {
        console.log("FUzzy match failed!");
        return null;
    }
    
    console.log(matchData);
    
    var matchName = matchData[0][1];
    var matchScore = matchData[0][0];
    
    if (matchScore > fuzzyThreshold) {
        for (var i = 0; i < deviceList.length; i++) {
            if (deviceList[i].name === matchName) {
                console.log("Returning fuzzy match of " + matchName + " that had score of " + matchScore);
                return deviceList[i];
            }
        }
    }
    else {
        console.log("Fuzzy matching found " + matchName + " but score of " + matchScore + " is below threshold of " + fuzzyThreshold);
    }
    
    return null;
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
                console.log("Error changing switch status for deviceId " + deviceId + " to status " + action + "! Response: " + response + "\n" + body);
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
            title: "SessionSpeechlet - " + title,
            content: "SessionSpeechlet - " + output
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

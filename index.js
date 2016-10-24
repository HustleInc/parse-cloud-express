/*
parse-cloud - This module adds the Parse.Cloud namespace to the Parse JS SDK,
  allowing some code previously written for Cloud Code to run in a Node environment.

Database triggers and cloud functions defined with Parse.Cloud methods will be wrapped
  into an Express app, which can then be mounted on your main Express app.  These
  routes can then be registered with Parse via the Webhooks API.

See our example project

*/
var express = require('express');
var bodyParser = require('body-parser');
var Parse = global.Parse || require('parse/node').Parse;
var Request = require('request');

var Triggers = {};

// Make sure to set your Webhook key via heroku config set or local environment variable
var webhookKey = process.env.PARSE_WEBHOOK_KEY;

// Middleware to enforce security using the Webhook Key
function validateWebhookRequest(req, res, next) {
  if (req.get('X-Parse-Webhook-Key') !== webhookKey) {
    return errorResponse(res, 'Unauthorized Request.');
  }
  next();
}

// Middleware to inflate a Parse.Object passed to a webhook route
function inflateParseObject(req, res, next) {
  if (req.body.original && req.body.update) {
    var object = Parse.Object.fromJSON(req.body.original);
    object.set(Parse._decode(undefined, req.body.update));
    req.object = object;
  } else {
    req.object = Parse.Object.fromJSON(req.body.object);
  }
  next();
}

// Middleware to create the .success and .error methods expected by a Cloud Code function
function addParseResponseMethods(req, res, next) {
  res.success = function(data) {
    successResponse(res, data);
  };
  res.error = function(data) {
    errorResponse(res, data);
  };
  next();
}

// Middleware to promote the cloud function params to the request object
function updateRequestFunctionParams(req, res, next) {
  req.params = req.body.params;
  next();
}

// Middleware to promote the installationId to the request object
function updateRequestInstallationId(req, res, next) {
  req.installationId = req.body.installationId;
  next();
}

// Middleware to inflate a Parse.User if provided, and promote the master key option to the request
function inflateParseUser(req, res, next) {
  if (req.body.user) {
    if (req.body.user.className === undefined) {
      req.body.user.className = "_User";
    }
    req.user = Parse.Object.fromJSON(req.body.user);
  }
  req.master = req.body.master;
  next();
}

var respondEmptyIfPossible = function(req, res, next) {
  if (req.body.triggerName.startsWith('after')) {
    res.status(200).send({});
  }
  next();
};

var successResponse = function(res, data) {
  data = data || true;
  res.status(200).send({ "success" : data });
}

var errorResponse = function(res, message) {
  message = message || true;
  try {
    res.status(200).send({ "error" : message });
  } catch(error) {
    console.error(`Sent headers twice for error message: ${message}`);
  }
}

var jsonParser = bodyParser.json();

var cloudFunctionApp = express();
cloudFunctionApp.use(validateWebhookRequest);
cloudFunctionApp.use(jsonParser)

var cloudFuncMiddlewares = [
  updateRequestInstallationId,
  updateRequestFunctionParams,
  addParseResponseMethods,
  inflateParseUser,
];

var triggerApp = express();
triggerApp.use(validateWebhookRequest);
triggerApp.use(jsonParser)

var beforeMiddlewares = [
  updateRequestInstallationId,
  addParseResponseMethods,
  inflateParseObject,
  inflateParseUser,
  respondEmptyIfPossible
]

var afterMiddlewares = [
  updateRequestInstallationId,
  inflateParseObject,
  inflateParseUser,
  respondEmptyIfPossible
]

function triggerHandler(request, response) {
  const triggerName = request.body.triggerName;
  const className = request.body.object.className;
  Triggers[className][triggerName](request, response);
}

function registerTrigger(className, trigger, handler) {
  var classTriggers = Triggers[className];
  if (!classTriggers) {
    Triggers[className] = {};
    classTriggers = Triggers[className];
  }
  Triggers[className][trigger] = handler;
  const middlewares = trigger.startsWith('before') ? beforeMiddlewares : afterMiddlewares;
  triggerApp.post('/', middlewares, triggerHandler);
}


var beforeSave = function(className, handler) {
  registerTrigger(className, 'beforeSave', handler)
};

var afterSave = function(className, handler) {
  registerTrigger(className, 'afterSave', handler)
};

var beforeDelete = function(className, handler) {
  registerTrigger(className, 'beforeDelete', handler)
}

var afterDelete = function(className, handler) {
  registerTrigger(className, 'afterDelete', handler)
}

var define = function(functionName, handler) {
  cloudFunctionApp.post('/' + functionName, cloudFuncMiddlewares, handler);
};

function inflateObjectsToClassNames(methodToWrap) {
  return function(objectOrClassName, handler) {
    if (objectOrClassName === null || !objectOrClassName.className) {
      return methodToWrap(objectOrClassName, handler);
    }
    return methodToWrap(objectOrClassName.className, handler);
  }
}

Parse.Cloud.beforeSave = inflateObjectsToClassNames(beforeSave);
Parse.Cloud.afterSave = inflateObjectsToClassNames(afterSave);
Parse.Cloud.beforeDelete = inflateObjectsToClassNames(beforeDelete);
Parse.Cloud.afterDelete = inflateObjectsToClassNames(afterDelete);
Parse.Cloud.define = define;
Parse.Cloud.httpRequest = require("./lib/httpRequest");

Parse.Cloud.job = function() { console.log('Running jobs is not supported in parse-cloud-express'); }

module.exports = {
  Parse: Parse,
  successResponse: successResponse,
  errorResponse: errorResponse,
  triggerApp: triggerApp,
  cloudFunctionApp: cloudFunctionApp,
};

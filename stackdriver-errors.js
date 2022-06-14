/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

let StackTrace = require('stacktrace-js');

/**
 * URL endpoint of the Stackdriver Error Reporting report API.
 */
const baseAPIUrl = 'https://clouderrorreporting.googleapis.com/v1beta1/projects/';

/**
 * An Error handler that sends errors to the Stackdriver Error Reporting API.
 */
const StackdriverErrorReporter = function() {};

/**
 * Initialize the StackdriverErrorReporter object.
 * @param {Object} config - the init configuration.
 * @param {Object} [config.context={}] - the context in which the error occurred.
 * @param {string} [config.context.user] - the user who caused or was affected by the error.
 * @param {String} config.key - the API key to use to call the API.
 * @param {String} config.projectId - the Google Cloud Platform project ID to report errors to.
 * @param {Function} config.customReportingFunction - Custom function to be called with the error payload for reporting, instead of HTTP request. The function should return a Promise.
 * @param {Function} config.customMessageTranslator - Custom function to be called with the error payload for message translating. This function should return the new message.
 * @param {String} [config.service=web] - service identifier.
 * @param {String} [config.version] - version identifier.
 * @param {String} [config.basePath] - base path of all the js files for location.
 * @param {Boolean} [config.reportUncaughtExceptions=true] - Set to false to stop reporting unhandled exceptions.
 * @param {Boolean} [config.disabled=false] - Set to true to not report errors when calling report(), this can be used when developping locally.
 */
StackdriverErrorReporter.prototype.start = function(config) {
    if (!config.key && !config.targetUrl && !config.customReportingFunction) {
        throw new Error('Cannot initialize: No API key, target url or custom reporting function provided.');
    }
    if (!config.projectId && !config.targetUrl && !config.customReportingFunction) {
        throw new Error('Cannot initialize: No project ID, target url or custom reporting function provided.');
    }

    this.customReportingFunction = config.customReportingFunction;
    this.customMessageTranslator = config.customMessageTranslator;
    this.apiKey = config.key;
    this.projectId = config.projectId;
    this.targetUrl = config.targetUrl;
    this.context = config.context || {};
    this.basePath = config.basePath;
    this.serviceContext = {service: config.service || 'web'};
    if (config.version) {
        this.serviceContext.version = config.version;
    }
    this.reportUncaughtExceptions = config.reportUncaughtExceptions !== false;
    this.reportUnhandledPromiseRejections = config.reportUnhandledPromiseRejections !== false;
    this.disabled = !!config.disabled;

    registerHandlers(this);
};

function registerHandlers(reporter) {
    // Register as global error handler if requested
    let noop = function() {};
    if (reporter.reportUncaughtExceptions) {
        let oldErrorHandler = window.onerror || noop;

        window.onerror = function(message, source, lineno, colno, error) {
            if (error) {
                reporter.report(error).catch(noop);
            }
            oldErrorHandler(message, source, lineno, colno, error);
            return true;
        };
    }
    if (reporter.reportUnhandledPromiseRejections) {
        let oldPromiseRejectionHandler = window.onunhandledrejection || noop;

        window.onunhandledrejection = function(promiseRejectionEvent) {
            if (promiseRejectionEvent) {
                reporter.report(promiseRejectionEvent.reason).catch(noop);
            }
            oldPromiseRejectionHandler(promiseRejectionEvent.reason);
            return true;
        };
    }
}

/**
 * Report an error to the Stackdriver Error Reporting API
 * @param {Error|String} err - The Error object or message string to report.
 * @param {Object} options - Configuration for this report.
 * @param {number} [options.skipLocalFrames=1] - Omit number of frames if creating stack.
 * @returns {Promise} A promise that completes when the report has been sent.
 */
StackdriverErrorReporter.prototype.report = function(err, options) {
    if (this.disabled) {
        return Promise.resolve(null);
    }
    if (!err) {
        return Promise.reject(new Error('no error to report'));
    }
    options = options || {};

    let payload = {};
    payload.serviceContext = this.serviceContext;
    payload.context = this.context;
    payload.context.httpRequest = {
        userAgent: window.navigator.userAgent,
        url: window.location.href,
    };



    let firstFrameIndex = 0;
    if (typeof err == 'string' || err instanceof String) {
        // Transform the message in an error, use try/catch to make sure the stacktrace is populated.
        try {
            throw new Error(err);
        } catch (e) {
            err = e;
        }
        // the first frame when using report() is always this library
        firstFrameIndex = options.skipLocalFrames || 1;
    }

    let reportUrl = this.targetUrl || (
        baseAPIUrl + this.projectId + '/events:report?key=' + this.apiKey);

    let customFunc = this.customReportingFunction;
    let customMessageTranslator = this.customMessageTranslator;

    return resolveError(err, firstFrameIndex, this.basePath)
        .then(function([message, reportLocation]) {
            if (customMessageTranslator) {
                payload.message = customMessageTranslator(message)
            } else {
                payload.message = message;
            }
            if (customFunc) {
                return customFunc(payload);
            }

            payload.context.reportLocation = reportLocation;
            return sendErrorPayload(reportUrl, payload);
        });
};

function resolveError(err, firstFrameIndex, fileBasePath) {
    // This will use sourcemaps and normalize the stack frames
    return StackTrace.fromError(err).then(function(stack) {
        let lines = [err.toString()];
        // Reconstruct to a JS stackframe as expected by Error Reporting parsers.
        for (let s = firstFrameIndex; s < stack.length; s++) {
            // Cannot use stack[s].source as it is not populated from source maps.
            lines.push([
                '    at ',
                // If a function name is not available '<anonymous>' will be used.
                stack[s].getFunctionName() || '<anonymous>', ' (',
                stack[s].getFileName(), ':',
                stack[s].getLineNumber(), ':',
                stack[s].getColumnNumber(), ')',
            ].join(''));
        }

        let filePathList = stack[firstFrameIndex].getFileName().split("/");
        let fileName = []
        for (let e = 3; e < filePathList.length; e++) {
            fileName.push(filePathList[e].split("?")[0]);
        }

        fileName = fileBasePath + "/" + fileName.join("/");

        return [lines.join('\\n'), {
                filePath: fileName,
                lineNumber: stack[firstFrameIndex].getLineNumber(),
                functionName: stack[firstFrameIndex].getFunctionName() || '<anonymous>',
            }
        ]
    }, function(reason) {
        // Failure to extract stacktrace
        return [[
            'Error extracting stack trace: ', reason, '\n',
            err.toString(), '\n',
            '    (', err.file, ':', err.line, ':', err.column, ')',
        ].join(''), {}];
    });
}

function sendErrorPayload(url, payload) {
    let xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');

    return new Promise(function(resolve, reject) {
        xhr.onreadystatechange = function() {
            if (xhr.readyState === 4) {
                let code = xhr.status;
                if (code >= 200 && code < 300) {
                    resolve({message: payload.message});
                } else if (code === 429) {
                    // HTTP 429 responses are returned by Stackdriver when API quota
                    // is exceeded. We should not try to reject these as unhandled errors
                    // or we may cause an infinite loop with 'reportUncaughtExceptions'.
                    reject(
                        {
                            message: 'quota or rate limiting error on stackdriver report',
                            name: 'Http429FakeError',
                        });
                } else {
                    let condition = code ? code + ' http response'  : 'network error';
                    reject(new Error(condition + ' on stackdriver report'));
                }
            }
        };
        xhr.send(JSON.stringify(payload));
    });
}

/**
 * Set the user for the current context.
 *
 * @param {string} user - the unique identifier of the user (can be ID, email or custom token) or `undefined` if not logged in.
 */
StackdriverErrorReporter.prototype.setUser = function(user) {
    this.context.user = user;
};

module.exports = StackdriverErrorReporter;

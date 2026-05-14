// Adapted from "Simon Willison's TILs" (https://til.simonwillison.net/deno/pyodide-sandbox)

import pyodideModule from "npm:pyodide/pyodide.js";
import { readLines } from "https://deno.land/std@0.186.0/io/mod.ts";

// =============================================================================
// Python Code Templates
// =============================================================================

// Setup code run before each user code execution.
// Captures stdout, defines SUBMIT for early termination, and
// provides a helper to extract exception args across the JS/Python boundary.
const PYTHON_SETUP_CODE = `
import sys, io, json, traceback
old_stdout, old_stderr = sys.stdout, sys.stderr
buf_stdout, buf_stderr = io.StringIO(), io.StringIO()
sys.stdout, sys.stderr = buf_stdout, buf_stderr

def _json_safe(value):
  if value is None or isinstance(value, (str, int, float, bool)):
    return value
  if isinstance(value, dict):
    return {str(k): _json_safe(v) for k, v in value.items()}
  if isinstance(value, (list, tuple)):
    return [_json_safe(v) for v in value]
  return str(value)

def last_exception_args():
  return json.dumps(_json_safe(sys.last_exc.args)) if sys.last_exc else None

def last_exception_type():
  return type(sys.last_exc).__name__ if sys.last_exc else None

def last_exception_message():
  return str(sys.last_exc) if sys.last_exc else None

def last_exception_location():
  if not sys.last_exc or sys.last_exc.__traceback__ is None:
    return None

  tb = sys.last_exc.__traceback__
  while tb.tb_next is not None:
    tb = tb.tb_next

  frame = tb.tb_frame
  return json.dumps({
    "filename": frame.f_code.co_filename,
    "lineno": tb.tb_lineno,
    "function": frame.f_code.co_name,
  })

def last_exception_traceback(limit=20):
  if not sys.last_exc:
    return None

  try:
    return ''.join(traceback.format_exception(type(sys.last_exc), sys.last_exc, sys.last_exc.__traceback__, limit=limit))
  except MemoryError:
    return None

class FinalOutput(BaseException):
    # Control-flow exception to signal completion (like StopIteration)
    pass

# Default SUBMIT for single-output signatures (e.g., Program of Thought).
# Only define if not already registered with typed signatures.
if 'SUBMIT' not in dir():
    def SUBMIT(output):
        raise FinalOutput({"output": output})
`;

// Generate a tool wrapper function with typed signature.
// Parameters is an array of {name, type?, default?} objects.
// Convert a JavaScript/JSON value to Python literal syntax
const toPythonLiteral = (value) => {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return JSON.stringify(value);  // Works for strings, numbers, arrays, objects
};

const makeToolWrapper = (toolName, parameters = []) => {
  // Build signature parts: "query: str, limit: int = 10"
  const sigParts = parameters.map(p => {
    let part = p.name;
    if (p.type) part += `: ${p.type}`;
    if (p.default !== undefined) part += ` = ${toPythonLiteral(p.default)}`;
    return part;
  });
  const signature = sigParts.join(', ');
  const argNames = parameters.map(p => p.name);
  const kwargParts = argNames.map(n => `"${n}": ${n}`).join(', ');

  return `
import json
from pyodide.ffi import run_sync, JsProxy
def ${toolName}(${signature}):
    result = run_sync(_js_tool_call("${toolName}", json.dumps({"kwargs": {${kwargParts}}})))
    parsed = result.to_py() if isinstance(result, JsProxy) else result
    if isinstance(parsed, dict) and parsed.get("${TOOL_BRIDGE_ERROR_KEY}"):
        raise RuntimeError(parsed.get("message", "Tool bridge error"))
    return parsed
`;
};

// Generate SUBMIT function with output field signature.
// Outputs is an array of {name, type?} objects.
const makeSubmitWrapper = (outputs) => {
  if (!outputs || outputs.length === 0) {
    // Fallback to single-arg SUBMIT if no outputs defined
    return `
def SUBMIT(output):
    raise FinalOutput({"output": output})
`;
  }

  const sigParts = outputs.map(o => {
    let part = o.name;
    if (o.type) part += `: ${o.type}`;
    return part;
  });
  const dictParts = outputs.map(o => `"${o.name}": ${o.name}`);

  return `
def SUBMIT(${sigParts.join(', ')}):
    raise FinalOutput({${dictParts.join(', ')}})
`;
};

// =============================================================================
// JSON-RPC 2.0 Helpers
// =============================================================================

// JSON-RPC 2.0 protocol errors (reserved range: -32700 to -32600)
const JSONRPC_PROTOCOL_ERRORS = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
};

// Application errors (range: -32000 to -32099)
const JSONRPC_APP_ERRORS = {
  SyntaxError: -32000,
  NameError: -32001,
  TypeError: -32002,
  ValueError: -32003,
  AttributeError: -32004,
  IndexError: -32005,
  KeyError: -32006,
  RuntimeError: -32007,
  CodeInterpreterError: -32008,
  MemoryError: -32009,
  Unknown: -32099,
};

const jsonrpcRequest = (method, params, id) =>
  JSON.stringify({ jsonrpc: "2.0", method, params, id });

const jsonrpcNotification = (method, params = null) => {
  const msg = { jsonrpc: "2.0", method };
  if (params) msg.params = params;
  return JSON.stringify(msg);
};

const jsonrpcResult = (result, id) =>
  JSON.stringify({ jsonrpc: "2.0", result, id });

const jsonrpcError = (code, message, id, data = null) => {
  const err = { code, message };
  if (data) err.data = data;
  return JSON.stringify({ jsonrpc: "2.0", error: err, id });
};

let pyodide = null;
let activeExecuteRequestId = null;

function callPythonErrorHelper(name) {
  if (!pyodide?.globals) return null;

  let helper = null;
  try {
    helper = pyodide.globals.get(name);
    return helper ? helper() : null;
  } catch {
    return null;
  } finally {
    try {
      helper?.destroy?.();
    } catch {
      // Ignore cleanup failures in error-reporting paths.
    }
  }
}

function parseJsonValue(rawValue) {
  if (!rawValue) return null;
  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function formatErrorArgs(args, fallbackMessage) {
  if (!Array.isArray(args) || args.length === 0) return fallbackMessage;

  return args.map((arg) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join("; ");
}

function buildUnhandledAsyncError(reason) {
  const fallbackMessage = String(reason?.message || reason || "Unhandled async error");
  const errorData = {
    type: reason?.type || reason?.name || "UnhandledPromiseRejection",
    unhandled_async: true,
  };

  if (reason?.type === "PythonError" || String(reason) === "PythonError") {
    const exceptionType = callPythonErrorHelper("last_exception_type");
    const exceptionMessage = callPythonErrorHelper("last_exception_message");
    const exceptionArgs = parseJsonValue(callPythonErrorHelper("last_exception_args")) || [];
    const exceptionLocation = parseJsonValue(callPythonErrorHelper("last_exception_location"));
    const exceptionTraceback = callPythonErrorHelper("last_exception_traceback");

    if (exceptionType) errorData.type = exceptionType;
    if (exceptionArgs.length > 0) errorData.args = exceptionArgs;
    if (exceptionLocation) errorData.location = exceptionLocation;
    if (exceptionTraceback) errorData.traceback = exceptionTraceback;

    return {
      code: JSONRPC_APP_ERRORS[errorData.type] || JSONRPC_APP_ERRORS.RuntimeError,
      message: formatErrorArgs(exceptionArgs, exceptionMessage || fallbackMessage),
      data: errorData,
    };
  }

  return {
    code: JSONRPC_APP_ERRORS.RuntimeError,
    message: `Unhandled async error: ${fallbackMessage}`,
    data: errorData,
  };
}

// Global handler to prevent uncaught promise rejections from crashing Deno
// These can occur during async Python <-> JS interop
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const error = buildUnhandledAsyncError(event.reason);
  console.log(jsonrpcError(error.code, error.message, activeExecuteRequestId, error.data));
});

pyodide = await pyodideModule.loadPyodide();

// Tool call support: allows Python code to call host-side functions.
// Only the main loop reads from stdin; toolCallBridge waits on a promise that
// the main loop resolves when the matching JSON-RPC response arrives.
const stdinReader = readLines(Deno.stdin);
let requestIdCounter = 0;
const pendingHostResponses = new Map();
const pendingHostRequests = [];
const pendingHostRequestWaiters = [];

const TOOL_BRIDGE_ERROR_KEY = "__dspy_tool_bridge_error__";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextToolRequestId() {
  requestIdCounter += 1;
  return `tool-${requestIdCounter}`;
}

function rejectPendingHostResponses(message) {
  for (const pending of pendingHostResponses.values()) {
    pending.reject(new Error(message));
  }
  pendingHostResponses.clear();
}

function enqueueHostRequest(request) {
  const waiter = pendingHostRequestWaiters.shift();
  if (waiter) {
    waiter(request);
    return;
  }
  pendingHostRequests.push(request);
}

function nextHostRequest() {
  if (pendingHostRequests.length > 0) {
    return Promise.resolve(pendingHostRequests.shift());
  }
  return new Promise((resolve) => pendingHostRequestWaiters.push(resolve));
}

async function readStdinLoop() {
  try {
    while (true) {
      const { value: line, done } = await stdinReader.next();
      if (done) {
        rejectPendingHostResponses("stdin closed while waiting for tool response");
        enqueueHostRequest(null);
        return;
      }

      let input;
      try {
        input = JSON.parse(line);
      } catch (error) {
        // JSON-RPC parse error
        console.log(jsonrpcError(JSONRPC_PROTOCOL_ERRORS.ParseError, "Invalid JSON input: " + error.message, null));
        continue;
      }

      // Validate JSON-RPC format
      if (typeof input !== 'object' || input === null || input.jsonrpc !== "2.0") {
        console.log(jsonrpcError(JSONRPC_PROTOCOL_ERRORS.InvalidRequest, "Invalid Request: not a JSON-RPC 2.0 message", null));
        continue;
      }

      const requestId = input.id;

      // Route responses to the sandbox-side caller that is waiting on them.
      if ("result" in input || "error" in input) {
        const pendingResponse = pendingHostResponses.get(requestId);
        if (pendingResponse) {
          pendingHostResponses.delete(requestId);
          pendingResponse.resolve(input);
        } else {
          console.error(`Unexpected JSON-RPC response with id ${String(requestId)}`);
        }
        continue;
      }

      if (input.method === "shutdown") {
        rejectPendingHostResponses("runner shutdown while waiting for tool response");
        enqueueHostRequest(input);
        return;
      }

      enqueueHostRequest(input);
    }
  } catch (error) {
    rejectPendingHostResponses(`stdin reader failed: ${error.message}`);
    console.log(jsonrpcError(JSONRPC_APP_ERRORS.RuntimeError, `stdin reader failed: ${error.message}`, null));
    enqueueHostRequest(null);
  }
}

// This function is called from Python to invoke a host-side tool
async function toolCallBridge(name, argsJson) {
  const requestId = nextToolRequestId();

  try {
    const parsedArgs = JSON.parse(argsJson);

    const pendingResponse = createDeferred();
    pendingHostResponses.set(requestId, pendingResponse);

    // Send tool call request to host using JSON-RPC
    console.log(jsonrpcRequest("tool_call", {
      name: name,
      kwargs: parsedArgs.kwargs || {}
    }, requestId));

    // Wait for response from host. The main loop resolves this promise when it
    // receives the matching JSON-RPC response on stdin.
    const response = await pendingResponse.promise;

    // Expect JSON-RPC result or error with matching id
    if (response.id !== requestId) {
      return {
        [TOOL_BRIDGE_ERROR_KEY]: true,
        message: `Tool bridge error for '${name}': Unexpected response: expected id ${requestId}, got ${response.id}`
      };
    }

    if (response.error) {
      const errorType = response.error.data?.type || "ToolError";
      const errorMessage = response.error.message || "Tool call failed";
      return {
        [TOOL_BRIDGE_ERROR_KEY]: true,
        message: `${errorType}: ${errorMessage}`
      };
    }

    // Deserialize result based on type
    const result = response.result;
    if (result.type === "json") {
      return JSON.parse(result.value);
    }
    return result.value;
  } catch (error) {
    // Return a structured error payload so Python can raise with full context
    // without triggering a top-level unhandled rejection in Deno.
    return {
      [TOOL_BRIDGE_ERROR_KEY]: true,
      message: `Tool bridge error for '${name}': ${error.message}`
    };
  } finally {
    pendingHostResponses.delete(requestId);
  }
}

// Expose the bridge to Python
pyodide.globals.set("_js_tool_call", toolCallBridge);

void readStdinLoop();

try {
  const env_vars = (Deno.args[0] ?? "").split(",").filter(Boolean);
  for (const key of env_vars) {
    const val = Deno.env.get(key);
    if (val !== undefined) {
      pyodide.runPython(`
import os
os.environ[${JSON.stringify(key)}] = ${JSON.stringify(val)}
      `);
    }
  }
} catch (e) {
  console.error("Error setting environment variables in Pyodide:", e);
}

// Main loop processing requests/notifications queued by the stdin pump.
while (true) {
  const input = await nextHostRequest();
  if (input === null) break;

  const method = input.method;
  const params = input.params || {};
  const requestId = input.id; // May be undefined for notifications

  // Handle notifications (no response expected)
  if (method === "sync_file") {
    try {
      const virtualPath = params.virtual_path;
      const hostPath = params.host_path || virtualPath;
      await Deno.writeFile(hostPath, pyodide.FS.readFile(virtualPath));
    } catch (e) { /* ignore sync errors */ }
    continue;
  }

  if (method === "shutdown") break;

  // Handle requests (expect response)
  if (method === "mount_file") {
    const hostPath = params.host_path;
    const virtualPath = params.virtual_path || hostPath;
    try {
      const contents = await Deno.readFile(hostPath);
      const dirs = virtualPath.split('/').slice(1, -1);
      let cur = '';
      for (const d of dirs) {
        cur += '/' + d;
        // Check if directory exists before creating
        try {
          pyodide.FS.stat(cur);
          // Directory exists, continue to next
        } catch {
          // Directory doesn't exist, create it
          pyodide.FS.mkdir(cur);
        }
      }
      pyodide.FS.writeFile(virtualPath, contents);
      console.log(jsonrpcResult({ mounted: virtualPath }, requestId));
    } catch (e) {
      console.log(jsonrpcError(JSONRPC_APP_ERRORS.RuntimeError, `Failed to mount file: ${e.message}`, requestId));
    }
    continue;
  }

  if (method === "register") {
    const toolNames = [];

    // Register tools with typed signatures
    if (params.tools) {
      for (const tool of params.tools) {
        // Support both old format (string) and new format (object with parameters)
        if (typeof tool === 'string') {
          pyodide.runPython(makeToolWrapper(tool, []));
          toolNames.push(tool);
        } else {
          pyodide.runPython(makeToolWrapper(tool.name, tool.parameters || []));
          toolNames.push(tool.name);
        }
      }
    }

    // Always refresh SUBMIT. This restores the canonical binding if user code
    // shadowed it in a previous execution. When outputs are absent, fall back
    // to the single-output default wrapper.
    pyodide.runPython(makeSubmitWrapper(params.outputs || []));

    console.log(jsonrpcResult({
      tools: toolNames,
      outputs: params.outputs ? params.outputs.map(o => o.name) : []
    }, requestId));
    continue;
  }

  if (method === "inject_var") {
    const { name, value } = params;
    try {
      try { pyodide.FS.mkdir('/tmp'); } catch (e) { /* exists */ }
      try { pyodide.FS.mkdir('/tmp/dspy_vars'); } catch (e) { /* exists */ }
      pyodide.FS.writeFile(`/tmp/dspy_vars/${name}.json`, new TextEncoder().encode(value));
      console.log(jsonrpcResult({ injected: name }, requestId));
    } catch (e) {
      console.log(jsonrpcError(JSONRPC_APP_ERRORS.RuntimeError, `Failed to inject var: ${e.message}`, requestId));
    }
    continue;
  }

  if (method === "execute") {
    const code = params.code || "";
    let setupCompleted = false;  // Track if PYTHON_SETUP_CODE ran successfully
    activeExecuteRequestId = requestId;

    try {
      await pyodide.loadPackagesFromImports(code);
      pyodide.runPython(PYTHON_SETUP_CODE);
      setupCompleted = true;  // Mark setup as complete - old_stdout/old_stderr now exist

      // Run the user's code
      const result = await pyodide.runPythonAsync(code);
      const capturedStdout = pyodide.runPython("buf_stdout.getvalue()");

      // If result is None, output prints; otherwise output the result
      let output = (result === null || result === undefined) ? capturedStdout : (result.toJs?.() ?? result);
      console.log(jsonrpcResult({ output }, requestId));
    } catch (error) {
      // We have an error => check if it's a SyntaxError or something else
      // The Python error class name is stored in error.type: https://pyodide.org/en/stable/usage/api/js-api.html#pyodide.ffi.PythonError
      let errorType = error.type || "Error";
      // error.message is mostly blank for Python exceptions, especially SyntaxError.
      const fallbackMessage = String(error?.message || error || "Unknown error").trim();

      // Handle FinalOutput as a success result, not an error
      if (errorType === "FinalOutput") {
        const last_exception_args = pyodide.globals.get("last_exception_args");
        const errorArgs = JSON.parse(last_exception_args()) || [];
        const answer = errorArgs[0] || null;
        console.log(jsonrpcResult({ final: answer }, requestId));
        continue;
      }

      // Get error args and location for other exception types
      let errorArgs = [];
      let errorLocation = null;
      let errorTraceback = null;
      let errorMessage = fallbackMessage;
      if (setupCompleted) {
        const last_exception_args = pyodide.globals.get("last_exception_args");
        const last_exception_type = pyodide.globals.get("last_exception_type");
        const last_exception_message = pyodide.globals.get("last_exception_message");
        const last_exception_location = pyodide.globals.get("last_exception_location");
        // Regarding https://pyodide.org/en/stable/usage/type-conversions.html#type-translations-errors,
        // we do a additional `json.dumps` and `JSON.parse` on the values, to avoid the possible memory leak.
        errorArgs = JSON.parse(last_exception_args()) || [];

        const exceptionType = last_exception_type();
        if (exceptionType) {
          errorType = exceptionType;
        }

        const exceptionMessage = last_exception_message();

        const locationJson = last_exception_location();
        if (locationJson) {
          errorLocation = JSON.parse(locationJson);
        }

        if (errorType === "MemoryError") {
          const last_exception_traceback = pyodide.globals.get("last_exception_traceback");
          errorTraceback = last_exception_traceback();
        }

        errorMessage = errorType === "SyntaxError"
          ? (exceptionMessage || formatErrorArgs(errorArgs, fallbackMessage))
          : formatErrorArgs(errorArgs, exceptionMessage || fallbackMessage);
      }

      // Map error type to JSON-RPC error code
      const errorCode = JSONRPC_APP_ERRORS[errorType] || JSONRPC_APP_ERRORS.Unknown;
      console.log(jsonrpcError(errorCode, errorMessage, requestId, {
        type: errorType,
        args: errorArgs,
        location: errorLocation,
        traceback: errorTraceback,
      }));
    } finally {
      // Always restore stdout/stderr if setup completed, even after errors.
      // This prevents stream corruption where subsequent executions capture
      // StringIO buffers as old_stdout/old_stderr instead of real streams.
      if (setupCompleted) {
        try {
          pyodide.runPython("sys.stdout, sys.stderr = old_stdout, old_stderr");
        } catch (e) {
          // Ignore restoration errors to avoid masking the original error
        }
      }
      activeExecuteRequestId = null;
    }
    continue;
  }

  // Unknown method
  console.log(jsonrpcError(JSONRPC_PROTOCOL_ERRORS.MethodNotFound, `Method not found: ${method}`, requestId));
}

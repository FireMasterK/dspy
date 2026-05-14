import io
import json

from dspy.primitives.python_interpreter import PythonInterpreter


class _FakeStdin:
    def __init__(self):
        self.writes = []
        self.closed = False

    def write(self, data: str) -> None:
        self.writes.append(data)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _FakeStdout:
    def __init__(self, lines: list[str]):
        self._lines = [line if line.endswith("\n") else line + "\n" for line in lines]
        self.closed = False

    def readline(self) -> str:
        if not self._lines:
            return ""
        return self._lines.pop(0)

    def close(self) -> None:
        self.closed = True


class _FakeStderr(io.StringIO):
    def __init__(self, initial_value: str = ""):
        super().__init__(initial_value)
        self.closed_flag = False

    def close(self) -> None:
        self.closed_flag = True
        super().close()


class _FakeProcess:
    def __init__(self, stdout_lines: list[str]):
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout(stdout_lines)
        self.stderr = _FakeStderr("")
        self.alive = True
        self.terminated = False
        self.killed = False
        self.wait_calls = 0

    def poll(self):
        return None if self.alive else 0

    def terminate(self):
        self.terminated = True
        self.alive = False

    def kill(self):
        self.killed = True
        self.alive = False

    def wait(self, timeout=None):
        self.wait_calls += 1
        self.alive = False
        return 0


class _NoopSetupInterpreter(PythonInterpreter):
    def _ensure_deno_process(self) -> None:
        return None

    def _mount_files(self):
        return None

    def _register_tools(self) -> None:
        return None


class _ResetTrackingInterpreter(PythonInterpreter):
    def __init__(self):
        super().__init__()
        self.start_calls = 0

    def start(self) -> None:
        self.start_calls += 1


def test_send_request_resets_process_on_mismatched_response():
    interpreter = PythonInterpreter()
    process = _FakeProcess(
        [
            json.dumps({"jsonrpc": "2.0", "result": {"output": "stale"}, "id": 5}),
            json.dumps({"jsonrpc": "2.0", "result": {"output": "fresh"}, "id": 6}),
        ]
    )
    interpreter.deno_process = process
    interpreter._request_id = 5

    try:
        interpreter._send_request("execute", {"code": "print('ok')"}, "during unit test")
        raise AssertionError("Expected protocol desync error")
    except Exception as exc:
        message = str(exc)

    assert "Protocol desynchronized during unit test" in message
    assert interpreter.deno_process is None
    assert process.terminated or process.killed or process.stdin.closed


def test_send_request_resets_process_on_unexpected_tool_call():
    interpreter = PythonInterpreter(tools={"echo": lambda value: value})
    process = _FakeProcess(
        [
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "tool_call",
                    "params": {"name": "echo", "kwargs": {"value": "from-stale-request"}},
                    "id": "tc_old",
                }
            ),
            json.dumps({"jsonrpc": "2.0", "result": {"registered": True}, "id": 1}),
        ]
    )
    interpreter.deno_process = process

    try:
        interpreter._send_request("register", {}, "during unit test")
        raise AssertionError("Expected protocol desync error")
    except Exception as exc:
        message = str(exc)

    assert "Protocol desynchronized during unit test" in message
    assert "tc_old" in message
    assert interpreter.deno_process is None
    assert process.terminated or process.killed or process.stdin.closed


def test_execute_resets_process_on_mismatched_response():
    interpreter = _NoopSetupInterpreter()
    process = _FakeProcess(
        [
            json.dumps({"jsonrpc": "2.0", "result": {"output": "old"}, "id": 2}),
            json.dumps({"jsonrpc": "2.0", "result": {"output": "current"}, "id": 3}),
        ]
    )
    interpreter.deno_process = process
    interpreter._request_id = 2

    try:
        interpreter.execute("print('current')")
        raise AssertionError("Expected protocol desync error")
    except Exception as exc:
        message = str(exc)

    assert "Protocol desynchronized during execution" in message
    assert interpreter.deno_process is None
    assert process.terminated or process.killed or process.stdin.closed


def test_execute_resets_process_on_unhandled_async_error():
    interpreter = _NoopSetupInterpreter()
    process = _FakeProcess(
        [
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32007,
                        "message": 'NotCapable: Requires net access to "example.com:443", run again with the --allow-net flag',
                        "data": {
                            "type": "JsException",
                            "args": [
                                'NotCapable: Requires net access to "example.com:443", run again with the --allow-net flag'
                            ],
                            "location": {"filename": "<exec>", "lineno": 2, "function": "<module>"},
                            "unhandled_async": True,
                        },
                    },
                    "id": 1,
                }
            )
        ]
    )
    interpreter.deno_process = process

    try:
        interpreter.execute('import js\nawait js.fetch("https://example.com")')
        raise AssertionError("Expected unhandled async error")
    except Exception as exc:
        message = str(exc)

    assert "JsException" in message
    assert "Requires net access" in message
    assert "restarted" in message
    assert interpreter.deno_process is None
    assert process.killed or process.stdin.closed


def test_execute_request_includes_cpu_time_limit():
    interpreter = _NoopSetupInterpreter(max_cpu_time_seconds=0.25)
    process = _FakeProcess([json.dumps({"jsonrpc": "2.0", "result": {"output": 2}, "id": 1})])
    interpreter.deno_process = process

    result = interpreter.execute("1 + 1")

    assert result == 2
    request = json.loads(process.stdin.writes[0])
    assert request["method"] == "execute"
    assert request["params"]["max_cpu_time_seconds"] == 0.25


def test_execute_request_uses_default_cpu_time_limit():
    interpreter = _NoopSetupInterpreter()
    process = _FakeProcess([json.dumps({"jsonrpc": "2.0", "result": {"output": 2}, "id": 1})])
    interpreter.deno_process = process

    result = interpreter.execute("1 + 1")

    assert result == 2
    request = json.loads(process.stdin.writes[0])
    assert request["method"] == "execute"
    assert request["params"]["max_cpu_time_seconds"] == 8.0


def test_execute_request_can_disable_default_cpu_time_limit():
    interpreter = _NoopSetupInterpreter(max_cpu_time_seconds=None)
    process = _FakeProcess([json.dumps({"jsonrpc": "2.0", "result": {"output": 2}, "id": 1})])
    interpreter.deno_process = process

    result = interpreter.execute("1 + 1")

    assert result == 2
    request = json.loads(process.stdin.writes[0])
    assert request["method"] == "execute"
    assert request["params"]["max_cpu_time_seconds"] is None


def test_tool_call_limit_resets_process_and_raises():
    interpreter = PythonInterpreter(tools={"echo": lambda value: value}, max_tool_calls_per_execution=1)
    process = _FakeProcess([])
    interpreter.deno_process = process
    interpreter._active_max_tool_calls_per_execution = 1
    interpreter._tool_calls_this_execution = 1

    try:
        interpreter._handle_tool_call(
            {
                "jsonrpc": "2.0",
                "method": "tool_call",
                "params": {"name": "echo", "kwargs": {"value": "again"}},
                "id": "tool-2",
            }
        )
        raise AssertionError("Expected tool call limit error")
    except Exception as exc:
        message = str(exc)

    assert "Tool call limit exceeded (1)" in message
    assert interpreter.deno_process is None
    assert process.killed or process.stdin.closed


def test_format_remote_memory_error_includes_location_and_traceback():
    message = PythonInterpreter._format_remote_error(
        "MemoryError",
        "MemoryError",
        {
            "args": ["MemoryError"],
            "location": {"filename": "<exec>", "lineno": 3, "function": "blow_up"},
            "traceback": 'Traceback (most recent call last):\n  File "<exec>", line 3, in blow_up\nMemoryError',
        },
    )

    assert "MemoryError: ['MemoryError']" in message
    assert "Location: <exec>:3 in blow_up" in message
    assert "Traceback:" in message


def test_reset_force_clears_process_and_large_var_state():
    interpreter = _ResetTrackingInterpreter()
    process = _FakeProcess([])
    interpreter.deno_process = process
    interpreter._mounted_files = True
    interpreter._tools_registered = True
    interpreter._owner_thread = 123
    interpreter._request_id = 99
    interpreter._pending_large_vars = {"document": "x" * 100}

    interpreter.reset()

    assert interpreter.deno_process is None
    assert interpreter._mounted_files is False
    assert interpreter._tools_registered is False
    assert interpreter._owner_thread is None
    assert interpreter._request_id == 0
    assert interpreter._pending_large_vars == {}
    assert process.killed or process.stdin.closed
    assert process.stdout.closed
    assert process.stderr.closed_flag


def test_stop_process_closes_all_streams_for_exited_process():
    interpreter = PythonInterpreter()
    process = _FakeProcess([])
    process.alive = False
    interpreter.deno_process = process

    interpreter.reset()

    assert interpreter.deno_process is None
    assert process.stdin.closed
    assert process.stdout.closed
    assert process.stderr.closed_flag

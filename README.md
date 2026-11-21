# Screen state control / 屏幕状态控制

A DeepSeek Harness plugin that controls the Mac's screen state **while tasks are running**, without ever suspending a process.

一个在**任务运行期间**控制 Mac 屏幕状态的 DeepSeek Harness 插件，绝不挂起任何进程。

## What it does / 功能

While any agent, subagent, or background job is working, the plugin holds a macOS wake lock (`caffeinate`) so a long turn is not cut off by idle sleep. Two modes:

- **`keep-awake`** (default) — keeps the display on (`-d -i -s -m -w <hostPid>`).
- **`display-off`** — lets the display go dark while the system and every process keep running (`-i -s -m -w <hostPid>`, no `-d`). Optionally blanks the screen immediately via `pmset displaysleepnow` (no sudo).

When the last task finishes, the lock is held through a configurable **grace period** (default 60s) and then released. macOS then follows its own power settings and may sleep naturally. The plugin **never actively sleeps, suspends, or shuts down** the machine.

任务运行时持有 `caffeinate` 唤醒锁，防止长回合被空闲睡眠打断。两种模式：

- **`keep-awake`**（默认）——屏幕常亮。
- **`display-off`**——允许屏幕熄灭，但系统与所有进程继续运行（不含 `-d`），可选立即黑屏。

最后一个任务结束后，按可配置**宽限期**（默认 60 秒）释放唤醒锁，系统按自身设置自然睡眠。插件**绝不主动睡眠、挂起或关机**。

## Safety / 安全设计

1. **Least privilege** — only the built-in `/usr/bin/caffeinate` (and optional `pmset displaysleepnow`) is spawned. No sudo, no daemon, no preference files touched.
2. **Process binding** — every lock uses `-w <hostPid>`; if the host exits, the OS releases the assertion automatically. No orphan lock.
3. **Argument whitelist** — flags are fixed constants selected by booleans, pid is coerced to a number, `spawn()` takes an argv array with no shell. Command injection is impossible.
4. **Fail-safe** — any error resolves to a released state; a bug can never leave the machine pinned awake.
5. **Platform gate** — macOS only; on other platforms the plugin stays inactive.
6. **Idle detection** — uses `agent/status`, `subagent/start/end`, background jobs, and a `whenIdle()`/seq convergence re-check, because `Agent.status` misreports `idle` during maintenance and compaction.

## Usage / 用法

Via the `/screen` command:

```
/screen status          # current state
/screen awake           # keep-awake mode + hold now
/screen dark            # display-off mode + hold now
/screen hold            # acquire lock now
/screen release         # release lock now
/screen auto on|off     # enable/disable automatic task-based control
```

Or ask the agent to use the `screen_control` tool (actions: `status`, `mode`, `hold`, `release`, `auto`).

## Configuration / 配置

Set in the plugin row's `config` (Plugins page or `cordis.patch.yml`):

| key | default | meaning |
|---|---|---|
| `mode` | `keep-awake` | `keep-awake` or `display-off` |
| `auto` | `true` | hold the lock while tasks run |
| `graceSeconds` | `60` | seconds to hold after the last task |
| `displayOffNow` | `false` | also blank the screen immediately in display-off mode |
| `auditLog` | `true` | log switches and lock acquire/release |

## Requirements / 要求

- macOS (Darwin). Uses the built-in `caffeinate` and, optionally, `pmset`.
- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`.

## Install / 安装

```
dsh plugin add https://github.com/jyz48prsbr-netizen/dsh-screen-control
```

## License

MIT

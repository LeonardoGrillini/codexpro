# VM usage for AI agents

CodexPro provides disposable guests for testing software: **Windows: Hyper-V; Linux: QEMU/KVM; macOS: QEMU/HVF**. Treat a VM as a separate execution environment from the host repository. Backend selection and guest-control transport are automatic.

## Rules

1. Never install or import VM images yourself. Image approval and import are human operations through `codexpro vm setup`.
2. Only use images already returned by the lifecycle `vm` tool's `images` action.
3. Treat the VM filesystem as disposable and collect required artifacts before destroying it.
4. Never assume host secrets, SSH keys, browser state, environment variables, or the host workspace exist inside the guest.
5. Never attempt to modify the immutable base image or commit a disposable overlay into it.
6. Use `vm_guest_status` before guest work when availability is uncertain.
7. Prefer `argv` in `vm_exec`. Use `command` only when shell syntax is actually needed, and always select the shell explicitly.
8. A nonzero guest exit code is a command result, not proof that the VM transport failed. Inspect `exitCode`, `stdout`, `stderr`, and `timedOut`.
9. Do not turn guest paths into host paths. `vm_upload` accepts bounded base64 data only; `vm_download` retains bounded base64 in an in-memory output resource and returns its resource ID.
10. Hyper-V credentials are operation-scoped inputs. Never echo, log, persist, return, or write them into the repository.
11. Destroy disposable instances when they are no longer needed.
12. State clearly whether evidence came from host tools or from a VM.

VMs improve isolation, but they do not make every unsafe action safe. Continue to minimize privileges, network exposure, and destructive behavior.

## Lifecycle tool

The existing `vm` tool owns lifecycle only:

```json
{ "action": "images" }
```

```json
{ "action": "create", "image": "windows-driver-dev" }
```

```json
{ "action": "status", "id": "vm-0123456789abcdef" }
```

```json
{ "action": "destroy", "id": "vm-0123456789abcdef" }
```

It does not accept image-import paths, arbitrary host deletion targets, raw QMP commands, guest commands, or arbitrary host PowerShell.

## `vm_guest_status`

Use this to determine whether command/file guest control is currently usable.

```json
{ "id": "vm-0123456789abcdef" }
```

For Hyper-V Windows guests, supply valid guest credentials for a real PowerShell Direct connectivity check:

```json
{
  "id": "vm-0123456789abcdef",
  "credential": {
    "username": "devuser",
    "password": "[REDACTED_SECRET]"
  }
}
```

Typical reasons for unavailability include a stopped VM, missing/disconnected QEMU Guest Agent, a QGA command disabled by the guest administrator, missing Hyper-V credentials, or PowerShell Direct authentication failure. Do not print the credential in reports.

## `vm_exec`

Exactly one of `argv` or `command` is required.

Prefer direct argv execution:

```json
{
  "id": "vm-0123456789abcdef",
  "argv": ["python3", "-m", "pytest", "-q"],
  "env": { "CI": "1" },
  "timeout_ms": 120000
}
```

Use an explicit shell when shell syntax or a working directory is needed:

```json
{
  "id": "vm-0123456789abcdef",
  "command": "npm test",
  "shell": "bash",
  "cwd": "/work/project",
  "timeout_ms": 120000
}
```

Windows/Hyper-V example:

```json
{
  "id": "vm-0123456789abcdef",
  "command": "& msbuild.exe .\\driver.sln /m /p:Configuration=Debug",
  "shell": "powershell",
  "cwd": "C:\\work\\driver",
  "timeout_ms": 300000,
  "credential": {
    "username": "devuser",
    "password": "[REDACTED_SECRET]"
  }
}
```

The normalized result contains `exitCode`, separate `stdout` / `stderr`, `timedOut`, stdout/stderr truncation flags, and the internal transport label. Output is capped at 48 KiB per stream. Default timeout is 30 seconds; maximum timeout is 300 seconds.

Direct `argv` does not accept `cwd`. For shell mode, `cwd` is implemented by a fixed guest-side wrapper. `cmd` + `cwd` is not supported; use PowerShell for a Windows working directory.

## `vm_upload` and `vm_download`

Upload accepts canonical standard base64, not a host path:

```json
{
  "id": "vm-0123456789abcdef",
  "guest_path": "/work/project/source.tar",
  "data_base64": "<base64>"
}
```

Hyper-V adds the operation-scoped `credential` object shown above. Download takes `id` + `guest_path` (+ Hyper-V credential when needed) and returns `bytes`, `workspace_id`, `output_resource_id`, `stream=stdout`, `encoding=base64`, and `total_chars`. Read the retained base64 with `read_output`, following `next_offset` until null; concatenate all pages before decoding.

Each file is limited to 1 MiB. QEMU transfers use QGA guest-file APIs in 48 KiB chunks; Hyper-V uses a temporary file inside the CodexPro-owned instance directory plus `Copy-Item -ToSession` / `-FromSession`. Agents cannot name arbitrary host source or destination paths.

## Recommended driver-development workflow

```text
inspect host repository
→ choose a human-approved Windows development image
→ create disposable VM
→ vm_guest_status with operation-scoped Windows credentials
→ vm_upload source/build inputs
→ vm_exec PowerShell / MSBuild / Visual Studio Build Tools / WDK commands
→ inspect stdout/stderr and exitCode
→ run bounded install/test commands where appropriate
→ vm_download logs, dumps, and build artifacts
→ destroy VM
```

Do not hardcode WDK behavior into assumptions about the generic VM tools. They are shell/file primitives and should work for other guest workflows too.

## Backend behavior

QEMU guest operations use the private QEMU Guest Agent channel already recorded for the managed instance. A client timeout forces QGA protocol resynchronization before later commands. If `vm_exec` itself reaches its overall timeout, QGA has no generic process-kill RPC, so the guest process may continue; destroy or reset the disposable VM if continuing execution is unacceptable.

Hyper-V guest operations use PowerShell Direct with the persisted/verified VM GUID, never a caller-supplied Hyper-V name. PowerShell Direct does not require guest networking or WinRM. The host PowerShell script is fixed and receives all guest values as structured data. The PSSession is disposed after each operation.

Hyper-V networking remains disconnected by default unless a human changes it. QEMU retains user-mode networking. Neither backend automatically mounts the workspace or injects host credentials.

## Host versus VM

```text
Host bash:
    protected local developer execution
    existing CodexPro host safety rules still apply
    not an OS sandbox

VM execution:
    disposable OS-level guest environment
    immutable base + per-instance overlay
    normalized guest API
    Hyper-V: PowerShell Direct
    QEMU: QEMU Guest Agent
```

Persistent PTYs, GUI automation, and arbitrary backend-specific management are intentionally outside this interface.

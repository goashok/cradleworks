# MicroVM sandboxes: an evaluation

Status: written for M4, 2026-11-22. No change made; a spike is recommended below, but not run.

## The question

Today each task runs in a Docker container: no capabilities, no new privileges, a read-only
root, limits on processes, memory and CPU, and no network route out except the sandbox's own
egress proxy. The kernel is the boundary. A container escape (a kernel bug reachable from inside,
or a misconfiguration) gives the agent whatever the container host has.

A microVM puts a second kernel between the agent and the host. Is it worth it, and which one?

## What a container escape would reach today

- **On macOS (Docker Desktop):** the shared Linux VM that runs every container. From there it
  can reach the other sandboxes running at the same time and the bind-mounted worktrees under
  `~/.cradleworks/work`. It can't reach the Mac itself, your SSH keys, the Keychain or other
  repositories, unless Docker Desktop's file sharing exposes them. Since M4 the model credential
  sits in the proxy's mount, not the sandbox's, but an escape into the VM could read it there.
- **On a Linux host:** the host itself, as root unless Docker runs rootless.

So the extra layer matters most on Linux hosts, and for teams running several people's tasks on
one machine.

## Options

| Option | Isolation | Runs on | Start time | Fit with the factory |
| --- | --- | --- | --- | --- |
| Docker + runc (today) | Namespaces, seccomp, dropped capabilities | Everywhere | ~1 s | In place |
| gVisor (`runsc`) | A user-space kernel intercepts system calls | Linux (x86-64, arm64) | ~1 s | A Docker runtime flag; same adapter. Some toolchains (JVM, file watchers) get slower |
| Kata Containers | A lightweight VM per container, behind the OCI interface | Linux with KVM | 1-3 s | A Docker or containerd runtime; same adapter, if nested virtualisation is available |
| Firecracker (direct) | A microVM per sandbox | Linux with KVM | <1 s to boot | A new adapter: images become root filesystems, networking and file sharing are ours to build |
| Apple `container` | A lightweight VM per container | macOS 26 on Apple silicon | ~1 s | A new adapter with an OCI-image CLI close to Docker's; the closest fit for Mac users |
| Hosted sandboxes (cloud microVMs) | A VM per sandbox, someone else's machine | Anywhere with an API | Seconds | A new adapter; the worktree has to move to them and back, and so does the proxy design |

Firecracker and Kata both need KVM. Docker Desktop on Apple silicon doesn't offer nested
virtualisation to its Linux VM, so neither runs on a Mac without another layer.

## Recommendation

1. **Keep Docker as the default.** It works the same on every developer machine, and the M4
   controls (no credential inside, an allow-list, hard rules, a secret scan, a command deny list)
   don't depend on the kernel boundary holding.
2. **Linux hosts: offer gVisor as a setting first.** It's the cheapest real gain: one runtime
   option on the existing adapter (`sandbox.runtime: runsc`), no new images, and it works
   without KVM. Measure the eval suite's run time with it; the JVM projects are the risk.
3. **Shared or unattended hosts: Kata or Firecracker.** Kata first, because it keeps the OCI
   images and the Docker adapter. Firecracker directly only if start time or density matters
   more than the adapter work.
4. **Macs: spike an Apple `container` adapter** when someone runs the factory on macOS 26. It
   would give each task its own VM without Docker Desktop. The spike: run the Sandbox contract
   suite against it, with the egress proxy as a second container on an internal network.

None of this is needed for the reference projects; it's for running other people's tasks on a
shared machine.

## What a spike would check

The `Sandbox` contract suite (`packages/contracts`) already defines what any sandbox must do: run
commands, stream output, kill a process tree, enforce the network policy, and give the worktree
back. A new runtime passes when that suite and the live Claude Code contract pass on it, and
the eval suite's median run time stays within 20% of Docker's.

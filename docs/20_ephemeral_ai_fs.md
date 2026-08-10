# 20. Ephemeral AI FS replacement

> [!NOTE]
> This document describes the target architecture. The checked-in Computer
> implementation still uses `@cloudflare/dofs` until the migration and cutover
> requirements below pass.

Ephemeral AI FS is the default production replacement for the filesystem
subsystem used by Ephemeral AI Computer. It replaces the current filesystem
facade, namespace and content engine, schema, and Node-compatible virtual
filesystem provider on the default path. It does not replace Durable Objects,
Durable Object SQLite, `computerd`, FUSE, or the execution runtimes.

Computer retains DOFS as an optional comparison engine. It can be selected
explicitly by tests and benchmarks but is never an automatic fallback.

## Current boundary

The current authoritative path is:

```text
workspace.fs
    |
@cloudflare/dofs WorkspaceFilesystem
    |
DOFS filesystem primitives, schema, and content storage
    |
Durable Object SQLite
```

The current execution-side path is:

```text
Linux tools
    |
FUSE and @platformatic/vfs
    |
@cloudflare/dofs SQLiteWorkspaceProvider
    |
local SQLite mirror
```

`@cloudflare/dofs` also supplies sync data structures and operations used by
the remote procedure call layer. Those consumers must move to the Ephemeral AI
FS revision, manifest, object, and branch contracts.

## Target boundary

```text
Authoritative side                         Execution side

Workspace and branch API                   Linux tools and agents
          |                                         |
Workspace Durable Object                           FUSE
          |                                         |
workspace.fs: EphemeralFilesystem          node/VFS provider bridge
          |                                         |
Ephemeral AI FS <--- versioned sync ----> Ephemeral AI FS
          |                                         |
Cloudflare SQLite adapter                   Node.js SQLite adapter
          |                                         |
Durable Object SQLite                       local SQLite mirror
```

One selected filesystem implementation runs on both sides of a workspace.
Ephemeral AI FS is the default. DOFS remains available through an explicit
comparison selection. The two Ephemeral AI FS database adapters connect the
same portable engine to different SQLite runtimes; they do not implement
alternate filesystem behavior.

```text
ephemeral-ai-fs   default production and branch-capable engine
dofs              optional comparison engine for tests and benchmarks
```

The engines use separate databases. Computer must not switch engines while a
workspace is open or fall back after an error.

## Ownership

| Layer | Owner |
| --- | --- |
| Filesystem API, namespace, and metadata | Ephemeral AI FS |
| `workspace.fs` and branch composition | Ephemeral AI Computer |
| Durable Object identity and request routing | Ephemeral AI Computer |
| Authentication and sync RPC transport | Ephemeral AI Computer |
| Replication protocol and durable state | Ephemeral AI FS |
| `computerd`, FUSE, mounts, and process execution | Ephemeral AI Computer |
| Content, branches, publication, recovery, and collection | Ephemeral AI FS |
| Cloudflare and Node.js SQLite database adapters | Ephemeral AI FS |
| DOFS comparison adapter and benchmark selection | Ephemeral AI Computer |
| Durable Object SQLite service | Cloudflare runtime |

Computer-owned integration code may transport calls across Workers remote
procedure calls and translate Node-style or FUSE operations. It must not
create another filesystem API, schema, content engine, conflict model, or
garbage collector.

## Public API transition

`workspace.fs` remains the user-facing Computer property, but its filesystem
contract becomes `EphemeralFilesystem`. A Workers remote procedure call facade
must mirror that contract one-for-one. Computer may add convenience helpers
built from the portable primitives, but those helpers do not define separate
filesystem semantics.

Differences from the old `WorkspaceFilesystem` API are preview API migration
changes. Each difference must be listed explicitly and covered by migration
documentation rather than hidden behind a permanent compatibility API.

The DOFS comparison adapter must present the same common Computer filesystem
surface. It may report branch and publication capabilities as unsupported; it
must not emulate them with different semantics.

The branch API is additive:

```ts
const branch = await workspace.branches.create({ id: "agent-a" });
await branch.runtime.exec("npm test", { backend: "container" });
const result = await branch.publish({ operationId: requestId });
```

The branch handle selects the Ephemeral AI FS view used by the execution
backend. Reconnect must restore the same branch identity rather than opening
main or another agent's branch.

## Migration and cutover

The legacy representation may coexist with Ephemeral AI FS during migration
and afterward as the isolated comparison engine:

1. Record the unmodified upstream behavior and wire results.
2. Add the Computer compatibility bridge and both Ephemeral AI FS database
   adapters.
3. Route newly created replacement workspaces through Ephemeral AI FS on the
   authoritative and execution sides.
4. Migrate existing workspaces restartably, verify the new representation,
   and retain a tested rollback path for the preview window.
5. Make Ephemeral AI FS the default production path and retain DOFS behind the
   explicit comparison selector.

The engine selector is an internal benchmark and compatibility feature, not an
automatic fallback. Each workspace records one engine and uses it for its
authoritative and execution-side stores.

## Cutover criteria

The replacement is complete only when:

- authoritative and local adapters pass the Ephemeral AI FS conformance suite;
- `workspace.fs`, sync, `computerd`, FUSE, shell, Git, mounts, and tools use the
  replacement path;
- publication, restart, reconnect, migration, rollback, and garbage collection
  tests pass;
- the full push, execute, pull, publish, and verify path preserves content and
  namespace metadata;
- unsupported protocol pairs fail before changing either side; and
- omitted engine configuration selects Ephemeral AI FS;
- explicit DOFS selection runs the common comparison workload; and
- an engine error never causes automatic fallback or cross-engine database
  access.

Durable Object SQLite remains the authoritative database before, during, and
after this cutover.

Use [21. Ephemeral AI FS swap](./21_ephemeral_ai_fs_swap.md) as the Computer-side
implementation checklist after the filesystem packages are ready.

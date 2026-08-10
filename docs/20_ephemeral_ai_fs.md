# 20. Ephemeral AI FS replacement

> [!NOTE]
> This document describes the target architecture. The checked-in Computer
> implementation still uses `@cloudflare/dofs` until the migration and cutover
> requirements below pass.

Ephemeral AI FS is the complete replacement for the filesystem subsystem used
by Ephemeral AI Computer. It replaces the current filesystem facade,
namespace and content engine, schema, and Node-compatible virtual filesystem
provider. It does not replace Durable Objects, Durable Object SQLite,
`computerd`, FUSE, or the execution runtimes.

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

There is one filesystem implementation on both sides: Ephemeral AI FS. The two
database adapters connect the same portable engine to different SQLite
runtimes. They do not implement alternate filesystem behavior.

## Ownership

| Layer | Owner |
| --- | --- |
| Filesystem API, namespace, and metadata | Ephemeral AI FS |
| `workspace.fs` and branch composition | Ephemeral AI Computer |
| Durable Object identity and request routing | Ephemeral AI Computer |
| Sync transport and protocol negotiation | Ephemeral AI Computer |
| `computerd`, FUSE, mounts, and process execution | Ephemeral AI Computer |
| Content, branches, publication, recovery, and collection | Ephemeral AI FS |
| Cloudflare and Node.js SQLite database adapters | Ephemeral AI FS |
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

The legacy representation may coexist with Ephemeral AI FS only during the
preview migration window:

1. Record the unmodified upstream behavior and wire results.
2. Add the Computer compatibility bridge and both Ephemeral AI FS database
   adapters.
3. Route newly created replacement workspaces through Ephemeral AI FS on the
   authoritative and execution sides.
4. Migrate existing workspaces restartably, verify the new representation,
   and retain a tested rollback path for the preview window.
5. Make Ephemeral AI FS the only production filesystem path and remove runtime
   imports of `@cloudflare/dofs`.

The migration may use an internal engine selector while both representations
exist. That selector is not a permanent public feature.

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
- production filesystem paths have no runtime dependency on
  `@cloudflare/dofs`.

Durable Object SQLite remains the authoritative database before, during, and
after this cutover.

Use [21. Ephemeral AI FS swap](./21_ephemeral_ai_fs_swap.md) as the Computer-side
implementation checklist after the filesystem packages are ready.

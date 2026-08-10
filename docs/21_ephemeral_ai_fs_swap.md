# 21. Ephemeral AI FS swap

> [!NOTE]
> This is the Computer-side work list to use after Ephemeral AI FS is complete.
> It is not an implementation plan for the filesystem itself.

The swap should be small. Computer should import a finished filesystem, connect
it to existing workspace and execution boundaries, verify the full path, and
make it the default engine. Keep `@cloudflare/dofs` as an optional comparison
engine for controlled tests and benchmarks. Filesystem algorithms, replication
rules, database schema behavior, and the Node virtual filesystem provider
belong in Ephemeral AI FS packages.

## Starting condition

Do not begin the Computer swap until released Ephemeral AI FS packages provide:

- the complete `EphemeralFilesystem` and branch APIs;
- Durable Object SQLite and Node.js SQLite adapters;
- host-neutral revision and object replication operations;
- a Node-compatible virtual filesystem provider for `computerd`;
- schema initialization, migration, recovery, and garbage collection; and
- a shared conformance suite that passes on both database adapters.

If one of these capabilities is missing, add it to Ephemeral AI FS. Do not
reimplement it inside Computer to make the import compile.

## Size budget

The Computer-side swap should target:

- no more than 100 net-new production lines in aggregate;
- 150 to 400 touched production lines, including imports and types; and
- 200 to 500 touched test lines.

The 100-line aggregate includes engine selection, authoritative opening,
replication transport forwarding, Node VFS opening, and the branch handshake.
Treat exceeding it as a design warning: replication, provider, lifecycle, or
compatibility behavior is probably missing from an Ephemeral AI FS package.

`packages/dofs` remains in the repository as the benchmark control. Its code
does not count toward the small Ephemeral AI FS wiring budget.

## Add the engine selector

Define one narrow Computer engine interface and two factories:

```ts
type FilesystemEngine = "ephemeral-ai-fs" | "dofs";
```

Omitting the option selects `ephemeral-ai-fs`. Tests and benchmarks may select
`dofs` explicitly. The selected factory must create matching authoritative and
execution-side filesystems and expose their capabilities.

Do not change engines while a workspace is open. Do not fall back to DOFS when
Ephemeral AI FS returns an error. The engines use separate databases and must
never open each other's schema.

## Replace the authoritative filesystem

Change `Workspace` so it receives or opens an Ephemeral AI FS instance through
the Cloudflare SQLite adapter. The target construction should be equivalent to:

```ts
const database = createCloudflareSQLiteAdapter(options.storage);
const filesystem = await EphemeralFS.open({ database });
const workspace = new Workspace({ filesystem });
```

`EphemeralFS.open()` is asynchronous while the current `Workspace` constructor
is synchronous. Resolve that mismatch once, at the workspace lifecycle
boundary. Prefer an asynchronous factory or the existing `ready()` lifecycle;
do not add filesystem initialization checks to every operation.

`workspace.fs` must expose the `EphemeralFilesystem` contract. A Workers remote
procedure call facade may carry those calls across process boundaries, but it
must mirror the filesystem methods, results, and errors rather than retain
`WorkspaceFilesystem` as a second API.

Computer-only helpers such as search tools may be built from portable
filesystem primitives. Keep them outside the filesystem contract.

## Replace the execution-side filesystem

Change `computerd` to use the high-level Node virtual filesystem factory:

```ts
const nodeFs = await openNodeVfs({
  database: options.database,
  branchId: options.branchId,
  runtime: options.runtime,
});
const vfs = nodeFs.provider;
```

Keep FUSE, the shim, process execution, and mount selection in Computer. Remove
the `SQLiteWorkspaceProvider` prototype patch from the Ephemeral AI FS path and
every cross-engine dependency on DOFS buffers, rows, or schema details. Keep
the existing provider contained inside the DOFS comparison implementation.

## Replace synchronization

Keep the remote procedure call transport in Computer, but replace DOFS sync
functions with the host-neutral Ephemeral AI FS replication package. The wire
must carry versioned revisions, namespace changes, manifests, missing objects,
and branch identity without teaching Computer how those values are stored.

Computer should only create a replication endpoint around the selected
filesystem, expose `endpoint.exchange` through its authenticated RPC path, and
call `replicate` with that transport and an explicit plan. Handshake, format
negotiation, batching, cursors, staging, retry, content verification, and
atomic application remain Ephemeral AI FS behavior.

## Enforce the memory profile

For one active workspace, the reference host-process budget is 256 MiB: 128 MiB
of shared Ephemeral AI FS managed memory, a 16 MiB Node SQLite cache target,
zero-byte SQLite memory mapping, 20 MiB of replication transport reservation,
4 MiB of FUSE bridge reservation, and 88 MiB of runtime and native headroom.

These are ceilings, not eager allocations. Several workspaces in one process
must share one configured process budget; Computer must not grant each mount
an independent 256 MiB allowance. DOFS comparison runs use a separate database
and report their own resident-memory high-water.

The DOFS comparison engine may retain its existing sync operations behind the
same Computer transport boundary. Do not mix DOFS changes or watermarks with
an Ephemeral AI FS workspace.

## Bind branches to execution

When Computer starts or reconnects an execution backend, pass the selected
branch identity through the session handshake. The authoritative and local
filesystems must open the same branch view. A missing or terminal branch must
fail rather than fall back to main.

Keep runtime lifecycle separate from branch lifecycle. Stopping a process or
container must not publish or discard its branch.

## Decide whether data migration is required

Make the data decision before adding a dual-engine path:

- If preview workspaces are disposable, create new Ephemeral AI FS databases
  and skip legacy migration. Keep DOFS only for isolated comparison runs.
- If existing workspaces must survive, build a separate, restartable migration
  that copies and verifies namespace, content, metadata, and sync state before
  switching the active format.

Keep the selector for benchmarks, but do not expose it as automatic recovery.
Migration and benchmark selection are separate concerns.

## Update Computer consumers

Update the remaining imports and types in `computer`, `rpc`, and `computerd`.
Pay particular attention to:

- Workers remote procedure call stubs;
- Git and shell filesystem adapters;
- mounts and read-only enforcement;
- tools that use `find`, `grep`, `ls`, or streaming reads;
- storage and sync metrics; and
- test fixtures that inspect DOFS tables directly.

Prefer adapting these consumers to `EphemeralFilesystem`. Do not add a broad
class that recreates the old DOFS surface. The DOFS comparison adapter should
implement only the common Computer engine interface and report unsupported
branch capabilities clearly.

## Verify the replacement

Run the Ephemeral AI FS conformance suite against both databases, then run the
Computer path through:

1. host-side `workspace.fs` reads and writes;
2. push to `computerd`;
3. FUSE and shell reads and writes;
4. pull to the authoritative filesystem;
5. branch publication and conflict reporting;
6. Durable Object and container restart;
7. reconnect to the same branch; and
8. garbage collection and integrity verification.

Also run the existing Computer filesystem, sync, FUSE, Git, mount, tool, and
end-to-end suites. Replace tests that assert DOFS tables with public behavior or
Ephemeral AI FS maintenance results.

## Preserve the benchmark control

After Ephemeral AI FS becomes the default:

1. retain `packages/dofs` and its upstream-compatible tests;
2. keep its imports inside the DOFS engine adapter and benchmark harness;
3. make `ephemeral-ai-fs` the default when configuration is omitted;
4. require explicit `dofs` selection for a comparison run;
5. keep engine-specific schemas, diagnostics, and databases isolated; and
6. run the same common benchmark fixture against both engines.

Benchmark reports must state the selected engine, capabilities, fixture,
logical bytes, database growth, transferred bytes, timing, and resource use.
They must use fresh databases and must not warm one engine with the other's
run. Branch-only benchmarks may mark DOFS unsupported instead of changing the
workload.

## Completion condition

The swap is complete when the default Computer path contains only transport,
workspace, execution, and user-facing integration code; Ephemeral AI FS owns
every filesystem semantic and persisted representation on that path; the full
execution path passes; omitted configuration selects Ephemeral AI FS; and DOFS
runs only when the comparison engine is selected explicitly.

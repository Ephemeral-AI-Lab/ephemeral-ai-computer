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
- authenticated empty-only replica provisioning and host-neutral revision and
  object replication operations;
- a shared runtime that derives replication and a branch-scoped Node-compatible
  virtual filesystem provider for `computerd`;
- read-only execution-replica main and exact active-branch reconnect without
  main fallback;
- durable operation resume, canonical semantic errors, and
  generation-and-digest-guarded publication;
- a documented Cap'n Web text-carrier profile with pre-decode and decoded
  limits;
- schema initialization, migration, recovery, and garbage collection; and
- a shared conformance suite that passes on both database adapters.

If one of these capabilities is missing, add it to Ephemeral AI FS. Do not
reimplement it inside Computer to make the import compile.

The first cutover profile is one authoritative workspace, one persistent local
replica, one active private branch, and a newly provisioned Ephemeral AI FS
database. Add multi-replica fan-out and legacy migration only after this exact
path passes; those extensions do not relax its correctness or resource gates.

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

Give each Ephemeral AI FS workspace a persistent local SQLite database. A new
database begins in the package-defined unbound-replica state and adopts the
authority's exact filesystem and genesis identity through authenticated
provisioning. Do not initialize an unrelated local filesystem and attempt to
reconcile it later. Reject unrelated nonempty state, a wrong workspace, a wrong
engine, or a conflicting authority without writes. Accept and resume only the
exact Ephemeral AI FS durable unbound marker, versioned schema, authenticated
session, receipts, leases, and verified bounded staging produced by an earlier
provisioning attempt.

The unbound runtime exposes only provisioning replication. Provision first,
then reopen or promote the committed database before exposing filesystem or
Node virtual filesystem views. The exact APIs are package-owned, but the two
phases should be equivalent to:

```ts
const unbound = await openUnboundReplicaRuntime({
  database: options.database,
  authorization: options.authorization,
});
const provisioningEndpoint = unbound.createReplicationEndpoint();
const provisioning = await exposeOverComputerSession(provisioningEndpoint);
// The authenticated authority-side driver initiates fresh-replica provisioning.
await provisioning.completed;
await unbound.close();

const replica = await openNodeReplicaRuntime({
  database: options.database,
  runtime: options.runtime,
});
const replication = replica.replication;
const destinationEndpoint = replication.createEndpoint();
const synchronization = await exposeOverComputerSession(destinationEndpoint);
// The authority-side driver initiates main and branch transfer.
await synchronization.mainAndBranchReady(options.branchId);
const nodeFs = await replica.openNodeVfs({ branchId: options.branchId });
const vfs = nodeFs.provider;
```

The provider and replication endpoint must share this runtime's cache, mutation
coordinator, and aggregate admission controller. Do not open two Ephemeral AI
FS cores over the same database. A normal `computerd` or FUSE restart reopens
the persistent database and the same branch when the database file survives.
Container replacement or lost local storage uses authenticated empty-replica
provisioning again. Replacing the database must not masquerade as an ordinary
restart.

Keep FUSE, the shim, process execution, and mount selection in Computer. Remove
the `SQLiteWorkspaceProvider` prototype patch from the Ephemeral AI FS path and
every cross-engine dependency on DOFS buffers, rows, or schema details. Keep
the existing provider contained inside the DOFS comparison implementation.

## Replace synchronization

Keep the remote procedure call transport in Computer, but replace DOFS sync
functions with the host-neutral Ephemeral AI FS replication package. The wire
must carry versioned revisions, namespace changes, manifests, missing objects,
and branch identity without teaching Computer how those values are stored.

Computer must authenticate the peer and bind its principal, workspace,
filesystem, role, global flow, branch, host profile, policy version, and limits before
constructing or forwarding a replication exchange. The current unauthenticated
inverted WebSocket path is not sufficient for this cutover.

Computer should then expose `endpoint.exchange` through its bounded Cap'n Web
carrier and call `replicate` with one global role flow and, when applicable, one
branch identity. Before execution, the authoritative side sends main and the
selected active branch to the local replica. After execution, the replica
returns only that active branch generation to the authority. Handshake, format
negotiation, batching, cursors, staging, retry accounting, content verification,
and atomic application remain Ephemeral AI FS behavior.

`replicate()` runs on the source named by the global flow. The bidirectional Computer
session exposes the destination endpoint to that source: the authority-side driver
initiates provisioning, main transfer, branch delivery, and later terminal-result
delivery; `computerd` initiates only active-branch return to the authority. The RPC
adapter routes opaque `endpoint.exchange` request and response envelopes and never
implements a protocol phase.

Use the exact `computer-efs-carrier-v1` profile. Disable per-message WebSocket
compression for its replication connection or route replication through a
separate uncompressed connection. Configure the WebSocket server's raw
`maxPayload` to 4 MiB plus 64 KiB so rejection happens before Cap'n Web parses
JSON or decodes base64. Limit a decoded request or response to 3 MiB, mutating
acknowledgements to 64 KiB, carrier scratch to 2 MiB, and each operation to one
exchange in flight. Carry stable protocol errors inside canonical result
envelopes rather than relying on thrown JavaScript error properties. Negotiate
the exact canonical `computer-efs-carrier-v1` host-profile token before a
filesystem message.

All replication sessions in a process share one 20 MiB carrier admission pool.
Reserve the conservative simultaneous-copy maximum before reading a frame. At
most one maximum-sized 17.25 MiB exchange may run process-wide; admit concurrent
smaller exchanges only when their total reservations fit.

Ephemeral AI FS may return a durable pending result containing an opaque resume
key, not-before time, and reason. Computer owns alarms and wake-up scheduling,
but it must pass that key back unchanged; it must not reset attempt or elapsed
budgets or reconstruct cursors. Transport liveness uses a Computer-owned
`session.ping` operation, not an empty replication transaction.

## Enforce the memory profile

For one active workspace, the reference host-process budget is 256 MiB: 128 MiB
of shared Ephemeral AI FS managed memory, a 16 MiB Node SQLite cache target,
zero-byte SQLite memory mapping, 20 MiB of replication transport reservation,
4 MiB of FUSE bridge reservation, and 88 MiB of runtime and native headroom.

These are ceilings, not eager allocations. Several workspaces in one process
must share one configured process budget; Computer must not grant each mount
an independent 256 MiB allowance. DOFS comparison runs use a separate database
and report their own resident-memory high-water.

The 20 MiB transport reservation includes the complete Cap'n Web representation
and transient framing copies, not only the decoded `Uint8Array`. Release tests
must report raw and decompressed frame bytes, decoded envelope bytes, base64
expansion, transport and Ephemeral AI FS high-water memory, process resident
memory, SQLite and write-ahead log growth, and live remote procedure call stubs
after disconnect.

The DOFS comparison engine may retain its existing sync operations behind the
same Computer transport boundary. Do not mix DOFS changes or watermarks with
an Ephemeral AI FS workspace.

## Bind branches to execution

When Computer starts or reconnects an execution backend, pass the selected
branch identity through the session handshake. The authoritative and local
filesystems must open the same branch view. A missing or terminal branch must
fail rather than fall back to main.

The execution replica's main view is read-only. Every writable FUSE operation
must target the selected active branch. New opens after an incoming activation
see the activated state; already pinned reads retain their documented snapshot.
An activation that meets a dirty local writer must serialize or return the
stable filesystem conflict or busy error. It must never silently rebase,
discard, or overwrite the pending write.

Keep runtime lifecycle separate from branch lifecycle. Stopping a process or
container must not publish or discard its branch.

When a returned branch generation activates on the authority, retain its exact
generation and generation digest. Publish with both values plus the operation
identifier. If the branch changes before publication, fail without changing
main. A lost publication response must replay the first durable result. After
publication, transfer the authority's terminal branch state and retained result
to the replica before another execution reconnect. The stale local active branch
must close and must never reopen or fall back to main.

## Keep external mounts branch-safe

Computer external mounts are not replication peers. `MountContext` must include
the selected workspace, engine, and branch, and the local provider must enforce
read-only policy before mutation. A private execution branch must not write
through to an external mount before an explicit publication policy permits the
authoritative change. Discarding a branch has no external side effect. A mount
that cannot represent these semantics must remain read-only for branch
execution.

## Keep scratch data explicit

Replication copies the exact selected branch namespace. Do not add ignore rules
for `node_modules`, caches, build outputs, or other paths. If a workload needs
nondurable scratch, mount a separate scratch filesystem with its own quota and
lifecycle. Otherwise the data is ordinary branch content and participates in
replication, publication, and garbage collection.

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

1. authenticate and provision a truly empty persistent local replica;
2. restart after every accepted provisioning batch, on both sides of final
   activation, and during each later replication phase;
3. write authoritative main, transfer it, and verify its digest through real
   FUSE;
4. create and transfer one active private branch, mount exactly that branch,
   prove that it sees base-main content, its private mutations remain invisible
   to main and siblings, sibling-private mutations remain invisible to it, and
   replica main is read-only;
5. run shell and Git work plus hard link, symbolic link, rename, mode, truncate,
   and range writes through FUSE, then `fsync`, restart, and remount;
6. return the exact active branch generation while dropping each request and
   response in turn, proving one activation and deterministic resume;
7. publish with generation and digest expectations, replay a lost response, and
   verify the final `workspace.fs` namespace and digest;
8. transfer terminal branch state and the publication result back to the
   replica, then prove reconnect rejects the branch without main fallback;
9. activate incoming state with pinned readers and dirty writers and prove the
   documented snapshot and conflict behavior;
10. delete the local database after synchronizing an active branch, provision a
    replacement from empty, retransmit main and the branch, and prove exact
    identity and digest without another authority activation;
11. expire and collect replication state and prove zero sessions, leases,
    reservations, and remote procedure call stubs; and
12. reject wrong authentication, workspace, filesystem, branch, schema,
    protocol, and engine inputs before any write.

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
authenticated and bounded Cap'n Web, persistent replica, exact-branch FUSE,
durable resume, guarded publication, and cleanup path passes within one process
budget; omitted configuration selects Ephemeral AI FS; and DOFS runs only when
the comparison engine is selected explicitly.

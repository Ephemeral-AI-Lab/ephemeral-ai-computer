# EphemeralAI Computer product requirements

| Field | Value |
| --- | --- |
| Status | Draft |
| Owner | Ephemeral AI Lab |
| Last updated | 2026-08-10 |

## Summary

EphemeralAI Computer is an independent fork of Cloudflare Computer that adds
branchable multi-agent workspaces through EphemeralAI FS. It keeps Cloudflare
Computer's Durable Object, runtime, `computerd`, FUSE, and synchronization
architecture. It replaces the current `@cloudflare/dofs` filesystem subsystem
with EphemeralAI FS as the default production engine and adds a versioned
content sync protocol plus a first-class branch and publication API. Computer
retains DOFS as an optional comparison engine for controlled benchmarks.

EphemeralAI FS is the default production replacement for
`WorkspaceFilesystem`, the DOFS filesystem primitives and schema, and
`SQLiteWorkspaceProvider`. It does not replace Durable Objects or SQLite.
Durable Object SQLite remains the authoritative database through the
EphemeralAI FS Cloudflare adapter.
EphemeralAI Computer connects that filesystem to temporary containers and
worker runtimes, assigns private branches to agents, and publishes accepted
changes back to the durable main workspace.

DOFS is never an automatic fallback. A workspace selects one engine when it is
created, and its authoritative and execution-side databases use that engine
for the workspace lifetime.

This project is not an official Cloudflare product.

## Upstream baseline

The repository begins as a GitHub fork of `cloudflare/computer` and preserves
its history and MIT license. The upstream fixed 512 KiB content path remains an
optional comparison engine so benchmarks can measure both filesystems through
the same Computer boundary.

The product must keep an `upstream` Git remote and document how maintainers
fetch, test, and merge upstream changes. Fork-specific code should avoid moving
or renaming upstream files without a functional reason.

## Current evidence

The storage prototype has already been exercised in three boundaries:

- direct storage-engine calls in local Durable Object SQLite;
- separate multi-agent requests to one workspace-owning Durable Object;
- a full Computer path through push, `computerd`, FUSE, shell execution, pull,
  and authoritative SQLite verification.

The pinned prototype patched both sides of the existing DOFS representation
and passed the upstream DOFS test suite at that revision. A branch adapter also
demonstrated private mounts and conflict-aware publication above the existing
Computer wire.

This evidence does not make the patch production-ready. Current upstream has
changed some of the same synchronization and write paths. The implementation
must be ported onto the current fork through stable interfaces rather than by
blindly applying the old patch.

## Problem

Cloudflare Computer provides a durable SQLite-backed workspace and projects it
into temporary execution environments. Its current sync model is designed for
one authoritative workspace and matched peers. It does not provide first-class
private branches for several agents that edit the same base concurrently.

Copying the complete workspace for every agent wastes storage and transfer.
Sharing one writable workspace avoids copies but allows concurrent work to
overwrite accepted state. Fixed chunk boundaries also amplify insertions and
deletions, which makes branch creation cheap but later synchronization more
expensive than the logical change.

EphemeralAI Computer needs to preserve Computer's execution model while adding
cheap private workspaces and an explicit, transactional publication boundary.

## Product boundary

EphemeralAI Computer owns:

- the Cloudflare Computer fork and upstream maintenance policy;
- Durable Object workspace identity and request serialization;
- runtime and container lifecycle;
- `computerd`, FUSE, and local workspace mirrors;
- synchronization and protocol capability negotiation;
- mapping an agent or execution environment to a filesystem branch;
- compatibility bridges from Computer's `workspace.fs`, sync, and FUSE
  surfaces to EphemeralAI FS;
- branch-aware public APIs, examples, and end-to-end benchmarks.

EphemeralAI FS owns:

- the complete asynchronous filesystem API used by Computer;
- filesystem namespace, metadata, schema, and content representation;
- content-addressed storage and manifests;
- content-defined chunking and copy-on-write pages;
- filesystem revisions and private branch state;
- conflict-aware publication, recovery, and garbage collection;
- portable Node.js and Durable Object SQLite adapters.

The Computer fork must not duplicate those algorithms. EphemeralAI FS is the
default production path. Computer retains `@cloudflare/dofs` behind the same
engine boundary only when a caller explicitly selects the comparison engine.

## Target users

The first users are teams building:

- parallel coding agents that share one project base;
- review workflows where only accepted agent changes reach main;
- long-lived Durable Object workspaces with temporary Linux containers;
- systems that need an auditable conflict result instead of last-writer-wins;
- storage and execution experiments that compare legacy fixed chunks with
  EphemeralAI FS.

## Goals

1. Preserve a passing, observable upstream Computer baseline.
2. Make EphemeralAI FS the default production filesystem without replacing
   Durable Objects or SQLite.
3. Keep authoritative and container-side EphemeralAI FS representations
   compatible.
4. Give each agent a private branch and execution view.
5. Publish branch changes in one authoritative SQLite transaction.
6. Merge independent paths and return explicit same-path conflicts.
7. Negotiate protocol capabilities before moving EphemeralAI FS manifests or
   branch data.
8. Provide migration and benchmark paths from DOFS to EphemeralAI FS while
   retaining DOFS as an explicit comparison control.
9. Keep future upstream merges reviewable.

## Non-goals for the first release

- Replacing Durable Objects with a new database or coordination service.
- Rewriting `computerd`, FUSE, or the container runtime from scratch.
- Removing DOFS from the repository or benchmark harness.
- Using DOFS as the production default or an automatic fallback.
- Promising EphemeralAI FS branch features when the DOFS comparison engine is
  selected.
- Supporting an old `computerd` process against a new protocol by guessing.
- Semantic source-code merges.
- Running several authoritative writers for one workspace identity.
- Renaming all upstream packages before the replacement integration passes.
- Claiming production readiness while upstream Computer remains a preview.

## Target architecture

```text
Authoritative side                         Execution side

Workspace and branch API                   Linux tools and agents
          |                                         |
Workspace Durable Object                           FUSE
          |                                         |
workspace.fs: EphemeralFilesystem          node/VFS provider bridge
          |                                         |
EphemeralAI FS <---- versioned sync ----> EphemeralAI FS
          |                                         |
Cloudflare SQLite adapter                   Node.js SQLite adapter
          |                                         |
Durable Object SQLite                       local SQLite mirror
```

EphemeralAI FS is the default engine on both sides of the sync boundary. Its
database adapters connect it to SQLite; they are not substitute filesystem
engines. Computer continues to own workspace identity, remote procedure calls,
sync transport, FUSE, and process execution.

`workspace.fs` uses the EphemeralAI FS public contract. Computer may wrap it
for Workers remote procedure calls or add helpers built from its primitives,
but it must not preserve `WorkspaceFilesystem` as a second semantic API.

Computer also keeps an internal engine selector:

```text
ephemeral-ai-fs   default production and branch-capable engine
dofs              optional comparison engine for tests and benchmarks
```

Both selections present the `EphemeralFilesystem`-compatible Computer surface.
The DOFS adapter may report unsupported capabilities for branch-only features.
An engine choice applies to both sides of sync and cannot change while a
workspace is open.

The planned repository additions are:

```text
packages/
    dofs/                       retained benchmark and comparison engine
    ephemeral-ai-fs-bridge/     workspace, sync, and VFS compatibility
    rpc/                        protocol capabilities and branch data
    computer/                   Workspace and branch public API
    computerd/                  local mirror, FUSE, and execution
examples/
    ephemeral-ai-fs-workspace/
    multi-agent-branches/
benchmarks/
    baseline-vs-ephemeral-ai-fs/
    computer-e2e/
    multi-agent/
docs/
    upstream.md
    20_ephemeral_ai_fs.md
    sync-v2.md
    agent-branches.md
```

## Functional requirements

### EC-1: Fork provenance and maintenance

The README and `UPSTREAM.md` must identify `cloudflare/computer` as the source
repository and explain that this fork is independent. The repository must
retain Cloudflare's copyright and MIT license notices.

Each upstream update must record the source revision, run the unchanged
baseline checks first, and separate conflict resolution from product changes
where practical.

### EC-2: Swappable filesystem engines

Computer must expose a narrow engine selector with two implementations:

- `ephemeral-ai-fs`, the default production and branch-capable engine; and
- `dofs`, the optional upstream comparison engine.

Omitting the option must select `ephemeral-ai-fs`. Selecting `dofs` must be
explicit and intended for tests, benchmarks, or upstream compatibility checks.
Computer must never fall back from one engine to the other after an error.

The engine choice is fixed for the workspace lifetime and must select matching
authoritative and execution-side implementations. The two engines use separate
databases and schema identities. A database created by one engine must not be
opened by the other.

### EC-3: Computer compatibility bridge

Computer-specific translation belongs in
`packages/ephemeral-ai-fs-bridge`. The bridge may depend on both Computer and
EphemeralAI FS. EphemeralAI FS must not depend on Computer packages.

The bridge must cover the authoritative Durable Object side and the local
`computerd` mirror side. `workspace.fs` exposes the EphemeralAI FS contract;
the bridge supplies Workers remote procedure call transport, sync, and the
Node-compatible provider required by FUSE without implementing another
filesystem. Both sides must interpret content identities, manifests, path
changes, and revision boundaries consistently.

### EC-4: Protocol capability negotiation

The synchronization handshake must identify protocol version, chunking mode,
manifest encoding, and branch support. A peer must reject an unsupported
combination with a clear error before applying changes.

A new peer must never interpret EphemeralAI FS data as a legacy fixed-chunk
payload. Version negotiation must be covered by supported, unsupported, and
downgrade tests.

### EC-5: Private execution branches

Callers must be able to create a branch from the current main revision and bind
an execution backend to that branch. Reads through the branch see main plus
private changes. Main and other branches do not see those changes before
publication.

Every mount and sync session must carry an unambiguous workspace and branch
identity. Reconnect must rejoin the same branch or fail rather than opening
main accidentally.

### EC-6: Branch API

The intended public workflow is:

```ts
const branch = await workspace.branches.create({
  id: `agent-${agentId}`,
});

await branch.runtime.exec("npm test", {
  backend: "container",
});

const result = await branch.publish({
  operationId: requestId,
});
```

The exact API may change before release. It must support create, inspect,
execute, publish, discard, and reconnect operations without exposing storage
schema details.

### EC-7: Transactional publication

Publication must run against authoritative Durable Object SQLite. It must
compare branch base versions with current main, reject conflicting paths, reuse
existing objects, create one durable revision, record the idempotent result,
and update main references in one transaction.

The API must return changed paths for success and conflicting paths for
conflict. A conflict must leave main unchanged and keep the branch available
for inspection or retry under a new operation.

### EC-8: Synchronization behavior

Push and pull must move EphemeralAI FS manifests, missing content objects,
namespace changes, and branch identity without materializing unchanged full
files. The protocol should batch object-existence checks and object transfer.

An empty sync must remain cheap. A reconnect must resume from durable
watermarks or request a safe reconciliation. Partial application must not
advance the visible revision.

### EC-9: Migration and benchmark isolation

Workspaces need an explicit migration state and schema version. Migration must
be restartable and must not delete the legacy representation until the
EphemeralAI FS representation has been verified. Operators must be able to
return to the legacy representation during the preview migration window
without restoring from an external backup.

The first milestone may support only newly created EphemeralAI FS workspaces,
but the API and schema must reserve a clear migration path. Keeping the DOFS
comparison engine does not permit opening the same database with both engines.
Benchmarks must create isolated workspaces from the same logical fixture.

### EC-10: Recovery and lifecycle

Durable Object restart, container restart, network interruption, and repeated
publication requests must have deterministic outcomes. Branch state lives in
the authoritative database, not only in a container or a long-lived remote
procedure call session.

Disposing a runtime must not discard its branch unless the caller asks for
that operation. Discard and garbage collection must be explicit and
observable.

### EC-11: Observability

Structured diagnostics must include workspace, branch, engine, protocol
version, sync direction, revision or watermark, object counts, and byte counts.
Logs must not include file content by default.

Metrics must distinguish logical changed bytes, transferred bytes, retained
branch payload, database growth, publish latency, conflicts, retries, and
garbage collection.

### EC-12: Compatibility and comparison

The DOFS comparison engine must continue to pass the common upstream tests and
examples. EphemeralAI FS must preserve the documented
`workspace.fs`, sync, and FUSE behavior or identify an intentional API change.
After cutover, omitted engine configuration must always select EphemeralAI FS.
DOFS remains callable only through explicit comparison configuration. A
filesystem failure must identify the selected engine and protocol layer rather
than presenting as a generic FUSE or network error, and must never trigger an
automatic engine change.

## Security and integrity requirements

- Keep Durable Object identity as the authority for workspace routing.
- Validate workspace and branch identity at every sync session boundary.
- Verify manifest and content-object integrity before advancing a revision.
- Bound incoming object sizes, batches, and queued changes.
- Do not log file bytes, secrets, or remote procedure call credentials.
- Treat container-side SQLite as a mirror, not an independent authority.
- Reject protocol mismatches before mutating either side.

## Performance requirements

All performance comparisons must use the same upstream revision, build mode,
fixture, container image, warm-up, and run count. Reports must label the
measured boundary.

The benchmark harness must run each common filesystem workload once with
`ephemeral-ai-fs` and once with `dofs`, using fresh isolated databases created
from the same logical fixture. It must report the selected engine, supported
capabilities, logical bytes, database growth, transferred bytes, elapsed time,
and resource use. It must not reuse one engine's cache or database for the
other run.

Branch and publication benchmarks apply only to engines that report those
capabilities. A DOFS result marked unsupported is clearer than a compatibility
shim that changes the workload.

The acceptance suite must include:

- first write and full rewrite controls;
- one small overwrite and repeated small overwrites;
- prepend, append, truncate, and rename;
- one and many distributed edits;
- many independent branches;
- same-path branch contention;
- cold and warm push and pull;
- empty synchronization;
- garbage collection after publish and discard;
- container and Durable Object restart.

EphemeralAI FS may use more processor time for first writes. Release decisions
must weigh that cost against retained storage, synchronization, and
multi-agent behavior rather than claiming improvement from one metric.

## Delivery plan

### Milestone 0: Fork foundation

- Approve this product requirements document.
- Add fork identity, `UPSTREAM.md`, and repository ownership rules.
- Record a clean upstream baseline and checks.
- Keep package names and behavior unchanged.

### Milestone 1: Replacement boundary

- Map every `@cloudflare/dofs` consumer in `computer`, `computerd`, sync, FUSE,
  mounts, Git, and tools.
- Define Computer-owned compatibility interfaces for those consumers.
- Keep DOFS behind the engine selector as the comparison control.

### Milestone 2: EphemeralAI FS replacement

- Add the compatibility bridge and EphemeralAI FS database adapters.
- Route authoritative `workspace.fs` and the local virtual filesystem provider
  through EphemeralAI FS.
- Run the same filesystem conformance suite on the Durable Object and local
  mirror.
- Remove duplicated filesystem algorithms from Computer-owned packages.

### Milestone 3: Versioned sync

- Add capability negotiation and EphemeralAI FS manifest and object transfer.
- Add mixed-version rejection, reconnect, batching, and integrity tests.
- Measure cold, warm, and empty sync behavior.

### Milestone 4: Agent branches

- Add branch lifecycle and execution binding.
- Add transactional, idempotent publication and explicit conflicts.
- Add examples for independent and conflicting agent work.

### Milestone 5: Migration and preview

- Add migration and rollback for existing workspaces.
- Complete full Computer, `computerd`, FUSE, shell, pull, and restart tests.
- Make EphemeralAI FS the default and keep DOFS as an explicit benchmark
  selection.
- Add paired benchmark runs over fresh, equivalent workspaces.
- Publish preview documentation with known limits and reproducible benchmarks.

## Preview acceptance criteria

- The repository can merge the selected current upstream baseline and pass its
  unchanged checks.
- The DOFS comparison engine continues to match common upstream behavior and
  wire results.
- EphemeralAI FS passes filesystem conformance on both authoritative and local
  mirror databases.
- Unsupported protocol pairs fail before applying data.
- Two independent branch paths publish successfully in either order.
- Two stale writers to the same path produce one success and one explicit
  conflict with no silent loss.
- Repeating a publication operation after restart returns the same result.
- A container reconnects to its intended branch without exposing another
  branch's private files.
- The full push, `computerd`, FUSE, shell, pull, publish, and verify path passes
  through EphemeralAI FS.
- Migration and rollback tests preserve file content and namespace metadata.
- Omitted engine configuration selects EphemeralAI FS, while explicit `dofs`
  selection runs the same common filesystem benchmark surface.
- An engine error never causes automatic fallback or cross-engine database
  access.
- Benchmarks publish raw data, environment details, and limitations.
- Documentation identifies planned behavior that is not yet implemented.

## Risks

- Upstream changes may overlap the storage and synchronization seams.
- Keeping the DOFS comparison engine increases maintenance and test cost.
- A protocol error can make authoritative and mirror state diverge.
- File-level conflicts may reject changes that a source-aware merge could
  combine.
- Smaller branch storage does not guarantee smaller cold synchronization.
- FUSE and container startup noise can hide storage improvements.
- Fork-wide package renames would make upstream updates harder to review.

## Open decisions

- Should branch identity be part of every existing sync call or represented by
  a branch-scoped session capability?
- Which engine-neutral fixture format should seed both isolated benchmark
  databases?
- How often should the DOFS comparison baseline follow upstream changes?
- Should Computer use the EphemeralAI FS 30-day branch retention default or
  configure a longer product-level window?
- How should a caller reopen a conflicted branch for manual resolution?
- Which compatibility window should protocol negotiation support?

## Licensing and attribution

The repository remains under the MIT License and preserves Cloudflare's
copyright and license notice. Fork documentation must state:

> EphemeralAI Computer is an independent fork of Cloudflare Computer and is
> not an official Cloudflare product.

New Ephemeral AI Lab code should keep attribution separate from Cloudflare's
upstream authorship. Dependencies and copied code must retain all notices
required by their licenses.

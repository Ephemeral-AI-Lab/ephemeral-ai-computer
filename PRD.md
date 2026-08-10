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
architecture. It adds a selectable filesystem engine, a versioned content sync
protocol, and a first-class branch and publication API.

EphemeralAI FS is a library dependency and storage engine, not a replacement
for Durable Objects. Durable Object SQLite remains the authoritative database.
EphemeralAI Computer connects that database to temporary containers and worker
runtimes, assigns private workspace branches to agents, and publishes accepted
changes back to the durable main workspace.

This project is not an official Cloudflare product.

## Upstream baseline

The repository begins as a GitHub fork of `cloudflare/computer` and preserves
its history and MIT license. The upstream fixed 512 KiB content path remains
the compatibility baseline while the EphemeralAI engine is developed.

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
- the adapter between Computer's filesystem surface and EphemeralAI FS;
- branch-aware public APIs, examples, and end-to-end benchmarks.

EphemeralAI FS owns:

- content-addressed storage and manifests;
- content-defined chunking and copy-on-write pages;
- filesystem revisions and private branch state;
- conflict-aware publication, recovery, and garbage collection;
- portable Node.js and Durable Object SQLite adapters.

The Computer fork must not duplicate those algorithms.

## Target users

The first users are teams building:

- parallel coding agents that share one project base;
- review workflows where only accepted agent changes reach main;
- long-lived Durable Object workspaces with temporary Linux containers;
- systems that need an auditable conflict result instead of last-writer-wins;
- storage and execution experiments that compare fixed chunks with C3.

## Goals

1. Preserve a passing, observable upstream Computer baseline.
2. Add EphemeralAI FS as a selectable engine without replacing Durable Objects.
3. Keep authoritative and container-side filesystem representations compatible.
4. Give each agent a private branch and execution view.
5. Publish branch changes in one authoritative SQLite transaction.
6. Merge independent paths and return explicit same-path conflicts.
7. Negotiate protocol capabilities before moving C3 manifests or branch data.
8. Provide migration, rollback, and benchmark paths between fixed and C3 modes.
9. Keep future upstream merges reviewable.

## Non-goals for the first release

- Replacing Durable Objects with a new database or coordination service.
- Rewriting `computerd`, FUSE, or the container runtime from scratch.
- Removing the upstream fixed-chunk engine.
- Supporting an old `computerd` process against a new protocol by guessing.
- Semantic source-code merges.
- Running several authoritative writers for one workspace identity.
- Renaming all upstream packages before the C3 integration passes.
- Claiming production readiness while upstream Computer remains a preview.

## Target architecture

```text
Workspace and branch API
    |
Workspace Durable Object
    |  identity, request serialization, SQLite transactions
    |
Computer filesystem adapter
    |
EphemeralAI FS
    |  CAS, FastCDC, manifests, COW pages, branches, publication
    |
Durable Object SQLite
    |
Versioned push and pull protocol
    |
computerd local SQLite mirror
    |
FUSE
    |
Linux tools and coding agents
```

The planned repository additions are:

```text
packages/
    dofs/                       upstream semantics plus an engine seam
    ephemeralai-fs-adapter/     Computer-specific integration
    rpc/                        protocol capabilities and branch data
    computer/                   Workspace and branch public API
    computerd/                  local mirror, FUSE, and execution
examples/
    c3-workspace/
    multi-agent-branches/
benchmarks/
    baseline-vs-c3/
    computer-e2e/
    multi-agent/
docs/
    upstream.md
    ephemeralai-fs.md
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

### EC-2: Selectable filesystem engine

Computer must expose a narrow engine seam with at least two implementations:

- `fixed512`, the upstream-compatible baseline;
- `c3`, backed by EphemeralAI FS.

The first integration must require an explicit `c3` selection. It may become
the default only after migration, rollback, and full pipeline acceptance tests
pass.

### EC-3: Computer adapter package

Computer-specific translation belongs in
`packages/ephemeralai-fs-adapter`. The adapter may depend on both Computer and
EphemeralAI FS. EphemeralAI FS must not depend on Computer packages.

The adapter must cover the authoritative Durable Object side and the local
`computerd` mirror side. Both sides must interpret content identities,
manifests, path changes, and revision boundaries consistently.

### EC-4: Protocol capability negotiation

The synchronization handshake must identify protocol version, chunking mode,
manifest encoding, and branch support. A peer must reject an unsupported
combination with a clear error before applying changes.

A new peer must never interpret C3 data as a fixed-chunk payload. Version
negotiation must be covered by supported, unsupported, and downgrade tests.

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

Push and pull must move C3 manifests, missing content objects, namespace
changes, and branch identity without materializing unchanged full files. The
protocol should batch object-existence checks and object transfer.

An empty sync must remain cheap. A reconnect must resume from durable
watermarks or request a safe reconciliation. Partial application must not
advance the visible revision.

### EC-9: Migration and rollback

Workspaces need an explicit storage mode and schema version. Migration must be
restartable and must not delete the fixed representation until the C3
representation has been verified. Operators must be able to return to the
fixed engine during the preview period without restoring from an external
backup.

The first milestone may support only newly created C3 workspaces, but the API
and schema must reserve a clear migration path.

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

### EC-12: Compatibility baseline

The fixed engine must continue to pass upstream tests and examples. New engine
selection code must not change fixed-mode behavior. A failure in C3 mode must
identify the selected engine and protocol rather than presenting as a generic
FUSE or network error.

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

C3 may use more processor time for first writes. Release decisions must weigh
that cost against retained storage, synchronization, and multi-agent behavior
rather than claiming improvement from one metric.

## Delivery plan

### Milestone 0: Fork foundation

- Approve this product requirements document.
- Add fork identity, `UPSTREAM.md`, and repository ownership rules.
- Record a clean upstream baseline and checks.
- Keep package names and behavior unchanged.

### Milestone 1: Engine seam

- Define the smallest storage-engine boundary in DOFS.
- Wrap existing behavior as `fixed512` without changing results.
- Add engine selection, diagnostics, and compatibility tests.

### Milestone 2: EphemeralAI FS adapter

- Add the adapter package and C3 mode.
- Run the same filesystem conformance suite on the Durable Object and local
  mirror.
- Port storage changes onto current upstream interfaces.

### Milestone 3: Versioned sync

- Add capability negotiation and C3 manifest and object transfer.
- Add mixed-version rejection, reconnect, batching, and integrity tests.
- Measure cold, warm, and empty sync behavior.

### Milestone 4: Agent branches

- Add branch lifecycle and execution binding.
- Add transactional, idempotent publication and explicit conflicts.
- Add examples for independent and conflicting agent work.

### Milestone 5: Migration and preview

- Add migration and rollback for existing workspaces.
- Complete full Computer, `computerd`, FUSE, shell, pull, and restart tests.
- Publish preview documentation with known limits and reproducible benchmarks.

## Preview acceptance criteria

- The repository can merge the selected current upstream baseline and pass its
  unchanged checks.
- Fixed mode matches upstream behavior and wire results.
- C3 mode passes filesystem conformance on both authoritative and mirror
  databases.
- Unsupported protocol pairs fail before applying data.
- Two independent branch paths publish successfully in either order.
- Two stale writers to the same path produce one success and one explicit
  conflict with no silent loss.
- Repeating a publication operation after restart returns the same result.
- A container reconnects to its intended branch without exposing another
  branch's private files.
- The full push, `computerd`, FUSE, shell, pull, publish, and verify path passes
  for fixed and C3 modes.
- Migration and rollback tests preserve file content and namespace metadata.
- Benchmarks publish raw data, environment details, and limitations.
- Documentation identifies planned behavior that is not yet implemented.

## Risks

- Upstream changes may overlap the storage and synchronization seams.
- Supporting two representations increases migration and test cost.
- A protocol error can make authoritative and mirror state diverge.
- File-level conflicts may reject changes that a source-aware merge could
  combine.
- Smaller branch storage does not guarantee smaller cold synchronization.
- FUSE and container startup noise can hide storage improvements.
- Fork-wide package renames would make upstream updates harder to review.

## Open decisions

- Should branch identity be part of every existing sync call or represented by
  a branch-scoped session capability?
- Should fixed and C3 representations share one database or use isolated
  schema namespaces during preview?
- When should C3 become the default for newly created workspaces?
- Which branch retention policy should Computer apply after successful
  publication?
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

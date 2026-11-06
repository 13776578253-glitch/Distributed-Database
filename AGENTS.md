# Project Development Conventions

## 1. Development Principles

1. **Single-agent serial development.** Do not proactively create sub-agents, and do not modify multiple subsystems in parallel.
2. Before starting a task, check `README.md`, `docs/PLAN.md`, the relevant task records, Git status, and code ownership.
3. Understand the existing implementation, data flow, and state invariants before deciding how to modify them.
4. Prefer fixing the root cause in the existing mechanism. Do not layer patches, duplicate state, hide fallbacks, or add unnecessary compatibility layers.
5. When a new mechanism replaces an old implementation, remove the obsolete code and interfaces.
6. Designs should be minimal and complete. Target roughly 6,000 lines of code overall; correctness, necessary tests, and experiments take priority over line count.
7. Do not refactor unrelated modules because of a local change, and do not implement features from later phases ahead of time.

## 2. Module Responsibilities and Data Boundaries

### Raft (`src/raft/`)

- `core/` owns the protocol state for elections, terms, log replication, commitment, and consistent reads.
- `adapters/` owns SQLite persistence and HTTP communication.
- `api/` owns request validation, client responses, and experiment interfaces.
- `main.ts` owns process assembly, timers, and asynchronous scheduling.

Keep the protocol core independent of HTTP, Docker, and concrete database APIs.

### Transaction (`src/transaction/`)

- Owns transaction state, version visibility, isolation semantics, the WAL, and recovery.
- Transaction LSNs and Raft log indexes use different identifiers and lifecycles.
- Do not directly modify Raft internal state.
- The WAL must preserve observable durability ordering and recovery semantics.

### Verification (`src/verification/`)

- Consumes client operation histories and transaction read/write records.
- Implements linearizability checking, dependency graphs, and business-invariant validation.
- Does not participate in modifying storage engine internal state.
- Verdicts must be supported by evidence; return `INCONCLUSIVE` when a determination cannot be made.

Shared contracts live in `src/contracts/`. Before changing cross-module interfaces, define the impact scope and migration approach.

## 3. Comment Conventions

Comments explain ownership, state invariants, execution order, durability boundaries, and failure semantics.

Use three kinds of comments:

**Module Header**

- Use a short English `/** ... */` at the top of the file.
- Describe the module's responsibilities, the state it owns, and its boundaries.

**Declaration Contract**

- Use a Chinese `/** ... */` before the necessary interfaces, classes, fields, or methods.
- Explain lifecycle, preconditions, postconditions, or invariants.
- Simple declarations whose names already express the meaning need no comment.

**Logic Note**

- Use Chinese `//` inside functions.
- Focus on critical execution order, persistence timing, state transitions, safety constraints, and special branches.
- Avoid line-by-line translation of code, restating conditions, or explaining obvious syntax.

Comments must accurately reflect the current implementation. Behavior that cannot be confirmed from the source must not be written as an implemented guarantee.

### Comment-Specific Tasks

When the task is to add comments or help explain the source:

1. Keep runtime logic, interfaces, data structures, and test behavior unchanged.
2. Do not perform incidental refactoring, reformat entire files, or add unrelated functionality.
3. Prioritize commenting the core state machine, public interfaces, and important data flows.
4. Save longer mechanism explanations, call chains, and state diagrams in `docs/learning/`.
5. After changes, inspect the diff to confirm that only comments or explicitly authorized documentation changed.

## 4. Testing and Experiments

- Unit tests focus on actual behavior, state changes, and protocol invariants.
- The Raft core uses deterministic message scheduling to validate complex timing.
- Real fault experiments use isolated containers and persistent volumes via Docker Compose.
- Define separate judgment criteria for crashes, network partitions, recovery, concurrent conflicts, and unknown outcomes.
- Do not make tests pass by changing assertions, fabricating logs, or weakening judgment criteria.
- When adding or fixing a significant mechanism, add regression tests that reproduce the problem.

Keep ordinary tests in `tests/`; real-system experiments are executed by `scripts/`.

Run before each commit:

```bash
pnpm test
pnpm typecheck
```

For changes involving Compose, persistence, or fault mechanisms, also run the relevant real experiments.

## 5. Evidence and Temporary Files

- `.scratch/` holds temporary probes, debug output, one-off scripts, and intermediate results.
- `evidence/` holds formal experiment commands, timestamps, raw output, events, and verdicts.
- Formal evidence must not be modified or overwritten to obtain a PASS.
- Use a unique Run ID for each experiment.
- Keep failed evidence as well; after a fix, generate a new experiment record.
- Metrics cited in the report must be traceable to actual experiment files.

Do not build extra complex infrastructure for temporary file management.

## 6. Documentation and Task Records

- Record the scope, design, verification method, and actual results for important development phases in `docs/current-task/`.
- Put task plans in `docs/PLAN.md`; record actual execution in the task document.
- When existing historical conclusions need correction, keep a traceable change record.
- Put complex mechanism explanations in `docs/learning/`.
- Documentation should describe current facts, core invariants, and data flows first, rather than duplicating full source code.
- Each phase should be able to explain module ownership, the core call chain, key failure boundaries, and properties not yet verified.

`AI_USAGE.md` truthfully records the scope of AI involvement, what was adopted, and the verification method.

## 7. Git Management

1. Check the current branch, working tree status, and relevant diffs before modifying.
2. Do not overwrite or clean up uncommitted changes left by other tasks.
3. Make local commits by phase.
4. Stage relevant paths explicitly; avoid `git add -A`.
5. Use Conventional Commits, e.g. `docs(raft): explain log commit invariants`.
6. Check test results and the diff before committing.
7. Push, rewrite public history, or delete remote content only when explicitly requested.

## 8. Phase Delivery

At the end of each round, report:

- The actual scope modified this round
- Changes to core mechanisms and data flows
- State and abstractions added, removed, or replaced
- Test and experiment results
- Unverified boundaries or remaining issues

Do not treat all tests passing as the sole completion criterion. Also ensure the data flow is clear, module responsibilities are explicit, and the implementation matches the comments.

## 9. File Encoding

1. **Standardize file encoding:** Use UTF-8 without BOM for source code and configuration files, preserving compatibility exceptions only where genuinely necessary.
2. **Prefer native file tools:** Use native file reading, editing, and search tools for source code. Avoid bulk-reading source files through PowerShell pipelines.
3. **Use appropriate tools for file processing:** Prefer `ripgrep (rg)` for bulk searches. When file parsing is required, use the Node.js `fs` API with explicit UTF-8 encoding.
4. **Use PowerShell 7:** On Windows, default to PowerShell 7 (`pwsh`) for command execution. Avoid Windows PowerShell 5.1.
5. **Specify encoding explicitly:** When reading files through PowerShell, use `Get-Content -Raw -Encoding utf8`.
6. **Diagnose encoding issues before changing files:** When encountering garbled Chinese text, distinguish actual file corruption, incorrect decoding during file reading, and terminal output encoding issues. Never modify source code based on garbled scan results.
7. **Verify changes:** After modifications, inspect the Git diff to ensure there are no unintended encoding conversions, BOM changes, or widespread unrelated text differences.

# Orchestrator / Worker Multi-Agent Coordination — Research Report

> How well-architected, production-grade multi-agent systems actually coordinate: assignment,
> result-return, memory, state/handoff/conflict, and per-agent prompt overhead. Open survey, no
> preferred conclusion. Skeptic-verified; corrections folded in.

**Method.** Two deep-research rounds, ~115 agents, ~2.7M tokens, 26 sources, adversarial 3-vote
(round 1) / 1-vote skeptic (round 2) verification. Round 1 established the isolated-worker core
(Anthropic, Claude Code, OpenAI Agents SDK, Google A2A). Round 2 filled the gaps (LangGraph,
AutoGen/AG2, CrewAI, Temporal, message-queue/actor/blackboard, Cognition/Devin dissent).
Findings marked **[high]** rest on primary vendor/standards docs with unanimous verification;
**[medium]** had a split vote or a weak cited source. Known errors are flagged in §6.

---

## 1. Bottom line

There is **no single winner.** The popular "spawn isolated workers" framing is *one point* on a
spectrum, not the whole design space. The field splits along three independent axes:

**Axis A — context topology** (the main spectrum):

```
ISOLATED PARALLEL WORKERS  <————>  SHARED-STATE GRAPH  <————>  SINGLE-THREADED LINEAR
Anthropic research system,         LangGraph channels,         Cognition / Devin
Claude Code subagents,             AutoGen GroupChat,
OpenAI Agents SDK, A2A,            CrewAI shared memory
Temporal, AutoGen 0.4 Core
```

- **Left** — max parallelism, min context coherence, ~15× tokens, a hard merge problem at the end.
- **Right** — max coherence, zero merge problem, no parallelism, full context carried every step.
- **Middle** — parallel-ish agents over shared state, reconciled by **reducers / a manager LLM / broadcast**.

**Axis B — durability** (orthogonal). Crash recovery / pause-for-days / no-duplicate-execution.
Most isolated-worker systems have *none*. Temporal owns this axis; LangGraph has a weaker version.

**Axis C — conflict handling** (what "the orchestrator just synthesizes" hand-waves). See §4.

**Verdicts, plainly:**

| Superlative | Winner |
|---|---|
| Most complete *framework* | **LangGraph** — context-topology + conflict (reducers) + durability (checkpointer/store) in one package |
| Most sophisticated *durability* | **Temporal** — event-sourced replay; but it's a substrate, not an agent framework |
| Most actually-shipped | **Isolated workers** — Claude Code subagents, OpenAI Agents SDK, Anthropic's own system |
| Most correct *default* for tightly-coupled work | **Cognition single-thread** — one writer, no merge problem |

---

## 2. The verified core (round 1) — isolated orchestrator/worker

The dominant *production* pattern, documented independently across four vendors:

> **A lead/orchestrator decomposes the goal → spawns workers in ISOLATED context windows → each
> worker gets only its OWN system prompt + tools (never a shared global prompt, never the parent's
> history) → returns a COMPACT result (summary / artifact / reference) → orchestrator synthesizes.**

- **Assign** **[high]** — lead "analyzes… develops a strategy, and spawns subagents to explore
  different aspects simultaneously," each given "an objective, an output format, guidance on the
  tools and sources to use, and clear task boundaries." (Anthropic)
- **Isolation** **[high]** — "Each subagent starts with a fresh, isolated context window. It does not
  see your conversation history, the skills you've already invoked, or the files Claude has already
  read." Only exception: a `fork` inherits the parent. (Claude Code docs, verbatim)
- **Prompt overhead** **[high]** — "Subagents receive only this system prompt … NOT the full Claude
  Code system prompt." Each agent = "an LLM equipped with instructions and tools." Per-agent system
  prompt + scoped tools — not a shared global prompt, not the parent's prompt. (Claude Code / OpenAI SDK)
- **Memory** **[high]** — worker working-context is private; cross-agent **state** is persisted in an
  EXTERNAL store. The lead "saves its plan to Memory to persist the context, since if the context
  window exceeds 200,000 tokens it will be truncated"; long jobs "spawn fresh subagents with clean
  contexts while maintaining continuity through careful handoffs," then "retrieve stored context like
  the research plan from their memory." Bulky outputs go to an external system; only a lightweight
  reference passes back. (Anthropic)
- **Trade-off** **[high]** — Anthropic's own number: multi-agent costs **~15× the tokens of a single
  chat**; a poor fit when all agents must share one tight context.

**OpenAI Agents SDK** (production successor to the experimental Swarm) **[high]** — two explicit
delegation primitives: **handoffs** (transfer control; the other agent becomes active — implemented
as a `transfer_to_<agent>` tool) vs **agents-as-tools** (`Agent.as_tool()`; the manager keeps
control and combines outputs). Driven by a built-in **Runner** loop: invoke tool → feed result back
to the LLM → iterate until `final_output` or `max_turns` (→ `MaxTurnsExceeded`).

**Google A2A** (the cross-vendor open standard for this same shape) **[high]** — a **client agent**
formulates/sends tasks; a **remote agent** acts. Built explicitly for **opaque agents that "don't
share memory, tools and context."**
- Assign via `message/send` carrying a `Message` of typed `Parts` (text/file/structured-data) + role;
  returns either a `Task` (tracks processing) or a direct response.
- Task lifecycle: `SUBMITTED → WORKING → COMPLETED/FAILED` (+ `INPUT_REQUIRED`, `CANCELED`, …);
  results = array of **Artifact** objects.
- Discovery via a JSON **Agent Card** (`/.well-known/agent-card.json`) advertising
  identity/capabilities/skills/endpoint/auth; client picks the best agent (LLM reasoning over cards).
- Three delivery modes: synchronous block · **SSE streaming**
  (`TaskStatusUpdateEvent`/`TaskArtifactUpdateEvent`) · **async push** (agent HTTP-POSTs a
  client-registered webhook on state change — for long jobs).
- **A2A vs MCP** **[medium]** — A2A = agent↔agent, assumes the remote peer is itself LLM-driven,
  treats it as a partner; MCP = tool/resource access, relies on the *caller's* LLM. "A2A is about
  agents partnering on tasks, while MCP is more about agents using capabilities." (Confidence capped
  at medium: the cited primary was a community GitHub comment; the maintainer declined the hard
  distinction. Official A2A docs corroborate the substance.)

---

## 3. The gap frameworks (round 2)

### 3.1 LangGraph — shared-state graph **[high]**

The orchestrator is itself a **node** in a `StateGraph`. Assignment is a **handoff tool**, not an
edge: `create_handoff_tool(agent_name=...)` produces a tool that, when the supervisor LLM calls it,
returns a `Command` object that **atomically routes control AND mutates shared state in one write** —
`Command(goto=agent, graph=Command.PARENT, update={**state, "messages": ...})` (or, for fan-out,
`goto=[Send(agent, ...)]`). `graph=Command.PARENT` lets a tool inside the supervisor's subgraph jump
to a sibling node. Prebuilt `create_supervisor` wires a star/cycle: `START → supervisor → worker →
supervisor → … → END`.

- **Receive/respond** — a worker receives its task as **messages injected into the shared `messages`
  channel** (the handoff packs prior history + a "Successfully transferred to {agent_name}"
  ToolMessage). The worker is a compiled subgraph; on finish, the static `add_edge(agent, supervisor)`
  back-edge returns control and its messages merge back. How *much* returns is governed by
  **`output_mode`**: default `"last_message"` (compact) vs `"full_history"` (everything).
- **Memory** — **ONE shared `State` object** threaded through every node; each key is a "channel,"
  nodes return *partial* updates that the framework merges. Cross-agent memory = the shared `messages`
  channel (`add_messages` reducer, ID-based dedup). Workers are isolated only in their *internal
  scratch* state. Durability layered on: a **checkpointer** persists thread-scoped (short-term) state
  at every super-step; a **store** persists cross-thread (long-term) key-value memory.
- **Conflict** — resolved per-channel by **reducers** `(current, update) -> new` (e.g. `operator.add`
  concatenates, `add_messages` dedupes). Reducers are the prescribed way to make parallel fan-in safe.
- **Prompt overhead** — no enforced shared system prompt; per-worker overhead to the supervisor is
  **one `transfer_to_<agent>` tool-schema entry**, not a re-sent prompt (the cheapest of all surveyed).
- **Steal this** — the **`Command` object**: one structured value that records output to shared state
  AND names who runs next. Collapses "edges" into data → edgeless, auditable, dynamically-routed graphs.

### 3.2 Microsoft AutoGen / AG2 — conversational message-passing **[high]**

Spans the spectrum *by itself*, across two generations:

- **Classic GroupChat (0.2 / AG2)** — a single `GroupChatManager` owns ONE shared conversation
  thread. Each turn it **selects** a speaker (`auto` = manager LLM picks from participant
  name+descriptions; `round_robin`; `random`; `manual`; or a custom `(last_speaker, groupchat) ->
  Agent`). The selected agent reads the shared transcript, produces one message, the manager
  **broadcasts** it to every agent so all contexts stay in sync. Maximal shared context, no isolation.
- **AutoGen 0.4 Core** — no central orchestrator object; an **actor runtime** delivers messages.
  Assignment = direct RPC (`send_message` → typed request/response) or `publish_message` to a
  `TopicId` (type+source), mapped to agents via `type_subscription` (sender needn't know recipient
  IDs). Each actor has **private state**; share-nothing. `AgentChat` teams reintroduce a shared thread
  on top via broadcast.
- **AG2 Swarm/handoffs** — tiered evaluation: `OnContextCondition` (context-variable expression,
  evaluated first, **no LLM**) → `OnCondition` (LLM tool-call) → `AfterWork` fallback. A `ReplyResult`
  can carry output AND name the next target.
- **Durability** — 0.2 in-memory only; 0.4 adds `save_state`/`load_state` (serialize a whole team to
  JSON and resume).
- **Prompt overhead** — each agent carries its OWN full system prompt; the *shared* part is the
  transcript, not the instructions. `auto`/Selector group chat spends an **extra LLM call per turn**
  just to pick the next speaker. AG2's `OnContextCondition` is the cheap (no-LLM) routing path.
- **Steal this** — 0.4 Core's **pub/sub by topic-type subscription**: publish to a `TopicId`, never
  name recipients; add/remove workers without touching producers. (Plus AG2's tiered handoff — pay
  for an LLM only when a rule genuinely needs judgment.)

### 3.3 CrewAI — role-based crews, agents-as-tools **[high]**

Two modes. **Sequential** (default): no orchestrator — tasks are pre-assigned and run in list order,
chained via the `context` parameter (one task's output feeds the next). **Hierarchical**: a **manager
agent** (auto-created via `manager_llm`, or supplied as `manager_agent`) allocates tasks by **calling
a tool**.

- **Assign / receive / respond** — when an agent has `allow_delegation=True`, CrewAI injects two
  tools — **"Delegate work to coworker(task, context, coworker)"** and **"Ask question to
  coworker(…)"**. The manager picks a worker by its **`role` string**; the worker runs
  **synchronously inline** and its natural-language output returns as the **tool observation**. The
  worker has no awareness it was "delegated to." (Sharp edge, issue #2606: the tool schema expects
  plain `str`; managers sometimes emit dicts → validation failure — confirming a strict-typed handoff
  boundary, not a rich object graph.)
- **Memory** — OFF by default (`memory=True` to enable). Three stores + a contextual assembler:
  **short-term** (current run, RAG over a vector DB), **long-term** (SQLite, persists task *outcomes*
  across runs), **entity** (RAG knowledge base). Memory is **crew-scoped and SHARED across all agents
  by default** — global shared state, with opt-in per-agent isolation in newer versions.
- **Conflict** — **no formal merge layer.** Sequential = ordering arbitrates; hierarchical = the
  **manager LLM** validates/accepts/redoes. No locking, no CRDT, no diff-merge.
- **Durability** — long-term memory persists across runs; **Flows** add real durable orchestration
  state (`self.state`, auto-UUID, persist/resume; event-driven `@start`/`@listen`/`@router`).
- **Prompt overhead** — each agent carries its OWN full prompt (role + goal + backstory interpolated
  into a system template); delegation tool schemas layered on top.
- **Steal this** — **agents-as-tools**: reify every coworker as an ordinary typed LLM tool; a handoff
  is just a tool call returning the sub-agent's text. Adding/removing a worker = adding/removing a tool.

### 3.4 Temporal — durable execution **[high]** (with a correction, see §6)

No "supervisor" abstraction — orchestration is **plain workflow code** (the agentic loop *is* a
Workflow function). Three assignment mechanisms:
1. **Activities** — `await workflow.execute_activity(tool, params, …)`; an LLM activity can return the
   next tool to run.
2. **Child workflows** — a planner spawns one child per parallel sub-agent; each gets its own durable
   execution + event history.
3. **Nexus** — cross-team/namespace delegation via versioned, discoverable endpoints.

Workers (OS processes) **long-poll a task queue and pull** work; the orchestrator enqueues, the
Temporal Server routes.

- **Receive/respond** — the framework invokes the function with typed args; an Activity's return value
  is recorded as an `ActivityTaskCompleted` event and flows back at the `await` point. State readable
  mid-run via **Queries** without waiting for completion.
- **Memory** — **isolated by construction**: "each workflow instance has its own execution context."
  State is ordinary instance variables, durable because **derived by replaying the event history**,
  not serialized. No implicit shared global memory; sharing is explicit (args, return values,
  Signals, cross-workflow Queries, Nexus).
- **Durability / conflict** — event-sources *everything*; on crash, code re-runs from the top but
  completed Activities return their **logged results** instead of re-executing. Demands deterministic
  workflow code (non-determinism pushed into Activities). **Human handoff**: a `@workflow.signal`
  flips state; the workflow blocks on `wait_condition(..., timeout=days)` and resumes deterministically.
  **Conflict** handled by **identity + idempotency** (unique workflow IDs lock one entity to one
  instance), NOT by merge. Temporal prevents *duplicate/racing execution*; it does **not** auto-merge
  conflicting LLM outputs.
- **Steal this** — **durability by replay, not snapshot**: persist only the event log; regenerate
  state by re-running while completed steps short-circuit. Mid-flight crash recovery at every `await`,
  pause-for-days human-in-loop. (For Fleet: log each worker step as an event, reconstruct a session by
  replay, use a unique session/worktree ID as the lock so two app windows can't drive the same
  `fleet-N` namespace.)

### 3.5 Message-queue / actor / blackboard — the pre-LLM substrate **[high]**

The archetypes the LLM frameworks rediscover:
- **Actor model (Akka)** — no central dispatcher; a parent creates children (a supervision tree) and
  assigns work by sending an async message to a child's `ActorRef`. Each actor has a **private
  mailbox** + isolated state; share-nothing. Failure handled by the **supervision tree**
  (Resume / Restart / Stop / Escalate). Handoff = forward the message.
- **Task queue (Celery)** — fully decoupled push-then-pull: the producer adds a message; the **broker**
  routes by queue/routing-key; any free worker claims it. Results go to a **separate result backend**
  the client polls. **Durable** (persisted queues, `acks_late` + retries → at-least-once).
- **Blackboard (Hearsay-II)** — **no orchestrator.** Each Knowledge Source is a condition-action pair
  triggered when the **shared blackboard** changes in a way it declared interest in; a monitor
  enqueues candidates and a **heuristic scheduler** runs the highest-priority one. **Shared global
  memory.** Conflict is *expected*: competing hypotheses coexist, each with a **credibility rating**,
  re-scored as more KSs corroborate — competition is the mechanism, not an error.
- **Memory axis** — actor/queue = private mailbox, share-nothing; blackboard = single shared knowledge
  space.
- **Steal this** — the blackboard's **opportunistic, data-directed control**: the shared state
  *selects* which agent runs (no planner); drop in a new specialist by declaring its trigger; resolve
  overlapping answers by **scoring**, not by preventing overlap.

### 3.6 Cognition / Devin — the single-thread dissent **[high]**

A contrarian *position*, not a framework (Walden Yan, "Don't Build Multi-Agents," + follow-up
"Multi-Agents: What's Actually Working"). Devin is the production embodiment.

- **Thesis** — most fan-out parallel-subagent designs are **fragile**. Default to **one continuous
  single-threaded agent**: "the context is continuous." It rejects (a) naive parallel (each subagent
  gets only its subtask) and (b) improved parallel (each also gets the full task) — both fail because
  "decision-making ends up being too dispersed and context isn't shared thoroughly enough."
- **Two principles** — **(1)** Share context — **full agent traces, not just messages**; every actor
  should read the complete trace, not a summarized handoff. **(2)** "Actions carry implicit decisions,
  and conflicting decisions carry bad results" — two parallel agents inevitably make incompatible
  *implicit* choices (style, edge-cases) that no later combiner can reconcile (the Flappy Bird
  example: mismatched background + bird).
- **Memory** — ONE shared linear context; for overflow they do NOT shard across agents — they
  **compress one shared history** with a dedicated fine-tuned summarization model. Isolation
  ("clean context") is used as a feature for **critique** agents only, never writers.
- **Conflict** — avoided **structurally**, not merged: keep **WRITES SINGLE-THREADED**. "Multiple
  agents contribute intelligence to a task while writes stay single-threaded" — one writer, so there's
  never a concurrent write to reconcile.
- **Prompt overhead** — the opposite of cheap message-passing: carry the **full accumulated trace** at
  every step (maximal by intent), mitigated by the learned compression model. They explicitly
  criticize Swarm/AutoGen for passing only messages because it loses decisions.
- **Steal this** — **"single-threaded writes, parallel intelligence"**: decouple *who thinks* from
  *who writes*. Fan out freely for reading/reviewing/critiquing (even across different frontier
  models); allow only ONE writer to commit mutations. Dissolves the merge-conflict problem at the
  architecture level. Second idea: treat **context compression as a first-class learned component**.

---

## 4. Conflict handling — the axis everyone hand-waves

| Mechanism | Determinism | Systems |
|---|---|---|
| **Reducers** — per-channel fold (`add_messages` dedupes by id) | deterministic | LangGraph |
| **Credibility-scored competing hypotheses** | deterministic | classic blackboard (Hearsay-II) |
| **Manager LLM reconciles in natural language** | non-deterministic | AutoGen, CrewAI, Anthropic "synthesize" |
| **Unique-ID locking** — prevent the race, no semantic merge | deterministic (prevents, doesn't merge) | Temporal |
| **One writer only** — eliminate the conflict structurally | n/a | Cognition / Devin |

Only blackboard scoring and LangGraph reducers do a *deterministic semantic merge*. Everyone else
either avoids concurrency (Temporal IDs, Cognition single-writer) or defers to an LLM's judgment.

---

## 5. When to use what

- **Isolated parallel workers** — read-heavy, decomposable, low-interdependence work (broad search,
  parallel research, independent file edits, fan-out review). Wrong when subtasks share implicit
  design decisions. Pay the ~15× knowingly.
- **Shared-state graph (LangGraph)** — agents must see each other's intermediate results; you want
  deterministic, auditable routing + safe parallel fan-in (reducers). Overkill for a one-shot fan-out.
- **Durable execution (Temporal)** — long runs, must survive crashes, pause for human input
  hours/days, duplicates unacceptable. **Orthogonal** — wrap *any* topology in it.
- **Single-thread linear (Cognition)** — tightly-coupled work where every action encodes decisions
  others must respect (most coding tasks). Add agents only for parallel *intelligence*, never parallel
  *writes*. No true throughput parallelism.

**"Most sophisticated AND most adopted"** is genuinely split: **LangGraph = most complete framework**,
**Temporal = most sophisticated durability**, **isolated-workers = most actually shipped**,
**Cognition single-thread = most correct default for coupled work**.

---

## 6. ⚠️ Skeptic corrections (do NOT propagate these errors)

- **Temporal — exactly-once.** Activities are **at-least-once, NOT exactly-once**; an activity may run
  multiple times. Replay short-circuits already-*completed* activities; **true exactly-once requires
  developer-supplied idempotency keys.** ID-locking prevents a race but does NOT make a partially-run
  step idempotent. (Several "quotes" in the raw research were paraphrase dressed as quotation.)
- **CrewAI — `allowed_agents`.** PR #2068 was **never merged**; the parameter does not exist in
  current source. Don't cite it as shipped. The strict-`str` delegation boundary (issue #2606) is real.
- **LangGraph — concurrent writes.** No-reducer **concurrent** same-key writes (same super-step) raise
  a hard **`InvalidUpdateError`**; "last-write-wins (override)" applies only to **sequential**
  single-writer updates — two distinct cases. Also: the prebuilt supervisor defaults
  `parallel_tool_calls=False`, so parallel handoffs are **OFF by default**. The `branch:to:X` internal
  channel name is unverified.
- **AutoGen — naming.** "AG2 Swarm" is **deprecated / merged into Group Chat (v0.9)**; the mechanics
  are current but the name is not a live standalone orchestrator. `publish_message` delivers **once per
  agent**, not "once per matching subscription."
- **Cognition — anecdote attribution.** The "we gave Devin an MCP to spawn other Devins → chaotic
  world" story is associated with the **Latent Space interview** discussion (attributed in the round-1
  skeptic to Cole Murray / OpenInspect), **not** a claim from Cognition's own essays. The
  "single-threaded writes, parallel intelligence" framing is from the **follow-up** essay only, not the
  original.
- **Blackboard.** "No orchestrator" is loose — Hearsay-II has a central **scheduler**; it denies task
  *routing*, not central control.

---

## 7. Unresolved / open questions

- **Conflict at scale** — beyond reducers (LangGraph) and credibility scoring (blackboard), there is no
  proven *semantic* merge for contradictory LLM outputs. Everyone else avoids concurrency or trusts an
  LLM judge.
- **Auto-delegation reliability** — Claude Code's description-driven auto-delegation is documented as
  unreliable in practice (independent reports say explicit by-name invocation is more reliable); A2A
  mandates no selection algorithm. "Pick the best agent" at scale is unproven.
- **The dissent is unadjudicated** — Cognition's "multi-agent is fragile" position surfaced but every
  verifier abstained (session-cap failures in round 1); it is *present in the field, not refuted on the
  merits.*

---

## 8. Sources

**Primary (vendor / standards / canonical):**
- Anthropic — https://www.anthropic.com/engineering/multi-agent-research-system
- Claude Code subagents — https://code.claude.com/docs/en/sub-agents
- OpenAI Agents SDK — https://openai.github.io/openai-agents-python/
- Google A2A blog — https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- A2A spec — https://a2a-protocol.org/latest/specification/
- LangGraph graph API / persistence — https://docs.langchain.com/oss/python/langgraph/graph-api · https://docs.langchain.com/oss/python/langgraph/persistence
- langgraph-supervisor source — https://github.com/langchain-ai/langgraph-supervisor-py (supervisor.py, handoff.py)
- AutoGen 0.4 — https://www.microsoft.com/en-us/research/articles/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/ · https://microsoft.github.io/autogen/stable/ · AG2 docs https://docs.ag2.ai/ · paper https://arxiv.org/pdf/2308.08155
- CrewAI docs — https://docs.crewai.com/ (hierarchical-process, processes, collaboration, memory, agents, flows) · PR #2068 · issue #2606
- Temporal — https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai · https://docs.temporal.io/workflow-execution · https://learn.temporal.io/
- Akka supervision — https://doc.akka.io/libraries/akka-core/current/general/supervision.html
- Celery — https://docs.celeryq.dev/en/stable/getting-started/introduction.html
- Hearsay-II (blackboard) — https://websites.nku.edu/~foxr/CSC425/hearsay2.pdf
- Cognition — https://cognition.com/blog/dont-build-multi-agents · https://cognition.com/blog/multi-agents-working · https://www.latent.space/p/cognition
- LangChain — https://blog.langchain.com/how-and-when-to-build-multi-agent-systems/

**Secondary / comparison:** Arize, Composio, DataCamp framework comparisons; Diagrid
"checkpoints-are-not-durable-execution"; LangChain "LangGraph vs Temporal"; Augment/Descope/DigitalOcean
A2A-vs-MCP; arXiv 2507.01701 (blackboard MAS), 2503.13657, 2505.02279.

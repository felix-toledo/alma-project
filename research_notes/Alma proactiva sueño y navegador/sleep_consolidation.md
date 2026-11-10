# Nightly "sleep / dreaming" phases for AI agents: consolidation, forgetting, next-day planning, wake trigger

Research date: 2026-11-08. Labels: **[SHIPPED]** = generally available product; **[PREVIEW]** = shipped but research preview, beta or gated; **[RESEARCH]** = paper or prototype; **[UNOFFICIAL]** = only third-party or reverse-engineered sources. Items dated before 2025 are marked **(older)**.

## Sleep-time compute: Letta's sleep-time agents and the 2025 paper

### Takeaway
Sleep-time compute means doing reasoning offline over context the agent already has, before the user asks, so answers at "test time" are cheaper and better. Letta's version pairs a fast primary agent that talks to the user with a slower, stronger background agent. Only the background agent may rewrite the shared core memory. The paper reports about 5x less test-time compute for the same accuracy, but the gains depend on how predictable the next queries are.

### Cited Findings
- **[RESEARCH]** "Sleep-time Compute: Beyond Inference Scaling at Test-time", by Kevin Lin, Charlie Snell, Yu Wang, Charles Packer, Sarah Wooders, Ion Stoica and Joseph E. Gonzalez (arXiv:2504.13171, 17 April 2025). The model "thinks" offline about a context before queries arrive, anticipating likely questions and precomputing useful quantities. — [arXiv](https://arxiv.org/abs/2504.13171)
- Results: about 5x less test-time compute for the same accuracy on Stateful GSM-Symbolic and Stateful AIME; scaling sleep-time compute raises accuracy by up to 13% (GSM-Symbolic) and 18% (AIME). On Multi-Query GSM-Symbolic, sharing sleep-time work across related queries cuts the average cost per query by 2.5x. — [arXiv](https://arxiv.org/abs/2504.13171)
- How predictable the user's query is correlates with how much sleep-time compute helps. The paper also includes an agentic software-engineering case study. — [arXiv](https://arxiv.org/abs/2504.13171)
- **[SHIPPED]** Letta blog, 21 April 2025: each sleep-time-enabled agent is two agents "under the hood". The **primary agent** messages the user, calls custom tools and searches external memory (recall and archival), but **has no tools to edit its core memory** (the in-context memory blocks). The **sleep-time agent** holds the core-memory editing tools and manages both its own memory and the primary agent's. — [Letta blog](https://www.letta.com/blog/sleep-time-compute)
- The sleep-time agent turns "raw context" into "learned context". Updates are asynchronous, so the primary agent reads whatever is current without waiting. How often it runs is configurable: "The higher the frequency setting, the more tokens your agent will use." The post suggests a fast model (for example gpt-4o-mini) for the primary agent and stronger models (gpt-4.1, Sonnet 3.7) for the sleep-time agent, since it is not latency-bound. — [Letta blog](https://www.letta.com/blog/sleep-time-compute)
- Letta docs, as reported in search snippets: sleep-time agents "share the memory of primary agents" and change it asynchronously. All agents in the system share one or more memory blocks, and one block can be attached to several agents. It is enabled with `enable_sleeptime=True` (TS: `enableSleeptime: true`). Attaching a file such as a PDF spawns an "ephemeral" sleep-time agent to process it. — [Letta docs (search snippet)](https://docs.letta.com/guides/agents/architectures/sleeptime/index.md); the page itself returned 404 when fetched.
- Current Letta docs (2026) describe the evolved design. Agents use **MemFS**, "a git-backed memory filesystem that they can inspect and edit". **Dreaming** uses "background subagents" to review recent conversations and update memory. It is configured with `/sleeptime` (CLI) or "Dream settings" (app) and runs after "a set number of completed agent steps or when the context window is compacted". An "Agent reviews before applying" option has the agent revise proposed updates in "a second background conversation", which costs more tokens and does not ask the user for approval. Memory repos are capped at 5 MiB (Free) or 50 MiB (Pro). — [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)

### Inferences
- The design pattern that matters for Alma: **only the "sleeper" writes curated long-term memory**, while the live agent only appends raw events or episodes. That gives a single writer, an audit point and no write contention with live chats.
- Letta's triggers are event-based (step count, context compaction), not clock-based. For a laptop, a hybrid fits best: event triggers during the day plus one "deep" nightly pass.
- Git-backed memory (Letta MemFS) gives diffs, history and rollback for free. Alma's Markdown vault can do the same if the nightly pass commits its changes.

### Gaps
- Letta's current docs do not publish default frequencies or recommended models for dreaming. The 2025 blog's model suggestions are now dated.
- I found no independent evaluation of Letta's sleep-time agents on real personal-assistant workloads; the paper uses math benchmarks plus one SWE case study.

## Product features named "dreaming" / consolidation / overnight work (Claude, ChatGPT, Gemini, others)

### Takeaway
"Dreaming" is now a real product term. Anthropic ships **Dreams** as a research-preview API for Managed Agents (announced May 2026), and its design is the most relevant reference for Alma. It is non-destructive: it writes a new memory store for review and never edits the input store. Claude Code's "Auto Dream" is only documented by third parties. OpenAI shipped overnight research (Pulse, Sept 2025) and later folded it into scheduled tasks (June 2026). Google's CC (Dec 2025) became Gemini "Daily Brief" (2026).

### Cited Findings
**Anthropic, Claude Managed Agents "Dreams" [PREVIEW]**
- What it does: "A dream reads an existing memory store alongside past session transcripts, then produces a new, reorganized memory store: duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced. The input store is never modified, so you can review the output and discard it." — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- Inputs: one memory store plus **1 to 100 sessions** (transcripts). It is an async job with states pending, running, completed, failed and canceled. It "typically take[s] minutes to a few hours". An optional `instructions` field steers synthesis ("focus on coding-style preferences; ignore one-off debugging notes"). It is "a synthesis pass ... not an editor", so line-level edits should go through the Memory Stores API. — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- Auditability: the dream runs as a session whose events can be streamed to "observe what the dream is reading and writing in real time". The session is archived, not deleted, afterward. A failed run leaves a partial output store for inspection. — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- Cost: billed at standard token rates, and cost "scales roughly linearly with the number and length of input sessions. Start with a small batch". Not eligible for ZDR or HIPAA. A cookbook recipe ("Dreaming with a dynamic workflow") shows how to build your own dream with your own prompts, models, timing and transcript choice. — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- Launch: announced at Code with Claude, 6 May 2026, as a research preview behind a developer access form. Press describes it as a scheduled process that merges duplicates and drops stale entries, with updates applied automatically or reviewed first. — [9to5mac](https://9to5mac.com/2026/05/07/anthropic-updates-claude-managed-agents-with-three-new-features/); [Techzine](https://www.techzine.eu/news/devops/141125/anthropic-introduces-dreaming-for-claude-managed-agents/)

**Claude Code auto memory and "Auto Dream" [SHIPPED / UNOFFICIAL]**
- Official: auto memory is on by default. Claude writes notes into `MEMORY.md` plus topic files, and "the first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation"; Claude moves detail into topic files to keep MEMORY.md concise. Toggled through `autoMemoryEnabled`. **The official memory page does not mention Auto Dream or /dream** (checked 2026-11-08). — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Third-party claims, unverified: a background sub-agent reviews recent transcripts and prunes, merges and de-duplicates memory files, fixes relative dates, and removes contradictions. It reportedly triggers after at least 24 h since the last consolidation **and** at least 5 sessions, with a manual `/dream`, a lock file to prevent concurrent runs, and write access limited to memory files. It surfaced around March 2026 behind a feature flag. — [claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream); [implicator.ai](https://www.implicator.ai/anthropic-adds-auto-dream-to-claude-code-fixing-memory-decay-between-sessions); [nicolasneira](https://nicolasneira-com.pages.dev/en/claude-code-memory-2.0/)

**Claude app (claude.ai) memory [SHIPPED]**
- The Help Center (read through a mirror) says the memory synthesis "is updated every 24 hours" and gives context to each new standalone conversation. Secondary sources say the July 10, 2026 release notes moved to individual categorized memory entries updated during conversations, with gradual migration. — [Help Center mirror](https://hn.jakechampion.name/reader/https://support.anthropic.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context); [leadwithai](https://www.leadwithai.co/article/claude-memory-updates-live-chat-cowork) (secondary)

**OpenAI ChatGPT [SHIPPED, then retired]**
- **Pulse** launched 25 Sept 2025 in preview for Pro on mobile. ChatGPT "can now proactively deliver personalized, focused updates for you once a day ... based on asynchronous research ChatGPT can do on your behalf overnight, synthesizing information from your memory, chat history, and direct feedback". It came to web on 29 Oct 2025. — [OpenAI: Introducing ChatGPT Pulse](https://openai.com/index/introducing-chatgpt-pulse/); [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) (via search snippet; page 403 when fetched)
- Pulse output was visual cards, typically 5 to 10 per day, that **expire after 24 h unless saved**. Users steered it with thumbs up or down and a "curate" request. Gmail and Calendar connectors were optional, and memory had to be on. — [OpenAI announcement](https://openai.com/index/introducing-chatgpt-pulse/); [The Neuron](https://www.theneuron.ai/explainer-articles/chatgpt-pulse-makes-ai-your-personal-research-assistant-while-you-sleep) (secondary)
- **Sunset:** the 17 June 2026 release notes say Pulse "is being sunset as proactive updates move into scheduled tasks", rolling out to Plus, Pro, Business and Enterprise. — [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) (search snippet)
- **Automatic memory management**: announced 15 Oct 2025, it ends "memory full". ChatGPT ranks memories by relevance (reportedly recency, frequency and user interaction), shows what is "top of mind", and users can sort, search and re-prioritize. — [TestingCatalog](https://testingcatalog.com/openai-prepares-automatic-memory-management-for-chatgpt); [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-is-smarter-now-that-its-learned-to-forget-a-huge-memory-upgrade-is-coming); prioritization criteria from [Eastgate](https://eastgate-software.com/chatgpts-new-memory-update-learns-to-forget/) (secondary)
- Claims of a June 2026 ChatGPT "Dreaming" memory update appear only on low-authority blogs and could not be verified. — [unabyss](https://unabyss.com/blog/chatgpt-memory) **[UNOFFICIAL]**

**Google CC → Gemini Daily Brief [SHIPPED]**
- CC is a Google Labs experiment that rolled out from 16 Dec 2025. It sends a morning email, "Your Day Ahead", that summarizes the schedule, key tasks and important updates (appointments, bills), built from Gmail, Calendar and Drive. Users can reply to it. — [Tom's Guide](https://www.tomsguide.com/ai/google-just-launched-a-new-ai-agent-that-runs-your-inbox-heres-what-cc-actually-does); [Chrome Unboxed](https://chromeunboxed.com/googles-new-cc-ai-agent-wants-to-be-your-morning-executive-assistant)
- Gemini "Daily Brief" was reportedly announced at I/O on 19 May 2026 as the successor to CC. It covers Gmail, Calendar, Drive and the web, and went to US AI Plus, Pro and Ultra tiers (one source says free in the US from 4 Sep 2026). — [jetstream.blog](https://jetstream.blog/?p=223568) (secondary; dates unverified against Google)

**Open-source / community [RESEARCH/UNOFFICIAL]**
- "Neuroplastic Memory" (claude-brain) is an MCP server with a "dream" cycle (NREM-style replay, REM-style random walks). The author calls it a non-production weekend project. — [mcpservers.org](https://mcpservers.org/servers/gammon-bio/claude-brain)

### Inferences
- Anthropic's Dreams is the closest blueprint for Alma's nightly pass. Copy-on-write output plus human review, a steerable `instructions` prompt, batch inputs (a store plus N transcripts), a streamable audit transcript, and token cost linear in the transcripts read.
- Product trend from 2025 to 2026: dedicated "overnight" features (Pulse) collapsed into general **scheduled tasks**. For Alma, the morning brief and the nightly dream should be routines on the existing routine/reminder engine, not a separate subsystem.
- Pulse's 24 h expiry for briefing cards is a useful forgetting default: the brief is ephemeral unless the user saves it.

### Gaps
- No official Anthropic documentation of Claude Code's Auto Dream was found; trigger thresholds come from reverse engineering.
- Couldn't fetch OpenAI's help article on Pulse (403). Details of the scheduled-tasks replacement are unconfirmed.
- Microsoft Copilot morning brief or daily digest, and "Hark": not researched within budget, no sources found.

## Academic work: reflection, tiered memory, graph memory, decay and neuroscience-inspired consolidation

### Takeaway
The settled toolkit has three parts. (1) Score memories by recency × importance × relevance (Generative Agents). (2) Run periodic **reflection** that writes higher-level insights back as memories. (3) Store facts with validity intervals so contradictions supersede rather than overwrite (Zep/Graphiti). Ebbinghaus-style decay (MemoryBank) is the classic forgetting model. Explicit NREM/REM "sleep" architectures exist only as 2026 prototypes.

### Cited Findings
- **(older, 2023) [RESEARCH] Generative Agents** (Park et al., arXiv:2304.03442). Memory stream; retrieval = recency (exponential decay, factor 0.995 per sandbox hour) + importance (LLM-rated 1 to 10) + relevance (embedding similarity). **Reflection** fires when the summed importance of recent events passes a threshold (150). It generates salient questions and writes cited "insights" back into the stream, forming a tree of reflections. Ablations show reflection, planning and observation all matter. — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) (details from the paper body)
- **(older, 2023) [RESEARCH] MemGPT** (Packer et al., arXiv:2310.08560): OS-style virtual context with main context (core memory) plus external recall and archival storage, paged in and out by the agent's own function calls. It is the ancestor of Letta. — [arXiv 2310.08560](https://arxiv.org/abs/2310.08560)
- **(older, 2023) [RESEARCH] MemoryBank** (Zhong et al., arXiv:2305.10250): an updating mechanism "inspired by the Ebbinghaus Forgetting Curve" that "permits the AI to forget and reinforce memory based on time elapsed and the relative significance of the memory". Recalled memories are reinforced; others fade. — [arXiv 2305.10250](https://arxiv.org/abs/2305.10250)
- **[RESEARCH] A-MEM** (Xu et al., arXiv:2502.12110, Feb 2025, NeurIPS 2025): Zettelkasten-style notes with descriptions, keywords and tags, auto-linked to similar notes. **Memory evolution**: new memories can update the context and attributes of older ones. Reports gains over SOTA baselines on six foundation models (no numbers in the abstract). — [arXiv 2502.12110](https://arxiv.org/abs/2502.12110)
- **[RESEARCH + SHIPPED OSS] Mem0** (Chhikara et al., arXiv:2504.19413, Apr 2025): extracts, consolidates and retrieves salient facts, with an optional graph variant. On LOCOMO it reports a 26% relative improvement on LLM-as-a-Judge vs OpenAI memory, 91% lower p95 latency and more than 90% token savings vs full context; the graph variant is about 2% higher. — [arXiv 2504.19413](https://arxiv.org/abs/2504.19413)
- **[RESEARCH + SHIPPED OSS] Zep / Graphiti** (Rasmussen et al., arXiv:2501.13956, Jan 2025): a "temporally-aware knowledge graph engine" that keeps historical relationships. DMR 94.8% vs 93.4% for MemGPT; up to 18.5% accuracy gain on LongMemEval; 90% lower latency vs baselines. — [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)
- **[RESEARCH] SCM: Sleep-Consolidated Memory with Algorithmic Forgetting** (S. S. Shinde, arXiv:2604.20943, 22 Apr 2026, prototype). It has five components: limited working memory, multi-dimensional importance tagging, offline **NREM** consolidation (strengthens important associations), **REM** "dreaming" (generates novel connections), and value-based intentional forgetting, plus a self-model. Reported results: 90.9% reduction in memory noise from forgetting, sub-millisecond search over hundreds of concepts, an 8-test suite; removing forgetting caused unbounded growth. — [arXiv 2604.20943](https://arxiv.org/abs/2604.20943); ablation detail from [search snippet of the PDF](https://arxiv.org/pdf/2604.20943)
- **Surveys:** "A Survey on Memory in AI" (Du et al., arXiv:2505.00675, May 2025) defines six memory operations including **consolidation** and **forgetting**. — [arXiv 2505.00675](https://arxiv.org/abs/2505.00675). "Memory in the Age of AI Agents" (arXiv:2512.13564, Dec 2025) frames formation, decay, consolidation and retrieval as the core dynamics. — [HF papers](https://huggingface.co/papers/2512.13564). "Memory for Autonomous LLM Agents" (arXiv:2603.07670, Mar 2026) lists open problems: continual consolidation, trustworthy reflection, **learned forgetting**. — [arXiv 2603.07670](https://arxiv.org/abs/2603.07670v1)

### Inferences
- A neuroscience mapping that fits Alma's layers. These terms come from neuroscience; this session did not verify primary neuroscience sources, so treat them as design metaphors. Day: episodic, hippocampus-like fast capture (chat logs, events). NREM-like pass: replay the day's episodes, extract durable facts and preferences into semantic memory (vault notes), deduplicate. REM-like pass: cross-link distant notes and propose hypotheses ("Felix mentioned X on Monday and Y today, so maybe Z"). The REM output must be labeled *speculative* and kept apart from facts. Synaptic homeostasis (global down-scaling) maps to a nightly decay of all scores, plus pruning below a threshold.
- For Alma's sqlite-vec plus vault stack, Graphiti-style **validity intervals** (valid_from / invalidated_at) let consolidation supersede a fact without deleting history. This resolves contradictions safely.

### Gaps
- Primary neuroscience citations (complementary learning systems, McClelland et al. 1995; synaptic homeostasis, Tononi & Cirelli) were not fetched in this session.
- Full-text SCM methodology (how REM "novel connections" are generated and validated) is not in the abstract.

## Forgetting policies: what to forget, archive vs delete, decay, summarization hierarchies, privacy

### Takeaway
Production systems almost never hard-delete on their own. They **deprioritize** (ChatGPT), **supersede** (Zep validity intervals, Dreams "replace stale with latest value"), or **produce a new store and keep the old one** (Anthropic Dreams). Hard deletion is reserved for explicit user requests. Decay plus importance scoring decides what stays loaded in context, not what exists.

### Cited Findings
- Anthropic Dreams never modifies the input; old stores are deleted or archived by the developer after review. — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- ChatGPT automatic memory management keeps memories but ranks them, shows what is "top of mind", and lets users sort by recency and re-prioritize. — [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-is-smarter-now-that-its-learned-to-forget-a-huge-memory-upgrade-is-coming)
- Claude Code keeps a bounded index (200 lines / 25 KB of MEMORY.md loaded) and pushes detail to topic files: a two-level summarization hierarchy. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Pulse briefing cards expire after 24 h unless saved. — [The Neuron](https://www.theneuron.ai/explainer-articles/chatgpt-pulse-makes-ai-your-personal-research-assistant-while-you-sleep)
- MemoryBank: retention depends on elapsed time and significance, and recall reinforces. — [arXiv 2305.10250](https://arxiv.org/abs/2305.10250)
- Generative Agents: recency decays exponentially, while importance is fixed at write time. — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)
- SCM: removing forgetting led to unbounded memory growth, and value-based forgetting cut memory noise by 90.9%. — [arXiv 2604.20943](https://arxiv.org/abs/2604.20943)
- Letta memory repos have hard size caps (5 / 50 MiB), which force curation. — [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)

### Inferences
- A suggested tiering for Alma (synthesized, not from one source):
  1. **Never auto-forget**: anything the user explicitly said to remember, commitments with a future date, identity facts, security decisions.
  2. **Supersede, don't delete**: changed facts get `invalidated_at` plus a pointer to the replacement.
  3. **Compress**: raw chat turns older than N days become a daily or weekly episode summary in the vault; raw logs are archived (cold, encrypted, out of retrieval).
  4. **Decay out of context**: low importance × low recency × never recalled drops out of retrieval ranking.
  5. **Hard delete**: only on the user's request ("forget X"). That deletion must propagate to embeddings, summaries derived from X, and archives (right to be forgotten).
- Deleting a source without also purging the summaries and embeddings derived from it is the main privacy trap. Track provenance (summary → source IDs) so a "forget" can cascade.
- Make forgetting user-visible: the morning brief can include "I archived 14 trivial items; tap to review". This mirrors ChatGPT's "top of mind" view and Dreams' review-before-use step.

### Gaps
- No source found that gives a quantitative "safe to forget" threshold for personal assistants. Thresholds will need tuning against Felix's data.
- GDPR or right-to-erasure handling of derived memories (embeddings, summaries) in shipped assistants: no primary source found.

## Next-day planning and morning briefs

### Takeaway
Shipped morning briefs (Pulse, CC/Daily Brief) build on three inputs: calendar, inbox and the assistant's memory of recent chats. They deliver a short, scannable digest early in the day that the user can reply to and steer. Overnight work does the research ahead of time, so the morning interaction is cheap. This is the same amortization the sleep-time compute paper measured.

### Cited Findings
- Pulse: once-daily overnight asynchronous research from memory, chat history and feedback, with optional Gmail and Calendar. It produced 5 to 10 cards, users could ask for specific topics to be researched nightly, and feedback came from thumbs and "curate". — [OpenAI](https://openai.com/index/introducing-chatgpt-pulse/); [The Neuron](https://www.theneuron.ai/explainer-articles/chatgpt-pulse-makes-ai-your-personal-research-assistant-while-you-sleep)
- Pulse moved into "scheduled tasks" in June 2026. — [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- CC: a morning email "Your Day Ahead" that summarizes the schedule, highlights key tasks, and flags appointments and bills, built from email, calendar and docs. Users can reply to teach it or ask for things. — [Tom's Guide](https://www.tomsguide.com/ai/google-just-launched-a-new-ai-agent-that-runs-your-inbox-heres-what-cc-actually-does)
- Sleep-time compute pays off most when the next queries are predictable, and shared precomputation across related queries cut per-query cost 2.5x. — [arXiv 2504.13171](https://arxiv.org/abs/2504.13171)
- Generative Agents produce top-down daily plans (broad strokes, then recursively finer) and revise them when observations change. — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) (older)

### Inferences
- "Open loops" for Alma's nightly planner: unanswered Telegram or WhatsApp messages, tasks or reminders due tomorrow, promises in chat ("I'll send it tomorrow"), unfinished agent tasks or approvals, company or meeting prep, calendar events, and home-automation anomalies.
- Output should be a **precomputed brief plus pre-warmed context** (sleep-time "learned context"): a short note in the vault, plus memory-block updates the morning agent loads, so the first reply is instant.
- Separate **facts** (calendar: "meeting at 10") from **predictions** ("you'll probably want to finish X"); label the latter as guesses.

### Gaps
- Microsoft Copilot daily brief and Hark: not found or not researched.
- No evaluation data found on how accurate "predicted tomorrow tasks" are in shipped products.

## Wake detection and morning trigger (Windows / Electron / home)

### Takeaway
On Windows/Electron, the cheapest reliable "Felix is up" signals are: OS resume from sleep, screen unlock, idle time dropping to zero after a long idle stretch, and the first inbound message on any channel. Electron exposes most of these natively. Smart-home and phone presence can add earlier signals. The brief should fire on the first strong signal after a night window, not on a fixed clock.

### Cited Findings
- Electron `powerMonitor`: `suspend` and `resume` events (no platform restriction listed); `lock-screen` and `unlock-screen` on **macOS and Windows**; `user-did-become-active` and `user-did-resign-active` on **macOS only**; `shutdown` on Linux and macOS only; `getSystemIdleTime()` (seconds idle) and `getSystemIdleState(threshold)` (`locked` "available on supported systems only"). — [Electron docs: powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)
- Win32: `WTSRegisterSessionNotification` registers a window for `WM_WTSSESSION_CHANGE` session-change messages (logon, lock, unlock and so on). Services use `HandlerEx`. — [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification)
- Win32 `GetLastInputInfo` gives the tick of the last input event (the basis for idle detection). — [Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo) (not fetched this session; standard API)

### Inferences
- A suggested trigger rule for Alma: after a "night window" (for example 00:00 to 10:00, learned from history), the **first** of these fires the morning greeting once per day:
  - (a) inbound Telegram, WhatsApp or voice message;
  - (b) `unlock-screen` or `resume` with the idle period before it over about 4 h;
  - (c) `getSystemIdleTime()` going from more than 4 h to under 60 s (poll every minute; this covers machines that never locked);
  - (d) a Home Assistant presence or sensor event (bedroom motion, phone alarm dismissed, phone off charger). Alma already embeds HA, so its person/device-tracker states and the companion-app "next alarm" sensor are candidates.
- Debounce: one brief per day; if the user is in the middle of a task, deliver it as a gentle card rather than interrupting. If the user opens with a request, answer it first and attach the brief after.
- `user-did-become-active` is macOS-only, so on Windows rely on unlock, resume and idle polling.

### Gaps
- Home Assistant presence or "sleep tracking" docs and the companion-app next-alarm sensor were not fetched in this session; verify before designing on them.
- How Pulse or CC time their delivery (fixed hour vs user wake) is not documented in the sources found; CC is described only as "morning".

## Cost and scheduling: overnight LLM jobs on a laptop that may be asleep

### Takeaway
Don't count on the laptop being awake at 03:00. Task Scheduler's "wake the computer" is unreliable on Modern Standby hardware. The robust design is **catch-up**: run the dream when the machine is idle and on AC power during the night if possible, and otherwise at first resume or boot, before or while the morning brief is prepared. Cap tokens per run and batch transcripts, since cost scales linearly with transcripts read.

### Cited Findings
- Users report that Modern Standby PCs often do **not** honor wake timers from Task Scheduler. Behavior varies by OEM and firmware, and some ignore wake timers on battery. `powercfg /a` shows the sleep model. "Run as soon as possible after a scheduled start is missed" is the common fallback. — [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1660115/regarding-waking-up-from-sleep-on-a-modern-standby); [HP forum](https://h30434.www3.hp.com/t5/Notebook-Operating-System-and-Recovery/Scheduled-task-does-not-wake-laptop-reliably/m-p/9564506); [ElevenForum](https://www.elevenforum.com/t/modern-standby-scheduled-tasks.16749/page-3) (community sources, not official)
- Anthropic Dreams: cost "scales roughly linearly with the number and length of input sessions"; start small. Runs take minutes to hours, and a `timeout` error exists for runs over the runtime budget. — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- Letta: higher sleep-time frequency costs more tokens. Use a cheap fast model live and a stronger model offline. — [Letta blog](https://www.letta.com/blog/sleep-time-compute)
- Claude Code Auto Dream reportedly gates on at least 24 h **and** at least 5 sessions, which avoids wasted runs on quiet days. — [claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-dream) **[UNOFFICIAL]**
- Mem0 reports more than 90% token savings vs full-context by consolidating facts. — [arXiv 2504.19413](https://arxiv.org/abs/2504.19413)

### Inferences
- Scheduling recipe for Alma (Electron main process): store `lastDreamAt`. On a timer, on `resume` and at app start, if `now - lastDreamAt > 20h` and (night window, or idle over 30 min) and on AC, run the dream. A missed night becomes a catch-up run before the morning brief. Gate also on "enough new material" (for example at least N new turns), as Auto Dream does. Electron's `powerMonitor.isOnBatteryPower()` / `on-ac` exist but were not verified in this session.
- Split cost by phase. NREM (extract and dedupe) is cheap and can run on a local model or a small API model. REM (cross-linking and hypotheses) and next-day planning benefit from a stronger model but run on a capped token budget. Embeddings (bge-m3 locally) cost no API money.
- Keep it **resumable and idempotent**: process transcripts in batches, checkpoint after each, and hold a lock (Auto Dream reportedly uses a lock file) so a run interrupted by sleep resumes rather than duplicating.

### Gaps
- No official Microsoft statement found on wake-timer support under Modern Standby (S0ix).
- No measured token cost figures for a personal-assistant nightly dream; these must be measured on Alma's own logs.

## Risks: hallucinated memories, drift, consolidation errors, auditability

### Takeaway
The main danger is the consolidator writing confident but false "memories" (REM-style synthesis especially) that then get loaded into every future prompt. Mitigations seen in products: non-destructive output plus review (Dreams), an observable transcript of the consolidation run (Dreams), provenance and citations on reflections (Generative Agents), and supersession instead of overwrite (Zep).

### Cited Findings
- Dreams: "The input store is never modified, so you can review the output and discard it"; the dream session can be streamed and is archived for later audit; failed runs leave inspectable partial output. — [Claude Platform docs: Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)
- Press coverage lists provenance or audit visibility and over-pruning of rare-but-important notes as open concerns for Anthropic's dreaming. — [letsdatascience](https://letsdatascience.com/news/anthropic-introduces-dreaming-for-claude-agent-memory-consol-32a279c9)
- Letta's "Agent reviews before applying" adds a second background pass to revise proposed memory updates. It is self-review, not user approval. — [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)
- Generative Agents reflections cite the memory records they were derived from. — [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) (older)
- The 2026 survey names "trustworthy reflection" and "learned forgetting" as open challenges. — [arXiv 2603.07670](https://arxiv.org/abs/2603.07670v1)
- Claude Code docs warn that contradictory memory or instructions lead Claude to "pick one arbitrarily", and that memory is context, not enforced configuration. — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)

### Inferences
- Guardrails for Alma's dream:
  - (1) Every consolidated memory carries source IDs (chat turn or episode) and a `created_by: dream@date` tag.
  - (2) REM or hypothesis output goes into a separate "ideas/speculation" layer that is never loaded as fact.
  - (3) Write through git, or keep a diff log in the vault, so a bad night can be rolled back; show a "what I learned / what I archived" diff in the morning brief.
  - (4) The dream may not change security-relevant settings, approvals or tool risk levels. It writes only memory, mirroring the reported Auto Dream limit to memory files.
  - (5) Treat inbound channel content (WhatsApp, email) as untrusted during consolidation, to resist prompt injection that plants fake memories.
  - (6) Cap how many existing facts one run may invalidate; above the cap, ask Felix.
  - (7) Secrets never enter the dream prompt, matching Alma's existing rule.
- Drift: repeated summary-of-summary passes lose detail. Keep raw episodes archived so a later dream can re-derive from source rather than from its own previous output.

### Gaps
- No quantitative study found measuring hallucination or false-memory rates introduced by LLM consolidation passes in production assistants.

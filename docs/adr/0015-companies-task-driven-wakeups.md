---
status: accepted
---

# Companies are agent teams that sleep and wake only for a concrete trigger

A **company** is a team of agents with an org chart, a task board, meetings and a monthly budget, with the person as the board ("Directorio"). Agents are not "alive all day": they wake only for a task assigned or commented, a review, an optional per-position routine, a meeting (preparation N hours before, default 2, then the meeting itself without tools), a question from a colleague, or the person's message. The engine checks every 30 s (`TICK_MS` in `src/coordinator/company/engine.ts`) and on every change. Built in commit 81c561c.

## Why

Design note "companies-design", user decisions: agents work very little on their own, to control cost; each company has its own vault and accounts; outgoing actions go first to the agent's boss (an LLM review with the boss's own instructions) and then to the person; budgets per company and per agent (USD per month, estimated from token usage), notify at 80% and pause at 100%. The feature was built after researching Paperclip, CrewAI, MetaGPT, ChatDev and AutoGen; what was taken from each is Rationale not documented.

## Considered options

The note names the projects researched, not which designs were rejected. Alternatives: not documented.

## Consequences

- Cost is bounded by triggers and caps, but the cap is soft: enforcement happens when a run starts, so a run in progress keeps spending. Prices are one list price per provider, not per model.
- A task may come back from review at most 2 times (`MAX_REVISIONS`); the third send-back blocks it and notifies the person.
- Company agents get the company vault as working folder, no home tools, no MCP by default and no `delegate_task`; writes inside the company vault and Office/image tools are auto-approved (`COMPANY_AUTO_APPROVE`), while `run_command` still asks and `publish` tools go boss then person (R-07 accepts this).
- A delivery can sit in `review` forever if the reviewer never calls `review_task`.
- Every new position is created with provider `anthropic`; a person with no Anthropic key gets agents that cannot run until edited.
- Deleting a company leaves its `companies/<id>.json` and WhatsApp session behind.
- Each company mailbox password is encrypted like API keys ([ADR 0013](0013-secrets-with-safestorage.md)).

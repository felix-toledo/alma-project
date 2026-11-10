# Proactive AI assistants and agents that take initiative (excluding sleep/memory consolidation and Hark)

Research date: 2026-11-08. Labels: **[SHIPPED]**, **[PREVIEW/ANNOUNCED]**, **[LEAK]**, **[RESEARCH]**, **[RETIRED]**.

## Products: what triggers initiative, which channel, how often, what controls

### Takeaway
By late 2026 the shipped patterns have converged on three things: (1) a **once-a-day brief** built from connected mail, calendar and memory (Pulse → Gemini Daily Brief → Google CC → Copilot "Today"), (2) **user-scheduled/standing tasks** that run unattended and only alert on change (ChatGPT Scheduled tasks, Gemini Spark, Copilot Autopilot, OpenClaw cron), and (3) **ask before high-stakes actions** (spend, send). The most-hyped "AI texts you first" feature, ChatGPT Pulse, was **retired in June 2026** and folded into user-controlled scheduled tasks. That is a strong signal that a feed the agent picks for you lost out to standing orders the user writes.

### Cited Findings
**OpenAI**
- [RETIRED] ChatGPT Pulse launched as a preview on 2025-09-25 for Pro users on mobile. It ran research overnight and showed a daily set of visual cards built from chat history, memory, feedback and optional connectors (Gmail, Google Calendar). Cards refreshed daily and disappeared unless saved, and thumbs up/down shaped later editions. OpenAI admitted Pulse "may sometimes present information that is not relevant." — [Tom's Guide](https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed); [Investing.com](https://www.investing.com/news/company-news/openai-launches-chatgpt-pulse-for-pro-users-bringing-proactive-updates-93CH-4256232); [Android Authority](https://www.androidauthority.com/chatgpt-pulse-launched-3601783/)
- Third-party guides (unverified, not OpenAI pages) say each Pulse connector had a separate "Allow proactive activity" toggle that was **off by default**, plus a "curate" control for requesting topics. — [skywork.ai FAQ (mirror)](https://wombatech.pages.dev/service/https://skywork.ai/blog/chatgpt-pulse-faq-2025-9/)
- [SHIPPED] About 2026-06-17/20, OpenAI announced Pulse's retirement and moved it into **Scheduled tasks**. A new "Scheduled" sidebar page lets users view, pause, edit or delete tasks. Tasks can run at set times or at a part of the day (morning/afternoon/evening), **at most once per hour**, and **pause automatically if the user goes inactive**. Research tasks search the web and connected apps and alert "**only when something actually changes**." OpenAI's suggested replacement for Pulse is asking ChatGPT to schedule a daily briefing. No reason was given beyond tasks being "faster and more reliable." — [The Decoder, 2026-06-20](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/); [Analytics Insight](https://www.analyticsinsight.ae/news/openai-shifts-from-ai-briefings-to-automation-with-scheduled-tasks-rollout)
- The caps on active tasks differ between sources (for example, "3 for Free" vs "10 active"). One user reported that daily briefings break when connector tokens expire. — [prowlo.com](https://prowlo.com/blog/chatgpt-pulse-shut-down); [testingcatalog on X](https://x.com/testingcatalog/status/2067321189362454952)
- Earlier ChatGPT Tasks (help center): one-off or recurring tasks run whether or not the user is online. Voice, file uploads and GPTs are not supported. — [OpenAI Help (mirror)](https://hn.jakechampion.name/reader/https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)

**Google**
- [SHIPPED, Labs] Google Labs **CC** (around Dec 2025) connects to Gmail, Calendar, Drive and the web. Each morning it emails the user a "Your Day Ahead" briefing without being asked, and users customize it by **replying to the email**. Access went through a waitlist (sources disagree on whether it was Ultra-only or for paid Gemini users). — [Tom's Guide](https://www.tomsguide.com/ai/google-just-launched-a-new-ai-agent-that-runs-your-inbox-heres-what-cc-actually-does); [BGR](https://bgr.com/2054540/google-gmail-cc-ai-assistant-email-to-do-google-labs)
- [SHIPPED] **Gemini Daily Brief** (I/O, 2026-05-19) is a skimmable morning digest from Gmail (urgent items), Calendar and connected apps. It prioritizes items against the user's **stated goals** and suggests next steps. It is opt-in to connect apps, and thumbs up/down steers it over time. It launched for Google AI Plus/Pro/Ultra subscribers in the US. — [Google blog, 2026-05-19](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/). It reportedly reached **free US users from 2026-09-09** as a gradual rollout. — [Android Central](https://www.androidcentral.com/apps-software/ai/geminis-daily-brief-drops-its-subscription-fee-heres-what-you-get)
- [PREVIEW] **Gemini Spark** is a 24/7 cloud agent (Gemini 3.5, Antigravity harness). It handles recurring triggers (for example, scanning monthly card statements for hidden fees), learned skills (for example, watching a school inbox for deadlines and sending a daily digest to you **and a partner**) and multi-step workflows (drafting follow-ups). The user chooses whether to turn it on and which apps it connects to. It is "designed to ask first before high-stakes actions like spending money or sending emails." It went to trusted testers in May 2026, then a US Ultra beta. Planned additions are texting/emailing Spark and local browser control. — [Google blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)
- [LEAK, April 2026] "**Proactive Assistance**" in Gemini app code would read on-screen content and notifications, plus data from apps the user explicitly picks. The in-app text reportedly says the data is processed on-device and not used for training or human review. The example given is a "leave now" reminder based on calendar plus live traffic. I found no confirmation that it shipped under that name. One aggregator says it was rebranded into Daily Brief. — [9to5Google](https://9to5google.com/2026/04/27/gemini-proactive-assistance/); [Android Authority](https://www.androidauthority.com/google-gemini-proactive-assistance-3661314/); [AIBase (low quality)](https://news.aibase.com/news/27530)

**Microsoft**
- [PREVIEW] **Copilot Autopilot** (formerly Scout; blog 2026-09-25) is a "persistent, proactive and personal agent that keeps working even when you're not." The user gives it a name, role and goal. It watches channels, follows up on threads, runs recurring work and resumes projects days later. It runs with its own identity, memory and workspace, and permissions, audit and governance apply. Billing is usage-based, with admin spending policies and credit-request approval workflows. — [Microsoft blog](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)
- [PREVIEW] **Copilot "Today"** is a proactive command center over mail, calendar, Teams and tasks, split into "what you missed / what needs attention now / what can wait." It can "draft a message, propose a schedule change, or **stage** a forgotten follow-up **for you to send**," which is the prepare-don't-send pattern. — [Microsoft blog](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)
- [ANNOUNCED, 2026-10-07] Copilot on Copilot+ PCs gets local files and recent activity, plus the ability to act across Windows (organizing files, diagnostics, troubleshooting), "in the coming months." — [Unite.AI](https://www.unite.ai/microsoft-gives-copilot-local-file-context-and-os-wide-actions/)
- **Backlash:** after the "Microslop" backlash, Microsoft is removing eight Copilot actions from the File Explorer context menu (mid-Nov to Dec 2026). It had committed in March 2026 to cutting "unnecessary Copilot entry points." — [Windows Latest, 2026-10-21](https://www.windowslatest.com/2026/10/21/microsoft-is-now-scaling-back-copilot-in-windows-11-amid-microslop-backlash-pulling-8-ai-actions-from-file-explorer-and-calling-it-simplifying/); [Wccftech](https://wccftech.com/microsoft-scales-back-copilot-in-windows-11-removing-eight-ai-actions-from-file-explorer-amid-user-backlash/)

**Meta**
- [TEST, July 2025] Meta AI Studio bots trained (via Alignerr, "Project Omni") to send unprompted follow-ups. The guardrails were: only within **14 days** after the user starts a conversation, only if the user sent **≥5 messages** in that window, and **one follow-up only** with nothing more if the user doesn't reply. Coverage framed the motive as engagement and retention. Meta confirmed "testing follow-up messaging." One report says users complained they could not block the bots, which Meta called a bug. — [TechCrunch](https://techcrunch.com/2025/07/03/meta-has-found-another-way-to-keep-you-engaged-chatbots-that-message-you-first/); [Engadget](https://www.engadget.com/big-tech/meta-is-reportedly-training-its-ai-chatbots-to-send-unprompted-messages-143229039.html); [The Decoder](https://the-decoder.com/meta-tests-chatbots-with-proactive-messaging-to-boost-retention/)

**Amazon**
- Alexa+ reportedly suggests seasonal or weather-based routines (for example, closing the garage when rain is forecast), remembers family preferences, alerts on unusual motion or sound, and gives energy insights. These come from secondary sources. The 2022 "smart home suggestions" feature alerted owners about things like a door left unlocked with nobody home. — [inkl](https://www.inkl.com/news/alexa-here-s-everything-you-need-to-know); [The Drum](https://www.thedrum.com/news/alexa-will-soon-be-able-alert-users-about-information)
- Third-party Alexa skills can only push through the Proactive Events API, on a single channel (Alexa Notifications), and only after **explicit user opt-in**. — [Amazon developer docs](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html)

**Apple**
- [SHIPPED, iOS 18.4+] The Reduce Interruptions Focus and "Intelligent Breakthrough & Silencing" rank notifications by priority. **Manual allow/silence choices always override the AI.** — [Apple Support](https://support.apple.com/en-za/guide/iphone/iph1fbe7d2b9/ios). Critics say non-"Maybe Important" items are hidden entirely, so time-sensitive messages can be missed. — [iMore](https://imore.com/ios/ios-18/i-do-not-trust-apple-intelligence-to-prioritize-my-notificationsyet)

**Wearables and gadgets**
- Humane AI Pin got harsh reviews (MKBHD: "The Worst Product I've Ever Reviewed... For Now") and was later discontinued. Rabbit R1 was widely panned. — [Fast Company](https://www.fastcompany.com/91231902/the-great-ai-gadget-debacle-of-2024?partner=rss); [SlashGear](https://www.slashgear.com/2026417/worst-ai-devices-ever-made-users-say)
- The Friend pendant ($129) is an always-listening companion that texts the user. Its fall 2025 NYC subway campaign (>11,000 car ads, >$1M) was heavily vandalized ("AI wouldn't care if you lived or died," "surveils you"). WIRED found the companion "snarky, sarcastic, unhelpful… argumentative." — [CNN via KVIA](https://kvia.com/news/business-technology/cnn-business-consumer/2025/11/16/how-this-tiny-device-became-a-symbol-for-the-backlash-against-ai/); [Fortune](https://fortune.com/2025/10/01/who-is-avi-schiffmann-friend-ai-pendant-necklace); [Verdict](https://www.verdict.co.uk/ai-friend-loneliness-epidemic/)

**Open source: OpenClaw (formerly Clawdbot)**
- [SHIPPED, OSS] The **heartbeat** is a system-owned monitor job per agent, run by the cron scheduler. Each tick is one agent turn. The default interval is `30m` (`1h` on Anthropic OAuth), and `0m` stops the cadence but keeps event-driven wakes. The agent either sends an alert or suppresses the reply (`NO_REPLY`, or `heartbeat_respond{notify:false}`); older docs and blogs call this `HEARTBEAT_OK`. Other details:
  - **Visibility:** each channel has `heartbeatVisibility` (`showOk`/`showAlerts`/`useIndicator`).
  - **Active hours:** `activeHours{start,end,timezone}`.
  - **Delivery target:** `owner` by default (never a group), with `last`, a specific channel, or `none` as alternatives. `directPolicy:"block"` suppresses DMs.
  - **Busy deferral:** scheduled polls are skipped, not queued, while the user's session is active.
  - **Event wakes:** rate-limited to at least 30 s apart, with a flood guard after 5 starts in 60 s.
  - **Empty checklist:** an empty scratch skips the run.
  - **Cost:** cost = cadence × prompt × model. The levers are `isolatedSession`, a cheaper model, a longer interval, active hours, `lightContext`, and a small scratch.
  - **Checklist storage:** HEARTBEAT.md has been replaced by a per-job "scratch" in the state DB.
  - **No dedupe:** there is no content-based dedupe.
  - **Separation from cron and dreaming:** user-authored recurring work belongs in cron, not the heartbeat, and memory consolidation ("dreaming") is a separate plugin. — [clawdocs.org heartbeat architecture](https://clawdocs.org/architecture/heartbeat)
- Community guidance is to keep the heartbeat checklist short (about 200 words), because every tick costs tokens. Use cron when exact timing matters and heartbeat when "next cycle is fine" and session context helps. — [dev.to](https://dev.to/hex_agent/openclaw-heartbeats-making-your-ai-agent-proactive-instead-of-reactive-2pi5); [Ampere](https://www.ampere.sh/blog/cron-jobs-heartbeats-making-openclaw-proactive)

### Inferences
- The trajectory (Pulse retired, tasks with an "alert only on change" rule, auto-pause on inactivity) suggests that **user-authored standing orders plus a single daily digest** beat an agent-curated feed for reliability and trust. Alma already has routines and reminders, so its proactivity can be built as "routines the agent proposes, the user accepts" rather than a new feed.
- Every major vendor puts **outward actions** (send, spend) behind ask-first or "stage for you to send." This matches Alma's `publish` risk exactly. The proactive layer should *prepare* and *stage*, never send.
- Meta's numeric guardrails (an eligibility window, a minimum-engagement threshold, a single follow-up, stop on silence) are a concrete, copyable throttle for unprompted Telegram/WhatsApp messages.
- OpenClaw's heartbeat is a near-direct template for Alma: a cheap periodic turn with a silent-OK contract, active hours, owner-only DM routing, busy deferral and a flood guard. Its missing content dedupe is a known gap Alma should close.

### Gaps
- I could not fetch the official OpenAI Pulse/Tasks help pages (HTTP 403), so the current plan caps for Scheduled tasks are unverified and the sources conflict.
- I did not research Lindy, Martin, Dot (New Computer), Rewind/Limitless or Bee in depth. From memory and unverified: Amazon acquired Bee in 2025, Meta acquired Limitless in late 2025, and Dot shut down in 2025. Verify before citing.
- Meta's follow-up feature: I found no 2026 confirmation of a broad launch.
- Alexa+: I found no official Amazon document on its proactive trigger logic or frequency.
- Apple: I found no source on proactive Siri (personal context) shipping status in 2026.

## Research: proactive agents, mixed initiative, interruption cost, notification fatigue

### Takeaway
The research agrees with the product lessons. Initiative should be gated by **expected utility versus the cost of interruption** (Horvitz 1999), timed to **task breakpoints rather than idleness** (Iqbal; CHI 2025 Codellaborator), and scored by an internal "motivation to speak" (Inner Thoughts). Current LLMs still predict *when* to help poorly. The best ProactiveBench F1 is about 66%, and real-world data and long-term memory matter a lot (ProAgentBench 2026).

### Cited Findings
- [RESEARCH, 1999] Horvitz, "Principles of Mixed-Initiative User Interfaces" (CHI '99; LookOut calendar agent). It says automated actions should be guided by the **expected value of acting, weighing the context-dependent costs of assisting versus disturbing**. When the system is unsure of intent, it should open an efficient dialog, considering the cost of bothering the user needlessly. The decision is made over P(goal | evidence). — [Horvitz PDF](https://www.erichorvitz.com/chi99horvitz.pdf); [MSR page](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/). The three-way split (do nothing / dialog / act, with probability thresholds) is how secondary summaries describe it. — [VT course notes](https://wordpress.cs.vt.edu/cs6724s20/?p=353)
- [RESEARCH] Iqbal & Bailey: breakpoints can be detected from interaction data with 69–87% accuracy. Delivering notifications at breakpoints reduces resumption lag, frustration and errors, and **coarser breakpoints cost less**. — [Iqbal CHI08](https://www.interruptions.net/literature/Iqbal-CHI08.pdf); [Iqbal TOCHI10](https://www.interruptions.net/literature/Iqbal-TOCHI10.pdf); [survey arXiv 1711.10171](https://arxiv.org/pdf/1711.10171)
- [RESEARCH] Iqbal & Horvitz, CSCW 2010: a field study of desktop alerts that frames awareness benefit against interruption cost. — [PDF](https://www.erichorvitz.com/shamsi_iqbal-eric_horvitz_cscw_2010.pdf)
- [RESEARCH, ICLR 2025] Lu et al., "Proactive Agent" (arXiv 2410.12361): **ProactiveBench**, 6,790 events. A reward model trained on human accept/reject labels judges proactiveness. The best fine-tuned model reaches **F1 66.47%** at proactively offering help. — [arXiv](https://arxiv.org/abs/2410.12361v3)
- [RESEARCH, Feb 2026] **ProAgentBench** (arXiv 2602.04482): 28,000+ events from 500+ hours of real sessions. It splits the task into **timing prediction (when)** and **assist content (what)**. Long-term memory and history "significantly enhance prediction accuracy," and real data beats synthetic. Real behavior is bursty (B = 0.787). — [arXiv](https://arxiv.org/abs/2602.04482)
- [RESEARCH, CHI 2025] "Assistance or Disruption?" (arXiv 2502.18658, 18 participants, programming). Proactive help cut the time to interpret AI responses from 34.5 s to 18.7 s, but raised perceived disruption (7-point scale: 1.56 prompt-only, 3.78 Codellaborator, 4.61 CodeGhost). The authors call this the "Disruption-Help Paradox." **Triggers at task boundaries** (after running code or multi-line edits) led to productive engagement 66.7% of the time. **Idle-time triggers were poorly received**, because pauses were often "deep thought." Implicit signals (selections, comments) gave false positives. Presence indicators and salience scaled to importance reduced disruption. — [alphaXiv](https://www.alphaxiv.org/abs/2502.18658); [ACM DL](https://dl.acm.org/doi/10.1145/3706598.3713357)
- [RESEARCH, CHI 2025] "Proactive Conversational Agents with Inner Thoughts" (Liu et al., arXiv 2501.00383). The agent keeps a covert stream of thoughts and rates each one by its **intrinsic motivation** to voice it, using criteria from a 24-person think-aloud study such as relevance and information gap. It beat next-speaker prediction on all seven metrics. — [arXiv](https://arxiv.org/abs/2501.00383v2)
- [RESEARCH, 2025] "Having Lunch Now" (arXiv 2509.24073): a 14-day field study (n=12) of a proactive daily-planning check-in agent. Problems were **rigidity, premature turn-taking, overpromising**, and annoyance at re-asking questions the user had already answered. — [arXiv](https://arxiv.org/html/2509.24073v4)
- [RESEARCH, 2025] ContextAgent (arXiv 2505.14668) uses sensory context. The authors tuned prompts toward **more conservative initiation** to make it less intrusive. — [arXiv](https://arxiv.org/html/2505.14668v2). USERVILLE (arXiv 2511.02208) frames proactivity as asking for clarification versus the risk of annoyance. — [arXiv](https://arxiv.org/pdf/2511.02208). ProactiveEval (arXiv 2508.20973) is a unified evaluation framework for proactive dialogue. — [arXiv](https://arxiv.org/pdf/2508.20973)

### Inferences
- For Alma, "when" is the hard part and can be scored separately from "what": first decide whether to speak now, later or never, then generate the content.
- On a desktop, good moments to speak are coarse breakpoints: app switch, end of a call or meeting, PC unlock, morning start. Idle time on its own is not one.
- Re-asking things the user already answered is a top annoyance, so initiative candidates should be checked against memory and the vault.

### Gaps
- I did not retrieve Pielot's smartphone notification-overload studies or Gloria Mark's resumption-time figures, so I cite no numbers for them.
- I found no surveys of proactive conversational agents (for example, Deng et al.) in this pass.
- I found no specific false-positive rates in ProAgentBench (the abstract page lacks them).

## Initiative taxonomy and mapping to a risk/approval model

### Takeaway
Two complementary axes help: **what the agent does with its initiative** (inform → suggest → prepare/stage → act and report → act silently) and **the user's role** (Feng et al.'s L1 Operator … L5 Observer). Shipped products cap outward actions at "stage for the user to send" or "ask first," which maps cleanly onto Alma's `ToolRisk`.

### Cited Findings
- [RESEARCH, 2025] Feng, McDonald & Zhang, "Levels of Autonomy for AI Agents" (arXiv 2506.12469). Autonomy is a **design choice separate from capability**, organized by user role: L1 Operator (user directs), L2 Collaborator, L3 Consultant (agent leads, consults the user), **L4 Approver (user involved only in risky or pre-specified situations)**, L5 Observer (full autonomy, user monitors). It proposes "autonomy certificates." — [arXiv](https://arxiv.org/html/2506.12469v2)
- Shipped examples by rung:
  - **Inform:** Daily Brief, CC email, Pulse cards. — [Google blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)
  - **Suggest:** Alexa+ routine suggestions. — [inkl](https://www.inkl.com/news/alexa-here-s-everything-you-need-to-know)
  - **Prepare/stage:** Copilot Today "stage a forgotten follow-up for you to send." — [Microsoft](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)
  - **Act and report, ask on high stakes:** Gemini Spark "ask first before … spending money or sending emails." — [Google blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)
  - **Silent act / silent check:** OpenClaw heartbeat `NO_REPLY` when nothing needs attention. — [clawdocs](https://clawdocs.org/architecture/heartbeat)
- Horvitz's do-nothing / dialog / act thresholds over P(goal | evidence) are the classic decision rule for choosing a rung. — [Horvitz PDF](https://www.erichorvitz.com/chi99horvitz.pdf)

### Inferences
- Proposed mapping for Alma:
  - **read-only / local-safe** tools: the agent may act silently and log the action in the audit trail (for example, pre-fetching vault notes or preparing a draft).
  - **local-mutating** tools (vault edits, home scenes that are reversible): act and report, with undo.
  - **`publish`** (Telegram/WhatsApp/mail to third parties, purchases): never beyond "prepare and stage." The draft goes into the existing approvals queue.
  - Proactive *messages to the owner* on the owner's own channel are a separate, throttled "inform/suggest" rung. They are not `publish`, but they are governed by an interruption budget.
- Initiative level should be configurable per domain (home, mail, vault, companies), following Feng's "autonomy as a design choice." The default should be L3/L4.

### Gaps
- I found no shipped product that publicly documents a full per-domain autonomy matrix.

## Signals for when to intervene: context, thresholds, quiet hours, budgets, learning from feedback

### Takeaway
Shipped controls are simple: **opt-in per connector**, **active/quiet hours**, a **once-a-day cadence**, **alert only on change**, **auto-pause when the user goes inactive**, **thumbs up/down**, and **manual overrides beat AI**. Research adds breakpoint timing and memory-aware scoring.

### Cited Findings
- Opt-in per data source: Daily Brief requires connecting apps. — [Google blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/). Proactive Assistance (leak) works only with apps the user picks. — [9to5Google](https://9to5google.com/2026/04/27/gemini-proactive-assistance/). Pulse had a per-connector "allow proactive activity" toggle, off by default (unverified secondary). — [skywork mirror](https://wombatech.pages.dev/service/https://skywork.ai/blog/chatgpt-pulse-faq-2025-9/). Alexa skill notifications require opt-in. — [Amazon docs](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html)
- Time windows: OpenClaw `activeHours`, and ticks outside the window are skipped. — [clawdocs](https://clawdocs.org/architecture/heartbeat). ChatGPT tasks run by part of the day. — [The Decoder](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/)
- Rate and budget: ChatGPT tasks run at most once per hour. — [The Decoder](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/). Meta allows a single follow-up within 14 days after ≥5 user messages. — [TechCrunch](https://techcrunch.com/2025/07/03/meta-has-found-another-way-to-keep-you-engaged-chatbots-that-message-you-first/). OpenClaw event wakes are at least 30 s apart, with a flood guard at 5 per 60 s. — [clawdocs](https://clawdocs.org/architecture/heartbeat)
- Inactivity: ChatGPT tasks pause if the user goes inactive, so the agent does not keep talking to an absent user. — [The Decoder](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/). Meta stops if there is no reply. — [Engadget](https://www.engadget.com/big-tech/meta-is-reportedly-training-its-ai-chatbots-to-send-unprompted-messages-143229039.html)
- Busy deferral: OpenClaw skips a scheduled poll when the user has an active run or queued work. — [clawdocs](https://clawdocs.org/architecture/heartbeat)
- Value threshold: research tasks alert only when something changes. — [The Decoder](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/). Daily Brief prioritizes against the user's stated goals. — [Google blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)
- Feedback: thumbs up/down in Pulse and Daily Brief. — [Tom's Guide](https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed); [Google blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/). CC is steered by email replies. — [BGR](https://bgr.com/2054540/google-gmail-cc-ai-assistant-email-to-do-google-labs). Apple: manual allow/silence always overrides AI ranking. — [Apple Support](https://support.apple.com/en-za/guide/iphone/iph1fbe7d2b9/ios)
- Context: calendar plus traffic gives "leave now" (Gemini leak). — [Android Authority](https://www.androidauthority.com/google-gemini-proactive-assistance-3661314/). Breakpoints beat idleness. — [alphaXiv 2502.18658](https://www.alphaxiv.org/abs/2502.18658); [Iqbal TOCHI10](https://www.interruptions.net/literature/Iqbal-TOCHI10.pdf)

### Inferences
- A minimal Alma rule set:
  - Opt-in per source and per channel.
  - Quiet hours, by default following the Windows Focus / Do Not Disturb state where it can be read.
  - A daily interruption budget per channel, for example N pushes per day plus a digest for the rest.
  - Speak only on a change or a deadline.
  - Back off on dismissals (for example, mute a category after K consecutive dismissals and ask before re-enabling).
  - Stop on silence.
  - Manual rules always beat model scores.
- Thresholds such as N and K were not found in any source and must be decided as an Open Question. Note "one follow-up" (Meta) and "≤1/hour" (OpenAI) as reference points.

### Gaps
- I found no public numbers for any vendor's daily interruption budget or for dismissal-learning algorithms.

## Architecture patterns: event bus, heartbeat, cron vs event, scoring, dedupe, "why am I seeing this"

### Takeaway
The reference design is **cron for user-authored exact-time routines + a cheap periodic heartbeat turn with a silent-OK contract + event wakes (rate-limited)**, all routed through one delivery policy (owner only, active hours, busy deferral). Content dedupe and explanations are not well covered in the sources I found, so Alma would be adding them itself.

### Cited Findings
- Heartbeat versus cron: the heartbeat is one system-owned monitor per agent with its own scratch context, while cron holds user-authored jobs. Recurring work belongs in automations, not in the heartbeat scratch. Both share one scheduler. — [clawdocs](https://clawdocs.org/architecture/heartbeat); [Ampere](https://www.ampere.sh/blog/cron-jobs-heartbeats-making-openclaw-proactive)
- Silent-OK contract: the agent replies `NO_REPLY` (older docs: `HEARTBEAT_OK`) when nothing needs attention, so nothing is delivered. — [clawdocs](https://clawdocs.org/architecture/heartbeat); [dev.to](https://dev.to/hex_agent/openclaw-heartbeats-making-your-ai-agent-proactive-instead-of-reactive-2pi5)
- Isolation and cost: without `isolatedSession`, a small heartbeat model on the shared main session "may overflow the next user turn." Cost scales with cadence × prompt × price. — [clawdocs](https://clawdocs.org/architecture/heartbeat)
- Two-stage scoring:
  - When versus what: ProAgentBench splits the task this way. — [arXiv 2602.04482](https://arxiv.org/abs/2602.04482)
  - Motivation score: Inner Thoughts scores each candidate thought by its motivation to speak. — [arXiv 2501.00383](https://arxiv.org/abs/2501.00383v2)
  - Accept/reject judge: ProactiveBench trains a reward model on human accept/reject labels. — [arXiv 2410.12361](https://arxiv.org/abs/2410.12361v3)
- Ephemerality: Pulse cards disappear unless saved, so they do not pile up as a backlog. — [Tom's Guide](https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed)
- Explainability and presence: presence indicators and context reduced disruption. — [alphaXiv 2502.18658](https://www.alphaxiv.org/abs/2502.18658). Copilot Today's "missed / now / can wait" triage is an implicit "why." — [Microsoft](https://blogs.microsoft.com/blog/2026/09/25/introducing-the-new-copilot-with-home-code-and-autopilot/)

### Inferences
- Pipeline for Alma's coordinator:
  1. Sources (cron routines, vault changes, mail, HA events, calendar, heartbeat tick) emit candidate initiatives onto an event bus.
  2. The candidates are scored for utility, urgency and confidence, against the interruption cost given the current breakpoint, quiet hours and budget.
  3. Dedupe by key (source + entity + day) against a sent log.
  4. Pick a rung from the risk map.
  5. Deliver now, fold into the daily digest, or drop.
  6. Every delivered item carries a one-line "why" (trigger + source) and feedback buttons (useful / not now / never this kind).
- Use a cheap or local model for the "should I speak" pass and the main model only for content, mirroring OpenClaw's cheap-model and lightContext levers.

### Gaps
- I found no public description of how OpenAI or Google dedupe or rank Pulse/Brief items internally.
- I found no shipped example of an explicit "why am I seeing this" UI for an AI assistant in this pass.

## Failure modes, backlash, and metrics

### Takeaway
Proactivity fails in four ways: **spammy/irrelevant** (Pulse admitted it, ignored suggestions), **creepy/surveillant** (Friend, screen- and notification-reading), **engagement-driven** (Meta's retention framing), and **forced entry points** (the Copilot "Microslop" rollback). Metrics should weigh acceptance and usefulness against disruption, not engagement.

### Cited Findings
- Irrelevance: OpenAI warned that Pulse may show irrelevant items, and Pulse was retired within about 9 months. — [Tom's Guide](https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed); [The Decoder](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/)
- Disruption-help paradox: proactive help is faster but more disruptive, and some users deliberately ignored suggestions to stay in control and keep ownership. — [alphaXiv 2502.18658](https://www.alphaxiv.org/abs/2502.18658)
- Rigidity and repetition: the 14-day field study found rigidity, premature turn-taking and overpromising. — [arXiv 2509.24073](https://arxiv.org/html/2509.24073v4)
- Creepiness and surveillance: the Friend backlash, with ads defaced "surveils you." — [CNN via KVIA](https://kvia.com/news/business-technology/cnn-business-consumer/2025/11/16/how-this-tiny-device-became-a-symbol-for-the-backlash-against-ai/)
- Engagement-bait: Meta's proactive bots were reported as a retention play, and users reportedly could not block them. — [The Decoder](https://the-decoder.com/meta-tests-chatbots-with-proactive-messaging-to-boost-retention/); [Technology Magazine](https://technologymagazine.com/articles/ai-the-loneliness-economy-metas-chatbots-get-proactive)
- Over-insertion: Microsoft is removing Copilot entry points after backlash. — [Windows Latest](https://www.windowslatest.com/2026/10/21/microsoft-is-now-scaling-back-copilot-in-windows-11-amid-microslop-backlash-pulling-8-ai-actions-from-file-explorer-and-calling-it-simplifying/)
- Over-filtering: AI-hidden notifications can make users miss important messages. — [iMore](https://imore.com/ios/ios-18/i-do-not-trust-apple-intelligence-to-prioritize-my-notificationsyet)
- Fragility: briefings break silently when connector tokens expire. — [testingcatalog on X](https://x.com/testingcatalog/status/2067321189362454952)
- Metrics used in research:
  - F1 of help-offer decisions plus a reward model trained on human accept/reject (ProactiveBench). — [arXiv](https://arxiv.org/abs/2410.12361v3)
  - Timing accuracy (ProAgentBench). — [arXiv](https://arxiv.org/abs/2602.04482)
  - Perceived disruption on a 7-point scale, time to interpret, and the share of engagements that were productive (Codellaborator). — [alphaXiv](https://www.alphaxiv.org/abs/2502.18658)
  - Seven conversational metrics including turn-taking appropriateness (Inner Thoughts). — [arXiv](https://arxiv.org/abs/2501.00383v2)
  - Resumption lag, frustration and errors (interruption literature). — [Iqbal TOCHI10](https://www.interruptions.net/literature/Iqbal-TOCHI10.pdf)

### Inferences
- Metrics for Alma:
  - acceptance rate per initiative type (acted on / staged draft approved)
  - explicit "not useful" and "never this" rates
  - mute/opt-out events
  - pushes per day against the budget
  - the share of pushes landing in quiet hours (target 0)
  - stale or duplicate rate
  - silent heartbeat rate and cost per day
  - "missed important" reports (the over-filtering side)
- Alma should avoid engagement metrics such as messages per day or session length as goals.
- Trust protections:
  - The **owner's channel only**, never groups. This mirrors the OpenClaw `owner` default.
  - No proactive outreach on behalf of the user.
  - Surfacing a health check when a connector or token breaks, instead of failing silently.

### Gaps
- I found no published production metrics (acceptance rates, opt-out rates) from OpenAI, Google, Microsoft or Meta for their proactive features.
- I found no quantitative data on why Pulse was retired.

# Integrated AI-agent browsers in assistant apps, and how to build one into Alma (Electron)

Research date: 2026-11-08. Primary sources preferred; where only secondary coverage exists it is flagged. OpenAI's own pages (openai.com) returned HTTP 403 to the fetcher, so OpenAI facts rely on secondary write-ups that quote them.

## Anthropic: Claude in Chrome, the desktop app's built-in browser, Computer Use, and safety numbers

### Takeaway
Anthropic now ships two browser paths. Claude in Chrome is an extension that drives the user's real Chrome with their own logins; it went GA on 2026-08-26. The built-in browser is a separate in-app profile inside Claude Desktop (Code tab, and Cowork from 2026-08-26), with per-site import of logins and first-use site approval. Both share the same safeguards: model training, content probes and an action classifier. Anthropic's own figures show prompt-injection success going from 23.6% (2025 pilot, no mitigations) to roughly 0–0.3% for its newest models with probes and classifier, but Anthropic still says the risk "can't be fully eliminated."

### Cited Findings
**Claude in Chrome: timeline**
- 2025-08-25: pilot with 1,000 Max users from a waitlist. — [Claude blog: Piloting Claude in Chrome](https://claude.com/blog/claude-for-chrome)
- 2025-11-24: beta for all Max subscribers, adding scheduled tasks and multi-tab workflows. 2025-12-18: expanded to Pro, Team and Enterprise, with a Claude Code integration; Team and Enterprise admins can switch it on or off org-wide and set site allowlists and blocklists. — [Claude blog](https://claude.com/blog/claude-for-chrome)
- 2026-08-26: "Claude in Chrome is generally available" on every paid plan. The post says Chrome only, installed from the Chrome Web Store, with no mobile version. — [Claude blog: GA](https://claude.com/blog/claude-in-chrome-generally-available)
- Conflicting statements on Edge and status:
  - The GA post says Chrome only. — [Claude blog: GA](https://claude.com/blog/claude-in-chrome-generally-available)
  - The support article says GA in Cowork and Claude Code but beta in the Chrome browser, and Google Chrome only. — [support.claude.com](https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome)
  - A Claude Code docs issue says the Claude Code docs were updated to "generally available, works with Chrome and Edge." — [claudeissues.com](https://claudeissues.com/issue/72936-docs-claude-code-chrome-integration-docs-still-describe-it-as-beta-after-v2-1-19)

**Claude in Chrome: how it drives Chrome**
- It runs in a side panel next to the page. Claude reads, clicks, types, navigates and fills forms. — [support.claude.com](https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome)
- Tabs Claude opens go into a separate, differently colored tab group. — [support.claude.com](https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome)
- It can read console output, network requests and DOM state, take screenshots, manage tabs, run scheduled tasks, upload images, download files and replay recorded workflows. 1Password sign-in is in beta on macOS. — [support.claude.com](https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome)
- The Desktop and Claude Code connection uses Chrome native messaging. — [support.claude.com](https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome)

**Claude in Chrome: permissions**
- The default mode is "Automatically approve": a safety classifier approves safe actions and pauses to ask when approval is needed. Users can switch to approving every action. — [support.claude.com](https://support.claude.com/en/articles/12012173-getting-started-with-claude-in-chrome); [Claude blog: GA](https://claude.com/blog/claude-in-chrome-generally-available)
- Pilot-era mitigations:
  - Site-level permissions that the user can grant or revoke.
  - Confirmation before publishing, purchasing or sharing personal data, kept even in autonomous mode for highly sensitive actions.
  - Blocked categories: financial services, adult content and pirated content.
  - Updated system prompts.
  - Classifiers for suspicious instruction patterns.
  - [Claude blog: pilot](https://claude.com/blog/claude-for-chrome)

**Built-in browser in Claude Desktop**
- Code tab: a sandboxed browser pane shipped around 2026-07-06 to 07-10 (v2.1.202 to v2.1.206). It opens with Ctrl+Shift+B on Windows and uses a clean profile separate from the user's browser. This is secondary coverage. — [digitalapplied.com](https://www.digitalapplied.com/blog/claude-code-desktop-sandboxed-browser-agents-2026); [Claude Desktop docs](https://claude.com/docs/third-party/claude-desktop/browser)
- Cowork: announced 2026-08-26 for Pro, Max, Ultra and Team, and available to Enterprise through an admin toggle. — [Claude blog: Cowork browser](https://claude.com/blog/cowork-built-in-browser)
  - It runs on macOS, Windows and Linux (beta).
  - It is on by default and opens automatically when a task involves a website.
  - It is a separate browser: Claude "never sees your tabs, bookmarks, or passwords."
- Logins are imported one site at a time. On Windows and Linux only Firefox can be imported; macOS also supports Chrome and Edge. Banking, email and SSO sites are unchecked by default. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- Sign-ins persist across Cowork sessions on that computer. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- It opens as a side panel next to the task, and transcript links open in the same panel. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- Claude asks permission before acting on a site for the first time, and high-risk sites are blocked. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- Anthropic "strongly advises against" using it for financial, medical or other people's personal data. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- The Cowork session runs in the cloud while the browser runs in the desktop app, so the desktop app must be open and online. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- Users choose a "Preferred browser" (built-in or Chrome). If the preferred one is unavailable, Claude falls back to the other and tells the user; if the user named a browser explicitly, Claude asks before switching. — [support.claude.com 16607400](https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork.md)
- In third-party deployments the built-in browser is off by default and enabled with the `builtinBrowserEnabled` key. This comes from a search snippet. — [claude.com docs third-party](https://claude.com/docs/third-party/claude-desktop/browser)
- It uses the same safeguards as Claude in Chrome, including checks that compare Claude's actions with the user's request. — [Claude blog: Cowork browser](https://claude.com/blog/cowork-built-in-browser)

**Computer Use API (current docs)**
- The current tool is `computer_toolset_20260801` and needs no beta header. It covers Claude 5.5 and later; those models return a 400 error for older tool versions. Earlier versions are `computer_20251124` (Opus 4.5 to 4.7) and `computer_20250124`. — [platform.claude.com computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- It is a client toolset: the application executes every action. It has 17 members (screenshot, zoom, clicks, drag, scroll, type, key, hold_key, wait, and others). — [platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- Coordinates are in the pixel space of the screenshot. For Opus 4.7 and later the limit is 2,576 px on the long edge. For the web, Anthropic recommends 1280×800 or 1366×768, and nothing above 1920×1080. — [platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- Recommended controls:
  - A dedicated VM or container.
  - Keep credentials away from the model.
  - A domain allowlist.
  - Human confirmation for payments, cookie consent and accepting terms.
  - User consent.
  - Anthropic's classifiers scan tool outputs such as screenshots and steer the model to verify instructions when they flag an injection; this is on by default and opt-out is by contacting support.
  - [platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

**Prompt-injection numbers (Anthropic's own evaluations)**
- 2025 pilot: 123 cases across 29 scenarios.
  - Autonomous mode: 23.6% attack success rate (ASR) without mitigations, 11.2% with them.
  - Browser-specific challenge set: 35.7% down to 0%.
  - [Claude blog: pilot](https://claude.com/blog/claude-for-chrome)
- Simon Willison called 11.2% "catastrophic." — [simonwillison.net](https://simonwillison.net/2025/Aug/26/piloting-claude-for-chrome/)
- 2025-11-24, adaptive Best-of-N attacker, around 2,200 to 3,200 samples per bar — [Anthropic research](https://www.anthropic.com/research/prompt-injection-defenses):

  | Model | Model only | Improved safeguards |
  |---|---|---|
  | Opus 4.5 | 8.0% | 1.4% |
  | Sonnet 4.5 | 13.8% | 1.9% |

  Anthropic's comment on these results: "A 1% attack success rate … still represents meaningful risk"; "No browser agent is immune."
- The defenses described there:
  - RL on simulated pages that contain injections.
  - Classifiers that scan all untrusted context for hidden text, manipulated images and deceptive UI.
  - Human red teaming and external Gray Swan arenas.
  - [Anthropic research](https://www.anthropic.com/research/prompt-injection-defenses)
- 2026-08-26 GA figures, from professional red-teamers — [Claude blog: GA](https://claude.com/blog/claude-in-chrome-generally-available):
  - Without added safeguards: Opus 4.5 at 17.6%, Opus 5 at 3.8%.
  - With content probes and the action classifier: 0% for Sonnet 5, Opus 5 and Mythos 5, and 0.3% for Fable 5.
  - The three-layer design: training, then content probes that flag injected content in tool results and warn the model, then an action classifier that blocks actions not matching the original request.

### Inferences
- Anthropic's pattern has three parts: a separate profile, sign-ins imported per site with sensitive categories off, and first-use site approval. It pairs that with layered detectors: a probe on inputs and a critic on actions. This is the most reusable blueprint for Alma.
- The "Preferred browser plus fallback that tells the user" rule maps directly onto Alma, which already has a Chrome MCP alongside a possible in-app browser.

### Gaps
- No public detail on the built-in pane's internals: whether it is an Electron WebContentsView, how it is driven (CDP or an internal API), or how the profile is stored and encrypted.
- No published list of blocked "high-risk site" categories for the built-in browser.
- The Edge support conflict above is unresolved.

## OpenAI: Atlas (OWL), agent mode, ChatGPT agent (Operator/CUA), and the 2026 shift to a desktop-app built-in browser

### Takeaway
Atlas launched for macOS on 2025-10-21, was announced as deprecated on 2026-07-09 and was switched off around 2026-08-09. Its browsing and agent features moved into a unified ChatGPT desktop app (Mac and Windows) with a built-in browser for "ChatGPT Work". Atlas's OWL architecture remains the best public reference design: Chromium runs out of process over Mojo IPC, the agent receives screenshots, agent input bypasses browser chrome, and logged-out sessions are ephemeral, in-memory StoragePartitions.

### Cited Findings
**OWL architecture (2025-10-30 engineering post, via secondary coverage)** — [ByteByteGo](https://blog.bytebytego.com/p/the-architecture-behind-atlas-openais); [OpenAI, via search snippet](https://openai.com/index/building-chatgpt-atlas)
- Chromium's browser process runs outside the Atlas app process. Atlas (Swift/AppKit) is the "OWL Client" and Chromium is the "OWL Host". They talk over Mojo with custom Swift and TypeScript bindings.
- Client abstractions: Session, Profile, WebView, WebContentRenderer and LayerHost/Client.
- Rendering: Chromium draws to a CALayer that Atlas embeds through CALayerHost, and the GPU memory is shared.
- Input: Chromium has no visible windows. Atlas turns NSEvents into Blink WebInputEvents, and Chromium returns events the page did not handle.
- Agent mode:
  - The model takes a single screenshot; Atlas composites pop-ups such as dropdowns into that frame at their coordinates.
  - Agent-generated events go straight to the page renderer and bypass the privileged browser layer. Synthesized shortcuts that would trigger browser actions are blocked.
  - Logged-out agent sessions use Chromium StoragePartition, giving isolated in-memory stores whose cookies are discarded when the session ends.
  - Several isolated agent sessions can run in parallel tabs.
- Builds: shipping OWL as a prebuilt binary cut Atlas build time from hours to minutes. — [OpenAI search snippet](https://openai.com/index/building-chatgpt-atlas)

**Atlas features at launch (2025-10-21)** — [search summary of OpenAI launch](https://openai.com/index/introducing-chatgpt-atlas/); [Simon Willison](https://simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/)
- "Browser memories" were opt-in. A page-visibility toggle stops ChatGPT from seeing a page and from creating memories about it.
- Agent mode was a preview for Plus, Pro and Business. The agent could not run code, download files or install extensions.
- In logged-out mode the agent uses no existing cookies.

**Security posture**
- The OpenAI CISO (Dane Stuckey, 2025-10-22) described: red-teaming; training to ignore malicious instructions; overlapping guardrails; rapid response that blocks attack campaigns; "logged out mode"; and "Watch Mode", which pauses the agent on sensitive sites if the user leaves the tab. — [Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)
- Simon Willison found Watch Mode never triggered on GitHub or on a bank site, and said logged-in mode pushes security decisions onto users. — [Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)
- A December 2025 post, "Continuously hardening ChatGPT Atlas against prompt injection", describes an automated RL attacker used to train defenses and admits prompt injection is "unlikely to ever be fully solved." Only secondary coverage was available. — [eSecurity Planet](https://www.esecurityplanet.com/artificial-intelligence/openai-hardens-chatgpt-atlas-against-prompt-injection-attacks/); [Zenity Labs](https://labs.zenity.io/p/hardening-atlas-the-relentless-challenge-of-securing-an-untrusted-browser-agent)
- Zenity's view: logged-out Atlas is "significantly safer" and also "significantly less useful." — [Zenity Labs](https://labs.zenity.io/p/hardening-atlas-the-relentless-challenge-of-securing-an-untrusted-browser-agent)

**Operator, ChatGPT agent and CUA**
- Operator ran on the Computer-Using Agent (CUA) model, combining GPT-4o vision with RL, in a remote browser on OpenAI servers.
- "Takeover mode" hands control to the user for logins and payments; Operator does not screenshot what the user types during takeover. It also asked for approval before orders and emails.
- Operator is now folded into ChatGPT agent ("agent mode").
- [OpenAI: introducing Operator](https://openai.com/index/introducing-operator/) (search snippets); [MIT Technology Review](https://www.technologyreview.com/2025/01/23/1110484/openai-launches-operator-an-agent-that-can-use-a-computer-for-you/)

**2026 transition**
- James Sun (OpenAI) gave a targeted deprecation date of "8/9". The Windows version of Atlas was cancelled, and Windows users get the ChatGPT desktop app with a built-in browser instead. — [Tbreak, 2026-07-10](https://tbreak.com/chatgpt-atlas-dead-openai-retires-ai-browser-less/); [PCMag (linked)](https://www.pcmag.com/news/openai-to-retire-chatgpt-atlas-browser-less-than-a-year-after-launch)
- Announced 2026-07-09 and turned off 2026-08-09 according to aggregators. They cite an OpenAI help article, "Evolving Atlas into ChatGPT for browser-based agentic work", which was not fetched. — [Prosopo](https://prosopo.io/blog/chatgpt-atlas-discontinued/); [agentsai.fyi](https://agentsai.fyi/news/openai-shuts-down-chatgpt-atlas-browser-2026-08-12)
- New unified ChatGPT desktop app (Mac and Windows; modes Chat, Work and Codex) — [PPC Land](https://ppc.land/openai-kills-atlas-browser-folds-it-into-new-chatgpt-work-agent/):
  - Its built-in browser lets the agent take steps across pages while the person reviews.
  - Admin governance covers browser sessions and network policies, and an "auto-review" by advanced models runs before significant actions.
  - The Chrome extension was updated to work in Chrome's sidebar.
- Aggregators say the built-in browser handles tabs, downloads, navigation and logins, and that a separate cloud browser exists in ChatGPT Work. — [search summary: Prosopo / askedabout](https://askedabout.com/news/openai-deprecates-atlas-browser-agent-moves-into-chatgpt)
- Comet held about 47% of measured agentic traffic in May 2026 against Atlas's 20.3% (HUMAN Security data relayed by PPC Land; no link given). — [PPC Land](https://ppc.land/openai-kills-atlas-browser-folds-it-into-new-chatgpt-work-agent/)

### Inferences
- Both Anthropic and OpenAI converged in mid-2026 on the same design: a browser built into the assistant's desktop app, plus an optional extension for the user's own Chrome. A standalone AI browser (Atlas) lost out to "AI browsing without abandoning Chrome". That validates Alma building an in-app browser instead of a separate browser product.
- OWL's three security ideas are reproducible in Electron:
  - Agent input goes only to page content, never to app chrome or shortcuts.
  - Ephemeral in-memory partitions for logged-out agent work.
  - Persistent partitions only when the user opts in.

### Gaps
- Primary OpenAI pages were blocked (403), so exact wording and whether the new desktop browser runs locally or in the cloud remain unconfirmed.
- The fate of "browser memories" after the Atlas shutdown was not found.

## Peers: Perplexity Comet, Dia, Opera Neon, Edge Copilot, Chrome Gemini / Project Mariner

### Takeaway
Every peer is a Chromium fork or a Chromium vendor adding an agent layer. They differ mainly in how they separate the agent from the user's session (Gemini's isolated "User Alignment Critic", Edge folding the agent into Edge itself, Neon exposing the session over MCP). Comet is the recurring cautionary example of indirect prompt injection.

### Cited Findings
- **Perplexity Comet**
  - Windows has been supported since the 2025-07-09 launch, and Comet became free worldwide on 2025-10-02. The Background Assistant is for paid tiers (Max at $200/month). — [TechCrunch](https://www.techcrunch.com/2025/10/02/perplexitys-comet-ai-browser-now-free-max-users-get-new-background-assistant/)
  - iOS launched on 2026-03-18 (secondary source). — [geotoolbox](https://geotoolbox.ai/blog/perplexity-comet.md)
  - Brave (August 2025) showed that hidden Reddit-comment instructions plus a click on "Summarize this page" could hijack Comet, because Comet fed page content to the model without separating it from user instructions. Brave says the fixes were later defeated. — [Brave](https://brave.com/blog/comet-prompt-injection/); [Simon Willison](https://simonwillison.net/2025/Aug/25/)
  - Brave's proposed defenses: confirmation for sensitive actions, and isolating agentic browsing from normal browsing. — [Brave](https://brave.com/blog/comet-prompt-injection/)
  - Brave also showed injection through screenshots (October 2025). — [Ultima Hora](https://www.ultimahora.es/noticias/tecnologia-videojuegos/2025/10/22/2496525/captura-pantalla-web-puede-desencadenar-ataque-prompt-injection-comet-alertan-desde-brave.html)
  - Later issues: LayerX "CometJacking" and Zenity "PleaseFix" (2026-03-03, secondary). A "Privacy Snapshot" lets users block tasks or disable web actions. — [geotoolbox](https://geotoolbox.ai/blog/perplexity-comet.md); [TestingCatalog](https://www.testingcatalog.com/comet-update-centralizes-data-controls-with-privacy-snapshot)
- **Dia (The Browser Company):** Atlassian agreed in September 2025 to buy The Browser Company for $610M in cash, mainly for Dia, which launched in June 2025. Dia is positioned as an AI browser for SaaS tabs. — [TechRepublic](https://www.techrepublic.com/article/news-atlassian-acquires-the-browser-company/); [BetaNews](https://betanews.com/2025/09/05/atlassian-moves-into-ai-browsers-with-610-million-purchase-of-the-browser-company/)
- **Opera Neon**
  - An agentic browser that controls tabs, launched 2025-09-30 at $19.90/month (German report). — [all-ai.de](https://www.all-ai.de/news/top-news24/opera-neon-browser-ki)
  - April 2026: a "Neon MCP Connector" lets third-party AI clients operate inside the user's active browser session (search summary). — [search result](https://proxyops-dev.pages.dev/artiklar/ai-browser-watch-week-21-2026)
- **Microsoft Edge**
  - Copilot Mode launched in July 2025 with Actions and Journeys. — [GeekWire](https://www.geekwire.com/2025/microsoft-launches-new-copilot-mode-in-edge-as-ai-reignites-browser-competition/); [MacRumors](https://www.macrumors.com/2025/10/24/microsoft-edge-copilot-mode-ai-browser/)
  - On 2026-05-13 Microsoft said it is retiring "Copilot Mode" in favor of "Browse with Copilot", limited to Microsoft 365 Premium in the US (secondary). — [startupfortune](https://startupfortune.com/?p=10575)
- **Google**
  - December 2025: Chrome added a "User Alignment Critic", an isolated model that sees action metadata rather than raw page content and vetoes actions that don't serve the user's goal.
  - Gemini is limited to domains relevant to the task.
  - Confirmation is required on sensitive sites, and the user grants permission or completes the final step for purchases and messages.
  - [BleepingComputer](https://bleepingcomputer.com/news/security/google-chrome-adds-new-security-layer-for-gemini-ai-agentic-browsing); [The Register](https://www.theregister.com/2025/12/09/google_fortifies_chrome_ai_with/)
- **Project Mariner** shut down on 2026-05-04, with its technology moved into Gemini Agent and AI Mode. Chrome "auto browse" is said to absorb its capabilities (unconfirmed). — [Android Authority](https://androidauthority.com/google-project-mariner-shutdown-3664323/); [TechSpot](https://www.techspot.com/news/112334-project-mariner-dead-but-google-browser-controlling-ai.html)

### Inferences
- The action-critic pattern (Google's User Alignment Critic, Anthropic's action classifier, OpenAI's "auto-review") is now industry standard. Its key property is that the critic never sees raw untrusted page text.

### Gaps
- No primary 2026 sources were found for Dia's current agent capabilities or Comet's latest Windows security changes.

## Technical approaches and libraries (CDP, Playwright, a11y tree vs DOM vs screenshots)

### Takeaway
Two perception styles dominate. Atlas and Computer Use rely on screenshots plus coordinates. Playwright MCP, Stagehand, and the text-reading mode of Anthropic's built-in browser use an accessibility-tree or DOM snapshot with element refs. Snapshot plus refs is cheaper and more deterministic; vision is the fallback for canvas and unlabeled UI. Everything ultimately sits on CDP.

### Cited Findings
**Playwright MCP (Microsoft; Apache-2.0; about 39.3k stars)** — [GitHub microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
- Uses the accessibility tree, so no vision model is needed. `browser_snapshot` is the default, and `--caps=vision` adds coordinate tools.
- Session flags:
  - `--isolated` keeps the profile in memory.
  - `--user-data-dir` sets a persistent profile.
  - `--storage-state` loads cookies and localStorage into an isolated context.
  - `--cdp-endpoint` attaches to an existing browser.
  - `--extension` attaches to a running Chrome or Edge.
- `--allowed-origins` and `--blocked-origins` are "not a security boundary" and don't affect redirects.
- The default is a persistent profile per workspace hash, and only one instance can use it at a time.
- `browser_tabs` handles tabs, and tabs can open in named isolated contexts.
- The README says coding agents may do better with the Playwright CLI plus skills, which is more token-efficient.

**Chrome DevTools MCP (Google; Apache-2.0; about 55.0k stars)** — [GitHub ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- Built on Puppeteer. Offers performance traces, network, console with source maps, and screenshots.
- Flags include `--isolated`, `--headless`, `--slim`, and a WebSocket or connect-to-running mode.
- It warns that MCP clients can see and modify any browser data.
- Usage statistics and npm update checks are on by default; opt out with `--no-usage-statistics`, `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS` and `--no-performance-crux`.

**Alma's current setup**
- Alma offers a one-click Chrome MCP preset in `src/renderer/src/components/SettingsDialog.tsx` (around line 592): `{ type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0'] }` under the key `chrome-devtools`. — local repo file E:\Tembiapo\Ilist-multiagents\src\renderer\src\components\SettingsDialog.tsx

**Stagehand (Browserbase)**
- v3 dropped Playwright for native CDP. It builds a hybrid snapshot from the AX tree via `Accessibility.getFullAXTree` merged with interactive DOM, piercing shadow DOM and iframes. — [Browserbase iframe post](https://www.browserbase.com/blog/taming-iframes-a-stagehand-update); [Stagehand docs mirror](https://www.mintlify.com/browserbase/stagehand/concepts/how-stagehand-works)
- v4 (2026-08-10) — [Browserbase: Stagehand v4](https://browserbase.com/blog/stagehand-v4):
  - The core moved into an in-browser extension service worker loaded via `Extensions.loadUnpacked` for local browsers. SDKs in TypeScript, Python and Go talk to it over one WebSocket.
  - Domain policy is enforced inside the browser at the request level.
  - Other CDP clients (Playwright, Puppeteer) can attach at the same time but may interfere with each other.

**browser-use**
- A Python, autonomous agent loop over a DOM-based page representation. It is more exploratory than Stagehand's code-first per-step control. Only secondary comparisons were available. — [Scrapfly](https://scrapfly.io/blog/posts/stagehand-vs-browser-use); [AgenticWire](https://www.agenticwire.news/article/browser-use-vs-stagehand)

**Snapshot size**
- One blog claims about 2–5 KB for an AX snapshot against 100 KB or more for a screenshot. This is not a controlled benchmark. — [kfchou](https://kfchou.github.io/agent-web-browsing-tools/)

### Inferences
- For Alma (TypeScript, Windows), Stagehand v4's extension-in-browser design and Playwright MCP's snapshot-plus-refs model are the two most relevant references. Since Alma already uses chrome-devtools-mcp for the user's Chrome, an in-app browser can expose a small Alma-native tool set without adding a library: navigate, snapshot (AX tree), click and type by ref, screenshot, tabs. It would talk CDP directly over `webContents.debugger`.

### Gaps
- Steel and Browserbase session, cookie and download APIs were not researched in depth (cloud-focused, less relevant to a local Electron app).
- No first-party download-handling details were found for Playwright MCP.

## Electron specifics: embedding a visible, agent-drivable browser

### Takeaway
Use `WebContentsView` (BrowserView has been deprecated since v29/30; the `<webview>` tag is discouraged). Give it a dedicated `session.fromPartition('persist:alma-browser')`, or a non-persistent partition for logged-out tasks. Drive it in-process with `webContents.debugger` (CDP) rather than opening a remote-debugging port. Because the view is visible in the window, the user watches every action and can take over.

### Cited Findings
- BrowserView is deprecated and replaced by `WebContentsView` plus `BaseWindow`, aligned with Chromium's Views API. Migration is mostly mechanical; `setAutoResize` is replaced by a resize listener. — [Electron BrowserView docs](https://electronjs.org/docs/api/browser-view); [Electron migration commit](https://ayakael.net/mirrors/electron/commit/15c60143241c7d0335f3bc8c722054ce6b8a9481)
- Electron: "We do not recommend you to use WebViews" — the tag undergoes "dramatic architectural changes." WebContentsView "offers the most control," but aligning it with DOM content needs coordination between main and renderer. — [Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)
- `webContents.debugger` — [Electron debugger API](https://www.electronjs.org/docs/latest/api/debugger):
  - It is an alternate transport for CDP inside the main process: `attach(protocolVersion)`, `sendCommand(method, params, sessionId)`, and events `message` and `detach`.
  - The session ends when the webContents closes or DevTools opens on it.
  - Commands sent right after attach may wait until navigation.
- Playwright `connectOverCDP` against Electron needs a remote-debugging port (`--remote-debugging-port` or `app.commandLine.appendSwitch`). The ws URL comes from `/json/version`, and you pick a `page` target. All sources here are community guides, not official docs. — [browserstack guide](https://www.browserstack.com/guide/playwright-connect-to-existing-browser)
- One unconfirmed source claims Electron 34+ dropped the CLI flag in favor of `appendSwitch`. — [cnblogs](https://www.cnblogs.com/jakezhang/p/20711182)

### Inferences
- **Recommended Alma design.** This is an inference: Electron documentation for partitions and permission handlers was not fetched in this session, beyond the APIs cited above.
  1. Put a `WebContentsView` in the main window, sized to a renderer "browser panel" region, and sync bounds over IPC.
  2. Isolate sessions with `session.fromPartition`:
     - `persist:alma-web` holds the user-approved, logged-in profile.
     - A fresh non-`persist:` partition per agent task is "logged-out mode", equivalent to OWL's in-memory StoragePartition.
  3. Control through `view.webContents.debugger.attach('1.3')`:
     - `Accessibility.getFullAXTree` or `DOMSnapshot.captureSnapshot` for perception.
     - `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` for actions.
     - `Page.captureScreenshot` for the vision fallback.
     - `Network.*` events for logging.
     - This avoids opening a TCP debugging port that any local process could use.
  4. Live view and takeover:
     - The view is visible, so the user sees the agent act. Draw a cursor or highlight overlay through `Overlay.highlightNode`, or inject CSS.
     - A "Take over" button pauses the agent loop and gives input back to the user (Operator-style takeover), with no screenshots while the user types credentials.
  5. Guardrails:
     - `session.setPermissionRequestHandler` denies camera, mic, notifications and similar by default.
     - `will-navigate` and `setWindowOpenHandler` enforce per-site first-use approval and a blocklist.
     - `will-download` routes downloads to a quarantine folder and asks the user.
     - Synthesized input goes only to the page's webContents, never to Alma's own UI, mirroring OWL's rule.
- In Alma's architecture this belongs in `src/main/` (electron is only allowed there and in `coordinator/index.ts`). Browser tools should declare `ToolRisk`: navigate and read as low risk; form submit, purchase and post as `publish`, which always asks, per CLAUDE.md.

### Gaps
- Not verified in this session: the exact current Electron version behavior of `--remote-debugging-port`; whether `webContents.debugger` coexists with an external Playwright CDP client; and how Electron session partitions encrypt cookies on Windows. Chromium's cookie encryption via DPAPI is expected but unsourced here.

## Security: indirect prompt injection, exfiltration, credentials, and mitigations

### Takeaway
No vendor claims to have solved prompt injection. The published defense stack is consistent across vendors:
- Adversarial training.
- Input probes on untrusted content.
- An isolated action critic.
- Site permissions and allowlists, with high-risk categories blocked.
- Human confirmation for consequential actions.
- Logged-out or ephemeral sessions by default.
- Takeover for credentials.

### Cited Findings
- Anthropic: "No browser agent is immune to prompt injection"; 1% ASR "still represents meaningful risk." — [Anthropic research](https://www.anthropic.com/research/prompt-injection-defenses)
- OpenAI: prompt injection is unlikely to ever be fully "solved." Logged-out mode is recommended, and logged-in mode only for narrow tasks on trusted sites. — [eSecurity Planet](https://www.esecurityplanet.com/artificial-intelligence/openai-hardens-chatgpt-atlas-against-prompt-injection-attacks/); [Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)
- Simon Willison: in application security "a 99% success rate is still a failing grade." — [Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)
- Google's critic sees metadata, not page content, so it is hard for a malicious page to manipulate. — [BleepingComputer](https://bleepingcomputer.com/news/security/google-chrome-adds-new-security-layer-for-gemini-ai-agentic-browsing)
- Brave recommends isolating agentic from casual browsing and confirming sensitive actions. — [Brave](https://brave.com/blog/comet-prompt-injection/)
- Injection can also arrive through images and screenshots. — [Ultima Hora on Brave](https://www.ultimahora.es/noticias/tecnologia-videojuegos/2025/10/22/2496525/captura-pantalla-web-puede-desencadenar-ataque-prompt-injection-comet-alertan-desde-brave.html); [Anthropic research](https://www.anthropic.com/research/prompt-injection-defenses)
- Playwright MCP origin lists are "not a security boundary." — [playwright-mcp](https://github.com/microsoft/playwright-mcp)
- Chrome DevTools MCP exposes all browser data to the MCP client. — [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)

### Inferences
- **Exfiltration.** The dangerous combination is private data, untrusted content and an outbound channel all in one agent. In a browser, outbound channels include navigating to an attacker URL with data in the query string, submitting forms and loading images. For Alma:
  - Navigation to a new origin in the same task should go through the action critic and site approval.
  - Content from the logged-in partition should be tagged as private, and tool results from pages as untrusted.
- **Credentials.**
  - Never put cookies or passwords in prompts or logs (this matches Alma's secrets rule).
  - Use takeover for login, and do not screenshot during takeover.
  - Import per site only on explicit opt-in, with banking, email and SSO excluded by default (Anthropic's pattern).
- Alma's existing approvals flow (spec 004) and `ToolRisk.publish` are a natural home for confirmation of consequential browser actions. The Chrome MCP preset (the user's real Chrome) is the riskier path and should keep "ask" semantics.

### Gaps
- No independent third-party benchmark comparing vendors' ASR under the same attacks was found. All ASR figures are vendor self-reports.

## REA (github.com/morluto/rea) and the legality/ToS question

### Takeaway
REA is a very popular, MIT-licensed TypeScript MCP server and CLI. It covers websites (Chrome observation, HAR/SAZ captures), Electron/JS apps, native binaries, and turning recorded API traffic into RL environments. Its setup rewrites agent configs (with backups). It is legitimate for analyzing Alma's own build and the user's own HAR captures. Using it on Claude Desktop would breach Anthropic's Consumer Terms (§3 bars decompiling and reverse engineering, except where law forbids the restriction), and OpenAI's terms carry a similar ban.

### Cited Findings
**Repository facts (GitHub API, 2026-11-08)** — [GitHub API repos/morluto/rea](https://github.com/morluto/rea)
- 442,933 stars and 109,475 forks.
- 1,643 open issues, a count that includes PRs.
- About 6,704 commits.
- Created 2026-04-14, last push 2026-11-08, language TypeScript, license MIT, about 30 contributors on the first page.
- Latest releases: rea-agents-6.8.0 (2026-10-25), 6.7.0 and 6.6.0 (2026-10-18).

**Targets and requirements (README)** — [GitHub morluto/rea](https://github.com/morluto/rea)
- Websites: page structure, scripts, network observations and screenshots through a Chrome-family browser.
- Saved captures: HAR or Fiddler Everywhere SAZ files, with mitmdump needed on Linux.
- RL environments: REA turns recorded requests and responses into callable tools and exports a runnable environment, which requires AgentEnv and Docker.
- Electron/JS apps: modules, imports, routes, IPC and native add-ons.
- Native binaries: through Hopper, Ghidra, IDA or Kuna, plus Go, Rust, .NET, APK and firmware.
- Requires Node 22.23.4+, 24.22.1+ or 26.12.1+.

**Install footprint** — [GitHub morluto/rea](https://github.com/morluto/rea)
- `npx rea-agents setup`, or `npm install --global rea-agents`.
- Setup "adds REA's MCP server and matching workflow instructions, with backups of existing configuration." It records the selected runtime and entry script, and can optionally install Hopper with approval.
- Targets Claude Code, Codex, Cursor, Gemini CLI and Grok Build.

**Stated use policy** — [GitHub morluto/rea](https://github.com/morluto/rea)
- REA is "for lawful research, education, interoperability, software preservation," and for software you own or are authorized to examine.
- Commercial tools must be licensed; cracked copies are not authorized.
- Further guidance is in DISCLAIMER.md.

**Anthropic Consumer Terms (effective 2025-10-08), §3 prohibited uses** — [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- "To decompile, reverse engineer, disassemble, or otherwise reduce our Services to human-readable form" (except where applicable law prohibits the restriction).
- "To crawl, scrape, or otherwise harvest data or information from our Services."
- Access "through automated or non-human means, whether through a bot, script, or otherwise" (except through an API key or explicit permission).
- "To develop any products or services that compete with our Services … including to develop or train any artificial intelligence or machine learning algorithms or models."

**OpenAI Terms of Use** (third-party copies; the live page returned 403)
- March 2023 wording: users may not "reverse assemble, reverse compile, decompile, translate or otherwise attempt to discover the source code or underlying components of the Services" (except where law conflicts). — [archived copy via search](https://tostracker.app/document/openai/version/853589)
- Later rest-of-world wording: users may not "attempt to or assist anyone to reverse engineer, decompile or discover the source code or underlying components of our Services, including our models, algorithms, or systems". — [ConductAtlas](https://conductatlas.com/platform/openai/terms-of-use-row/prohibition-on-reverse-engineering-services/)
- The terms also bar using output to develop competing models. — [ConductAtlas](https://conductatlas.com/platform/openai/terms-of-use-row/prohibition-on-reverse-engineering-services/)

### Inferences
- **Popularity signal.** About 443k stars and 109k forks within about 7 months of creation is far above typical for a niche RE tool. Treat stars as a weak maturity signal and judge by releases (frequent, v6.x) and code instead. This is an inference; there is no source on star inflation.
- **Install footprint.** `npx rea-agents setup` edits global agent configs, including Claude Code's MCP config. Alma's CLAUDE.md forbids `npm install` / `npm audit fix` in the repo. Any trial should run in a throwaway user profile or VM, not on the dev machine's main configs. It also needs Node 22.23+ and, for RL export, Docker.
- **Legitimate uses for Alma:**
  - Analyzing Alma's own packaged Electron build: IPC surface, preload exposure and bundled native add-ons, to check the architecture rules and security controls (docs/security).
  - Recording HAR files of the user's own sessions on sites Alma automates, to design robust browser tools or API shortcuts.
  - Observing public site behavior.
- **Not legitimate:**
  - Decompiling Claude Desktop or the ChatGPT app to copy their browser implementation. That is prohibited by both vendors' consumer terms and is unnecessary: the architectures are publicly described (OWL post, Anthropic docs).
  - Using REA's "API traffic → RL environment" feature on Claude or ChatGPT traffic, which could also hit the anti-competitive training clause.

### Gaps
- REA's DISCLAIMER.md and per-target docs were not read in full.
- No independent security audit of REA was found.
- Local law on interoperability exceptions to reverse-engineering bans (e.g., the EU Software Directive art. 6, or the law of the user's jurisdiction) was not researched. Both vendors' clauses carve out cases where applicable law prohibits the restriction, so a jurisdiction-specific legal check is needed before relying on that carve-out.
- The current live OpenAI Terms text could not be fetched (403).

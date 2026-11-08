# Privacy: data inventory, processors and rights

Basis for the record of processing activities (ISO/IEC 27701 7.2.8; SOC 2 P1–P8). **Alma has no servers of its own**: everything it stores lives on the computer of the person who uses it (`%APPDATA%\Alma` and the folders that person chooses). Whoever installs it is the controller; the providers in section 2 are processors or sub-processors depending on what the person configures.

## 1. What personal data Alma processes

| Data | Where it ends up | What for | Retention | Leaves the machine |
|---|---|---|---|---|
| Conversations with the agents (`threads/`) | Local disk, JSON | Continuity of the work | Until deleted; optional automatic deletion (30/90/180/365 days) | Each message travels to the agent's model provider. With the remote **History** scope on, the titles and the user and assistant text of the conversations (company ones excepted) are served to the owner's paired phone over the tailnet; with its «continue conversations» sub-switch on, a message typed on the phone is written into the conversation and travels to that conversation's provider like any message. Tool calls, results and attachments are not sent to the phone; the phone keeps nothing |
| Files the person sends (photos, audio; `inbox/`) | Local disk | So the agent can see or transcribe them | Until «Borrar mi historial» | Only if the agent analyzes them (model provider) |
| Vault notes and their search index (`knowledge/`) | Folder chosen by the person; the index, local | Memory and search | Decided by the person | The embeddings model (bge‑m3) runs on the machine. With the remote **Notes** scope on, the active vault's notes and images (minus the excluded folders) are served read-only to the owner's own paired phone over the tailnet; the phone keeps nothing |
| Voiceprint (`voice-profile.json`) — "biometric data" | Local disk | Answering only to their voice (optional) | Until «Borrar mi historial» or «Olvidar mi voz» | No |
| Microphone audio | Memory (not stored) | Dictation and voice assistant | Not kept | Only if the transcription is «OpenAI» or «Meta»; local Whisper by default |
| Credentials (API keys, Telegram token, mail password) | `settings.json`, encrypted with the OS store | Connecting to the services | Until deleted | Only to the service they belong to |
| Mail (reading and sending over IMAP/SMTP) | Not stored: read on demand | So the agent can read and draft mails | — | The content read travels to the model provider |
| WhatsApp and Telegram chat | WhatsApp session in `whatsapp-auth*`; Telegram has no local state | Talking to Alma from the phone | Until unlinked | Through the WhatsApp/Telegram servers |
| Cameras and home devices (embedded Home Assistant) | Local; HA history 7 days | Home automation and surveillance with judgment | 7 days | Photos that are analyzed go to the vision provider; those requested over Telegram, to Telegram; a paired phone fetches its stills over the tailnet |
| Agent companies: tasks, meetings, mailboxes | `companies/` and each company's folder | Teamwork of agents | Decided by the person | Like the conversations |
| Audit trail (`audit/`) | Local disk | Security and accountability | 13 months | No. It contains no messages or secrets. A phone opening a note, an image or a conversation, sending or stopping leaves an entry with the device id, the outcome and the vault-relative path or the conversation id; never a title, a text or a search query |
| Paired phones (`remote/devices.json`) | Local disk. Exported as `remote-devices.json` | Knowing which phones may connect, with what scopes | Until revoked; idle 15 days | No: names and dates only, no key material |
| Push subscriptions (endpoint + keys, sealed) | Local disk, sealed with the OS store | Waking the phone when an approval waits | Until unsubscribed or revoked | The vendor learns a content-free push was sent, and when |
| Tailscale machine name | Not stored by Alma; it is the Serve certificate name | Serving the PWA over HTTPS | While served | Yes: public certificate-transparency logs |

## 2. External providers (processors / sub-processors)

They are activated only when the person loads the key or chooses the service. Region of processing, basis for international transfers and terms: "review each one's data processing agreement (DPA) before using it with third-party data" (🏢).

| Provider | What it receives | When |
|---|---|---|
| Anthropic (Claude), xAI (Grok), DeepSeek, Meta (Muse), Vercel AI Gateway (and the labs behind them) | Messages, tool results, attached images | When an agent uses that provider |
| The auto-review model's provider | The one sentence (the reason, in English) with which auto-review flagged an action, to translate it into the app language. Boss reasons and the notes of allowed actions are not sent | Only when the app language is Spanish and auto-review flagged an action; one low-effort call per reason, cached |
| OpenAI, xAI, Meta | Descriptions to generate images | `generate_image` |
| OpenAI, Meta | Audio to transcribe | Cloud transcription enabled in «Voz» |
| ElevenLabs | Text to read aloud | Voice «ElevenLabs» |
| Telegram, WhatsApp | Messages, photos | Channels enabled |
| DuckDuckGo and the sites visited | Queries and the machine's IP address | `web_search`, `fetch_url` |
| Instagram | Posts (always with approval) | `instagram_publish` |
| Configured mail server | Credentials and messages | Mail enabled |
| Hugging Face | One-time download of models (voice, embeddings); no data is sent | First use |
| Push vendors (Google/Apple/Mozilla) | An empty wake-up: no content, no title with details; they learn a push was sent, and when | A remote approval is waiting and the phone subscribed |
| Tailscale (coordination + DERP relays) | Account identity and, when direct connection fails, relayed encrypted traffic it cannot read | Remote access on |

## 3. People's rights and how they are handled

| Right | How |
|---|---|
| Access and portability | «Ajustes → General → Privacidad → Exportar mis datos»: copies the conversations, companies, audit trail, routines and the voiceprint into a new folder. |
| Erasure | «Borrar mi historial» (conversations, received files, voiceprint). The vault belongs to the person: it is deleted from the vault. Credentials: «Borrar» on each provider. |
| Retention / restriction | «Borrar conversaciones sin actividad» at 30/90/180/365 days. |
| Rectification | Conversations and notes are text the person can edit; Alma does not build profiles. |
| Objection to processing by a provider | Change the agent's provider or delete its key; voice and embeddings can stay 100 % local. |
| Requests from third parties (if Alma processes other people's data, e.g. a customer's mail) | Handled by the responsible organization, with the same export and deletion mechanism, and the vault search to locate the data subject. |

## 4. Privacy by design

- Everything that can be local is local by default: Whisper, Kokoro, embeddings and the wake word run on the machine.
- Keys are sealed with the system store and do not reach the interface or the environment of commands.
- What leaves the machine is an explicit choice (provider per agent, channel by channel).
- The audit trail records *what* was done and *who allowed it*, never the content.
- The phone is a window, not a copy (spec 028): notes and conversations live in its memory while a screen is open and nothing is cached or stored (only its key, its push subscription and the app shell), every API response is `no-store`, and no push carries a title or text. Alma cannot stop the person from copying or screenshotting what the phone displays. No new third party receives anything; the tailnet relays only encrypted traffic.
- Pending (🏢): legal basis and consent for the voiceprint and the cameras; DPIA if third parties are surveilled; record of processing activities per organization.

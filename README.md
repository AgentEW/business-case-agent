# Business Case Agent

A small web app that records audio from the microphone, transcribes it, extracts a structured business case, and persists everything for review.

## Features

- a landing menu to choose between starting an interview or browsing the extracted business case
- guided discovery sessions — gated by a short intake form (name, role, current project) so every answer is traceable to an interviewee, with questions asked one at a time
- transcript-then-review flow — voice answers are transcribed and dropped into the answer box for the interviewee to review/edit before submitting; answers save instantly, with no per-question wait for AI extraction
- a "Skip Question" button and a "Generate Test Answer" button (a Claude-roleplayed, deliberately noisy synthetic answer for stress-testing the pipeline)
- business case extraction is deferred to the end of the interview — when the last question is answered, the session is "finalized" in one batch, running extraction for all of that session's answers at once instead of one at a time
- browser microphone recording with audio metadata extraction (duration, sample rate, channels)
- server-side transcription (OpenAI gpt-4o-mini-transcribe)
- server-side extraction (Claude): distinct business problems (with time cost, frequency, headcount, current workaround, supporting quote, and confidence), stakeholders, risks, desired capabilities, and structured workflow detection
- cross-recording problem deduplication — new problems are matched against a running master list and merged when they describe the same underlying issue, with each mention timestamped and quantified
- a business case dashboard (Overview, Problems, Workflows, Desired Capabilities, Records) — ranked problems by estimated annual hours, browsable in the UI, separate from the interview flow
- persisted uploads and record logs

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure API keys — copy `.env.example` to `.env` and fill in:

```text
OPENAI_API_KEY=...   # used for audio transcription (gpt-4o-mini-transcribe)
ANTHROPIC_API_KEY=...  # used for business case extraction (Claude)
```

3. Start the app:

```bash
npm run dev
```

4. Open the app in your browser:

```text
http://localhost:3000
```

## How it works

1. The landing menu offers two paths: **Start Interview** or **View Business Case Extract**.
2. Starting an interview first asks for the interviewee's name, role, and current project (`POST /api/session/start`), which creates a session in `data/sessions.json`. The app then loads the discovery questions from `discovery-questions.json` (via `GET /api/questions`) and walks through them one at a time.
3. For each question, the interviewee can type an answer, record one, or click "Generate Test Answer" to have Claude roleplay a noisy synthetic answer for stress-testing. Recorded audio is transcribed (`POST /api/transcribe`) and the transcript is placed in the answer box for review/editing before submission — nothing is auto-submitted. "Skip Question" advances without saving anything.
4. Submitting an answer (`POST /api/record/text`) saves it immediately — transcript, question, technical metadata, and the interviewee's session — with `businessCase` left `null`. No extraction runs at this point, which is what keeps each question fast.
5. When the last question is answered, the session is finalized: the client calls `POST /api/session/:sessionId/finalize`, which runs extraction for every still-unprocessed record in that session, one batch instead of one call per question. For each: Claude extracts distinct business problems (with time cost, frequency, headcount affected, current workaround, a supporting quote, and a confidence rating), stakeholders, risks, desired capabilities, and a structured workflow (title, trigger, actors, steps, duration) if one was described.
6. Each extracted problem is matched (via a second Claude call) against the master problem list in `data/problems.json`. Matches get a new timestamped, quantified mention appended to the existing entry; non-matches become new entries.
7. If a workflow was described, it's appended to `data/workflows.json` as a structured entry.
8. Once the whole session's records are processed, `data/business-case-report.json`/`.md` is regenerated once: problems ranked by estimated annual hours (time cost × frequency × headcount), with unquantified problems and desired capabilities called out separately.
9. The transcript, the question it answered, and the extraction results are stored alongside the technical metadata in the record log and shown in the dashboard.
10. **View Business Case Extract** opens a dashboard (Overview, Problems, Workflows, Desired Capabilities, Records) backed by `GET /api/business-case-report`, `GET /api/workflows`, `GET /api/sessions`, and `GET /api/records`. Nothing extracted is visible during the interview itself — only here.

If the `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are missing or a request fails, the record is still saved with `transcript`/`businessCase` set to `null`. A record stays eligible for extraction (`businessCase === null`) until it succeeds, so re-calling finalize for a session retries anything that failed the first time.

## Project structure

- `server.js` - Express backend for sessions, questions, transcription, transcript generation, batched extraction (session finalize), problem deduplication, workflow capture, the business case rollup, and record storage
- `discovery-questions.json` - guided discovery questions, grouped by category, asked one by one during a session
- `public/index.html` - browser UI: landing menu, interview flow, and business case dashboard
- `public/app.js` - menu/view switching, guided session flow, microphone capture, upload logic, and dashboard rendering
- `public/styles.css` - UI styling
- `.env.example` - required environment variables (copy to `.env`)
- `uploads/` - saved audio files
- `data/sessions.json` - one entry per interview session (name, role, project, start time)
- `data/records.jsonl` - structured record log (transcript + per-recording extraction per record), each stamped with its session
- `data/problems.json` - master deduplicated list of business problems, each with its mention history (record id, session, interviewee, and quantification per mention)
- `data/workflows.json` - structured workflow entries (title, trigger, actors, steps, duration) extracted across recordings
- `data/desired-capabilities.json` - aspirational asks extracted across recordings
- `data/business-case-report.json` / `data/business-case-report.md` - regenerated once per session finalize: problems ranked by estimated annual hours, plus desired capabilities

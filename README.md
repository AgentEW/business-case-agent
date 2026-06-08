# Business Case Agent

A small web app that records audio from the microphone, transcribes it, extracts a structured business case, and persists everything for review.

## Features

- guided discovery sessions — questions are asked one at a time, with recording/upload/analysis happening automatically between each
- browser microphone recording
- audio metadata extraction (duration, sample rate, channels)
- server-side transcription (OpenAI Whisper)
- server-side extraction (Claude): distinct business problems, stakeholders, risks, and workflow detection
- cross-recording problem deduplication — new problems are matched against a running master list and merged when they describe the same underlying issue, with each mention timestamped
- workflow descriptions are appended to a running Markdown context file
- upload endpoint with structured JSON metadata
- persisted uploads and record logs

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure API keys — copy `.env.example` to `.env` and fill in:

```text
OPENAI_API_KEY=...   # used for audio transcription (Whisper)
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

1. Clicking "Start Session" loads the discovery questions from `discovery-questions.json` (via `GET /api/questions`) and walks through them one at a time.
2. For each question, the user clicks "Start Recording", answers, then "Stop Recording". The browser extracts technical metadata (duration, sample rate, channels) via the Web Audio API and immediately uploads the answer — there is no separate upload step, and the session advances to the next question once the upload completes.
3. On upload, the server saves the audio file, transcribes it with Whisper, then sends the transcript — along with the discovery question it answers — to Claude to extract: distinct business problems, stakeholders, risks, and whether a business workflow was described.
4. Each extracted problem is matched (via a second Claude call) against the master problem list in `data/problems.json`. Matches get a new timestamped mention appended to the existing entry; non-matches become new entries.
5. If a workflow was described, a Markdown summary is appended to `data/context.md` with the recording's date/time and filename.
6. The transcript, the question it answered, and the extraction results are stored alongside the technical metadata in the record log and shown in the UI.

If the `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are missing or a request fails, the record is still saved with `transcript`/`businessCase` set to `null`.

## Project structure

- `server.js` - Express backend for the questions endpoint, upload, transcription, extraction, problem deduplication, and record storage
- `discovery-questions.json` - guided discovery questions, grouped by category, asked one by one during a session
- `public/index.html` - browser UI
- `public/app.js` - guided session flow, microphone capture, upload logic, and results display
- `public/styles.css` - UI styling
- `.env.example` - required environment variables (copy to `.env`)
- `uploads/` - saved audio files
- `data/records.jsonl` - structured record log (transcript + per-recording extraction per record)
- `data/problems.json` - master deduplicated list of business problems, each with its mention history (record id + timestamp)
- `data/context.md` - running Markdown log of business workflows described across recordings

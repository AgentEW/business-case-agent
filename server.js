require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    problems: {
      type: 'array',
      description: 'The distinct business problems mentioned in the transcript. If the same underlying problem is mentioned more than once, merge those mentions into a single entry rather than listing it twice.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          timeCostHoursLow: { type: 'number', description: 'Low end of the time cost mentioned, in hours (convert days/minutes to hours). 0 if no time figure was mentioned.' },
          timeCostHoursHigh: { type: 'number', description: 'High end of the time cost mentioned, in hours. Equal to timeCostHoursLow if only a single figure was given. 0 if no time figure was mentioned.' },
          occurrencesPerYear: { type: 'number', description: 'Best-effort estimate of how many times per year this occurs, based on the stated frequency (e.g. "per RFI", "per project phase", "weekly"). 0 if frequency cannot reasonably be estimated from the transcript.' },
          peopleAffectedCount: { type: 'number', description: 'Number of people affected, based on what is mentioned. Default to 1 if only the interviewee is implicated.' },
          currentWorkaround: { type: 'string', description: 'The tool or process they currently use to deal with this, if mentioned. "" if not mentioned.' },
          directQuote: { type: 'string', description: 'The verbatim sentence(s) from the transcript that best evidences this problem.' },
          confidence: { type: 'string', enum: ['stated', 'estimated', 'anecdotal'], description: '"stated" if hard numbers were given, "estimated" if Claude inferred a reasonable estimate, "anecdotal" if only a vague qualitative complaint was made.' },
        },
        required: ['description', 'timeCostHoursLow', 'timeCostHoursHigh', 'occurrencesPerYear', 'peopleAffectedCount', 'currentWorkaround', 'directQuote', 'confidence'],
      },
    },
    stakeholders: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The stakeholder\'s name, or "" if not mentioned. Never write "<UNKNOWN>" or similar placeholders.' },
          role: { type: 'string' },
        },
        required: ['name', 'role'],
      },
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['description', 'severity'],
      },
    },
    workflow: {
      type: 'object',
      description: 'Set present=true only if the transcript walks through a step-by-step business workflow/process.',
      properties: {
        present: { type: 'boolean' },
        title: { type: 'string', description: 'A short name for the workflow (e.g. "RFI Handling Workflow"), or "" if present is false.' },
        trigger: { type: 'string', description: 'What kicks off the workflow, or "" if present is false.' },
        actors: { type: 'array', items: { type: 'string' }, description: 'The roles/people involved in the workflow, in order of involvement.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The ordered steps of the workflow, one per array entry.' },
        duration: { type: 'string', description: 'How long the workflow typically takes, as stated, or "" if not mentioned.' },
      },
      required: ['present', 'title', 'trigger', 'actors', 'steps', 'duration'],
    },
    desiredCapabilities: {
      type: 'array',
      description: 'Aspirational asks or "if I had X, I would..." statements — things the interviewee wishes they had, distinct from problems they currently face.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          directQuote: { type: 'string', description: 'The verbatim sentence(s) this was drawn from.' },
        },
        required: ['description', 'directQuote'],
      },
    },
  },
  required: ['problems', 'stakeholders', 'risks', 'workflow', 'desiredCapabilities'],
};

const PROBLEM_MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      description: 'One entry per item in "New problems", in the same order.',
      items: {
        type: 'object',
        properties: {
          matchedExistingId: {
            type: 'string',
            description: 'The id of the existing known problem that describes the same underlying issue, or "" if this is a genuinely new problem.',
          },
        },
        required: ['matchedExistingId'],
      },
    },
  },
  required: ['matches'],
};

// Uses a hand-rolled multipart request instead of the openai SDK's fetch-based client,
// which reliably hit ECONNRESET on this network before a response was ever received.
// Reused across requests so transcription calls don't pay a fresh TLS handshake every time.
const openaiKeepAliveAgent = new https.Agent({ keepAlive: true });

function transcribeAudio(audioBuffer, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = `----whisper-${Date.now()}`;

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      agent: openaiKeepAliveAgent,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return reject(new Error(`Whisper returned non-JSON response (status ${res.statusCode}): ${data.slice(0, 200)}`));
        }
        if (res.statusCode >= 400) {
          return reject(new Error(parsed.error?.message || `Whisper request failed with status ${res.statusCode}`));
        }
        resolve(parsed.text);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function extractFromTranscript(transcript, questionContext) {
  const contextLine = questionContext
    ? `This recording is the interviewee's answer to the discovery question: "${questionContext}"\n\n`
    : '';

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    tools: [
      {
        name: 'record_extraction',
        description: 'Record structured business details extracted from a transcript.',
        input_schema: EXTRACTION_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'record_extraction' },
    messages: [
      {
        role: 'user',
        content: `${contextLine}Extract the business details from the following transcript. Use empty strings/arrays/zeros for anything not mentioned — do not guess or invent details. For numeric time/frequency/headcount fields, only fill in a non-zero estimate when it is stated or reasonably inferable from the transcript; mark confidence accordingly.\n\nTranscript:\n"""\n${transcript}\n"""`,
      },
    ],
  });

  const toolUse = message.content.find(block => block.type === 'tool_use');
  return toolUse ? toolUse.input : null;
}

const STRESS_TEST_PERSONA_PROMPT = `You generate synthetic interview transcripts for stress-testing a speech-to-text
and business-extraction pipeline. You consistently roleplay one persona:

PERSONA: Frank Castellano, 58, a senior/master architect and partner at "SJ Group,"
a mid-size architecture firm. Three decades in the field. Sharp, opinionated, a bit
gruff, proud of his craft, openly skeptical of AI and most "innovation" pitches —
he's seen too many tools overpromise. He answers honestly and at length because he
likes complaining about real problems, but he can't resist needling the premise of
the interview itself.

TASK: Given a discovery interview question, write what Frank would say out loud in
response — roughly 2 minutes of spoken speech (260-320 words), as a raw, unedited
transcript (not a cleaned-up quote).

To stress-test the downstream pipeline, work in MOST of the following noise
patterns, varied each time so no two answers feel templated:
- filler words and verbal tics (uh, look, I mean, you know)
- at least one false start or self-correction ("we usually— actually no, half the
  time we...")
- a tangent that wanders off-topic for a sentence or two before snapping back
- one aside expressing skepticism about AI or this interview itself
- inconsistent/mixed figures when giving time or cost estimates (e.g. "a day and a
  half" and "12 hours" in the same answer)
- at least one mid-sentence cutoff or garbled fragment, like a dropped transcription
- concrete architecture-firm specifics: drawings, specs, RFIs, code research, junior
  staff, redlines, submittals, invented project names — specific, not generic

Stay grounded enough that the answer is still useful raw material — a real busy
professional thinking out loud, not pure noise.

If you're given a running summary of earlier answers from this same interview,
treat this as one continuing conversation: reuse the same project names, coworker
names, numbers, and complaints already established in the summary rather than
inventing disconnected new ones every time, the way a real recurring interviewee
would.

Do not break character, do not add meta-commentary, disclaimers, or formatting in
the transcript itself.`;

const STRESS_TEST_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    transcript: {
      type: 'string',
      description: "Frank's spoken answer to the discovery question — only the spoken words, nothing else.",
    },
    updatedSummary: {
      type: 'string',
      description: 'An updated running summary of what Frank has established across the interview so far (project names, coworker names, recurring numbers/complaints, tone notes), folding in anything new from this answer. Keep it under 100 words. This replaces the previous summary entirely, so it must include everything still relevant, not just what changed.',
    },
  },
  required: ['transcript', 'updatedSummary'],
};

async function generateStressTestTranscript(question, priorSummary) {
  const summaryBlock = priorSummary
    ? `Running summary of what Frank has already established earlier in this interview:\n"${priorSummary}"\n\n`
    : '';

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    temperature: 1,
    system: STRESS_TEST_PERSONA_PROMPT,
    tools: [
      {
        name: 'frank_answer',
        description: "Record Frank's spoken answer and the updated running summary of the interview.",
        input_schema: STRESS_TEST_RESPONSE_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'frank_answer' },
    messages: [
      {
        role: 'user',
        content: `${summaryBlock}Discovery question: "${question.text}" (category: ${question.category})\n\nGenerate Frank's spoken answer now.`,
      },
    ],
  });

  const toolUse = message.content.find(block => block.type === 'tool_use');
  return toolUse ? toolUse.input : { transcript: '', updatedSummary: priorSummary ?? '' };
}

async function matchProblems(newProblems, existingProblems) {
  if (!newProblems.length || !existingProblems.length) {
    return newProblems.map(() => ({ matchedExistingId: '' }));
  }

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: [
      {
        name: 'match_problems',
        description: 'Match each new problem against the list of already-known problems, or mark it as new.',
        input_schema: PROBLEM_MATCH_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'match_problems' },
    messages: [
      {
        role: 'user',
        content: `Existing known problems:\n${existingProblems.map(p => `- [${p.id}] ${p.description}`).join('\n')}\n\nNew problems mentioned in the latest recording:\n${newProblems.map((p, i) => `${i + 1}. ${p.description}`).join('\n')}\n\nFor each new problem, decide whether it describes the same underlying business problem as one of the existing known problems (return its id) or is genuinely new (return "").`,
      },
    ],
  });

  const toolUse = message.content.find(block => block.type === 'tool_use');
  return toolUse ? toolUse.input.matches : newProblems.map(() => ({ matchedExistingId: '' }));
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
const recordsPath = path.join(dataDir, 'records.jsonl');
const problemsPath = path.join(dataDir, 'problems.json');
const workflowsPath = path.join(dataDir, 'workflows.json');
const questionsPath = path.join(__dirname, 'discovery-questions.json');
const sessionsPath = path.join(dataDir, 'sessions.json');
const desiredCapabilitiesPath = path.join(dataDir, 'desired-capabilities.json');
const reportJsonPath = path.join(dataDir, 'business-case-report.json');
const reportMdPath = path.join(dataDir, 'business-case-report.md');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(recordsPath)) {
  fs.writeFileSync(recordsPath, '');
}

if (!fs.existsSync(problemsPath)) {
  fs.writeFileSync(problemsPath, '[]');
}

if (!fs.existsSync(workflowsPath)) {
  fs.writeFileSync(workflowsPath, '[]');
}

if (!fs.existsSync(sessionsPath)) {
  fs.writeFileSync(sessionsPath, '[]');
}

if (!fs.existsSync(desiredCapabilitiesPath)) {
  fs.writeFileSync(desiredCapabilitiesPath, '[]');
}

function loadQuestions() {
  const data = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
  return data.categories.flatMap(category =>
    category.questions.map(text => ({ category: category.category, text }))
  );
}

function loadProblems() {
  return JSON.parse(fs.readFileSync(problemsPath, 'utf8'));
}

function saveProblems(problems) {
  fs.writeFileSync(problemsPath, JSON.stringify(problems, null, 2));
}

function loadSessions() {
  return JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
}

function saveSessions(sessions) {
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
}

function loadDesiredCapabilities() {
  return JSON.parse(fs.readFileSync(desiredCapabilitiesPath, 'utf8'));
}

function saveDesiredCapabilities(capabilities) {
  fs.writeFileSync(desiredCapabilitiesPath, JSON.stringify(capabilities, null, 2));
}

function buildMention(problem, record) {
  return {
    recordId: record.id,
    recordedAt: record.createdAt,
    sessionId: record.sessionId,
    interviewee: record.interviewee,
    timeCostHoursLow: problem.timeCostHoursLow ?? 0,
    timeCostHoursHigh: problem.timeCostHoursHigh ?? 0,
    occurrencesPerYear: problem.occurrencesPerYear ?? 0,
    peopleAffectedCount: problem.peopleAffectedCount ?? 1,
    currentWorkaround: problem.currentWorkaround ?? '',
    directQuote: problem.directQuote ?? '',
    confidence: problem.confidence ?? 'anecdotal',
  };
}

function mergeProblemsIntoMasterList(newProblems, matches, record) {
  const masterList = loadProblems();
  const merged = [];

  newProblems.forEach((problem, index) => {
    const matchedId = matches[index]?.matchedExistingId;
    const existing = matchedId ? masterList.find(p => p.id === matchedId) : null;

    if (existing) {
      existing.mentions.push(buildMention(problem, record));
      merged.push({ problemId: existing.id, description: existing.description, matched: true });
    } else {
      const entry = {
        id: `problem-${Date.now()}-${index}`,
        description: problem.description,
        mentions: [buildMention(problem, record)],
      };
      masterList.push(entry);
      merged.push({ problemId: entry.id, description: entry.description, matched: false });
    }
  });

  saveProblems(masterList);
  return merged;
}

function appendDesiredCapabilities(capabilities, record) {
  if (!capabilities.length) return;

  const list = loadDesiredCapabilities();
  capabilities.forEach(capability => {
    list.push({
      recordId: record.id,
      recordedAt: record.createdAt,
      sessionId: record.sessionId,
      interviewee: record.interviewee,
      description: capability.description,
      directQuote: capability.directQuote,
    });
  });
  saveDesiredCapabilities(list);
}

function loadWorkflows() {
  return JSON.parse(fs.readFileSync(workflowsPath, 'utf8'));
}

function saveWorkflows(workflows) {
  fs.writeFileSync(workflowsPath, JSON.stringify(workflows, null, 2));
}

function appendWorkflow(workflow, record) {
  const workflows = loadWorkflows();
  workflows.push({
    id: `workflow-${Date.now()}`,
    recordId: record.id,
    recordedAt: record.createdAt,
    sessionId: record.sessionId,
    interviewee: record.interviewee,
    title: workflow.title,
    trigger: workflow.trigger,
    actors: workflow.actors,
    steps: workflow.steps,
    duration: workflow.duration,
  });
  saveWorkflows(workflows);
}

function loadRecords() {
  return fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function saveAllRecords(records) {
  fs.writeFileSync(recordsPath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// Runs extraction + problem matching + workflow/capability capture for one record,
// mutating record.businessCase in place. Used at session finalize time, batched,
// rather than per-answer, since each call costs two sequential Claude requests.
async function applyExtractionToRecord(record) {
  let extraction = null;
  try {
    extraction = await extractFromTranscript(record.transcript, record.question?.text);
  } catch (error) {
    console.error('Extraction failed', error);
    return;
  }

  let problems = extraction.problems.map(p => ({ problemId: null, description: p.description, matched: false }));

  try {
    const existingProblems = loadProblems();
    const matches = await matchProblems(extraction.problems, existingProblems);
    problems = mergeProblemsIntoMasterList(extraction.problems, matches, record);
  } catch (error) {
    console.error('Problem reconciliation failed', error);
  }

  try {
    appendDesiredCapabilities(extraction.desiredCapabilities ?? [], record);
  } catch (error) {
    console.error('Failed to append desired capabilities', error);
  }

  if (extraction.workflow?.present) {
    try {
      appendWorkflow(extraction.workflow, record);
    } catch (error) {
      console.error('Failed to append workflow', error);
    }
  }

  record.businessCase = {
    problems,
    stakeholders: extraction.stakeholders,
    risks: extraction.risks,
    workflowDetected: Boolean(extraction.workflow?.present),
    desiredCapabilities: extraction.desiredCapabilities ?? [],
  };
}

function estimateAnnualHours(mention) {
  const avgHours = (mention.timeCostHoursLow + mention.timeCostHoursHigh) / 2;
  if (!avgHours || !mention.occurrencesPerYear) return 0;
  return avgHours * mention.occurrencesPerYear * (mention.peopleAffectedCount || 1);
}

function computeBusinessCaseReport() {
  const problems = loadProblems();

  const ranked = problems.map(problem => {
    const quantifiedMentions = problem.mentions.filter(m => estimateAnnualHours(m) > 0);
    const estimatedAnnualHours = quantifiedMentions.reduce((sum, m) => sum + estimateAnnualHours(m), 0);
    const workarounds = [...new Set(problem.mentions.map(m => m.currentWorkaround).filter(Boolean))];
    const quotes = problem.mentions.map(m => m.directQuote).filter(Boolean);
    const confidences = [...new Set(problem.mentions.map(m => m.confidence).filter(Boolean))];

    return {
      id: problem.id,
      description: problem.description,
      estimatedAnnualHours,
      quantified: quantifiedMentions.length > 0,
      mentionCount: problem.mentions.length,
      currentWorkarounds: workarounds,
      confidence: confidences,
      supportingQuotes: quotes,
    };
  });

  ranked.sort((a, b) => b.estimatedAnnualHours - a.estimatedAnnualHours);

  const desiredCapabilities = loadDesiredCapabilities();

  const report = {
    generatedAt: new Date().toISOString(),
    problems: ranked,
    desiredCapabilities,
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportMdPath, renderBusinessCaseReportMarkdown(report));
  return report;
}

function renderBusinessCaseReportMarkdown(report) {
  const quantified = report.problems.filter(p => p.quantified);
  const unquantified = report.problems.filter(p => !p.quantified);

  const lines = [`# Business Case Report`, ``, `_Generated ${report.generatedAt}_`, ``, `## Ranked Problems (by estimated annual hours)`, ``];

  quantified.forEach((p, index) => {
    lines.push(`### ${index + 1}. ${p.description}`);
    lines.push(`- **Estimated annual hours:** ${p.estimatedAnnualHours.toFixed(1)}`);
    lines.push(`- **Mentioned:** ${p.mentionCount} time(s)`);
    lines.push(`- **Confidence:** ${p.confidence.join(', ') || 'n/a'}`);
    if (p.currentWorkarounds.length) lines.push(`- **Current workaround(s):** ${p.currentWorkarounds.join('; ')}`);
    if (p.supportingQuotes.length) lines.push(`- **Supporting quotes:**\n${p.supportingQuotes.map(q => `  > ${q}`).join('\n')}`);
    lines.push('');
  });

  if (unquantified.length) {
    lines.push(`## Not Yet Quantified`, '');
    unquantified.forEach(p => {
      lines.push(`- ${p.description} (mentioned ${p.mentionCount} time(s))`);
    });
    lines.push('');
  }

  if (report.desiredCapabilities.length) {
    lines.push(`## Desired Capabilities`, '');
    report.desiredCapabilities.forEach(c => {
      lines.push(`- ${c.description}`);
      if (c.directQuote) lines.push(`  > ${c.directQuote}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function resolveSession(sessionId) {
  if (!sessionId) return null;
  return loadSessions().find(s => s.id === sessionId) || null;
}

function updateSession(sessionId, patch) {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return null;
  Object.assign(session, patch);
  saveSessions(sessions);
  return session;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/session/start', (req, res) => {
  const { name, role, project } = req.body;

  if (!name?.trim() || !role?.trim() || !project?.trim()) {
    return res.status(400).json({ error: 'Name, role, and project are all required.' });
  }

  const session = {
    id: `session-${Date.now()}`,
    name: name.trim(),
    role: role.trim(),
    project: project.trim(),
    startedAt: new Date().toISOString(),
    testPersonaSummary: '',
    extractionStatus: 'not_started',
  };

  const sessions = loadSessions();
  sessions.push(session);
  saveSessions(sessions);

  res.json({ success: true, session });
});

app.post('/api/record/text', async (req, res) => {
  const { answer, question, sessionId, audio, source } = req.body;

  if (!answer || typeof answer !== 'string' || !answer.trim()) {
    return res.status(400).json({ error: 'No answer text provided.' });
  }

  const session = resolveSession(sessionId);

  const record = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    sessionId: session?.id ?? null,
    interviewee: session ? { name: session.name, role: session.role, project: session.project } : null,
    source: source ?? (audio ? 'voice' : 'text'),
    fileName: audio?.fileName ?? null,
    filePath: audio?.filePath ?? null,
    mimeType: audio?.mimeType ?? 'text/plain',
    sizeBytes: audio?.sizeBytes ?? Buffer.byteLength(answer, 'utf8'),
    metadata: audio?.metadata ?? {},
    question: question || null,
    transcript: answer.trim(),
    businessCase: null,
  };

  fs.appendFileSync(recordsPath, JSON.stringify(record) + '\n');
  res.json({ success: true, record });
});

app.get('/api/questions', (req, res) => {
  try {
    res.json({ questions: loadQuestions() });
  } catch (error) {
    console.error('Failed to load discovery questions', error);
    res.status(500).json({ error: 'Failed to load discovery questions.' });
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  const fileName = `record-${Date.now()}.${req.file.mimetype.includes('wav') ? 'wav' : 'webm'}`;
  const filePath = path.join(uploadsDir, fileName);

  try {
    // Archival disk write and the transcription request run concurrently —
    // transcription no longer waits on the disk write to finish first.
    const [transcript] = await Promise.all([
      transcribeAudio(req.file.buffer, fileName),
      fs.promises.writeFile(filePath, req.file.buffer),
    ]);

    res.json({
      success: true,
      transcript,
      fileName,
      filePath: `uploads/${fileName}`,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    });
  } catch (error) {
    console.error('Transcription failed', error);
    res.status(500).json({ error: `Transcription failed: ${error.message}` });
  }
});

app.post('/api/generate-transcript', async (req, res) => {
  const { question, sessionId } = req.body;

  if (!question?.text) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  const session = resolveSession(sessionId);

  try {
    const { transcript, updatedSummary } = await generateStressTestTranscript(question, session?.testPersonaSummary ?? '');
    if (session) {
      updateSession(session.id, { testPersonaSummary: updatedSummary });
    }
    res.json({ success: true, transcript });
  } catch (error) {
    console.error('Transcript generation failed', error);
    res.status(500).json({ error: `Transcript generation failed: ${error.message}` });
  }
});

app.get('/api/records', (req, res) => {
  const lines = fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

  res.json({ records: lines });
});

app.get('/api/business-case-report', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(reportJsonPath, 'utf8')));
  } catch (error) {
    res.json({ generatedAt: null, problems: [], desiredCapabilities: [] });
  }
});

app.get('/api/workflows', (req, res) => {
  res.json({ workflows: loadWorkflows() });
});

app.get('/api/sessions', (req, res) => {
  res.json({ sessions: loadSessions() });
});

app.post('/api/session/:sessionId/finalize', (req, res) => {
  const { sessionId } = req.params;
  const records = loadRecords();
  const pending = records.filter(r => r.sessionId === sessionId && r.businessCase === null);

  if (!pending.length) {
    updateSession(sessionId, { extractionStatus: 'complete' });
    return res.json({ success: true, processedCount: 0, status: 'complete' });
  }

  updateSession(sessionId, { extractionStatus: 'pending' });
  res.json({ success: true, processedCount: pending.length, status: 'pending' });

  // Runs after the response is sent — the client doesn't wait on this, it polls
  // GET /api/sessions instead to see extractionStatus flip to "complete".
  (async () => {
    for (const record of pending) {
      await applyExtractionToRecord(record);
    }
    saveAllRecords(records);
    computeBusinessCaseReport();
    updateSession(sessionId, { extractionStatus: 'complete' });
  })().catch(error => {
    console.error('Background finalize failed', error);
    updateSession(sessionId, { extractionStatus: 'complete' });
  });
});

app.post('/api/clear-all', (req, res) => {
  fs.writeFileSync(recordsPath, '');
  fs.writeFileSync(problemsPath, '[]');
  fs.writeFileSync(workflowsPath, '[]');
  fs.writeFileSync(sessionsPath, '[]');
  fs.writeFileSync(desiredCapabilitiesPath, '[]');

  if (fs.existsSync(reportJsonPath)) fs.unlinkSync(reportJsonPath);
  if (fs.existsSync(reportMdPath)) fs.unlinkSync(reportMdPath);

  for (const fileName of fs.readdirSync(uploadsDir)) {
    fs.unlinkSync(path.join(uploadsDir, fileName));
  }

  res.json({ success: true });
});

app.listen(port, () => {
  console.log(`Business Case Agent running at http://localhost:${port}`);
});

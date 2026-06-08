require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
        },
        required: ['description'],
      },
    },
    stakeholders: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
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
        description: {
          type: 'string',
          description: 'A clear written summary of the workflow in Markdown (steps, actors, triggers), or "" if present is false',
        },
      },
      required: ['present', 'description'],
    },
  },
  required: ['problems', 'stakeholders', 'risks', 'workflow'],
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

async function transcribeAudio(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1',
  });

  return transcription.text;
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
        content: `${contextLine}Extract the business details from the following transcript. Use empty strings/arrays for anything not mentioned — do not guess or invent details.\n\nTranscript:\n"""\n${transcript}\n"""`,
      },
    ],
  });

  const toolUse = message.content.find(block => block.type === 'tool_use');
  return toolUse ? toolUse.input : null;
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
const contextPath = path.join(dataDir, 'context.md');
const questionsPath = path.join(__dirname, 'discovery-questions.json');

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

if (!fs.existsSync(contextPath)) {
  fs.writeFileSync(contextPath, '# Business Workflow Context\n');
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

function mergeProblemsIntoMasterList(newProblems, matches, record) {
  const masterList = loadProblems();
  const merged = [];

  newProblems.forEach((problem, index) => {
    const matchedId = matches[index]?.matchedExistingId;
    const existing = matchedId ? masterList.find(p => p.id === matchedId) : null;

    if (existing) {
      existing.mentions.push({ recordId: record.id, recordedAt: record.createdAt });
      merged.push({ problemId: existing.id, description: existing.description, matched: true });
    } else {
      const entry = {
        id: `problem-${Date.now()}-${index}`,
        description: problem.description,
        mentions: [{ recordId: record.id, recordedAt: record.createdAt }],
      };
      masterList.push(entry);
      merged.push({ problemId: entry.id, description: entry.description, matched: false });
    }
  });

  saveProblems(masterList);
  return merged;
}

function appendWorkflowToContextFile(workflow, record) {
  const heading = `\n## Workflow — ${record.createdAt} (${record.fileName})\n\n`;
  fs.appendFileSync(contextPath, heading + workflow.description.trim() + '\n');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/record/text', async (req, res) => {
  const { answer, question } = req.body;

  if (!answer || typeof answer !== 'string' || !answer.trim()) {
    return res.status(400).json({ error: 'No answer text provided.' });
  }

  const record = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    fileName: null,
    filePath: null,
    mimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(answer, 'utf8'),
    metadata: {},
    question: question || null,
    transcript: answer.trim(),
    businessCase: null,
  };

  let extraction = null;
  try {
    extraction = await extractFromTranscript(record.transcript, question?.text);
  } catch (error) {
    console.error('Extraction failed', error);
  }

  if (extraction) {
    let problems = extraction.problems.map(p => ({ problemId: null, description: p.description, matched: false }));

    try {
      const existingProblems = loadProblems();
      const matches = await matchProblems(extraction.problems, existingProblems);
      problems = mergeProblemsIntoMasterList(extraction.problems, matches, record);
    } catch (error) {
      console.error('Problem reconciliation failed', error);
    }

    if (extraction.workflow?.present && extraction.workflow.description) {
      try {
        appendWorkflowToContextFile(extraction.workflow, record);
      } catch (error) {
        console.error('Failed to append workflow to context file', error);
      }
    }

    record.businessCase = {
      problems,
      stakeholders: extraction.stakeholders,
      risks: extraction.risks,
      workflowDetected: Boolean(extraction.workflow?.present),
    };
  }

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

app.post('/api/record', upload.single('audio'), async (req, res) => {
  const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};
  const question = req.body.question ? JSON.parse(req.body.question) : null;

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  const fileName = `record-${Date.now()}.${req.file.mimetype.includes('wav') ? 'wav' : 'webm'}`;
  const filePath = path.join(uploadsDir, fileName);

  fs.writeFileSync(filePath, req.file.buffer);

  let transcript = null;
  let extraction = null;

  try {
    transcript = await transcribeAudio(filePath);
    extraction = await extractFromTranscript(transcript, question?.text);
  } catch (error) {
    console.error('Transcription/extraction failed', error);
  }

  const record = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    fileName,
    filePath: `uploads/${fileName}`,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    metadata,
    question,
    transcript,
    businessCase: null,
  };

  if (extraction) {
    let problems = extraction.problems.map(p => ({ problemId: null, description: p.description, matched: false }));

    try {
      const existingProblems = loadProblems();
      const matches = await matchProblems(extraction.problems, existingProblems);
      problems = mergeProblemsIntoMasterList(extraction.problems, matches, record);
    } catch (error) {
      console.error('Problem reconciliation failed', error);
    }

    if (extraction.workflow?.present && extraction.workflow.description) {
      try {
        appendWorkflowToContextFile(extraction.workflow, record);
      } catch (error) {
        console.error('Failed to append workflow to context file', error);
      }
    }

    record.businessCase = {
      problems,
      stakeholders: extraction.stakeholders,
      risks: extraction.risks,
      workflowDetected: Boolean(extraction.workflow?.present),
    };
  }

  fs.appendFileSync(recordsPath, JSON.stringify(record) + '\n');

  res.json({ success: true, record });
});

app.get('/api/records', (req, res) => {
  const lines = fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

  res.json({ records: lines });
});

app.listen(port, () => {
  console.log(`Business Case Agent running at http://localhost:${port}`);
});

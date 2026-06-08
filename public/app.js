const startSessionButton = document.getElementById('startSessionButton');
const sessionSection = document.getElementById('sessionSection');
const questionProgress = document.getElementById('questionProgress');
const questionText = document.getElementById('questionText');
const answerInput = document.getElementById('answerInput');
const submitButton = document.getElementById('submitButton');
const recordButton = document.getElementById('recordButton');
const playback = document.getElementById('playback');
const statusText = document.getElementById('statusText');
const recordsList = document.getElementById('recordsList');

let mediaRecorder;
let audioChunks = [];
let activeStream;
let questions = [];
let currentQuestionIndex = -1;
let submitting = false;

// ── Rendering ──────────────────────────────────────────────────────────────

function renderBusinessCase(businessCase) {
  if (!businessCase) {
    return '<p class="case-pending">No business case extracted for this recording.</p>';
  }

  const { problems, stakeholders, risks, workflowDetected } = businessCase;

  const list = (items, render) =>
    items.length ? `<ul>${items.map(render).join('')}</ul>` : '<p class="empty">None mentioned</p>';

  return `
    <dl class="case-fields">
      <dt>Problems</dt><dd>${list(problems ?? [], p => `<li>${p.description} <span class="tag ${p.matched ? '' : 'new'}">${p.matched ? 'linked to existing' : 'new'}</span></li>`)}</dd>
      <dt>Stakeholders</dt><dd>${list(stakeholders ?? [], s => `<li>${s.name} — ${s.role}</li>`)}</dd>
      <dt>Risks</dt><dd>${list(risks ?? [], r => `<li>${r.description} (${r.severity})</li>`)}</dd>
      <dt>Workflow</dt><dd>${workflowDetected ? 'Described — see data/context.md' : '<span class="empty">Not described</span>'}</dd>
    </dl>
  `;
}

async function fetchRecords() {
  try {
    const response = await fetch('/api/records');
    const result = await response.json();
    recordsList.innerHTML = '';

    result.records.slice(-20).reverse().forEach(record => {
      const item = document.createElement('li');

      if (record.question?.text) {
        const questionLabel = document.createElement('p');
        questionLabel.className = 'record-question';
        questionLabel.textContent = `Q (${record.question.category}): ${record.question.text}`;
        item.appendChild(questionLabel);
      }

      const summary = document.createElement('div');
      summary.className = 'case-summary';
      const inputType = record.mimeType === 'text/plain' ? 'typed' : `${record.metadata?.duration?.toFixed(2) ?? 'n/a'}s · ${record.mimeType}`;
      summary.textContent = `${new Date(record.createdAt).toLocaleString()} · ${inputType}`;
      item.appendChild(summary);

      const details = document.createElement('details');
      const caseSummaryEl = document.createElement('summary');
      caseSummaryEl.textContent = record.businessCase ? 'View extracted business case' : 'No business case extracted';
      details.appendChild(caseSummaryEl);

      if (record.transcript) {
        const transcriptEl = document.createElement('p');
        transcriptEl.className = 'transcript-text';
        transcriptEl.textContent = record.transcript;
        details.appendChild(transcriptEl);
      }

      const body = document.createElement('div');
      body.innerHTML = renderBusinessCase(record.businessCase);
      details.appendChild(body);

      item.appendChild(details);
      recordsList.appendChild(item);
    });
  } catch (error) {
    console.error('Failed to load records', error);
  }
}

function updateStatus(message) {
  statusText.textContent = message;
}

// ── Session control ────────────────────────────────────────────────────────

startSessionButton.addEventListener('click', startSession);

async function startSession() {
  updateStatus('Loading discovery questions...');

  try {
    const response = await fetch('/api/questions');
    const result = await response.json();
    questions = result.questions ?? [];
  } catch (error) {
    console.error('Failed to load discovery questions', error);
    updateStatus('Could not load discovery questions.');
    return;
  }

  if (!questions.length) {
    updateStatus('No discovery questions are configured.');
    return;
  }

  currentQuestionIndex = -1;
  startSessionButton.hidden = true;
  sessionSection.hidden = false;
  showNextQuestion();
}

function showNextQuestion() {
  currentQuestionIndex += 1;

  if (currentQuestionIndex >= questions.length) {
    endSession();
    return;
  }

  submitting = false;
  const question = questions[currentQuestionIndex];
  questionProgress.textContent = `Question ${currentQuestionIndex + 1} of ${questions.length} — ${question.category}`;
  questionText.textContent = question.text;

  answerInput.value = '';
  answerInput.disabled = false;
  submitButton.disabled = false;
  submitButton.textContent = 'Submit Answer';

  recordButton.disabled = false;
  recordButton.textContent = 'Start Recording';
  playback.hidden = true;

  updateStatus('Type your answer and submit, or click "Start Recording" to answer by voice.');
}

function endSession() {
  sessionSection.hidden = true;
  startSessionButton.hidden = false;
  updateStatus('Session complete. All answers have been analyzed.');
}

function lockInputs(statusMessage) {
  submitting = true;
  answerInput.disabled = true;
  submitButton.disabled = true;
  submitButton.textContent = 'Analyzing...';
  recordButton.disabled = true;
  updateStatus(statusMessage);
}

function unlockInputs() {
  submitting = false;
  answerInput.disabled = false;
  submitButton.disabled = false;
  submitButton.textContent = 'Submit Answer';
  recordButton.disabled = false;
  recordButton.textContent = 'Start Recording';
}

// ── Typed answer ───────────────────────────────────────────────────────────

submitButton.addEventListener('click', async () => {
  const answer = answerInput.value.trim();
  if (!answer) {
    updateStatus('Please type your answer before submitting.');
    return;
  }
  if (submitting) return;

  lockInputs('Analyzing your answer...');

  try {
    const response = await fetch('/api/record/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, question: questions[currentQuestionIndex] }),
    });

    const result = await response.json();
    if (result.success) {
      await fetchRecords();
      showNextQuestion();
    } else {
      console.error(result);
      updateStatus('Submission failed. Check the console for details.');
      unlockInputs();
    }
  } catch (error) {
    console.error('Submit error', error);
    updateStatus('Submission failed due to a network error. Please try again.');
    unlockInputs();
  }
});

// ── Voice answer ───────────────────────────────────────────────────────────

recordButton.addEventListener('click', async () => {
  if (submitting) return;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    recordButton.disabled = true;
    recordButton.textContent = 'Processing...';
    updateStatus('Stopping recording...');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeStream = stream;
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      activeStream.getTracks().forEach(track => track.stop());

      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const metadata = await getAudioMetadata(blob);

      playback.src = URL.createObjectURL(blob);
      playback.hidden = false;

      lockInputs('Transcribing and analyzing your answer...');
      await uploadVoiceAnswer(blob, metadata, questions[currentQuestionIndex]);
    };

    mediaRecorder.start();
    recordButton.textContent = 'Stop Recording';
    answerInput.disabled = true;
    submitButton.disabled = true;
    updateStatus('Recording your answer...');
  } catch (error) {
    console.error('Microphone access denied or unavailable', error);
    updateStatus('Unable to access microphone. Please check permissions.');
  }
});

async function uploadVoiceAnswer(blob, metadata, question) {
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');
  formData.append('metadata', JSON.stringify(metadata));
  formData.append('question', JSON.stringify({ category: question.category, text: question.text }));

  try {
    const response = await fetch('/api/record', { method: 'POST', body: formData });
    const result = await response.json();

    if (result.success) {
      await fetchRecords();
      showNextQuestion();
    } else {
      console.error(result);
      updateStatus('Upload failed. Check the console for details.');
      unlockInputs();
    }
  } catch (error) {
    console.error('Upload error', error);
    updateStatus('Upload failed due to a network error. Please try again.');
    unlockInputs();
  }
}

async function getAudioMetadata(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    return {
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      channelCount: decoded.numberOfChannels,
      mimeType: blob.type,
      sizeBytes: blob.size,
      recordedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn('Could not decode audio metadata', error);
    return { mimeType: blob.type, sizeBytes: blob.size, recordedAt: new Date().toISOString() };
  }
}

fetchRecords();

const menuSection = document.getElementById('menuSection');
const menuStartInterviewButton = document.getElementById('menuStartInterviewButton');
const menuViewExtractButton = document.getElementById('menuViewExtractButton');
const menuViewLogsButton = document.getElementById('menuViewLogsButton');
const logsSection = document.getElementById('logsSection');
const backFromLogsButton = document.getElementById('backFromLogsButton');
const refreshLogsButton = document.getElementById('refreshLogsButton');
const logsTextarea = document.getElementById('logsTextarea');
const clearAllButton = document.getElementById('clearAllButton');
const clearAllDialog = document.getElementById('clearAllDialog');
const clearAllConfirmInput = document.getElementById('clearAllConfirmInput');
const clearAllCancelButton = document.getElementById('clearAllCancelButton');
const clearAllConfirmButton = document.getElementById('clearAllConfirmButton');
const sessionStatusSection = document.getElementById('sessionStatusSection');
const sessionStatusList = document.getElementById('sessionStatusList');
const interviewSection = document.getElementById('interviewSection');
const backFromInterviewButton = document.getElementById('backFromInterviewButton');
const dashboardSection = document.getElementById('dashboardSection');
const backFromDashboardButton = document.getElementById('backFromDashboardButton');
const dashboardNavButtons = document.querySelectorAll('.dashboard-nav-item');
const overviewPanel = document.getElementById('overviewPanel');
const problemsPanel = document.getElementById('problemsPanel');
const workflowsPanel = document.getElementById('workflowsPanel');
const capabilitiesPanel = document.getElementById('capabilitiesPanel');
const recordsPanel = document.getElementById('recordsPanel');

const intakeSection = document.getElementById('intakeSection');
const intakeName = document.getElementById('intakeName');
const intakeRole = document.getElementById('intakeRole');
const intakeProject = document.getElementById('intakeProject');
const beginSessionButton = document.getElementById('beginSessionButton');
const sessionSection = document.getElementById('sessionSection');
const questionProgress = document.getElementById('questionProgress');
const questionText = document.getElementById('questionText');
const answerInput = document.getElementById('answerInput');
const submitButton = document.getElementById('submitButton');
const recordButton = document.getElementById('recordButton');
const playback = document.getElementById('playback');
const statusText = document.getElementById('statusText');
const recordsList = document.getElementById('recordsList');
const generateTestAnswerButton = document.getElementById('generateTestAnswerButton');
const skipQuestionButton = document.getElementById('skipQuestionButton');
const endSessionButton = document.getElementById('endSessionButton');

let mediaRecorder;
let audioChunks = [];
let activeStream;
let questions = [];
let currentQuestionIndex = -1;
let submitting = false;
let sessionId = null;
let interviewee = null;
let pendingAudio = null;
let pendingSource = null;
let sessionStatusPollTimer = null;

// ── Rendering ──────────────────────────────────────────────────────────────

function renderBusinessCase(businessCase) {
  if (!businessCase) {
    return '<p class="case-pending">No business case extracted for this recording.</p>';
  }

  const { problems, stakeholders, risks, workflowDetected, evaluationIssues } = businessCase;

  const list = (items, render) =>
    items.length ? `<ul>${items.map(render).join('')}</ul>` : '<p class="empty">None mentioned</p>';

  return `
    <dl class="case-fields">
      <dt>Problems</dt><dd>${list(problems ?? [], p => `<li>${escapeHtml(p.description)} <span class="tag ${p.matched ? '' : 'new'}">${p.matched ? 'linked to existing' : 'new'}</span>${p.severity ? ` <span class="badge ${p.severity}">${escapeHtml(p.severity)}</span>` : ''}${p.rootCause ? ` — root cause: ${escapeHtml(p.rootCause)}` : ''}</li>`)}</dd>
      <dt>Stakeholders</dt><dd>${list(stakeholders ?? [], s => `<li>${escapeHtml(s.name)} — ${escapeHtml(s.role)}${s.relationshipToProblem ? ` <span class="tag">${escapeHtml(s.relationshipToProblem)}</span>` : ''}</li>`)}</dd>
      <dt>Risks</dt><dd>${list(risks ?? [], r => `<li>${escapeHtml(r.description)} <span class="badge ${r.severity}">${escapeHtml(r.severity)}</span>${r.likelihood ? ` <span class="badge">${escapeHtml(r.likelihood)} likelihood</span>` : ''}${r.linkedProblemDescription ? ` — linked to: ${escapeHtml(r.linkedProblemDescription)}` : ''}</li>`)}</dd>
      <dt>Workflow</dt><dd>${workflowDetected ? 'Described — see the Workflows view' : '<span class="empty">Not described</span>'}</dd>
      ${evaluationIssues?.length ? `<dt>Evaluation issues</dt><dd>${list(evaluationIssues, i => `<li><span class="badge ${i.issueType === 'hallucinated_quote' || i.issueType === 'hallucinated_number' ? 'high' : 'low'}">${escapeHtml(i.severity)}</span> ${escapeHtml(i.field)} — ${escapeHtml(i.explanation)}</li>`)}</dd>` : ''}
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

      if (record.interviewee) {
        const intervieweeLabel = document.createElement('p');
        intervieweeLabel.className = 'record-interviewee';
        intervieweeLabel.textContent = `${record.interviewee.name} · ${record.interviewee.role} · ${record.interviewee.project}`;
        item.appendChild(intervieweeLabel);
      }

      if (record.question?.text) {
        const questionLabel = document.createElement('p');
        questionLabel.className = 'record-question';
        questionLabel.textContent = `Q (${record.question.category}): ${record.question.text}`;
        item.appendChild(questionLabel);
      }

      const summary = document.createElement('div');
      summary.className = 'case-summary';
      const inputType = record.source === 'genai-stress-test'
        ? 'genai stress test'
        : record.mimeType === 'text/plain' ? 'typed' : `${record.metadata?.duration?.toFixed(2) ?? 'n/a'}s · ${record.mimeType}`;
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

beginSessionButton.addEventListener('click', beginSession);

async function beginSession() {
  const name = intakeName.value.trim();
  const role = intakeRole.value.trim();
  const project = intakeProject.value.trim();

  if (!name || !role || !project) {
    updateStatus('Please fill in your name, role, and current project before starting.');
    return;
  }

  beginSessionButton.disabled = true;
  updateStatus('Starting session...');

  try {
    const response = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role, project }),
    });
    const result = await response.json();

    if (!result.success) {
      console.error(result);
      updateStatus('Could not start session. Check the console for details.');
      beginSessionButton.disabled = false;
      return;
    }

    sessionId = result.session.id;
    interviewee = { name, role, project };
  } catch (error) {
    console.error('Session start error', error);
    updateStatus('Could not start session due to a network error.');
    beginSessionButton.disabled = false;
    return;
  }

  await startSession();
  beginSessionButton.disabled = false;
}

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
  intakeSection.hidden = true;
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
  pendingAudio = null;
  pendingSource = null;
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

  generateTestAnswerButton.disabled = false;
  endSessionButton.disabled = false;
  skipQuestionButton.hidden = currentQuestionIndex === questions.length - 1;
  skipQuestionButton.disabled = false;

  updateStatus('Type your answer and submit, or click "Start Recording" to answer by voice.');
}

async function endSession() {
  const finishedSessionId = sessionId;

  try {
    if (finishedSessionId) {
      // Fire-and-forget from the client's perspective — the server kicks off
      // extraction in the background and responds immediately. Progress is
      // tracked via the session status cards on the menu, not by waiting here.
      await fetch(`/api/session/${finishedSessionId}/finalize`, { method: 'POST' });
    }
  } catch (error) {
    console.error('Finalize error', error);
  }

  sessionSection.hidden = true;
  intakeSection.hidden = false;
  intakeName.value = '';
  intakeRole.value = '';
  intakeProject.value = '';
  sessionId = null;
  interviewee = null;

  showView('menu');
  updateStatus('Session complete. Extraction is running in the background — check the menu for progress.');
}

function lockInputs(statusMessage) {
  submitting = true;
  answerInput.disabled = true;
  submitButton.disabled = true;
  submitButton.textContent = 'Analyzing...';
  recordButton.disabled = true;
  generateTestAnswerButton.disabled = true;
  skipQuestionButton.disabled = true;
  endSessionButton.disabled = true;
  updateStatus(statusMessage);
}

function unlockInputs() {
  submitting = false;
  answerInput.disabled = false;
  submitButton.disabled = false;
  submitButton.textContent = 'Submit Answer';
  recordButton.disabled = false;
  recordButton.textContent = 'Start Recording';
  generateTestAnswerButton.disabled = false;
  skipQuestionButton.disabled = false;
  endSessionButton.disabled = false;
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
      body: JSON.stringify({ answer, question: questions[currentQuestionIndex], sessionId, audio: pendingAudio, source: pendingSource }),
    });

    const result = await response.json();
    if (result.success) {
      pendingAudio = null;
      pendingSource = null;
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

      lockInputs('Transcribing your answer...');
      await transcribeVoiceAnswer(blob, metadata);
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

async function transcribeVoiceAnswer(blob, metadata) {
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');

  try {
    const response = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const result = await response.json();

    if (result.success) {
      pendingAudio = {
        fileName: result.fileName,
        filePath: result.filePath,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        metadata,
      };
      answerInput.value = result.transcript;
      unlockInputs();
      answerInput.focus();
      updateStatus('Review the transcript below, edit if needed, then submit.');
    } else {
      console.error(result);
      updateStatus('Transcription failed. Check the console for details.');
      unlockInputs();
    }
  } catch (error) {
    console.error('Transcription error', error);
    updateStatus('Transcription failed due to a network error. Please try again.');
    unlockInputs();
  }
}

// ── Skip / generate test answer ─────────────────────────────────────────────

skipQuestionButton.addEventListener('click', () => {
  if (submitting) return;
  updateStatus('Skipped.');
  showNextQuestion();
});

endSessionButton.addEventListener('click', () => {
  if (submitting) return;
  endSession();
});

generateTestAnswerButton.addEventListener('click', async () => {
  if (submitting) return;

  lockInputs('Generating test answer...');

  try {
    const response = await fetch('/api/generate-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: questions[currentQuestionIndex], sessionId }),
    });
    const result = await response.json();

    if (result.success) {
      pendingSource = 'genai-stress-test';
      answerInput.value = result.transcript;
      unlockInputs();
      answerInput.focus();
      updateStatus('Generated test answer — review, edit if needed, then submit.');
    } else {
      console.error(result);
      updateStatus('Test answer generation failed. Check the console for details.');
      unlockInputs();
    }
  } catch (error) {
    console.error('Generate test answer error', error);
    updateStatus('Test answer generation failed due to a network error.');
    unlockInputs();
  }
});

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

// ── Menu / view switching ────────────────────────────────────────────────

function showView(view) {
  menuSection.hidden = view !== 'menu';
  interviewSection.hidden = view !== 'interview';
  dashboardSection.hidden = view !== 'dashboard';
  logsSection.hidden = view !== 'logs';

  if (view === 'menu') {
    renderSessionStatusCards();
  } else if (sessionStatusPollTimer) {
    clearInterval(sessionStatusPollTimer);
    sessionStatusPollTimer = null;
  }
}

menuStartInterviewButton.addEventListener('click', () => showView('interview'));
backFromInterviewButton.addEventListener('click', () => showView('menu'));

// ── Session status cards (menu) ─────────────────────────────────────────────

async function renderSessionStatusCards() {
  let sessions = [];
  try {
    const response = await fetch('/api/sessions');
    sessions = (await response.json()).sessions ?? [];
  } catch (error) {
    console.error('Failed to load sessions', error);
    return;
  }

  if (!sessions.length) {
    sessionStatusSection.hidden = true;
    return;
  }

  sessionStatusSection.hidden = false;
  sessionStatusList.innerHTML = sessions.slice(-10).reverse().map(s => {
    const status = s.extractionStatus ?? 'not_started';
    const isPending = status === 'pending';
    const badgeClass = isPending ? 'pending' : 'complete';
    const badgeText = isPending ? 'Pending' : 'Complete';
    return `
      <li class="session-status-card">
        <div class="session-status-name">${escapeHtml(s.name)} · ${escapeHtml(s.role)}</div>
        <div class="session-status-meta">${escapeHtml(s.project)} · ${new Date(s.startedAt).toLocaleString()}</div>
        <span class="session-status-badge ${badgeClass}">${isPending ? '<span class="session-status-spinner"></span>' : ''}${badgeText}</span>
      </li>
    `;
  }).join('');

  const anyPending = sessions.some(s => s.extractionStatus === 'pending');
  if (anyPending && !sessionStatusPollTimer) {
    sessionStatusPollTimer = setInterval(renderSessionStatusCards, 4000);
  } else if (!anyPending && sessionStatusPollTimer) {
    clearInterval(sessionStatusPollTimer);
    sessionStatusPollTimer = null;
  }
}

// ── Clear all data ───────────────────────────────────────────────────────

clearAllButton.addEventListener('click', () => {
  clearAllConfirmInput.value = '';
  clearAllConfirmButton.disabled = true;
  clearAllDialog.showModal();
  clearAllConfirmInput.focus();
});

clearAllConfirmInput.addEventListener('input', () => {
  clearAllConfirmButton.disabled = clearAllConfirmInput.value !== 'DELETE';
});

clearAllCancelButton.addEventListener('click', () => clearAllDialog.close());

clearAllConfirmButton.addEventListener('click', async () => {
  if (clearAllConfirmInput.value !== 'DELETE') return;

  clearAllConfirmButton.disabled = true;
  clearAllConfirmButton.textContent = 'Clearing...';

  try {
    await fetch('/api/clear-all', { method: 'POST' });
  } catch (error) {
    console.error('Clear all error', error);
  }

  clearAllConfirmButton.textContent = 'Clear All Data';
  clearAllDialog.close();
});

menuViewExtractButton.addEventListener('click', () => {
  showView('dashboard');
  loadDashboard();
});
backFromDashboardButton.addEventListener('click', () => showView('menu'));

menuViewLogsButton.addEventListener('click', () => {
  showView('logs');
  loadLogs();
});
backFromLogsButton.addEventListener('click', () => showView('menu'));
refreshLogsButton.addEventListener('click', loadLogs);

async function loadLogs() {
  logsTextarea.value = 'Loading...';
  try {
    const response = await fetch('/api/logs');
    logsTextarea.value = await response.text();
  } catch (error) {
    console.error('Failed to load logs', error);
    logsTextarea.value = 'Could not load logs due to a network error.';
  }
  logsTextarea.scrollTop = logsTextarea.scrollHeight;
}

dashboardNavButtons.forEach(button => {
  button.addEventListener('click', () => {
    dashboardNavButtons.forEach(b => b.classList.toggle('active', b === button));
    [overviewPanel, problemsPanel, workflowsPanel, capabilitiesPanel, recordsPanel].forEach(panel => {
      panel.hidden = panel.id !== `${button.dataset.panel}Panel`;
    });
  });
});

// ── Dashboard data ──────────────────────────────────────────────────────────

const escapeHtml = str => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadDashboard() {
  overviewPanel.innerHTML = '<p class="empty-panel">Loading...</p>';

  let report = { problems: [], desiredCapabilities: [] };
  let workflows = [];
  let sessions = [];

  try {
    [report, workflows, sessions] = await Promise.all([
      fetch('/api/business-case-report').then(r => r.json()),
      fetch('/api/workflows').then(r => r.json()).then(r => r.workflows ?? []),
      fetch('/api/sessions').then(r => r.json()).then(r => r.sessions ?? []),
      fetchRecords(),
    ]);
  } catch (error) {
    console.error('Failed to load dashboard data', error);
    overviewPanel.innerHTML = '<p class="empty-panel">Could not load dashboard data.</p>';
    return;
  }

  renderOverview(report, workflows, sessions);
  renderProblems(report.problems);
  renderWorkflows(workflows);
  renderCapabilities(report.desiredCapabilities);
}

function renderOverview(report, workflows, sessions) {
  const quantified = report.problems.filter(p => p.quantified);
  const totalAnnualHours = quantified.reduce((sum, p) => sum + p.estimatedAnnualHours, 0);
  const topProblem = quantified[0];

  overviewPanel.innerHTML = `
    <h2 class="panel-heading">Overview</h2>
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-card-value">${report.problems.length}</div><div class="stat-card-label">Problems tracked</div></div>
      <div class="stat-card"><div class="stat-card-value">${totalAnnualHours.toFixed(0)}</div><div class="stat-card-label">Quantified hours / year</div></div>
      <div class="stat-card"><div class="stat-card-value">${sessions.length}</div><div class="stat-card-label">Interviews conducted</div></div>
      <div class="stat-card"><div class="stat-card-value">${workflows.length}</div><div class="stat-card-label">Workflows captured</div></div>
    </div>
    ${topProblem ? `
      <div class="problem-card">
        <p class="problem-meta">Biggest opportunity by estimated annual hours</p>
        <strong>${escapeHtml(topProblem.description)}</strong>
        <p class="problem-hours"><strong>${topProblem.estimatedAnnualHours.toFixed(0)} hrs/yr</strong></p>
      </div>
    ` : '<p class="empty-panel">No quantified problems yet — keep interviewing.</p>'}
  `;
}

function renderProblems(problems) {
  if (!problems.length) {
    problemsPanel.innerHTML = '<h2 class="panel-heading">Problems</h2><p class="empty-panel">No problems extracted yet.</p>';
    return;
  }

  const cards = problems.map((p, index) => `
    <div class="problem-card">
      <div class="problem-card-header">
        <div><span class="problem-rank">#${index + 1}</span>${escapeHtml(p.description)}</div>
        <div class="problem-hours">${p.quantified ? `<strong>${p.estimatedAnnualHours.toFixed(0)} hrs/yr</strong>` : ''}</div>
      </div>
      <p class="problem-meta">
        <span class="badge ${p.severity}">${escapeHtml(p.severity)}</span>
        ${p.quantified ? '' : '<span class="badge unquantified">not yet quantified</span>'}
        ${p.confidence.map(c => `<span class="badge ${c}">${c}</span>`).join('')}
        mentioned ${p.mentionCount} time(s)
        ${p.currentWorkarounds.length ? `· current workaround: ${escapeHtml(p.currentWorkarounds.join('; '))}` : ''}
      </p>
      ${p.rootCauses?.length ? `<p class="problem-meta"><strong>Root cause(s):</strong> ${escapeHtml(p.rootCauses.join('; '))}</p>` : ''}
      ${p.impactAreas?.length ? `<p class="problem-meta"><strong>Impact area(s):</strong> ${escapeHtml(p.impactAreas.join(', '))}</p>` : ''}
      ${p.desiredFutureStates?.length ? `<p class="problem-meta"><strong>Desired future state:</strong> ${escapeHtml(p.desiredFutureStates.join('; '))}</p>` : ''}
      ${p.supportingQuotes.map(q => `<p class="problem-quote">${escapeHtml(q)}</p>`).join('')}
    </div>
  `).join('');

  problemsPanel.innerHTML = `<h2 class="panel-heading">Problems — ranked by estimated annual hours × severity</h2>${cards}`;
}

function renderWorkflows(workflows) {
  if (!workflows.length) {
    workflowsPanel.innerHTML = '<h2 class="panel-heading">Workflows</h2><p class="empty-panel">No workflows captured yet.</p>';
    return;
  }

  const cards = workflows.map(w => `
    <div class="workflow-card">
      <div class="workflow-card-header">
        <h3 class="workflow-title">${escapeHtml(w.title)}</h3>
        <span class="workflow-meta">${w.interviewee ? `${escapeHtml(w.interviewee.name)} · ${escapeHtml(w.interviewee.role)} · ${escapeHtml(w.interviewee.project)} · ` : ''}${new Date(w.recordedAt).toLocaleDateString()}</span>
      </div>
      ${w.trigger ? `<p class="workflow-trigger"><strong>Trigger:</strong> ${escapeHtml(w.trigger)}</p>` : ''}
      ${w.actors?.length ? `<div class="workflow-actors">${w.actors.map(a => `<span class="badge">${escapeHtml(a)}</span>`).join('')}</div>` : ''}
      ${w.steps?.length ? `<ol class="workflow-steps">${w.steps.map(s => {
        const isObject = typeof s === 'object' && s !== null;
        const stepText = isObject ? s.step : s;
        const owner = isObject ? s.owner : '';
        const painPoint = isObject ? s.painPoint : '';
        return `<li>${escapeHtml(stepText)}${owner ? ` <em>(${escapeHtml(owner)})</em>` : ''}${painPoint ? `<br/><span class="workflow-pain-point">Pain point: ${escapeHtml(painPoint)}</span>` : ''}</li>`;
      }).join('')}</ol>` : ''}
      ${w.duration ? `<p class="workflow-duration">Duration: ${escapeHtml(w.duration)}</p>` : ''}
      ${w.frequency ? `<p class="workflow-duration">Frequency: ${escapeHtml(w.frequency)}</p>` : ''}
    </div>
  `).join('');

  workflowsPanel.innerHTML = `<h2 class="panel-heading">Workflows</h2>${cards}`;
}

function renderCapabilities(capabilities) {
  if (!capabilities.length) {
    capabilitiesPanel.innerHTML = '<h2 class="panel-heading">Desired Capabilities</h2><p class="empty-panel">No desired capabilities captured yet.</p>';
    return;
  }

  const cards = capabilities.map(c => `
    <div class="capability-card">
      <div>${escapeHtml(c.description)}${c.priority ? ` <span class="badge ${c.priority === 'must-have' ? 'high' : ''}">${escapeHtml(c.priority)}</span>` : ''}</div>
      <p class="problem-meta">${c.interviewee ? `${escapeHtml(c.interviewee.name)} · ${escapeHtml(c.interviewee.role)} · ${escapeHtml(c.interviewee.project)} · ` : ''}${new Date(c.recordedAt).toLocaleDateString()}</p>
      ${c.linkedProblemDescription ? `<p class="problem-meta"><strong>Resolves:</strong> ${escapeHtml(c.linkedProblemDescription)}</p>` : ''}
      ${c.directQuote ? `<p class="capability-quote">${escapeHtml(c.directQuote)}</p>` : ''}
    </div>
  `).join('');

  capabilitiesPanel.innerHTML = `<h2 class="panel-heading">Desired Capabilities</h2>${cards}`;
}

renderSessionStatusCards();

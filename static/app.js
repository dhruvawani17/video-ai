/* ═══════════════════════════════════════════════════════════════════
   VitalsAI — Analysis Dashboard JavaScript
   WebSocket-based real-time vitals with Chart.js & session summary
   ═══════════════════════════════════════════════════════════════════ */

const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const videoOverlay = document.getElementById('videoOverlay');

const hrValue = document.getElementById('hrValue');
const rrValue = document.getElementById('rrValue');
const tremorValue = document.getElementById('tremorValue');
const moodValue = document.getElementById('moodValue');
const gestureValue = document.getElementById('gestureValue');
const confValue = document.getElementById('confValue');
const statusBadge = document.getElementById('statusBadge');
const conditionsList = document.getElementById('conditionsList');
const sessionTimer = document.getElementById('sessionTimer');
const timerDisplay = document.getElementById('timerDisplay');

let stream = null;
let ws = null;
let sendInterval = null;
let summaryTimer = null;
let timerInterval = null;
let sessionStartTime = null;

// Agent state
const agentStatusEl = document.getElementById('agentStatus');
const agentStatusText = document.getElementById('agentStatusText');
const agentDot = document.getElementById('agentDot');
const agentAssessmentEl = document.getElementById('agentAssessment');
const agentAssessmentText = document.getElementById('agentAssessmentText');
const startAgentBtn = document.getElementById('startAgentBtn');
const stopAgentBtn = document.getElementById('stopAgentBtn');

let agentRunning = false;

// Session Data for Summary
let sessionData = {
    hr: [],
    rr: [],
    tremor: [],
    moods: {},
    conditions: new Set()
};

// ── Chart.js Setup ──────────────────────────────────────────────
const ctxChart = document.getElementById('hrChart').getContext('2d');

// Gradient fill for chart
const chartGradient = ctxChart.createLinearGradient(0, 0, 0, 260);
chartGradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
chartGradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

const hrChart = new Chart(ctxChart, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'Heart Rate (BPM)',
            data: [],
            borderColor: '#6366f1',
            backgroundColor: chartGradient,
            tension: 0.4,
            fill: true,
            borderWidth: 2,
            pointBackgroundColor: '#6366f1',
            pointBorderColor: '#6366f1',
            pointRadius: 0,
            pointHoverRadius: 5
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: 'rgba(13, 17, 23, 0.9)',
                borderColor: 'rgba(255,255,255,0.1)',
                borderWidth: 1,
                titleColor: '#f0f2f5',
                bodyColor: '#8b95a5',
                titleFont: { family: "'Space Grotesk', sans-serif", weight: '600' },
                bodyFont: { family: "'Inter', sans-serif" },
                padding: 12,
                cornerRadius: 8,
                displayColors: false
            }
        },
        scales: {
            y: {
                min: 40,
                max: 150,
                grid: {
                    color: 'rgba(255,255,255,0.04)',
                    drawBorder: false
                },
                ticks: {
                    color: '#565f6e',
                    font: { size: 11, family: "'Inter', sans-serif" }
                },
                border: { display: false }
            },
            x: {
                grid: { display: false },
                ticks: {
                    color: '#565f6e',
                    font: { size: 11, family: "'Inter', sans-serif" },
                    maxRotation: 0
                },
                border: { display: false }
            }
        },
        interaction: {
            intersect: false,
            mode: 'index'
        },
        animation: false
    }
});

function updateChart(hr) {
    if (!hr) return;
    
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    hrChart.data.labels.push(timeStr);
    hrChart.data.datasets[0].data.push(hr);
    
    if (hrChart.data.labels.length > 40) {
        hrChart.data.labels.shift();
        hrChart.data.datasets[0].data.shift();
    }
    
    hrChart.update();
}

// ── Timer ───────────────────────────────────────────────────────
function startSessionTimer() {
    sessionStartTime = Date.now();
    sessionTimer.style.display = 'flex';
    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        timerDisplay.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopSessionTimer() {
    if (timerInterval) clearInterval(timerInterval);
    sessionTimer.style.display = 'none';
}

// ── Animated Value Update ───────────────────────────────────────
function animateValue(el, newVal) {
    el.textContent = newVal;
    el.style.color = '#6366f1';
    setTimeout(() => { el.style.color = ''; }, 500);
}

// ── Status Badge Update ─────────────────────────────────────────
function setStatus(status, label) {
    statusBadge.className = `status-badge ${status}`;
    statusBadge.querySelector('span').textContent = label;
}

// ── Camera & WebSocket ──────────────────────────────────────────
async function startCamera() {
    try {
        sessionData = {
            hr: [],
            rr: [],
            tremor: [],
            moods: {},
            conditions: new Set()
        };
        
        stream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 640, height: 480, frameRate: { ideal: 30 } } 
        });
        video.srcObject = stream;
        videoOverlay.classList.add('hidden');
        
        startBtn.disabled = true;
        stopBtn.disabled = false;
        setStatus('analyzing', 'Analyzing...');
        startSessionTimer();
        
        // 1-minute summary toast
        if (summaryTimer) clearTimeout(summaryTimer);
        summaryTimer = setTimeout(() => {
            document.getElementById('summaryToast').style.display = 'flex';
        }, 60000);
        
        connectWebSocket();
    } catch (err) {
        console.error("Error accessing webcam:", err);
        alert("Could not access webcam. Please ensure permissions are granted.");
    }
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
    
    if (ws) ws.close();
    if (sendInterval) clearInterval(sendInterval);
    if (summaryTimer) clearTimeout(summaryTimer);
    
    document.getElementById('summaryToast').style.display = 'none';
    videoOverlay.classList.remove('hidden');
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('stopped', 'Stopped');
    stopSessionTimer();
    
    showSummary();
    
    // Reset metric values
    hrValue.textContent = "--";
    rrValue.textContent = "--";
    tremorValue.textContent = "--";
    moodValue.textContent = "--";
    gestureValue.textContent = "--";
    confValue.textContent = "--";
    conditionsList.innerHTML = '<li class="waiting">Waiting for data...</li>';
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
        console.log("WebSocket connected");
        sendInterval = setInterval(sendFrame, 200);
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.error) {
            console.error(data.error);
            return;
        }

        // ── Handle agent events ─────────────────────────────────
        if (data.type === 'agent_status') {
            updateAgentStatusUI(data.status || data.agent?.status || 'unknown');
            return;
        }
        if (data.type === 'assessment') {
            showAgentAssessment(data.data);
            return;
        }
        if (data.type === 'agent_error') {
            updateAgentStatusUI('error');
            if (agentAssessmentText) agentAssessmentText.textContent = 'Error: ' + (data.error || 'Unknown error');
            return;
        }
        if (data.type === 'agent_stopped') {
            updateAgentStatusUI('stopped');
            agentRunning = false;
            if (startAgentBtn) startAgentBtn.disabled = false;
            if (stopAgentBtn) stopAgentBtn.disabled = true;
            return;
        }

        // ── Handle frame analysis data ──────────────────────────
        // Update metric values
        animateValue(hrValue, data.heart_rate_bpm || "--");
        animateValue(rrValue, data.respiratory_rate_bpm || "--");
        animateValue(tremorValue, data.tremor_index !== null ? data.tremor_index : "--");
        animateValue(moodValue, data.mood || "--");
        animateValue(gestureValue, data.gesture || "--");
        animateValue(confValue, Math.round(data.confidence * 100));
        
        // Update Status
        const statusText = (data.status || '').replace('_', ' ').toUpperCase();
        if (data.status === 'no_face_detected') {
            setStatus('no_face', statusText);
        } else if (data.status === 'elevated') {
            setStatus('elevated', statusText);
        } else {
            setStatus('analyzing', statusText);
        }

        // Update agent badge from piggy-backed status
        if (data.agent && data.agent.status) {
            updateAgentStatusUI(data.agent.status);
        }
        
        // Update Conditions
        if (data.conditions && data.conditions.length > 0) {
            conditionsList.innerHTML = '';
            data.conditions.forEach(cond => {
                const li = document.createElement('li');
                li.textContent = cond;
                if (cond.includes("No obvious")) {
                    li.className = 'safe';
                } else {
                    li.className = 'alert';
                    sessionData.conditions.add(cond);
                }
                conditionsList.appendChild(li);
            });
        }
        
        // Track session data
        if (data.heart_rate_bpm && data.heart_rate_bpm > 0) sessionData.hr.push(data.heart_rate_bpm);
        if (data.respiratory_rate_bpm && data.respiratory_rate_bpm > 0) sessionData.rr.push(data.respiratory_rate_bpm);
        if (data.tremor_index !== null && data.tremor_index > 0) sessionData.tremor.push(data.tremor_index);
        if (data.mood && data.mood !== "Unknown") {
            sessionData.moods[data.mood] = (sessionData.moods[data.mood] || 0) + 1;
        }
        
        // Update Chart
        if (data.heart_rate_bpm) {
            updateChart(data.heart_rate_bpm);
        }
    };
    
    ws.onclose = () => {
        console.log("WebSocket disconnected");
        if (startBtn.disabled) {
            setTimeout(connectWebSocket, 1000);
        }
    };
}

function sendFrame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    if (canvas.width === 0) return;
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64Frame = canvas.toDataURL('image/jpeg', 0.7);
    ws.send(base64Frame);
}

// ── Event Listeners ─────────────────────────────────────────────
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

// Toast
const showSummaryBtn = document.getElementById('showSummaryBtn');
showSummaryBtn.addEventListener('click', () => {
    document.getElementById('summaryToast').style.display = 'none';
    stopCamera();
});

// ── Modal Logic ─────────────────────────────────────────────────
const modalOverlay = document.getElementById("summaryModal");
const closeBtn = document.querySelector(".close-btn");
const downloadBtn = document.getElementById("downloadReportBtn");

closeBtn.onclick = () => { modalOverlay.classList.remove('show'); };

modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) modalOverlay.classList.remove('show');
});

function showSummary() {
    if (sessionData.hr.length === 0 && Object.keys(sessionData.moods).length === 0 && sessionData.conditions.size === 0) {
        return; // Not enough data
    }

    const avgHr = sessionData.hr.length > 0 ? sessionData.hr.reduce((a, b) => a + b, 0) / sessionData.hr.length : 0;
    const avgRr = sessionData.rr.length > 0 ? sessionData.rr.reduce((a, b) => a + b, 0) / sessionData.rr.length : 0;
    const maxTremor = sessionData.tremor.length > 0 ? Math.max(...sessionData.tremor) : 0;
    
    let domMood = "Neutral";
    let maxCount = 0;
    for (const [mood, count] of Object.entries(sessionData.moods)) {
        if (count > maxCount) {
            maxCount = count;
            domMood = mood;
        }
    }

    document.getElementById('avgHr').textContent = avgHr > 0 ? `${Math.round(avgHr)} BPM` : '-- BPM';
    document.getElementById('avgRr').textContent = avgRr > 0 ? `${Math.round(avgRr)} BPM` : '-- BPM';
    document.getElementById('maxTremor').textContent = maxTremor > 0 ? maxTremor.toFixed(3) : '--';
    document.getElementById('domMood').textContent = domMood;

    const summaryConditionsList = document.getElementById('summaryConditionsList');
    summaryConditionsList.innerHTML = '';
    
    let finalConditions = Array.from(sessionData.conditions);
    if (finalConditions.length > 1) {
        finalConditions = finalConditions.filter(c => !c.includes("No obvious"));
    }

    if (finalConditions.length === 0 || (finalConditions.length === 1 && finalConditions[0].includes("No obvious"))) {
        summaryConditionsList.innerHTML = '<li>No significant conditions detected.</li>';
    } else {
        finalConditions.forEach(cond => {
            const li = document.createElement('li');
            li.textContent = cond;
            li.style.color = '#ef4444';
            summaryConditionsList.appendChild(li);
        });
    }

    modalOverlay.classList.add('show');
}

// ── Helper: gather summary payload ──────────────────────────────
function getSummaryPayload() {
    const avgHr = sessionData.hr.length > 0 ? sessionData.hr.reduce((a, b) => a + b, 0) / sessionData.hr.length : 0;
    const avgRr = sessionData.rr.length > 0 ? sessionData.rr.reduce((a, b) => a + b, 0) / sessionData.rr.length : 0;
    const maxTremor = sessionData.tremor.length > 0 ? Math.max(...sessionData.tremor) : 0;

    let domMood = "Neutral";
    let maxCount = 0;
    for (const [mood, count] of Object.entries(sessionData.moods)) {
        if (count > maxCount) { maxCount = count; domMood = mood; }
    }

    let finalConditions = Array.from(sessionData.conditions);
    if (finalConditions.length > 1) {
        finalConditions = finalConditions.filter(c => !c.includes("No obvious"));
    }
    if (finalConditions.length === 0) finalConditions = ["No significant conditions detected."];

    const elapsed = sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    return {
        avg_hr: avgHr,
        avg_rr: avgRr,
        max_tremor: maxTremor,
        dominant_mood: domMood,
        session_duration: `${mins}m ${secs}s`,
        conditions: finalConditions
    };
}

// ── Download PDF Report ─────────────────────────────────────────
downloadBtn.onclick = async function() {
    const originalText = downloadBtn.querySelector('span').textContent;
    downloadBtn.querySelector('span').textContent = 'Generating PDF...';
    downloadBtn.disabled = true;

    try {
        const payload = getSummaryPayload();
        const response = await fetch('/api/generate-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('PDF generation failed');

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `VitalsAI_Report_${new Date().getTime()}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (err) {
        console.error('PDF download error:', err);
        alert('Failed to generate PDF. Please try again.');
    } finally {
        downloadBtn.querySelector('span').textContent = originalText;
        downloadBtn.disabled = false;
    }
};

// ── Download TXT Report (fallback) ──────────────────────────────
// ═══════════════════════════════════════════════════════════════════
//  Agent Control Functions
// ═══════════════════════════════════════════════════════════════════

function updateAgentStatusUI(status) {
    if (!agentStatusEl) return;
    agentStatusEl.style.display = 'flex';
    const labels = {
        idle: 'Agent Idle',
        starting: 'Agent Starting…',
        running: 'Agent Running',
        joining_call: 'Joining Call…',
        in_call: 'In Call',
        analyzing: 'Agent Analyzing…',
        stopping: 'Agent Stopping…',
        stopped: 'Agent Stopped',
        finished: 'Analysis Complete',
        error: 'Agent Error',
    };
    if (agentStatusText) agentStatusText.textContent = labels[status] || status;
    if (agentDot) {
        agentDot.className = 'agent-dot';
        if (status === 'running' || status === 'analyzing' || status === 'in_call') {
            agentDot.classList.add('active');
        } else if (status === 'error') {
            agentDot.classList.add('error');
        } else if (status === 'finished') {
            agentDot.classList.add('finished');
        }
    }
}

function showAgentAssessment(text) {
    if (!agentAssessmentEl || !text) return;
    agentAssessmentEl.style.display = 'block';
    agentAssessmentText.textContent = text;
}

async function startAgent() {
    if (agentRunning) return;
    try {
        // Send via WebSocket if connected
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'start_agent', call_type: 'default', call_id: 'default' }));
        } else {
            // Fallback to REST
            const res = await fetch('/api/agent/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ call_type: 'default', call_id: 'default' }),
            });
            const data = await res.json();
            updateAgentStatusUI(data.status);
        }
        agentRunning = true;
        if (startAgentBtn) startAgentBtn.disabled = true;
        if (stopAgentBtn) stopAgentBtn.disabled = false;
    } catch (err) {
        console.error('Failed to start agent:', err);
        updateAgentStatusUI('error');
    }
}

async function stopAgent() {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stop_agent' }));
        } else {
            const res = await fetch('/api/agent/stop', { method: 'POST' });
            const data = await res.json();
            updateAgentStatusUI(data.status);
        }
        agentRunning = false;
        if (startAgentBtn) startAgentBtn.disabled = false;
        if (stopAgentBtn) stopAgentBtn.disabled = true;
    } catch (err) {
        console.error('Failed to stop agent:', err);
    }
}

// Bind agent buttons
if (startAgentBtn) startAgentBtn.addEventListener('click', startAgent);
if (stopAgentBtn) stopAgentBtn.addEventListener('click', stopAgent);

// Poll agent status on page load & handle autostart
(async function initPage() {
    // Sync agent status on load
    try {
        const res = await fetch('/api/agent/status');
        const data = await res.json();
        updateAgentStatusUI(data.status);
        if (data.status === 'running') {
            agentRunning = true;
            if (startAgentBtn) startAgentBtn.disabled = true;
            if (stopAgentBtn) stopAgentBtn.disabled = false;
        }
        if (data.has_assessment) {
            const aRes = await fetch('/api/agent/assessment');
            const aData = await aRes.json();
            if (aData.assessment) showAgentAssessment(aData.assessment);
        }
    } catch (e) { /* server not ready yet */ }

    // Auto-start camera + agent if ?autostart=true is in the URL
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === 'true') {
        // Clean the URL so a refresh won't re-trigger
        window.history.replaceState({}, '', '/analysis');

        // Small delay to let the page finish rendering
        setTimeout(async () => {
            // Start the camera & WebSocket analysis
            await startCamera();

            // Also kick off the AI agent
            await startAgent();
        }, 400);
    }
})();

const downloadTxtBtn = document.getElementById('downloadTxtBtn');
if (downloadTxtBtn) {
    downloadTxtBtn.onclick = function() {
        const p = getSummaryPayload();
        const reportText = `
======================================================
           VitalsAI - SESSION REPORT
======================================================

  Date:              ${new Date().toLocaleString()}
  Session Duration:  ${p.session_duration}

------------------------------------------------------
  VITAL METRICS
------------------------------------------------------
  Average Heart Rate:       ${p.avg_hr > 0 ? Math.round(p.avg_hr) + ' BPM' : 'N/A'}
  Average Respiratory Rate: ${p.avg_rr > 0 ? Math.round(p.avg_rr) + ' BPM' : 'N/A'}
  Maximum Tremor Index:     ${p.max_tremor > 0 ? p.max_tremor.toFixed(3) : 'N/A'}
  Dominant Mood:            ${p.dominant_mood}

------------------------------------------------------
  DETECTED CONDITIONS / SYMPTOMS
------------------------------------------------------
  - ${p.conditions.join('\n  - ')}

------------------------------------------------------
  DISCLAIMER
------------------------------------------------------
  This tool is for research and educational purposes only.
  It is NOT a medical device and does NOT provide medical
  diagnosis, treatment, or advice.
        `.trim();

        const blob = new Blob([reportText], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `VitalsAI_Report_${new Date().getTime()}.txt`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    };
}

const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

const hrValue = document.getElementById('hrValue');
const rrValue = document.getElementById('rrValue');
const tremorValue = document.getElementById('tremorValue');
const moodValue = document.getElementById('moodValue');
const gestureValue = document.getElementById('gestureValue');
const confValue = document.getElementById('confValue');
const statusBadge = document.getElementById('statusBadge');
const conditionsList = document.getElementById('conditionsList');

let stream = null;
let ws = null;
let sendInterval = null;
let summaryTimer = null;

// Session Data for Summary
let sessionData = {
    hr: [],
    rr: [],
    tremor: [],
    moods: {},
    conditions: new Set()
};

// Chart.js setup
const ctxChart = document.getElementById('hrChart').getContext('2d');
const hrChart = new Chart(ctxChart, {
    type: 'line',
    data: {
        labels: [],
        datasets: [{
            label: 'Heart Rate (BPM)',
            data: [],
            borderColor: '#007bff',
            tension: 0.4,
            fill: false
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            y: {
                min: 40,
                max: 150
            }
        },
        animation: false
    }
});

function updateChart(hr) {
    if (!hr) return;
    
    const now = new Date();
    const timeStr = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
    
    hrChart.data.labels.push(timeStr);
    hrChart.data.datasets[0].data.push(hr);
    
    if (hrChart.data.labels.length > 30) {
        hrChart.data.labels.shift();
        hrChart.data.datasets[0].data.shift();
    }
    
    hrChart.update();
}

async function startCamera() {
    try {
        // Reset session data
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
        
        startBtn.disabled = true;
        stopBtn.disabled = false;
        
        // Start 1-minute timer for summary toast
        if (summaryTimer) clearTimeout(summaryTimer);
        summaryTimer = setTimeout(() => {
            document.getElementById('summaryToast').style.display = 'block';
        }, 60000); // 60 seconds
        
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
    
    if (ws) {
        ws.close();
    }
    
    if (sendInterval) {
        clearInterval(sendInterval);
    }
    
    if (summaryTimer) {
        clearTimeout(summaryTimer);
    }
    document.getElementById('summaryToast').style.display = 'none';
    
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusBadge.textContent = "Status: Stopped";
    statusBadge.className = "status-badge normal";
    
    showSummary();
    
    hrValue.textContent = "--";
    rrValue.textContent = "--";
    tremorValue.textContent = "--";
    moodValue.textContent = "--";
    gestureValue.textContent = "--";
    confValue.textContent = "--";
    conditionsList.innerHTML = "<li>Waiting for data...</li>";
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
        console.log("WebSocket connected");
        statusBadge.textContent = "Status: Analyzing...";
        
        // Send frames every 200ms
        sendInterval = setInterval(sendFrame, 200);
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.error) {
            console.error(data.error);
            return;
        }
        
        // Update UI
        hrValue.textContent = data.heart_rate_bpm || "--";
        rrValue.textContent = data.respiratory_rate_bpm || "--";
        tremorValue.textContent = data.tremor_index !== null ? data.tremor_index : "--";
        moodValue.textContent = data.mood || "--";
        gestureValue.textContent = data.gesture || "--";
        confValue.textContent = Math.round(data.confidence * 100);
        
        // Update Status
        statusBadge.textContent = `Status: ${data.status.replace('_', ' ').toUpperCase()}`;
        statusBadge.className = `status-badge ${data.status}`;
        
        // Update Conditions
        if (data.conditions && data.conditions.length > 0) {
            conditionsList.innerHTML = '';
            data.conditions.forEach(cond => {
                const li = document.createElement('li');
                li.textContent = cond;
                if (cond.includes("No obvious")) {
                    li.style.color = "#28a745"; // green
                } else {
                    li.style.color = "#dc3545"; // red
                    li.style.fontWeight = "bold";
                    sessionData.conditions.add(cond); // Track for summary
                }
                conditionsList.appendChild(li);
            });
        }
        
        // Track data for summary
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
            // Reconnect if not manually stopped
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
    
    // Compress image to base64
    const base64Frame = canvas.toDataURL('image/jpeg', 0.7);
    ws.send(base64Frame);
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

// Toast Logic
const showSummaryBtn = document.getElementById('showSummaryBtn');
showSummaryBtn.addEventListener('click', () => {
    document.getElementById('summaryToast').style.display = 'none';
    stopCamera(); // This will automatically trigger showSummary()
});

// Summary Modal Logic
const modal = document.getElementById("summaryModal");
const closeBtn = document.getElementsByClassName("close-btn")[0];
const downloadBtn = document.getElementById("downloadReportBtn");

closeBtn.onclick = function() {
    modal.style.display = "none";
}

window.onclick = function(event) {
    if (event.target == modal) {
        modal.style.display = "none";
    }
}

function showSummary() {
    // We need at least some mood or condition data to show a summary, even if vitals are missing
    if (sessionData.hr.length === 0 && Object.keys(sessionData.moods).length === 0 && sessionData.conditions.size === 0) {
        alert("Not enough data collected for a summary.");
        return;
    }

    // Calculate averages
    const avgHr = sessionData.hr.length > 0 ? sessionData.hr.reduce((a, b) => a + b, 0) / sessionData.hr.length : 0;
    const avgRr = sessionData.rr.length > 0 ? sessionData.rr.reduce((a, b) => a + b, 0) / sessionData.rr.length : 0;
    const maxTremor = sessionData.tremor.length > 0 ? Math.max(...sessionData.tremor) : 0;
    
    // Find dominant mood
    let domMood = "Neutral";
    let maxCount = 0;
    for (const [mood, count] of Object.entries(sessionData.moods)) {
        if (count > maxCount) {
            maxCount = count;
            domMood = mood;
        }
    }

    // Update Modal UI
    document.getElementById('avgHr').textContent = avgHr > 0 ? `${Math.round(avgHr)} BPM` : '-- BPM';
    document.getElementById('avgRr').textContent = avgRr > 0 ? `${Math.round(avgRr)} BPM` : '-- BPM';
    document.getElementById('maxTremor').textContent = maxTremor > 0 ? maxTremor.toFixed(3) : '--';
    document.getElementById('domMood').textContent = domMood;

    const summaryConditionsList = document.getElementById('summaryConditionsList');
    summaryConditionsList.innerHTML = '';
    
    // Filter out "No obvious symptoms detected" if there are other conditions
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
            li.style.color = "#dc3545";
            summaryConditionsList.appendChild(li);
        });
    }

    modal.style.display = "block";
}

downloadBtn.onclick = function() {
    const avgHr = sessionData.hr.length > 0 ? Math.round(sessionData.hr.reduce((a, b) => a + b, 0) / sessionData.hr.length) : 0;
    const avgRr = sessionData.rr.length > 0 ? Math.round(sessionData.rr.reduce((a, b) => a + b, 0) / sessionData.rr.length) : 0;
    const maxTremor = sessionData.tremor.length > 0 ? Math.max(...sessionData.tremor).toFixed(3) : 0;
    
    let domMood = "Neutral";
    let maxCount = 0;
    for (const [mood, count] of Object.entries(sessionData.moods)) {
        if (count > maxCount) {
            maxCount = count;
            domMood = mood;
        }
    }

    let conditionsText = "None";
    let finalConditions = Array.from(sessionData.conditions);
    if (finalConditions.length > 1) {
        finalConditions = finalConditions.filter(c => !c.includes("No obvious"));
    }
    
    if (finalConditions.length > 0 && !(finalConditions.length === 1 && finalConditions[0].includes("No obvious"))) {
        conditionsText = finalConditions.join('\n- ');
    }

    const reportText = `
REMOTE HEALTH VITALS ESTIMATOR - SESSION REPORT
Date: ${new Date().toLocaleString()}
--------------------------------------------------
Average Heart Rate: ${avgHr > 0 ? avgHr : '--'} BPM
Average Respiratory Rate: ${avgRr > 0 ? avgRr : '--'} BPM
Maximum Tremor Index: ${maxTremor > 0 ? maxTremor : '--'}
Dominant Mood: ${domMood}

Detected Conditions/Symptoms:
- ${conditionsText}

--------------------------------------------------
DISCLAIMER: This tool is for research and educational purposes only. 
It is not a medical device and does not provide medical diagnosis.
    `.trim();

    const blob = new Blob([reportText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Health_Report_${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

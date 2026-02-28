# AI medical Wellness Assistnant 🩺

**Wellness Assistnat** is a real-time, AI-powered Medical Wellness Video Assistant. It provides empathetic, non-diagnostic wellness insights by analyzing a user's physical, respiratory, and emotional markers through live video feed using multimodal AI models. 

Built with **FastAPI**, **vision-agents**, and **WebSockets**, VitalsAI acts as a proactive wellness companion, capable of observing posture, estimating breathing patterns, and providing instant, conversational voice feedback.

---

## ✨ Features

- **Real-Time Video Analysis:** Uses WebRTC and WebSockets to process live camera feeds.
- **Posture & Kinematics Assessment:** Leverages YOLOv11 (`yolo11n-pose.pt`) to detect spinal alignment, shoulder symmetry, and physical strain.
- **Multimodal AI Companion:**
  - **Vision:** Google Gemini & Ultralytics for visual reasoning and pose estimation.
  - **Speech-to-Text:** Deepgram for real-time transcription.
  - **Text-to-Speech:** ElevenLabs for a calm, clinical, and friendly voice assistant.
- **Live Dashboard:** Real-time insights displayed in a unified HTML/JS dashboard.
- **Session Reports:** Automatically generates a downloadable PDF summary of the wellness session.

## 🛠 Tech Stack

- **Backend:** FastAPI, Uvicorn, Python 3.11+
- **AI / ML:** `vision-agents` framework, YOLOv11 (PyTorch), Google GenAI, Deepgram, ElevenLabs
- **Frontend:** Vanilla JavaScript, HTML5, CSS3, Jinja2 Templates
- **Video Infrastructure:** GetStream (WebRTC)

---

## 🚀 Getting Started

### 1. Prerequisites
- **Python 3.11+**
- (Optional but recommended) `uv` - the ultra-fast Python package installer.

### 2. Environment Setup
Create a `.env` file in the root directory and add the following API keys associated with the integrated services:

```env
STREAM_API_KEY=your_getstream_api_key
STREAM_API_SECRET=your_getstream_secret
GOOGLE_API_KEY=your_gemini_api_key
DEEPGRAM_API_KEY=your_deepgram_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
```

### 3. Installation
Install the project dependencies. This project uses `pyproject.toml`.

```bash
# Using standard pip
pip install -e .

# OR using uv (recommended)
uv pip install -e .
```

### 4. Running the Local Server
Start the unified FastAPI server:

```bash
uv run python server.py
# or
python server.py
```

The server will start on `http://0.0.0.0:8000`. 
Open your browser and navigate to `http://localhost:8000` to view the landing page.

---

## 📁 Project Structure

```text
video-ai/
├── main.py                    # Core AgentManager & vision-agent logic
├── server.py                  # FastAPI application & WebSocket handlers
├── pyproject.toml             # Project metadata & dependencies
├── medical_instructions.md    # System prompt / instructions for the AI Agent
├── yolo11n-pose.pt            # YOLO pose-estimation model weights
├── static/                    # Frontend CSS & JS
│   ├── app.js                 # Client-side WebRTC and WebSocket logic
│   ├── landing.css            # Styles for the landing page
│   └── styles.css             # Main application styles
└── templates/                 # Jinja2 HTML Templates
    ├── landing.html
    ├── analysis.html
    └── report.html
```

---

## 🌍 Deployment

Since the application requires access to the user's camera (via `getUserMedia`), **it must be served over HTTPS** in production. 

A `Dockerfile` is highly recommended for deployment to environments like Google Cloud Run, AWS App Runner, or Render, as it easily handles the system dependencies required by OpenCV and PyTorch (e.g., `libgl1`).

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## ⚠️ Medical Disclaimer

**VitalsAI is NOT a medical device and does not provide medical diagnoses.** 

The assessments (posture, breathing estimations, fatigue indicators) are for general wellness observation only. It does not replace a licensed healthcare professional. 

*If you feel unwell, experience acute symptoms, or require severe medical attention, please consult a licensed healthcare professional or contact emergency services immediately.*

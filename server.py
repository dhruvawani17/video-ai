"""
VitalsAI — Unified FastAPI Server
Serves the frontend, manages the AI wellness agent, and provides real-time
communication between the dashboard and the vision-agents backend.

Run with: uv run python server.py
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import random
from datetime import datetime

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fpdf import FPDF
from pydantic import BaseModel

from main import agent_manager  # singleton AgentManager from backend

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)-22s  %(message)s")
logger = logging.getLogger("vitalsai.server")

app = FastAPI(title="VitalsAI")

# Mount static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ═══════════════════════════════════════════════════════════════════════════════
# Connected WebSocket clients — used to broadcast agent events to every open tab
# ═══════════════════════════════════════════════════════════════════════════════

_ws_clients: set[WebSocket] = set()


async def broadcast(payload: dict) -> None:
    """Push a JSON message to every connected analysis WebSocket client."""
    dead: list[WebSocket] = []
    raw = json.dumps(payload)
    for ws in _ws_clients:
        try:
            await ws.send_text(raw)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


# Register the broadcast function with the agent manager so it can push
# events (assessment results, status changes) to frontend clients.
agent_manager.set_broadcast(broadcast)


# ═══════════════════════════════════════════════════════════════════════════════
# Page Routes
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/", response_class=HTMLResponse)
async def landing(request: Request):
    """Serve the landing page."""
    return templates.TemplateResponse("landing.html", {"request": request})


@app.get("/analysis", response_class=HTMLResponse)
async def analysis(request: Request):
    """Serve the live analysis dashboard."""
    return templates.TemplateResponse("analysis.html", {"request": request})


@app.get("/report", response_class=HTMLResponse)
async def report(request: Request):
    """Post-session report page — polls for PDF readiness."""
    return templates.TemplateResponse("report.html", {"request": request})


# ═══════════════════════════════════════════════════════════════════════════════
# Agent Lifecycle API
# ═══════════════════════════════════════════════════════════════════════════════

class StartAgentRequest(BaseModel):
    call_type: str = "default"
    call_id: str = "default"


@app.post("/api/agent/start")
async def api_start_agent(body: StartAgentRequest):
    """Start the AI wellness agent and have it join the given call."""
    result = await agent_manager.start(call_type=body.call_type, call_id=body.call_id)
    return result


@app.post("/api/agent/launch")
async def api_launch_agent(body: StartAgentRequest):
    """
    Start the agent AND return the GetStream meeting join URL.
    The frontend redirects the user to this URL so they land in the
    same video call as the AI agent.
    """
    if agent_manager.status == "running" and agent_manager.join_url:
        return {"join_url": agent_manager.join_url, **agent_manager.get_status()}

    result = await agent_manager.start(call_type=body.call_type, call_id=body.call_id)
    if result.get("error"):
        return result

    # Wait for the background task to generate the join URL (with a timeout)
    try:
        await asyncio.wait_for(agent_manager._join_url_ready.wait(), timeout=30)
    except asyncio.TimeoutError:
        return {"error": "Timed out waiting for meeting URL", **agent_manager.get_status()}

    if agent_manager.join_url:
        return {"join_url": agent_manager.join_url, **agent_manager.get_status()}
    else:
        return {"error": agent_manager.error_message or "Failed to create meeting", **agent_manager.get_status()}


@app.post("/api/agent/stop")
async def api_stop_agent():
    """Gracefully stop the running agent."""
    result = await agent_manager.stop()
    return result


@app.get("/api/agent/status")
async def api_agent_status():
    """Return the current agent status."""
    return agent_manager.get_status()


@app.get("/api/agent/assessment")
async def api_agent_assessment():
    """Return the last assessment text produced by the agent (if any)."""
    return {
        "has_assessment": agent_manager.last_assessment is not None,
        "assessment": agent_manager.last_assessment,
    }


@app.get("/api/agent/report")
async def api_agent_report():
    """
    Download the auto-generated PDF report from the agent session.
    Returns 404-style JSON if no PDF is available yet.
    """
    if not agent_manager.pdf_bytes:
        return {"error": "No report available yet. The session may still be in progress."}

    buffer = io.BytesIO(agent_manager.pdf_bytes)
    buffer.seek(0)
    filename = f"VitalsAI_Report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ═══════════════════════════════════════════════════════════════════════════════
# PDF Summary Model & Endpoint
# ═══════════════════════════════════════════════════════════════════════════════

class SessionSummary(BaseModel):
    avg_hr: float = 0
    avg_rr: float = 0
    max_tremor: float = 0
    dominant_mood: str = "Neutral"
    session_duration: str = "0m 0s"
    conditions: list[str] = []


@app.post("/api/generate-pdf")
async def generate_pdf(summary: SessionSummary):
    """Generate and return a styled PDF wellness report."""
    pdf = FPDF()
    pdf.add_page()
    pw = pdf.w - pdf.l_margin - pdf.r_margin  # usable page width

    # ── Header bar ───────────────────────────────────────────────
    pdf.set_fill_color(30, 30, 46)
    pdf.rect(0, 0, 210, 42, "F")
    pdf.set_font("Helvetica", style="B", size=22)
    pdf.set_text_color(255, 255, 255)
    pdf.set_y(10)
    pdf.cell(0, 10, txt="VitalsAI  -  Wellness Report", ln=True, align="C")
    pdf.set_font("Helvetica", size=10)
    pdf.set_text_color(180, 180, 210)
    now = datetime.now().strftime("%B %d, %Y  %I:%M %p")
    pdf.cell(0, 8, txt=f"Generated: {now}   |   Duration: {summary.session_duration}", ln=True, align="C")
    pdf.ln(12)

    # ── Section helper ───────────────────────────────────────────
    def section_title(title: str):
        pdf.set_font("Helvetica", style="B", size=13)
        pdf.set_text_color(75, 75, 200)
        pdf.cell(0, 10, txt=title, ln=True)
        pdf.set_draw_color(75, 75, 200)
        pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + pw, pdf.get_y())
        pdf.ln(3)

    def metric_row(label: str, value: str):
        pdf.set_font("Helvetica", style="B", size=11)
        pdf.set_text_color(50, 50, 50)
        pdf.cell(80, 8, txt=label, ln=False)
        pdf.set_font("Helvetica", size=11)
        pdf.set_text_color(30, 30, 30)
        pdf.cell(0, 8, txt=value, ln=True)

    # ── Vital Metrics ────────────────────────────────────────────
    section_title("Vital Metrics")
    metric_row("Average Heart Rate:", f"{round(summary.avg_hr)} BPM" if summary.avg_hr > 0 else "N/A")
    metric_row("Average Respiratory Rate:", f"{round(summary.avg_rr)} BPM" if summary.avg_rr > 0 else "N/A")
    metric_row("Maximum Tremor Index:", f"{summary.max_tremor:.3f}" if summary.max_tremor > 0 else "N/A")
    metric_row("Dominant Mood:", summary.dominant_mood)
    pdf.ln(6)

    # ── Conditions ───────────────────────────────────────────────
    section_title("Detected Conditions / Symptoms")
    pdf.set_font("Helvetica", size=11)
    pdf.set_text_color(50, 50, 50)
    if not summary.conditions or (len(summary.conditions) == 1 and "No" in summary.conditions[0]):
        pdf.set_text_color(34, 139, 34)
        pdf.cell(0, 8, txt="  No significant conditions detected.", ln=True)
    else:
        for cond in summary.conditions:
            pdf.set_text_color(200, 50, 50)
            pdf.cell(6, 8, txt="", ln=False)
            pdf.set_font("Helvetica", size=11)
            safe = cond.encode("latin-1", "replace").decode("latin-1")
            pdf.cell(0, 8, txt=f"  - {safe}", ln=True)
    pdf.ln(8)

    # ── Disclaimer ───────────────────────────────────────────────
    pdf.set_fill_color(255, 248, 230)
    pdf.rect(pdf.l_margin, pdf.get_y(), pw, 22, "F")
    pdf.set_font("Helvetica", style="I", size=9)
    pdf.set_text_color(140, 110, 20)
    pdf.ln(3)
    pdf.multi_cell(pw, 5, txt=(
        "Disclaimer: This report is generated by an AI assistant for research and educational "
        "purposes only. It is NOT a medical diagnosis. If you feel unwell, please consult a "
        "licensed healthcare professional."
    ))

    # ── Output to bytes ──────────────────────────────────────────
    pdf_bytes = pdf.output()
    buffer = io.BytesIO(pdf_bytes)
    buffer.seek(0)

    filename = f"VitalsAI_Report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for real-time bidirectional communication.

    • Receives base64 video frames from the browser.
    • Returns per-frame analysis JSON (simulated for now; swap with real
      pipeline when ready).
    • Also relays any events pushed by the agent_manager (assessment text,
      status changes) so the dashboard stays in sync with the backend.
    """
    await websocket.accept()
    _ws_clients.add(websocket)
    logger.info("WebSocket client connected (%d total)", len(_ws_clients))

    frame_count = 0
    try:
        while True:
            # Receive base64 frame from the client
            data = await websocket.receive_text()

            # ── Handle JSON control messages from the frontend ───────
            if data.startswith("{"):
                try:
                    msg = json.loads(data)
                    msg_type = msg.get("type")

                    if msg_type == "start_agent":
                        result = await agent_manager.start(
                            call_type=msg.get("call_type", "default"),
                            call_id=msg.get("call_id", "default"),
                        )
                        await websocket.send_text(json.dumps({"type": "agent_status", **result}))
                        continue

                    if msg_type == "stop_agent":
                        result = await agent_manager.stop()
                        await websocket.send_text(json.dumps({"type": "agent_status", **result}))
                        continue

                    if msg_type == "get_status":
                        await websocket.send_text(json.dumps({"type": "agent_status", **agent_manager.get_status()}))
                        continue
                except json.JSONDecodeError:
                    pass  # Not JSON — treat as a frame

            frame_count += 1

            # ── Replace this block with your real analysis pipeline ──
            hr = random.randint(62, 88)
            rr = random.randint(12, 20)
            tremor = round(random.uniform(0.001, 0.05), 3)
            confidence = round(random.uniform(0.85, 0.98), 2)
            moods = ["Relaxed", "Neutral", "Focused", "Calm", "Alert"]
            gestures = ["Sitting", "Resting", "Leaning", "Upright"]

            status = "normal"
            if hr > 85:
                status = "elevated"

            conditions = ["No obvious symptoms detected."]
            if hr > 82:
                conditions = ["Slightly elevated heart rate noted."]
            if tremor > 0.04:
                conditions.append("Minor tremor detected in upper body.")

            response = {
                "type": "frame_analysis",
                "heart_rate_bpm": hr,
                "respiratory_rate_bpm": rr,
                "tremor_index": tremor,
                "mood": random.choice(moods),
                "gesture": random.choice(gestures),
                "confidence": confidence,
                "status": status,
                "conditions": conditions,
                "agent": agent_manager.get_status(),
            }
            # ── End placeholder block ────────────────────────────────

            await websocket.send_text(json.dumps(response))

    except WebSocketDisconnect:
        logger.info("Client disconnected after %d frames.", frame_count)
    finally:
        _ws_clients.discard(websocket)


if __name__ == "__main__":
    print("\n  🩺 VitalsAI server starting...")
    print("  🌐 Open http://localhost:8000 in your browser\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)

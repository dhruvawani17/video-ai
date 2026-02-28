"""
VitalsAI — AI Wellness Agent Module
Exposes AgentManager for use by the FastAPI server, and can still run standalone via CLI.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Coroutine

from dotenv import load_dotenv
from fpdf import FPDF

from vision_agents.core import Agent, AgentLauncher, User, Runner
from vision_agents.plugins import getstream, gemini, deepgram, elevenlabs, ultralytics

load_dotenv()
logger = logging.getLogger("vitalsai.agent")

# ── Load medical instructions from markdown ──────────────────────────────────
INSTRUCTIONS_PATH = Path(__file__).parent / "medical_instructions.md"
MEDICAL_INSTRUCTIONS = INSTRUCTIONS_PATH.read_text(encoding="utf-8")

# ── System prompt combining medical context ──────────────────────────────────
SYSTEM_PROMPT = f"""
{MEDICAL_INSTRUCTIONS}

## Your Capabilities

You are an AI-powered Medical Wellness Video Assistant.
You receive a live video feed of the patient along with YOLO pose-estimation
keypoints overlaid on each frame.

Using the video and pose data, perform the following analysis:

1. **Posture Assessment**
   - Detect slouching, head tilt, shoulder asymmetry.
   - Note any visible skeletal misalignment from the pose keypoints.

2. **Breathing Pattern Estimation**
   - Observe chest / shoulder rise-and-fall over 8-10 seconds.
   - Classify as: slow (<12 bpm), normal (12-20 bpm), or fast (>20 bpm).

3. **Fatigue & Stress Indicators**
   - Look for drooping eyelids, frequent yawning, pallor, or fidgeting.
   - Note any tremors or involuntary movements visible in the keypoints.

4. **Skin & Visible Symptom Observation**
   - Note any visible redness, swelling, rashes, or discoloration.
   - Flag asymmetry in facial features (possible neurological indicators).

5. **Movement & Mobility Check**
   - If the patient moves, assess gait symmetry and range of motion.
   - Flag any limping, stiffness, or guarding behavior.

## Output Format

Provide your analysis in this structure:
- **Observation Summary**: 2-3 sentence overview of what you see.
- **Posture**: rating (good / fair / poor) + details.
- **Breathing**: estimated rate category + reasoning.
- **Visible Concerns**: list any notable observations.
- **Wellness Recommendation**: one actionable suggestion.
- **Disclaimer**: "This is not a medical diagnosis. If you feel unwell, please consult a licensed healthcare professional."

Stay calm, clinical, and friendly. Use short sentences. Never claim certainty
about a diagnosis. Always end with the disclaimer.
"""


# ═══════════════════════════════════════════════════════════════════════════════
# AgentManager — manages a single agent lifecycle, callable from FastAPI
# ═══════════════════════════════════════════════════════════════════════════════

# Callback type for broadcasting events to connected WebSocket clients
BroadcastCallback = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


@dataclass
class AgentManager:
    """Thread-safe manager that wraps the vision-agents Agent lifecycle."""

    status: str = "idle"           # idle | starting | running | stopping | stopped | error
    call_id: str | None = None
    call_type: str | None = None
    last_assessment: str | None = None
    error_message: str | None = None
    join_url: str | None = None    # GetStream demo URL for the human to join
    pdf_bytes: bytes | None = field(default=None, repr=False)  # auto-generated PDF
    session_started_at: datetime | None = field(default=None, repr=False)
    _agent: Agent | None = field(default=None, repr=False)
    _task: asyncio.Task | None = field(default=None, repr=False)
    _broadcast: BroadcastCallback | None = field(default=None, repr=False)
    _join_url_ready: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    # ── public helpers ────────────────────────────────────────────

    def set_broadcast(self, cb: BroadcastCallback) -> None:
        """Register a coroutine that pushes events to frontend clients."""
        self._broadcast = cb

    def get_status(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "call_id": self.call_id,
            "call_type": self.call_type,
            "has_assessment": self.last_assessment is not None,
            "has_pdf": self.pdf_bytes is not None,
            "error": self.error_message,
            "join_url": self.join_url,
        }

    # ── lifecycle ─────────────────────────────────────────────────

    async def start(self, call_type: str, call_id: str) -> dict:
        """Create the agent and join the call as a background task."""
        if self.status == "running":
            return {"error": "Agent is already running", **self.get_status()}

        self.status = "starting"
        self.call_type = call_type
        self.call_id = call_id
        self.last_assessment = None
        self.error_message = None
        self.join_url = None
        self.pdf_bytes = None
        self.session_started_at = datetime.now()
        self._join_url_ready = asyncio.Event()

        try:
            self._agent = Agent(
                edge=getstream.Edge(),
                agent_user=User(name="Medical Wellness Assistant", id="agent"),
                instructions=SYSTEM_PROMPT,
                llm=gemini.Realtime(fps=3),
                stt=deepgram.STT(),
                tts=elevenlabs.TTS(),
                processors=[
                    ultralytics.YOLOPoseProcessor(model_path="yolo11n-pose.pt"),
                ],
            )
            self._task = asyncio.create_task(self._run())
            self.status = "running"
            logger.info("Agent started — call %s/%s", call_type, call_id)
            return self.get_status()
        except Exception as exc:
            self.status = "error"
            self.error_message = str(exc)
            logger.exception("Failed to start agent")
            return self.get_status()

    async def stop(self) -> dict:
        """Cancel the background agent task."""
        if self._task and not self._task.done():
            self.status = "stopping"
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self.status = "stopped"
        await self._emit({"type": "agent_stopped"})
        logger.info("Agent stopped")
        return self.get_status()

    # ── internal ──────────────────────────────────────────────────

    async def _emit(self, payload: dict) -> None:
        if self._broadcast:
            try:
                await self._broadcast(payload)
            except Exception:
                logger.exception("Broadcast error")

    async def _run(self) -> None:
        """Background coroutine that drives the agent through its call."""
        try:
            await self._emit({"type": "agent_status", "status": "creating_call"})

            # Create user + call and generate the demo join URL for the human
            await self._agent.create_user()
            url = await self._agent.edge.open_demo_for_agent(
                self._agent, self.call_type, self.call_id
            )
            self.join_url = url
            self._join_url_ready.set()
            logger.info("Join URL ready: %s", url)
            await self._emit({"type": "join_url", "url": url})

            await self._emit({"type": "agent_status", "status": "joining_call"})
            call = await self._agent.create_call(self.call_type, self.call_id)
            async with self._agent.join(call):
                await self._emit({"type": "agent_status", "status": "in_call"})

                # Greet
                await self._agent.simple_response(
                    "Hello! I'm your AI Wellness Assistant. "
                    "Please sit upright facing the camera. "
                    "I'll observe for a few seconds and then share my wellness feedback."
                )
                await self._emit({"type": "agent_status", "status": "analyzing"})

                # Full analysis
                assessment = await self._agent.simple_response(
                    "Please analyze the patient's posture, breathing pattern, "
                    "and any visible health indicators from the video feed. "
                    "Provide a complete wellness assessment in standard text format."
                )

                self.last_assessment = str(assessment) if assessment else None
                await self._emit({
                    "type": "assessment",
                    "data": self.last_assessment,
                })

                # Wrap-up
                await self._agent.simple_response(
                    "I have completed my assessment. "
                    "A PDF summary is being generated for you now."
                )
                await self._agent.finish()

            # ── Auto-generate PDF from the assessment ────────────
            if self.last_assessment:
                try:
                    self.pdf_bytes = self._build_pdf(self.last_assessment)
                    logger.info("PDF report generated (%d bytes)", len(self.pdf_bytes))
                    await self._emit({"type": "pdf_ready"})
                except Exception:
                    logger.exception("PDF generation failed")

            self.status = "stopped"
            await self._emit({"type": "agent_status", "status": "finished"})

        except asyncio.CancelledError:
            self.status = "stopped"
            raise
        except Exception as exc:
            self.status = "error"
            self.error_message = str(exc)
            self._join_url_ready.set()  # unblock any waiter
            logger.exception("Agent runtime error")
            await self._emit({"type": "agent_error", "error": str(exc)})


    # ── PDF builder ───────────────────────────────────────────

    def _build_pdf(self, assessment_text: str) -> bytes:
        """Build a styled PDF report from the assessment and return raw bytes."""
        pdf = FPDF()
        pdf.add_page()
        pw = pdf.w - pdf.l_margin - pdf.r_margin

        # Header bar
        pdf.set_fill_color(30, 30, 46)
        pdf.rect(0, 0, 210, 42, "F")
        pdf.set_font("Helvetica", style="B", size=22)
        pdf.set_text_color(255, 255, 255)
        pdf.set_y(10)
        pdf.cell(0, 10, txt="VitalsAI  -  Wellness Report", ln=True, align="C")
        pdf.set_font("Helvetica", size=10)
        pdf.set_text_color(180, 180, 210)
        now = datetime.now().strftime("%B %d, %Y  %I:%M %p")
        started = (
            self.session_started_at.strftime("%I:%M %p")
            if self.session_started_at
            else "--"
        )
        pdf.cell(
            0, 8,
            txt=f"Generated: {now}   |   Session started: {started}",
            ln=True, align="C",
        )
        pdf.ln(12)

        # Section helper
        def section_title(title: str):
            pdf.set_font("Helvetica", style="B", size=13)
            pdf.set_text_color(75, 75, 200)
            pdf.cell(0, 10, txt=title, ln=True)
            pdf.set_draw_color(75, 75, 200)
            pdf.line(pdf.l_margin, pdf.get_y(), pdf.l_margin + pw, pdf.get_y())
            pdf.ln(3)

        # AI Assessment section
        section_title("AI Wellness Assessment")
        pdf.set_font("Helvetica", size=11)
        pdf.set_text_color(30, 30, 30)
        safe = assessment_text.encode("latin-1", "replace").decode("latin-1")
        pdf.multi_cell(pw, 6, txt=safe)
        pdf.ln(8)

        # Disclaimer
        pdf.set_fill_color(255, 248, 230)
        pdf.rect(pdf.l_margin, pdf.get_y(), pw, 22, "F")
        pdf.set_font("Helvetica", style="I", size=9)
        pdf.set_text_color(140, 110, 20)
        pdf.ln(3)
        pdf.multi_cell(pw, 5, txt=(
            "Disclaimer: This report is generated by an AI assistant for "
            "research and educational purposes only. It is NOT a medical "
            "diagnosis. If you feel unwell, please consult a licensed "
            "healthcare professional."
        ))

        return bytes(pdf.output())


# ── Module-level singleton (imported by server.py) ────────────────────────────
agent_manager = AgentManager()


# ═══════════════════════════════════════════════════════════════════════════════
# Standalone CLI entry-point (kept for backwards-compatibility)
# ═══════════════════════════════════════════════════════════════════════════════

async def _cli_create_agent(**kwargs) -> Agent:
    return Agent(
        edge=getstream.Edge(),
        agent_user=User(name="Medical Wellness Assistant", id="agent"),
        instructions=SYSTEM_PROMPT,
        llm=gemini.Realtime(fps=3),
        stt=deepgram.STT(),
        tts=elevenlabs.TTS(),
        processors=[
            ultralytics.YOLOPoseProcessor(model_path="yolo11n-pose.pt"),
        ],
    )


async def _cli_join_call(agent: Agent, call_type: str, call_id: str, **kwargs) -> None:
    await agent.create_user()
    call = await agent.create_call(call_type, call_id)
    async with agent.join(call):
        await agent.simple_response(
            "Hello! I'm your AI Wellness Assistant. "
            "Please sit upright facing the camera. "
            "I'll observe for a few seconds and then share my wellness feedback."
        )
        assessment = await agent.simple_response(
            "Please analyze the patient's posture, breathing pattern, "
            "and any visible health indicators from the video feed. "
            "Provide a complete wellness assessment in standard text format."
        )
        await agent.simple_response(
            "I have completed my assessment."
        )
        await agent.finish()


if __name__ == "__main__":
    Runner(AgentLauncher(create_agent=_cli_create_agent, join_call=_cli_join_call)).cli()
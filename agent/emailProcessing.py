"""
Email Processing Agent — a worker for the /summarize and /agenda API.

The agent polls the e-mail API for queued summarization jobs, analyses the
e-mails each job names with Claude, submits the finished summary back onto the
job, and then rewrites today's agenda from the current inbox. It loops forever
with a 10-second pause between cycles.

One cycle:

1. `GET  /summarize`        pending jobs, oldest first
2. `GET  /emails/{id}`      the e-mails a job names
3. Claude                   summary / type / keywords / priority per e-mail
4. `POST /summarize/{id}`   submit the job's summary — takes it out of the queue
5. `GET  /emails`           the whole inbox
6. `POST /agenda`           today's plan: top e-mail ids + meeting / support notes

Per-e-mail analyses are cached by e-mail id, so an e-mail is sent to Claude once
however many jobs and agenda rebuilds mention it.

Analysis output per e-mail:
{
    "summary": "Brief summary of the email",
    "type": "request|question|issue|meeting_request|other",
    "keywords": ["keyword1", "keyword2", ...],
    "priority": "high|medium|low",
    "reasoning": "Explanation of the classification"
}

`priority` above is the agent's own judgement on a high/medium/low scale. The
API's own `priority` field is a different vocabulary — `low`/`medium`/`critical`
— and is what agenda ranking leans on first; see PRIORITY_RANK / AGENT_PRIORITY_RANK.

Usage:
    ANTHROPIC_API_KEY=sk-ant-...                 # in the repo-root .env, or the
                                                 # environment, or: ant auth login
    uvicorn app.main:app --reload --port 8000    # in ../api, first
    python emailProcessing.py                    # poll forever, every 10s
    python emailProcessing.py --once             # one cycle, then exit

Or use as a module:
    from emailProcessing import EmailAPIClient, EmailProcessor, EmailWorker
    worker = EmailWorker(EmailAPIClient("http://localhost:8000"), EmailProcessor())
    worker.run_once()
"""

import argparse
import json
import logging
import os
import time
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence

# ── Corporate TLS inspection (Zscaler, Netskope, Palo Alto, …) ────────────
# On a managed laptop, HTTPS is often intercepted and re-signed by a corporate root
# CA that lives in the OS trust store. Python doesn't read that store - it verifies
# against certifi's own bundle - so api.anthropic.com fails with
# CERTIFICATE_VERIFY_FAILED / APIConnectionError even though the API is perfectly
# reachable (curl to the same URL succeeds, because curl uses the OS store).
# truststore points Python at the OS store too. A no-op on unmanaged machines.
try:
    import truststore
    truststore.inject_into_ssl()
    print("✓ TLS: verifying against the OS certificate store")
except Exception as _tls_exc:  # Python < 3.10, or the install was blocked
    print("[!!] truststore unavailable (" + type(_tls_exc).__name__ + ") - falling back "
          "to certifi. If the API check below fails with a certificate error, see SETUP.md.")

import httpx
from anthropic import Anthropic, APIError
from dotenv import load_dotenv

# The repo-root `.env` is where the setup step puts ANTHROPIC_API_KEY. The SDK only
# reads os.environ, so without this the key in that file is invisible and the first
# Claude call dies with `TypeError: Could not resolve authentication method`.
# Searches upward from this file, so it is found whatever the working directory.
load_dotenv()

LOG = logging.getLogger("emailProcessing")

DEFAULT_API_BASE = os.environ.get("EMAIL_API_BASE", "http://localhost:8000")
DEFAULT_POLL_INTERVAL = 10.0
DEFAULT_AGENDA_SIZE = 5
DEFAULT_MODEL = "claude-sonnet-5"

# The API's own priority vocabulary (low / medium / critical) and the agent's
# (low / medium / high). Lower rank sorts first.
PRIORITY_RANK = {"critical": 0, "medium": 1, "low": 2}
AGENT_PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}

EMAIL_TYPES = ["request", "question", "issue", "meeting_request", "other"]
AGENT_PRIORITIES = ["high", "medium", "low"]

# `28-Jul-2026` parsed without strptime's %b, which follows the active locale.
MONTHS = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}


EMAIL_PROCESSOR_SYSTEM = """\
You are an Email Processing Agent. Your job is to analyze emails and provide structured output.

For each email you receive, you must:

1. **Summarize** - Create a concise 1-2 sentence summary of the email's main point
2. **Classify Type** - Determine if the email is:
   - request: Asks for something to be done or provided
   - question: Seeks information or clarification
   - issue: Reports a problem, bug, or concern
   - meeting_request: Proposes or schedules a meeting
   - other: Informational, updates, or doesn't fit above categories
3. **Extract Keywords** - Identify 3-7 key terms that capture the main topics
4. **Define Priority** - Assess urgency as:
   - high: Requires immediate attention, time-sensitive, critical
   - medium: Important but can wait, normal business priority
   - low: Informational, no rush, nice-to-have
5. **Provide Reasoning** - Explain why you classified it this way

Be objective and base your analysis on:
- Explicit urgency indicators (URGENT, ASAP, deadline dates)
- Sender's stated needs and expectations
- Impact and scope of the request/issue
- Time sensitivity mentioned in the content

Return your analysis as a JSON object with this exact structure:
{
    "summary": "string",
    "type": "request|question|issue|meeting_request|other",
    "keywords": ["array", "of", "strings"],
    "priority": "high|medium|low",
    "reasoning": "string explaining your classification"
}
"""

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "type": {"type": "string", "enum": EMAIL_TYPES},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "priority": {"type": "string", "enum": AGENT_PRIORITIES},
        "reasoning": {"type": "string"},
    },
    "required": ["summary", "type", "keywords", "priority", "reasoning"],
    "additionalProperties": False,
}


class EmailAPIError(RuntimeError):
    """The e-mail API was unreachable or answered with an error status."""


class EmailAPIClient:
    """Thin client over the routes this worker drives.

    `/summarize` and `/agenda` are the two the worker owns; `/emails` is read-only
    here — the inbox is filled by `POST /emails/import`, not by this agent.
    """

    def __init__(self, base_url: str = DEFAULT_API_BASE, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "EmailAPIClient":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    # -- plumbing ---------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._http.request(method, path, **kwargs)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise EmailAPIError(
                f"{method} {path} -> {exc.response.status_code}: {exc.response.text[:400]}"
            ) from exc
        except httpx.RequestError as exc:
            raise EmailAPIError(f"{method} {path} failed: {exc}") from exc

        if not response.content:
            return None
        return response.json()

    # -- routes -----------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        return self._request("GET", "/health")

    def list_pending_summarizations(self) -> List[Dict[str, Any]]:
        """`GET /summarize` — queued jobs whose summary is still empty."""
        return self._request("GET", "/summarize") or []

    def submit_summary(self, job_id: int, summary: str) -> Dict[str, Any]:
        """`POST /summarize/{id}` — a blank summary is a 422, so never send one."""
        return self._request("POST", f"/summarize/{job_id}", json={"summary": summary})

    def list_emails(self) -> List[Dict[str, Any]]:
        """`GET /emails` — the whole inbox, newest first."""
        return self._request("GET", "/emails") or []

    def get_email(self, email_id: int) -> Optional[Dict[str, Any]]:
        """`GET /emails/{id}`, or None when the id is unknown."""
        try:
            return self._request("GET", f"/emails/{email_id}")
        except EmailAPIError as exc:
            if "-> 404" in str(exc):
                return None
            raise

    def store_agenda(self, top_ids: Sequence[int], meeting: str, support: str) -> Dict[str, Any]:
        """`POST /agenda` — one plan per day, so this replaces today's."""
        return self._request(
            "POST",
            "/agenda",
            json={"top": list(top_ids), "meeting": meeting, "support": support},
        )


class EmailProcessor:
    """Analyses one e-mail with Claude and returns the structured verdict."""

    def __init__(self, api_key: Optional[str] = None, model: str = DEFAULT_MODEL):
        """
        Args:
            api_key: Anthropic API key. When None the SDK resolves credentials
                itself — ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
                `ant auth login` profile.
            model: Claude model id.
        """
        self.client = Anthropic(api_key=api_key) if api_key else Anthropic()
        self.model = model

    def process_email(self, email_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process an email and return structured analysis.

        Args:
            email_data: An e-mail as the API returns it (`from`, `to`, `subject`,
                `body`, and optionally `priority`, `date`, `time`).

        Returns:
            Dictionary with summary, type, keywords, priority, and reasoning
        """
        required_fields = ["from", "to", "subject", "body"]
        missing = [f for f in required_fields if f not in email_data]
        if missing:
            raise ValueError(f"Missing required fields: {missing}")

        email_text = self._format_email(email_data)

        message = self.client.messages.create(
            model=self.model,
            max_tokens=4096,  # thinking is on by default and shares this budget
            system=EMAIL_PROCESSOR_SYSTEM,
            output_config={
                "effort": "low",  # classification, not deep reasoning
                "format": {"type": "json_schema", "schema": ANALYSIS_SCHEMA},
            },
            messages=[
                {
                    "role": "user",
                    "content": f"Analyze this email and return your analysis as JSON:\n\n{email_text}",
                }
            ],
        )

        response_text = next(
            (block.text for block in message.content if block.type == "text"), ""
        )

        try:
            result = self._extract_json(response_text)
            self._validate_output(result)
            return result
        except (json.JSONDecodeError, ValueError) as e:
            raise ValueError(
                f"Failed to parse agent response as JSON: {e}\nResponse: {response_text}"
            )

    def _format_email(self, email_data: Dict[str, Any]) -> str:
        """Format email data into readable text for the agent."""
        parts = [
            f"From: {email_data['from']}",
            f"To: {email_data['to']}",
            f"Subject: {email_data['subject']}",
        ]

        if "date" in email_data:
            parts.append(f"Date: {email_data['date']}")
        if "time" in email_data:
            parts.append(f"Time: {email_data['time']}")
        if "priority" in email_data:
            parts.append(f"Inbox Priority: {email_data['priority']}")

        parts.append(f"\nBody:\n{email_data['body']}")

        return "\n".join(parts)

    def _extract_json(self, text: str) -> Dict[str, Any]:
        """Extract JSON from response text that might contain markdown code blocks.

        `output_config.format` already guarantees plain JSON; the markdown and
        brace-slicing branches are a fallback for a model that ignores it.
        """
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        if "```json" in text:
            start = text.find("```json") + 7
            end = text.find("```", start)
            if end != -1:
                return json.loads(text[start:end].strip())
        elif "```" in text:
            start = text.find("```") + 3
            end = text.find("```", start)
            if end != -1:
                return json.loads(text[start:end].strip())

        start = text.find("{")
        end = text.rfind("}") + 1
        if start != -1 and end > start:
            return json.loads(text[start:end])

        raise json.JSONDecodeError("No JSON found in response", text, 0)

    def _validate_output(self, result: Dict[str, Any]) -> None:
        """Validate the output structure."""
        required = ["summary", "type", "keywords", "priority", "reasoning"]
        missing = [f for f in required if f not in result]
        if missing:
            raise ValueError(f"Missing fields in output: {missing}")

        if result["type"] not in EMAIL_TYPES:
            raise ValueError(f"Invalid type: {result['type']}. Must be one of {EMAIL_TYPES}")

        if result["priority"] not in AGENT_PRIORITIES:
            raise ValueError(
                f"Invalid priority: {result['priority']}. Must be one of {AGENT_PRIORITIES}"
            )

        if not isinstance(result["keywords"], list):
            raise ValueError("Keywords must be an array")


def _sent_at(email: Dict[str, Any]) -> datetime:
    """`date` + `time` as one value, for ordering. Unparseable dates sort last."""
    date = str(email.get("date", ""))
    time_of_day = str(email.get("time", ""))
    try:
        day, month, year = date.split("-")
        hour, minute = time_of_day.split(":")
        return datetime(int(year), MONTHS[month.title()], int(day), int(hour), int(minute))
    except (ValueError, KeyError):
        return datetime.min


def _label(email: Dict[str, Any], analysis: Optional[Dict[str, Any]]) -> str:
    """`critical/issue` — the inbox priority plus the agent's classification."""
    priority = str(email.get("priority", "?"))
    if analysis is None:
        return priority
    return f"{priority}/{analysis['type']}"


class EmailWorker:
    """Drains the summarization queue and keeps today's agenda current."""

    def __init__(
        self,
        client: EmailAPIClient,
        processor: EmailProcessor,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        agenda_size: int = DEFAULT_AGENDA_SIZE,
    ):
        self.client = client
        self.processor = processor
        self.poll_interval = poll_interval
        self.agenda_size = agenda_size
        # Analyses are cached by e-mail id: an e-mail costs one Claude call
        # however many jobs and agenda rebuilds name it.
        self._analyses: Dict[int, Dict[str, Any]] = {}
        self._last_agenda: Optional[tuple] = None

    # -- the loop ---------------------------------------------------------

    def run_forever(self) -> None:
        """Poll for new work every `poll_interval` seconds until interrupted."""
        LOG.info(
            "Polling %s every %.0fs (agenda: top %d)",
            self.client.base_url,
            self.poll_interval,
            self.agenda_size,
        )
        while True:
            try:
                self.run_once()
            except KeyboardInterrupt:
                raise
            except (EmailAPIError, APIError) as exc:
                # The API or Claude is down or rate-limiting; the next cycle retries.
                LOG.warning("Cycle failed: %s", exc)
            except Exception:  # noqa: BLE001 - a poller must outlive one bad cycle
                LOG.exception("Unexpected error during cycle")
            time.sleep(self.poll_interval)

    def run_once(self) -> None:
        """One cycle: drain the queue, then rewrite today's agenda."""
        jobs = self.client.list_pending_summarizations()
        if jobs:
            LOG.info("%d pending summarization job(s)", len(jobs))
        for job in jobs:
            try:
                self.handle_job(job)
            except (EmailAPIError, APIError, ValueError) as exc:
                # Leave the job pending — it is still listed next cycle.
                LOG.warning("Job %s failed: %s", job.get("id"), exc)

        self.update_agenda()

    # -- queue ------------------------------------------------------------

    def handle_job(self, job: Dict[str, Any]) -> None:
        """Summarize one queued job and submit the result."""
        job_id = job["id"]
        email_ids = job.get("emailIds") or []
        LOG.info("Job %s: %d e-mail id(s) %s", job_id, len(email_ids), email_ids)

        emails: List[Dict[str, Any]] = []
        missing: List[int] = []
        for email_id in email_ids:
            email = self.client.get_email(email_id)
            if email is None:
                missing.append(email_id)
            else:
                emails.append(email)

        if not emails:
            # Ids are not checked at enqueue time, so a job can name nothing that
            # exists. Say so rather than leaving it pending forever.
            summary = f"No e-mails found for ids {missing or email_ids}."
        else:
            analysed = [(email, self.analyse(email)) for email in emails]
            summary = self._compose_summary(analysed, missing)

        self.client.submit_summary(job_id, summary)
        LOG.info("Job %s: submitted (%d chars)", job_id, len(summary))

    def analyse(self, email: Dict[str, Any]) -> Dict[str, Any]:
        """Claude's verdict on one e-mail, cached by id."""
        email_id = email["id"]
        cached = self._analyses.get(email_id)
        if cached is not None:
            return cached

        analysis = self.processor.process_email(email)
        self._analyses[email_id] = analysis
        LOG.debug(
            "Analysed e-mail %s: %s / %s", email_id, analysis["type"], analysis["priority"]
        )
        return analysis

    def _compose_summary(
        self,
        analysed: Sequence[tuple],
        missing: Sequence[int],
    ) -> str:
        """Turn per-e-mail analyses into the one string the job stores."""
        if len(analysed) == 1:
            email, analysis = analysed[0]
            lines = [
                f"{email['subject']} ({_label(email, analysis)}): {analysis['summary']}",
                f"Reasoning: {analysis['reasoning']}",
            ]
            keywords = analysis.get("keywords") or []
            if keywords:
                lines.append("Keywords: " + ", ".join(keywords))
            if missing:
                lines.append(f"Ids not in the inbox: {list(missing)}.")
            return "\n".join(lines)

        counts: Dict[str, int] = {}
        for _, analysis in analysed:
            counts[analysis["priority"]] = counts.get(analysis["priority"], 0) + 1
        breakdown = ", ".join(
            f"{counts[priority]} {priority}"
            for priority in AGENT_PRIORITIES
            if priority in counts
        )

        lines = [f"{len(analysed)} e-mails — {breakdown}."]
        ordered = sorted(
            analysed,
            key=lambda pair: AGENT_PRIORITY_RANK.get(pair[1]["priority"], 9),
        )
        for email, analysis in ordered:
            lines.append(
                f"- [{_label(email, analysis)}] {email['subject']}: {analysis['summary']}"
            )

        keywords = self._merge_keywords(analysis for _, analysis in ordered)
        if keywords:
            lines.append("Keywords: " + ", ".join(keywords))
        if missing:
            lines.append(f"Ids not in the inbox: {list(missing)}.")
        return "\n".join(lines)

    @staticmethod
    def _merge_keywords(analyses: Iterable[Dict[str, Any]], limit: int = 10) -> List[str]:
        """Keywords across several e-mails, first occurrence wins, deduped."""
        merged: Dict[str, None] = {}
        for analysis in analyses:
            for keyword in analysis.get("keywords") or []:
                merged.setdefault(str(keyword).strip(), None)
        return [keyword for keyword in merged if keyword][:limit]

    # -- agenda -----------------------------------------------------------

    def update_agenda(self) -> None:
        """Rebuild today's plan from the current inbox and store it."""
        emails = self.client.list_emails()
        if not emails:
            LOG.debug("Inbox is empty; leaving the agenda alone")
            return

        ranked = sorted(emails, key=self._agenda_key)
        top = ranked[: self.agenda_size]

        # Analyse the shortlist only — enough to write the notes, bounded cost.
        analysed = []
        for email in top:
            try:
                analysed.append((email, self.analyse(email)))
            except (APIError, ValueError) as exc:
                LOG.warning("Could not analyse e-mail %s: %s", email["id"], exc)
                analysed.append((email, None))

        top_ids = [email["id"] for email, _ in analysed]
        meeting = self._meeting_note(analysed)
        support = self._support_note(analysed)

        signature = (tuple(top_ids), meeting, support)
        if signature == self._last_agenda:
            LOG.debug("Agenda unchanged")
            return

        self.client.store_agenda(top_ids, meeting, support)
        self._last_agenda = signature
        LOG.info("Agenda updated: top %s", top_ids)

    def _agenda_key(self, email: Dict[str, Any]) -> tuple:
        """Inbox priority first, then the agent's own, then newest."""
        inbox_rank = PRIORITY_RANK.get(str(email.get("priority")), 9)
        analysis = self._analyses.get(email["id"])
        agent_rank = (
            AGENT_PRIORITY_RANK.get(analysis["priority"], 9) if analysis else inbox_rank
        )
        # A negative timedelta puts the newest first. `datetime.min.timestamp()`
        # would be the obvious spelling but raises OSError on Windows, and
        # datetime.min is exactly what an unparseable date falls back to.
        return (inbox_rank, agent_rank, datetime.min - _sent_at(email))

    def _meeting_note(self, analysed: Sequence[tuple]) -> str:
        lines = [
            f"{email['subject']} ({email['date']} {email['time']}): {analysis['summary']}"
            for email, analysis in analysed
            if analysis and analysis["type"] == "meeting_request"
        ]
        if not lines:
            return "No meeting requests among the top e-mails."
        return " | ".join(lines)

    def _support_note(self, analysed: Sequence[tuple]) -> str:
        lines = [
            f"{_label(email, analysis)} — {email['subject']}: {analysis['summary']}"
            for email, analysis in analysed
            if analysis and analysis["type"] in ("issue", "request")
        ]
        if not lines:
            return "No open issues or requests among the top e-mails."
        return " | ".join(lines)


def main():
    """Command-line interface for the email processing worker."""
    parser = argparse.ArgumentParser(
        description="Poll /summarize for queued jobs, submit summaries, keep /agenda current."
    )
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        help=f"Base URL of the e-mail API (default: {DEFAULT_API_BASE})",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_POLL_INTERVAL,
        help=f"Seconds between polls (default: {DEFAULT_POLL_INTERVAL:.0f})",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=DEFAULT_AGENDA_SIZE,
        help=f"How many e-mails the agenda lists (default: {DEFAULT_AGENDA_SIZE})",
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, help=f"Claude model id (default: {DEFAULT_MODEL})"
    )
    parser.add_argument(
        "--once", action="store_true", help="Run a single cycle and exit"
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Log every analysis and skipped agenda write"
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    with EmailAPIClient(args.api_base) as client:
        try:
            client.health()
        except EmailAPIError as exc:
            raise SystemExit(f"E-mail API not reachable at {args.api_base}: {exc}")

        worker = EmailWorker(
            client=client,
            processor=EmailProcessor(model=args.model),
            poll_interval=args.interval,
            agenda_size=args.top,
        )

        if args.once:
            worker.run_once()
            return

        try:
            worker.run_forever()
        except KeyboardInterrupt:
            LOG.info("Stopped")


if __name__ == "__main__":
    main()

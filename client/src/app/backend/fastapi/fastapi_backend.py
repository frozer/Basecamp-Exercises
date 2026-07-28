from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta
from typing import List, Optional
import re
from enum import Enum

app = FastAPI(title="Email Processing API")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Models
class PriorityLevel(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

class Email(BaseModel):
    id: str
    from_email: str
    subject: str
    body: str
    received_at: datetime
    is_meeting: bool = False

class EmailSummary(BaseModel):
    id: str
    subject: str
    from_email: str
    received_at: datetime
    preview: str
    is_meeting: bool

class SummaryResponse(BaseModel):
    top_emails: List[EmailSummary]
    top_meetings: List[EmailSummary]
    total_emails: int

class PrioritizedEmail(BaseModel):
    id: str
    subject: str
    from_email: str
    priority: PriorityLevel
    received_at: datetime
    reason: str

class PriorityResponse(BaseModel):
    high_priority: List[PrioritizedEmail]
    medium_priority: List[PrioritizedEmail]
    low_priority: List[PrioritizedEmail]

# Mock email data
MOCK_EMAILS = [
    Email(
        id="1",
        from_email="john.smith@company.com",
        subject="Urgent: Project Deadline Update",
        body="The project deadline has been moved up to next Friday. Please review the updated timeline and confirm your availability.",
        received_at=datetime.now() - timedelta(hours=2),
        is_meeting=False
    ),
    Email(
        id="2",
        from_email="meeting.scheduler@calendar.com",
        subject="Meeting: Q3 Planning Session",
        body="You are invited to Q3 Planning Session. Tuesday 2:00 PM - 3:30 PM. Location: Conference Room A.",
        received_at=datetime.now() - timedelta(hours=5),
        is_meeting=True
    ),
    Email(
        id="3",
        from_email="manager@company.com",
        subject="Performance Review Feedback",
        body="Here is your performance review for this quarter. Overall performance has been excellent. Please review and schedule a follow-up discussion.",
        received_at=datetime.now() - timedelta(hours=8),
        is_meeting=False
    ),
    Email(
        id="4",
        from_email="client@external.com",
        subject="Meeting: Client Presentation",
        body="Can we schedule a meeting for client presentation? Preferred time: Thursday 10:00 AM.",
        received_at=datetime.now() - timedelta(hours=12),
        is_meeting=True
    ),
    Email(
        id="5",
        from_email="team@company.com",
        subject="Weekly Status Update",
        body="Please submit your weekly status report by EOD today. Include completed tasks and blockers.",
        received_at=datetime.now() - timedelta(hours=24),
        is_meeting=False
    ),
    Email(
        id="6",
        from_email="notifications@service.com",
        subject="System Maintenance Notification",
        body="Scheduled maintenance will occur on Sunday 2-4 AM. Services may be unavailable during this time.",
        received_at=datetime.now() - timedelta(days=2),
        is_meeting=False
    ),
]

# Helper functions
def detect_priority(email: Email) -> PriorityLevel:
    """Detect email priority based on subject and content."""
    urgent_keywords = ['urgent', 'asap', 'critical', 'deadline', 'important', 'action required']
    priority_keywords = ['meeting', 'review', 'feedback', 'update', 'status']

    text = (email.subject + " " + email.body).lower()

    for keyword in urgent_keywords:
        if keyword in text:
            return PriorityLevel.HIGH

    for keyword in priority_keywords:
        if keyword in text:
            return PriorityLevel.MEDIUM

    return PriorityLevel.LOW

def is_meeting_email(email: Email) -> bool:
    """Detect if email is about a meeting."""
    meeting_keywords = ['meeting', 'conference', 'calendar', 'invite', 'schedule', 'session']
    text = (email.subject + " " + email.body).lower()
    return any(keyword in text for keyword in meeting_keywords)

def get_email_preview(body: str, length: int = 100) -> str:
    """Extract preview from email body."""
    text = body.replace('\n', ' ').strip()
    return text[:length] + "..." if len(text) > length else text

@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}

@app.post("/emails/summarize")
def summarize_emails(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """
    Get summarized view of emails.

    Args:
        start_date: ISO format date string (e.g., 2026-07-28)
        end_date: ISO format date string
    """
    try:
        # Filter emails by date range
        filtered_emails = MOCK_EMAILS

        if start_date:
            start = datetime.fromisoformat(start_date)
            filtered_emails = [e for e in filtered_emails if e.received_at >= start]

        if end_date:
            end = datetime.fromisoformat(end_date)
            filtered_emails = [e for e in filtered_emails if e.received_at <= end]

        # Separate emails and meetings
        regular_emails = [e for e in filtered_emails if not is_meeting_email(e)]
        meetings = [e for e in filtered_emails if is_meeting_email(e)]

        # Get top 3 of each
        top_emails = [
            EmailSummary(
                id=e.id,
                subject=e.subject,
                from_email=e.from_email,
                received_at=e.received_at,
                preview=get_email_preview(e.body),
                is_meeting=False
            )
            for e in sorted(regular_emails, key=lambda x: x.received_at, reverse=True)[:3]
        ]

        top_meetings = [
            EmailSummary(
                id=e.id,
                subject=e.subject,
                from_email=e.from_email,
                received_at=e.received_at,
                preview=get_email_preview(e.body),
                is_meeting=True
            )
            for e in sorted(meetings, key=lambda x: x.received_at, reverse=True)[:3]
        ]

        return SummaryResponse(
            top_emails=top_emails,
            top_meetings=top_meetings,
            total_emails=len(filtered_emails)
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {str(e)}")

@app.post("/emails/prioritize")
def prioritize_emails(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """
    Get emails organized by priority level.

    Args:
        start_date: ISO format date string
        end_date: ISO format date string
    """
    try:
        # Filter emails by date range
        filtered_emails = MOCK_EMAILS

        if start_date:
            start = datetime.fromisoformat(start_date)
            filtered_emails = [e for e in filtered_emails if e.received_at >= start]

        if end_date:
            end = datetime.fromisoformat(end_date)
            filtered_emails = [e for e in filtered_emails if e.received_at <= end]

        # Categorize by priority
        high_priority = []
        medium_priority = []
        low_priority = []

        priority_keywords = {
            'urgent': 'Contains urgent keyword',
            'deadline': 'Deadline mentioned',
            'action required': 'Action required',
            'meeting': 'Meeting scheduled',
            'review': 'Review requested',
            'update': 'Status update'
        }

        for email in filtered_emails:
            priority = detect_priority(email)
            text = (email.subject + " " + email.body).lower()

            # Find reason
            reason = "Standard email"
            for keyword, desc in priority_keywords.items():
                if keyword in text:
                    reason = desc
                    break

            prioritized = PrioritizedEmail(
                id=email.id,
                subject=email.subject,
                from_email=email.from_email,
                priority=priority,
                received_at=email.received_at,
                reason=reason
            )

            if priority == PriorityLevel.HIGH:
                high_priority.append(prioritized)
            elif priority == PriorityLevel.MEDIUM:
                medium_priority.append(prioritized)
            else:
                low_priority.append(prioritized)

        return PriorityResponse(
            high_priority=sorted(high_priority, key=lambda x: x.received_at, reverse=True),
            medium_priority=sorted(medium_priority, key=lambda x: x.received_at, reverse=True),
            low_priority=sorted(low_priority, key=lambda x: x.received_at, reverse=True)
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

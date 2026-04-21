#!/usr/bin/env python3
"""
Skill: email-draft
Draft a professional email from a brief description.
Usage: /run email-draft {"to": "name@example.com", "subject": "...", "context": "..."}

Args (via SKILL_ARGS env or stdin):
  to       - recipient email
  subject  - email subject
  context  - brief description of what the email should say
  tone     - (optional) "professional" | "casual" | "formal" (default: professional)
"""

import json
import os
import sys

args = {}
try:
    raw = os.environ.get("SKILL_ARGS") or sys.stdin.read()
    args = json.loads(raw) if raw.strip() else {}
except Exception:
    pass

to = args.get("to", "recipient@example.com")
subject = args.get("subject", "(no subject)")
context = args.get("context", "")
tone = args.get("tone", "professional")

if not context:
    print("Error: 'context' is required. Example: {\"context\": \"follow up on our meeting about Q2 budget\"}")
    sys.exit(1)

template = f"""To: {to}
Subject: {subject}

---DRAFT---

Dear [Name],

[This is a draft — replace with your actual email content based on context below]

Context provided: {context}
Tone: {tone}

Suggested opening:
- If professional: "I hope this message finds you well."
- If casual: "Hope you're doing great!"
- If formal: "I am writing to..."

Key points to cover:
{context}

Suggested closing:
- "Best regards,"
- "Looking forward to your response,"
- "Thank you for your time,"

[Your name]
---END DRAFT---

Note: This is a structural template. Use /run email-draft with an ANTHROPIC_API_KEY
configured to get AI-generated draft content.
"""

print(template)

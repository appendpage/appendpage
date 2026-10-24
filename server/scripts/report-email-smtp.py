"""Deliver a moderation count and queue link through Gmail SMTP over TLS."""

import json
import os
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate


def build_message(payload, user, recipient):
    # Addresses come exclusively from protected operator configuration.
    for address in (user, recipient):
        if not re.fullmatch(r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+", address):
            raise ValueError("Invalid configured email address")
    count, posts = payload["count"], payload["posts"]
    if type(count) is not int or type(posts) is not int or not 1 <= posts <= count <= 500:
        raise ValueError("Invalid report counts")
    message_id = payload["message_id"]
    if not re.fullmatch(r"<appendpage-reports-[a-f0-9]{64}@append\.page>", message_id):
        raise ValueError("Invalid message ID")
    message = EmailMessage()
    message["From"] = user
    message["To"] = recipient
    message["Subject"] = f"[append.page] {count} new moderation report{'s' if count != 1 else ''}"
    message["Message-ID"] = message_id
    message["Date"] = formatdate(localtime=False)
    message.set_content(
        f"{count} new report{'s' if count != 1 else ''} on {posts} post{'s' if posts != 1 else ''} "
        f"{'await' if count != 1 else 'awaits'} your review.\n\n"
        "Review reports: https://append.page/admin\n\n"
        "Report details stay in the private moderation queue.\n"
    )
    return message


def send(payload):
    user = os.environ.get("REPORT_EMAIL_USER", "").strip()
    recipient = os.environ.get("REPORT_EMAIL_TO", "").strip()
    password = os.environ.get("GOOGLE_APP_PASSWORD", "").replace(" ", "").strip()
    if not password:
        raise ValueError("Missing mail credential")
    message = build_message(payload, user, recipient)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20, context=ssl.create_default_context()) as smtp:
        smtp.login(user, password)
        smtp.send_message(message, from_addr=user, to_addrs=[recipient])


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(2049)
        if len(raw) > 2048:
            raise ValueError("Oversized payload")
        send(json.loads(raw))
    except Exception:
        # SMTP errors can contain account details; do not log them.
        print("report_email_transport_failed", file=sys.stderr)
        sys.exit(1)

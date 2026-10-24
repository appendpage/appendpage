import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location("report_email_smtp", Path(__file__).parents[1] / "scripts/report-email-smtp.py")
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class ReportEmailTest(unittest.TestCase):
    def setUp(self):
        self.payload = {"count": 2, "posts": 1, "message_id": "<appendpage-reports-" + "a" * 64 + "@append.page>"}

    def test_fixed_message_ignores_untrusted_extra_text(self):
        self.payload["details"] = "PRIVATE REPORT TEXT"
        message = mail.build_message(self.payload, "sender@example.com", "operator@example.com")
        self.assertEqual(message["Subject"], "[append.page] 2 new moderation reports")
        self.assertIn("https://append.page/admin", message.get_content())
        self.assertNotIn("PRIVATE REPORT TEXT", message.as_string())

    def test_rejects_header_injection_and_invalid_counts(self):
        with self.assertRaises(ValueError):
            mail.build_message(self.payload, "sender@example.com\nBcc:other@example.com", "operator@example.com")
        self.payload["count"] = True
        with self.assertRaises(ValueError):
            mail.build_message(self.payload, "sender@example.com", "operator@example.com")

    def test_transport_uses_tls_and_explicit_recipient(self):
        smtp = MagicMock()
        with patch.dict(mail.os.environ, {"REPORT_EMAIL_USER": "sender@example.com", "REPORT_EMAIL_TO": "operator@example.com", "GOOGLE_APP_PASSWORD": "test only"}), patch.object(mail.smtplib, "SMTP_SSL", return_value=smtp) as transport:
            mail.send(self.payload)
            self.assertEqual(transport.call_args.args, ("smtp.gmail.com", 465))
            self.assertTrue(transport.call_args.kwargs["context"].check_hostname)
            smtp.__enter__.return_value.login.assert_called_once_with("sender@example.com", "testonly")
            self.assertEqual(smtp.__enter__.return_value.send_message.call_args.kwargs["to_addrs"], ["operator@example.com"])


if __name__ == "__main__":
    unittest.main()

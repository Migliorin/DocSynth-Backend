import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from docsynth_ocr_worker.worker import GenerationCancelled, SUMMARY_TTL, generate_summary, publish_event


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def __iter__(self):
        return iter(self.chunks)


class SummaryStreamTest(unittest.TestCase):
    def test_reasoning_precedes_visible_deltas_without_becoming_summary(self):
        def chunk(content=None, reasoning=None):
            delta = SimpleNamespace(content=content, reasoning_content=reasoning)
            return SimpleNamespace(choices=[SimpleNamespace(delta=delta)])

        client = Mock()
        client.chat.completions.create.return_value = FakeStream([
            chunk(reasoning="private thought"),
            chunk(reasoning="more thought"),
            SimpleNamespace(choices=[]),
            chunk(content="Olá"),
            chunk(content=", mundo!"),
        ])
        job = {"documentId": "test-document", "type": "PUR", "topics": ["Resumo"]}
        events = []

        result = generate_summary("conteúdo", job, client, "test-model", lambda *event: events.append(event))

        self.assertEqual(result, "Olá, mundo!")
        self.assertEqual(events, [("reasoning",), ("summary_delta", "Olá"), ("summary_delta", ", mundo!")])
        self.assertTrue(client.chat.completions.create.call_args.kwargs["stream"])

    def test_bonsai_summary_disables_hidden_thinking(self):
        client = Mock()
        delta = SimpleNamespace(content="Resumo", reasoning_content=None)
        client.chat.completions.create.return_value = FakeStream([SimpleNamespace(choices=[SimpleNamespace(delta=delta)])])
        job = {"documentId": "test-document", "type": "PUR", "topics": ["Resumo"]}

        generate_summary("conteúdo", job, client, "ternary-bonsai-27B", lambda *_: None)

        self.assertEqual(
            client.chat.completions.create.call_args.kwargs["extra_body"],
            {"return_progress": True, "chat_template_kwargs": {"enable_thinking": False}},
        )

    def test_reports_prompt_processing_percentage_before_text(self):
        client = Mock()
        client.chat.completions.create.return_value = FakeStream([
            SimpleNamespace(prompt_progress={"total": 100, "cache": 0, "processed": 0}, choices=[]),
            SimpleNamespace(prompt_progress={"total": 100, "cache": 0, "processed": 22}, choices=[]),
            SimpleNamespace(prompt_progress={"total": 100, "cache": 0, "processed": 22}, choices=[]),
            SimpleNamespace(prompt_progress={"total": 100, "cache": 0, "processed": 100}, choices=[]),
            SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Pronto", reasoning_content=None))]),
        ])
        job = {"documentId": "test-document", "type": "PUR", "topics": ["Resumo"]}
        events = []

        generate_summary("conteúdo", job, client, "test-model", lambda *event: events.append(event))

        self.assertEqual(events, [
            ("prompt_progress", 0),
            ("prompt_progress", 22),
            ("prompt_progress", 100),
            ("summary_delta", "Pronto"),
        ])
        self.assertTrue(client.chat.completions.create.call_args.kwargs["extra_body"]["return_progress"])

    def test_cancellation_closes_upstream_before_next_delta(self):
        client = Mock()
        def chunk(content):
            return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content, reasoning_content=None))])
        stream = FakeStream([chunk("Primeiro"), chunk("Segundo")])
        client.chat.completions.create.return_value = stream
        job = {"documentId": "test-document", "type": "PUR", "topics": ["Resumo"]}
        events = []

        with self.assertRaises(GenerationCancelled):
            generate_summary("conteúdo", job, client, "test-model", lambda *event: events.append(event), lambda: bool(events))

        self.assertEqual(events, [("summary_delta", "Primeiro")])
        self.assertTrue(stream.closed)

    def test_cancelled_queued_summary_never_calls_model(self):
        client = Mock()
        job = {"documentId": "test-document", "type": "PUR", "topics": ["Resumo"]}

        with self.assertRaises(GenerationCancelled):
            generate_summary("conteúdo", job, client, "test-model", lambda *_: None, lambda: True)

        client.chat.completions.create.assert_not_called()

    def test_cancelled_preview_keeps_progress_long_enough_to_reload(self):
        queue = Mock()
        queue.incr.return_value = 2

        publish_event(queue, "test-document", {"kind": "status", "status": "CANCELLED"})

        self.assertEqual(queue.set.call_args.kwargs["ex"], SUMMARY_TTL)


if __name__ == "__main__":
    unittest.main()

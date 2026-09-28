import json
import unittest

from lambda_function import lambda_handler


class PythonExampleTests(unittest.TestCase):
    def test_echoes_a_valid_message(self):
        response = lambda_handler(
            {
                "version": "2.0",
                "body": json.dumps({"message": "hello"}),
                "isBase64Encoded": False,
            },
            None,
        )

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(
            json.loads(response["body"]),
            {"ok": True, "language": "python", "message": "hello"},
        )

    def test_rejects_invalid_payloads(self):
        response = lambda_handler(
            {"body": json.dumps({"message": 42}), "isBase64Encoded": False},
            None,
        )
        self.assertEqual(response["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()

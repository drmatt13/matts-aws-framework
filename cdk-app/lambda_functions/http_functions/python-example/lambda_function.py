import base64
import json
from pathlib import Path
from typing import Any


CONTRACT = json.loads(
    Path(__file__).with_name("contract.schema.json").read_text(encoding="utf-8")
)


def _response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(payload),
    }


def _decode_body(event: dict[str, Any]) -> Any:
    body = event.get("body")
    if not isinstance(body, str):
        return body
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body)


def _matches_object_schema(value: Any, schema: dict[str, Any]) -> bool:
    if not isinstance(value, dict):
        return False
    required = schema.get("required", [])
    if any(key not in value for key in required):
        return False
    if schema.get("additionalProperties") is False:
        if any(key not in schema.get("properties", {}) for key in value):
            return False
    for key, property_schema in schema.get("properties", {}).items():
        if key not in value:
            continue
        if property_schema.get("type") == "string" and not isinstance(value[key], str):
            return False
        if "const" in property_schema and value[key] != property_schema["const"]:
            return False
    return True


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    try:
        request = _decode_body(event)
    except (ValueError, UnicodeDecodeError):
        return _response(400, {"error": "Request body must be valid JSON"})

    if not _matches_object_schema(request, CONTRACT["request"]):
        return _response(400, {"error": "Expected a JSON body containing only a string message"})

    response = {
        "ok": True,
        "language": "python",
        "message": request["message"],
    }
    if not _matches_object_schema(response, CONTRACT["response"]):
        raise RuntimeError("Python example response does not match its contract")

    return _response(200, response)

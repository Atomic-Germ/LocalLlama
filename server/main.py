from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
CONV_DIR = DATA_DIR / "conversations"
INDEX_PATH = DATA_DIR / "conversations.json"

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_API_BASE = f"{OLLAMA_BASE_URL}/api"

app = FastAPI()


@app.on_event("startup")
async def _ensure_data_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONV_DIR.mkdir(parents=True, exist_ok=True)
    if not INDEX_PATH.exists():
        INDEX_PATH.write_text("[]", encoding="utf-8")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


async def _ollama_get(path: str) -> Dict[str, Any]:
    url = f"{OLLAMA_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(url)
        if response.status_code >= 400:
            raise HTTPException(response.status_code, response.text)
        return response.json()


async def _ollama_post_json(path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    url = f"{OLLAMA_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(url, json=payload)
        if response.status_code >= 400:
            raise HTTPException(response.status_code, response.text)
        return response.json()


async def _ollama_stream(path: str, payload: Dict[str, Any]) -> AsyncGenerator[bytes, None]:
    url = f"{OLLAMA_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, json=payload) as response:
            if response.status_code >= 400:
                detail = await response.aread()
                raise HTTPException(response.status_code, detail.decode("utf-8", "ignore"))
            async for line in response.aiter_lines():
                if not line:
                    continue
                yield (line + "\n").encode("utf-8")


def _load_index() -> List[Dict[str, Any]]:
    try:
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def _save_index(items: List[Dict[str, Any]]) -> None:
    INDEX_PATH.write_text(json.dumps(items, indent=2), encoding="utf-8")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conversation_path(conv_id: str) -> Path:
    return CONV_DIR / f"{conv_id}.json"


def _load_conversation(conv_id: str) -> Optional[Dict[str, Any]]:
    path = _conversation_path(conv_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_conversation(data: Dict[str, Any]) -> None:
    conv_id = data["id"]
    _conversation_path(conv_id).write_text(json.dumps(data, indent=2), encoding="utf-8")


def _upsert_index_entry(conv_id: str, title: str, updated_at: str, created_at: str) -> None:
    items = _load_index()
    for item in items:
        if item["id"] == conv_id:
            item["title"] = title
            item["updated_at"] = updated_at
            _save_index(items)
            return
    items.append(
        {
            "id": conv_id,
            "title": title,
            "created_at": created_at,
            "updated_at": updated_at,
        }
    )
    _save_index(items)


@app.get("/api/models")
async def list_models() -> JSONResponse:
    data = await _ollama_get("/tags")
    return JSONResponse(data)


@app.get("/api/running")
async def list_running() -> JSONResponse:
    data = await _ollama_get("/ps")
    return JSONResponse(data)


@app.post("/api/pull", response_model=None)
async def pull_model(request: Request) -> StreamingResponse:
    payload = await request.json()
    stream = payload.get("stream", True)
    if not stream:
        data = await _ollama_post_json("/pull", payload)
        return JSONResponse(data)
    return StreamingResponse(_ollama_stream("/pull", payload), media_type="application/x-ndjson")


@app.post("/api/chat", response_model=None)
async def chat(request: Request) -> StreamingResponse | JSONResponse:
    payload = await request.json()
    stream = payload.get("stream", True)
    if not stream:
        data = await _ollama_post_json("/chat", payload)
        return JSONResponse(data)
    return StreamingResponse(_ollama_stream("/chat", payload), media_type="application/x-ndjson")


@app.post("/api/generate", response_model=None)
async def generate(request: Request) -> StreamingResponse | JSONResponse:
    payload = await request.json()
    stream = payload.get("stream", True)
    if not stream:
        data = await _ollama_post_json("/generate", payload)
        return JSONResponse(data)
    return StreamingResponse(_ollama_stream("/generate", payload), media_type="application/x-ndjson")


@app.get("/api/conversations")
async def list_conversations() -> JSONResponse:
    return JSONResponse(_load_index())


@app.get("/api/conversations/{conv_id}")
async def get_conversation(conv_id: str) -> JSONResponse:
    data = _load_conversation(conv_id)
    if not data:
        raise HTTPException(404, "conversation not found")
    return JSONResponse(data)


@app.post("/api/conversations")
async def save_conversation(request: Request) -> JSONResponse:
    payload = await request.json()
    conv_id = payload.get("id") or uuid4().hex
    title = payload.get("title") or "Untitled"
    created_at = payload.get("created_at") or _now_iso()
    updated_at = _now_iso()

    data = {
        "id": conv_id,
        "title": title,
        "created_at": created_at,
        "updated_at": updated_at,
        "system": payload.get("system", ""),
        "settings": payload.get("settings", {}),
        "messages": payload.get("messages", []),
    }

    _save_conversation(data)
    _upsert_index_entry(conv_id, title, updated_at, created_at)
    return JSONResponse(data)


@app.delete("/api/conversations/{conv_id}")
async def delete_conversation(conv_id: str) -> JSONResponse:
    data = _load_conversation(conv_id)
    if not data:
        raise HTTPException(404, "conversation not found")
    _conversation_path(conv_id).unlink(missing_ok=True)
    items = [item for item in _load_index() if item["id"] != conv_id]
    _save_index(items)
    return JSONResponse({"ok": True})

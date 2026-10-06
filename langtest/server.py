"""Compare sentence-embedding models on Philippine languages.

Harmony (harmonydata.ac.uk) matches questionnaire items across languages using
paraphrase-multilingual-MiniLM. On Philippine languages it scores at chance.
This serves a page for checking that yourself, with your own text.

Standard library only, apart from sentence-transformers.

    python langtest/server.py          # then open http://localhost:5190
"""
import json, os, statistics, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
PORT = int(os.environ.get("PORT", 5190))

# Reuse an existing download if one is lying around, rather than pulling ~5GB again.
if "HF_HOME" not in os.environ:
    for guess in (Path(os.environ.get("TEMP", "")) / "hb" / "hf",):
        if guess.exists():
            os.environ["HF_HOME"] = str(guess)
            break

MODELS = {
    "minilm": {"id": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
               "label": "MiniLM-L12", "note": "what Harmony's API uses", "size": "470 MB"},
    "labse":  {"id": "sentence-transformers/LaBSE",
               "label": "LaBSE", "note": "109 languages, incl. tl and ceb", "size": "1.9 GB"},
    "e5base": {"id": "intfloat/multilingual-e5-base",
               "label": "e5-base", "note": "", "size": "1.1 GB"},
    "e5large":{"id": "intfloat/multilingual-e5-large",
               "label": "e5-large", "note": "", "size": "2.2 GB"},
}

_loaded, _lock = {}, threading.Lock()


def get_model(key):
    """Load on first use and keep it; each one costs real memory."""
    with _lock:
        if key not in _loaded:
            from sentence_transformers import SentenceTransformer
            print(f"loading {MODELS[key]['id']} ...", flush=True)
            _loaded[key] = SentenceTransformer(MODELS[key]["id"])
        return _loaded[key]


def compare(key, list_a, list_b, scored):
    """Match every item in A against B, and report the margin over noise.

    A raw similarity means nothing on its own: each model packs sentences into a
    differently sized cone. The noise floor here is the mean similarity between
    two *unrelated* items of A, so margin says how far a match rises above it.
    """
    model = get_model(key)
    prefix = "query: " if "e5" in key else ""       # e5 expects its retrieval prefix
    n, m = len(list_a), len(list_b)
    emb = model.encode([prefix + t for t in list_a + list_b],
                       normalize_embeddings=True, show_progress_bar=False)
    sim = (emb @ emb.T).tolist()

    floor = statistics.mean(abs(sim[i][j]) for i in range(n) for j in range(n) if i != j) \
        if n > 1 else 0.0
    rows, picks = [], []
    for i in range(n):
        score, j = max((abs(sim[i][n + k]), k) for k in range(m))
        picks.append(j)
        rows.append({"a": list_a[i], "b": list_b[j], "score": score,
                     "correct": (j == i) if scored else None})
    hits = sum(r["correct"] for r in rows) if scored else None
    return {
        "model": MODELS[key]["label"],
        "rows": rows,
        "floor": floor,
        "margin": statistics.mean(r["score"] for r in rows) - floor,
        "collapse": n - len(set(picks)),
        "hits": hits, "total": n if scored else None,
        "matrix": [[abs(sim[i][n + j]) for j in range(m)] for i in range(n)],
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/api/models":
            self._send(200, json.dumps({"models": MODELS, "loaded": list(_loaded)}),
                       "application/json")
        elif path == "/api/presets":
            self._send(200, (HERE / "presets.json").read_bytes(),
                       "application/json; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path != "/api/compare":
            return self._send(404, "not found", "text/plain")
        try:
            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            a = [t.strip() for t in req["a"] if t.strip()]
            b = [t.strip() for t in req["b"] if t.strip()]
            if not a or not b:
                raise ValueError("both sides need at least one line")
            scored = bool(req.get("scored")) and len(a) == len(b)
            out = [compare(k, a, b, scored) for k in req["models"] if k in MODELS]
            self._send(200, json.dumps({"results": out, "scored": scored}), "application/json")
        except Exception as exc:
            self._send(400, json.dumps({"error": f"{type(exc).__name__}: {exc}"}),
                       "application/json")

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    try:
        import sentence_transformers  # noqa: F401
    except ImportError:
        sys.exit("sentence-transformers is missing. See langtest/README.md")
    print(f"langtest on http://localhost:{PORT}  (models load on first use)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

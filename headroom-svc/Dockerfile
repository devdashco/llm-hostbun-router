FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PORT=8000
EXPOSE 8000

# python:slim has no curl/wget, so health-check with stdlib urllib instead.
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=3).status==200 else 1)"

# Single worker is plenty — compression is CPU-light string work, and the proxy
# fast-fails on timeout anyway. Bump --workers via the start command if needed.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]

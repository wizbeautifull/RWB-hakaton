FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MESH_DB_PATH=/data/wildberries.sqlite3
WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --system mesh \
    && useradd --system --gid mesh mesh \
    && install -d -o mesh -g mesh /data
COPY backend/app ./backend/app
COPY config ./config
COPY --from=frontend-build /build/dist ./frontend/dist
USER mesh
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]

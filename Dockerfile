# Novia - Novacutan Assistant
# Dockerfile para Hugging Face Spaces

FROM python:3.11-slim

# Configurar variables de entorno
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Crear directorio de trabajo
WORKDIR /app

# Instalar dependencias del sistema (para numpy y otras libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements primero (para cache de Docker)
COPY requirements.txt .

# Instalar dependencias Python
RUN pip install --no-cache-dir -r requirements.txt

# Copiar código fuente
COPY main.py .
COPY agents/ ./agents/
COPY knowledge_base.json .

# Copiar archivos estáticos
COPY static/ ./static/

# Crear usuario no-root (requerido por HF Spaces)
RUN useradd -m -u 1000 user
USER user

# Puerto por defecto de HF Spaces
EXPOSE 7862

# Comando de inicio
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7862"]

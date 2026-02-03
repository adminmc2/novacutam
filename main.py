"""
Novia - Asistente de Ventas Novacutan RAG v3.0
Backend FastAPI con WebSocket para streaming
"""

import os
import re
import json
import asyncio
from typing import Optional
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import AsyncOpenAI
from groq import Groq

# Importar sistema de agentes
from agents.orchestrator import Orchestrator

load_dotenv()

# Clientes API
groq_api_key = os.getenv("GROQ_API_KEY")

# Cliente Groq para LLM (Kimi K2) — usando AsyncOpenAI para no bloquear event loop
llm_client = AsyncOpenAI(
    api_key=groq_api_key,
    base_url="https://api.groq.com/openai/v1"
) if groq_api_key else None

LLM_MODEL = "llama-3.3-70b-versatile"  # Kimi K2 saturado (503), usando Llama 3.3 como respaldo

# Modelo dedicado para infografías (JSON estructurado) — Llama 3.3 es más fiable para JSON
INFOGRAPHIC_MODEL = "llama-3.3-70b-versatile"

# Prompt para generación de infografías resumidas
INFOGRAPHIC_PROMPT = """Eres un diseñador de infografías médicas. Tu tarea es convertir la respuesta de un agente de ventas farmacéutico en un JSON estructurado para renderizar una infografía visual.

REGLAS ESTRICTAS:
1. Responde SOLO con JSON válido, sin markdown ni texto adicional.
2. Máximo 4 secciones.
3. Máximo 3 puntos por sección.
4. Cada punto máximo 100 caracteres.
5. Título máximo 60 caracteres.
6. Subtítulo máximo 80 caracteres.
7. Frase clave máximo 150 caracteres.
8. Prioriza datos concretos: cifras, porcentajes, nombres de estudios, dosis.
9. Determina color_tema según el contenido:
   - "productos" si habla de composición, dosis, FAB, especificaciones técnicas
   - "objeciones" si maneja dudas, precio, eficacia, seguridad, rebate
   - "argumentos" si presenta estrategia de venta, SPIN, argumentario, cierre

SCHEMA JSON:
{
  "titulo": "string (max 60 chars)",
  "subtitulo": "string (max 80 chars)",
  "color_tema": "productos | objeciones | argumentos",
  "secciones": [
    {
      "icono": "nombre icono Phosphor sin prefijo ph- (ej: heart-pulse, shield-check, trend-up, pill, flask, chart-line, clipboard-text, user, star)",
      "titulo": "string (max 40 chars)",
      "puntos": ["string max 100 chars", "..."]
    }
  ],
  "producto_destacado": {
    "nombre": "string o null",
    "dosis": "string o null",
    "indicacion": "string o null"
  },
  "frase_clave": "string o null (max 150 chars) — la frase más impactante para el médico",
  "datos_tabla": [
    { "etiqueta": "string corto", "valor": "string con número/dato" }
  ]
}

Extrae la información más relevante y visual. Si no hay producto específico, pon null. datos_tabla debe tener 2-4 entradas con los KPIs más impactantes."""

# Cliente Groq nativo (para transcripción de voz con Whisper)
groq_client = Groq(api_key=groq_api_key) if groq_api_key else None

if not groq_api_key:
    print("⚠️  GROQ_API_KEY no configurada - LLM y transcripción deshabilitados")

# ElevenLabs TTS (voz de Novia)
elevenlabs_api_key = os.getenv("ELEVENLABS_API_KEY")
elevenlabs_voice_id = os.getenv("ELEVENLABS_VOICE_ID", "NWqMOQLlMBaUbjKYdhbW")

if not elevenlabs_api_key:
    print("⚠️  ELEVENLABS_API_KEY no configurada - TTS deshabilitado")

# Orquestador de agentes
orchestrator: Optional[Orchestrator] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Inicializar el orquestador al arrancar"""
    global orchestrator
    print("Inicializando sistema multi-agente...")
    orchestrator = Orchestrator()
    # Acceder al RAG a través de cualquier agente (comparten la misma instancia singleton)
    rag = orchestrator.agents['productos'].rag
    print(f"Sistema listo. Base de conocimiento: {len(rag.qa_pairs)} documentos")
    yield
    print("Cerrando aplicación...")

app = FastAPI(
    title="Novia - Asistente de Ventas Novacutan",
    version="3.0.0",
    lifespan=lifespan
)

# Servir archivos estáticos
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    """Servir el frontend principal"""
    return FileResponse("static/index.html")


@app.get("/api/health")
async def health_check():
    """Verificar estado del sistema"""
    return {
        "status": "ok",
        "version": "3.0.0",
        "agents": ["productos", "objeciones", "argumentos"],
        "knowledge_base_size": len(orchestrator.agents['productos'].rag.qa_pairs) if orchestrator else 0
    }


@app.get("/api/test-infographic")
async def test_infographic():
    """Endpoint de diagnóstico para probar la generación de infografías"""
    if not llm_client:
        return {"success": False, "error": "LLM client no configurado (falta GROQ_API_KEY)"}

    test_text = "NOVACUTAN BioPRO contiene 20mg/ml de ácido hialurónico con tecnología 3DVS. Indicado para lifting de tejidos blandos y rejuvenecimiento facial. Triple acción celular: extracelular, intracelular y subcelular."

    try:
        data = await asyncio.to_thread(_generate_infographic_sync, test_text)
        return {"success": True, "model": INFOGRAPHIC_MODEL, "data": data}
    except Exception as e:
        import traceback
        return {
            "success": False,
            "model": INFOGRAPHIC_MODEL,
            "error": str(e),
            "traceback": traceback.format_exc()
        }


class InfographicRequest(BaseModel):
    agent_response: str


@app.post("/api/infographic")
async def generate_infographic(req: InfographicRequest):
    """Generar infografía JSON a partir de la respuesta del agente"""
    if not llm_client:
        raise HTTPException(status_code=503, detail="LLM client no configurado")

    if not req.agent_response.strip():
        raise HTTPException(status_code=400, detail="agent_response vacío")

    try:
        data = await asyncio.to_thread(_generate_infographic_sync, req.agent_response)
        return {"success": True, "data": data}
    except Exception as e:
        print(f"[Infographic] Error: {e}")
        return {"success": False, "error": str(e)}


@app.post("/api/voice")
async def transcribe_voice(audio: UploadFile = File(...)):
    """
    Transcribir audio a texto usando Whisper (Groq)
    Soporta: webm, mp3, wav, m4a, ogg
    """
    # Verificar si Groq está configurado
    if not groq_client:
        return {"text": "", "success": False, "error": "GROQ_API_KEY no configurada"}

    try:
        # Leer el archivo de audio
        audio_bytes = await audio.read()

        # Log para debug iOS
        print(f"[VOICE] Received audio: filename={audio.filename}, size={len(audio_bytes)} bytes, content_type={audio.content_type}")

        # Si el audio está vacío, devolver error claro
        if len(audio_bytes) < 100:
            print(f"[VOICE] Audio too small ({len(audio_bytes)} bytes), likely empty recording")
            return {"text": "", "success": False, "error": f"Audio vacío ({len(audio_bytes)} bytes)"}

        # Crear archivo temporal para Groq (usar /tmp para permisos en Docker)
        import tempfile
        ext = audio.filename.split('.')[-1] if audio.filename else 'webm'
        temp_filename = os.path.join(tempfile.gettempdir(), f"temp_audio_{os.getpid()}.{ext}")

        with open(temp_filename, "wb") as f:
            f.write(audio_bytes)

        # Transcribir con Whisper via Groq
        with open(temp_filename, "rb") as audio_file:
            transcription = groq_client.audio.transcriptions.create(
                model="whisper-large-v3",
                file=audio_file,
                language="es"
            )

        # Limpiar archivo temporal
        os.remove(temp_filename)

        print(f"[VOICE] Transcription result: '{transcription.text}'")
        return {"text": transcription.text, "success": True}

    except Exception as e:
        print(f"[VOICE] ERROR: {e}")
        return {"text": "", "success": False, "error": str(e)}


# Prompt para generar resumen conversacional para TTS
TTS_SUMMARY_PROMPT = """Eres Novia, una asistente de ventas de Novacutan. Convierte la siguiente respuesta escrita en un RESUMEN HABLADO conversacional y natural.

REGLAS:
1. Habla como si estuvieras conversando con el representante de ventas, en tono cercano y profesional.
2. NUNCA leas tablas, filas, columnas, pipes (|), separadores (---) ni datos tabulares. Extrae solo los 2-3 datos más relevantes de la tabla y menciónalos de forma conversacional. Ejemplo: "El BioPRO tiene 20 miligramos por mililitro de ácido hialurónico con tecnología 3DVS."
3. Máximo 3-4 oraciones (50-80 palabras). Sé concisa pero informativa.
4. Menciona solo el dato más importante (nombre de producto, técnica clave, o argumento principal).
5. Si hay un guion sugerido para el médico, menciónalo brevemente: "podrías decirle al doctor..."
6. NO uses markdown, asteriscos, viñetas, listas ni formato. Solo texto plano corrido para ser leído en voz alta por un sintetizador de voz.
7. NO digas "aquí tienes", "en resumen", "la respuesta es". Ve directo al contenido.
8. Usa vocabulario mexicano natural: "mira", "fíjate que", "lo que te recomiendo es".
9. Termina con algo útil: un tip, una frase para el médico, o un dato que el representante pueda recordar fácilmente.
10. NUNCA incluyas caracteres especiales como |, *, #, >, -, ni guiones al inicio de líneas. El texto debe sonar 100% natural al escucharlo."""


async def _generate_tts_summary(agent_response: str) -> str:
    """Genera un resumen conversacional corto del texto del agente para TTS."""
    if not llm_client:
        return ""

    try:
        response = await llm_client.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": TTS_SUMMARY_PROMPT},
                {"role": "user", "content": agent_response}
            ],
            stream=False,
            max_tokens=200,
            temperature=0.6
        )
        summary = response.choices[0].message.content.strip()
        # Limpiar cualquier markdown residual
        summary = re.sub(r'\*+', '', summary)           # bold/italic
        summary = re.sub(r'#{1,6}\s+', '', summary)     # headings
        summary = re.sub(r'^>\s*', '', summary, flags=re.MULTILINE)  # blockquotes
        summary = re.sub(r'\|', ' ', summary)            # table pipes
        summary = re.sub(r'^[\s\-:]+$', '', summary, flags=re.MULTILINE)  # table separators (---|---)
        summary = re.sub(r'^[-•]\s+', '', summary, flags=re.MULTILINE)    # list bullets
        summary = re.sub(r'^\d+\.\s+', '', summary, flags=re.MULTILINE)   # numbered lists
        summary = re.sub(r'\s{2,}', ' ', summary)       # collapse multiple spaces
        summary = re.sub(r'\n{2,}', '. ', summary)      # multiple newlines → period
        summary = summary.strip()
        print(f"[TTS] Summary ({len(summary)} chars): {summary[:100]}...")
        return summary
    except Exception as e:
        print(f"[TTS] Error generating summary: {e}")
        return ""


class TTSRequest(BaseModel):
    text: str
    skip_summary: bool = False  # True = send text directly to ElevenLabs without LLM summary


# ============================================
# Sincronización de historial entre dispositivos
# ============================================
USER_DATA_FILE = "user_data.json"


def load_user_data() -> dict:
    """Carga datos de usuarios desde archivo JSON"""
    if os.path.exists(USER_DATA_FILE):
        try:
            with open(USER_DATA_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[UserData] Error loading: {e}")
    return {}


def save_user_data(data: dict):
    """Guarda datos de usuarios a archivo JSON"""
    try:
        with open(USER_DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[UserData] Error saving: {e}")


class SearchHistoryRequest(BaseModel):
    username: str
    searches: list  # Lista de búsquedas recientes


class GetHistoryRequest(BaseModel):
    username: str


@app.post("/api/history/save")
async def save_search_history(req: SearchHistoryRequest):
    """Guarda el historial de búsquedas de un usuario"""
    if not req.username:
        raise HTTPException(status_code=400, detail="Username requerido")

    user_data = load_user_data()
    if req.username not in user_data:
        user_data[req.username] = {}

    user_data[req.username]["searches"] = req.searches
    user_data[req.username]["last_sync"] = __import__('time').time()
    save_user_data(user_data)

    return {"status": "ok", "saved": len(req.searches)}


@app.post("/api/history/load")
async def load_search_history(req: GetHistoryRequest):
    """Carga el historial de búsquedas de un usuario"""
    if not req.username:
        raise HTTPException(status_code=400, detail="Username requerido")

    user_data = load_user_data()
    if req.username in user_data and "searches" in user_data[req.username]:
        return {
            "status": "ok",
            "searches": user_data[req.username]["searches"],
            "last_sync": user_data[req.username].get("last_sync", 0)
        }

    return {"status": "ok", "searches": [], "last_sync": 0}


@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    """Genera audio TTS via ElevenLabs.
    1. El LLM resume la respuesta en un discurso conversacional corto (unless skip_summary).
    2. Ese resumen se envía a ElevenLabs para generar audio."""
    if not elevenlabs_api_key:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY no configurada")

    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Texto vacío")

    # Paso 1: Generar resumen conversacional con el LLM (or use text directly)
    if req.skip_summary:
        summary = req.text.strip()
    else:
        summary = await _generate_tts_summary(req.text)
        if not summary:
            raise HTTPException(status_code=500, detail="No se pudo generar resumen para TTS")

    # Paso 2: Enviar resumen a ElevenLabs
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{elevenlabs_voice_id}/stream"
        f"?output_format=mp3_44100_128"
    )
    headers = {
        "xi-api-key": elevenlabs_api_key,
        "Content-Type": "application/json",
    }
    body = {
        "text": summary,
        "model_id": "eleven_multilingual_v2",
        "language_code": "es",
        "voice_settings": {
            "stability": 0.35,          # Más bajo = más expresiva y natural
            "similarity_boost": 0.80,   # Mantener la voz reconocible
            "style": 0.45,              # Más estilo = más emocional/cálida
            "use_speaker_boost": True,
        },
    }

    async def stream_audio():
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    error_body = await resp.aread()
                    print(f"[TTS] ElevenLabs error {resp.status_code}: {error_body[:200]}")
                    return
                async for chunk in resp.aiter_bytes(chunk_size=4096):
                    yield chunk

    return StreamingResponse(
        stream_audio(),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-cache"},
    )


def _generate_infographic_sync(agent_response: str) -> dict:
    """Llamada sincrónica al LLM para generar infografía (se ejecuta en thread pool)"""
    print(f"[Infographic] Llamando a {INFOGRAPHIC_MODEL} con {len(agent_response)} chars...")
    response = llm_client.chat.completions.create(
        model=INFOGRAPHIC_MODEL,
        messages=[
            {"role": "system", "content": INFOGRAPHIC_PROMPT},
            {"role": "user", "content": agent_response}
        ],
        stream=False,
        max_tokens=1500,
        temperature=0.3,
        response_format={"type": "json_object"}
    )
    raw = response.choices[0].message.content.strip()
    print(f"[Infographic] Respuesta raw ({len(raw)} chars): {raw[:200]}...")
    # Limpiar posibles bloques markdown ```json ... ```
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3].strip()
    return json.loads(raw)


async def handle_infographic_request(websocket: WebSocket, agent_response: str):
    """Genera una infografía resumida a partir de la respuesta del agente"""
    print(f"[Infographic] Recibida solicitud ({len(agent_response)} chars)")
    await websocket.send_json({"type": "infographic_loading"})
    try:
        # Ejecutar en thread pool para no bloquear el event loop
        data = await asyncio.to_thread(_generate_infographic_sync, agent_response)
        print(f"[Infographic] JSON generado: {data.get('titulo', '?')}")
        await websocket.send_json({"type": "infographic_data", "data": data})
    except json.JSONDecodeError as e:
        await websocket.send_json({
            "type": "infographic_error",
            "message": f"Error al parsear JSON de infografía: {str(e)}"
        })
    except Exception as e:
        await websocket.send_json({
            "type": "infographic_error",
            "message": f"Error generando infografía: {str(e)}"
        })


def strip_wake_word(message: str) -> str:
    """Elimina variantes del wake word 'Hola Novia' del mensaje.
    Si lo que queda es solo un saludo vacío, retorna cadena vacía."""
    import unicodedata
    t = message.strip()
    # Remove wake word patterns (case-insensitive)
    wake_patterns = [
        r'(?:hola|hey|oye|ok|ola)\s*novia',
        r'\bnovia\b',
    ]
    for p in wake_patterns:
        t = re.sub(p, '', t, flags=re.IGNORECASE).strip()
    # Remove leftover punctuation/whitespace
    t = re.sub(r'^[,\s.!?]+', '', t).strip()
    # If only a bare greeting remains, return empty
    bare = unicodedata.normalize('NFD', t.lower())
    bare = re.sub(r'[\u0300-\u036f]', '', bare).strip()
    if re.match(r'^(hola|hey|oye|ok|buenas?|buenos?|que tal|como estas?|gracias?|adios|hasta luego)?[.!?,\s]*$', bare):
        return ''
    return t


def is_greeting_or_vague(message: str) -> bool:
    """Detecta si un mensaje NO contiene consulta pharma real.
    Usa whitelist: si no hay ninguna palabra clave del dominio, es vago.
    Excluye follow-ups conversacionales que indican continuación de charla."""
    import unicodedata
    t = unicodedata.normalize('NFD', message.lower().strip())
    t = re.sub(r'[\u0300-\u036f]', '', t)  # quitar acentos

    # Follow-ups conversacionales — NUNCA son greetings aunque no tengan keywords pharma
    followup_patterns = [
        r'cuentame', r'cuenteme', r'dime\s+mas', r'dame\s+mas', r'amplia',
        r'profundiza', r'explica', r'explicame', r'detalla', r'detallame',
        r'elabora', r'desarrolla', r'resume', r'resumeme', r'resumi',
        r'continua', r'sigue', r'prosigue', r'mas\s+informacion',
        r'mas\s+detalles', r'mas\s+sobre', r'que\s+mas', r'algo\s+mas',
        r'otra\s+cosa', r'otra\s+pregunta', r'y\s+sobre', r'tambien',
        r'ademas', r'aparte', r'igualmente', r'por\s+otro\s+lado',
        r'en\s+cuanto\s+a', r'respecto\s+a', r'sobre\s+eso',
        r'y\s+eso', r'por\s+que', r'como\s+asi', r'a\s+que\s+te\s+refieres',
        r'no\s+entiendo', r'no\s+entendi', r'repite', r'repetir',
        r'otra\s+vez', r'de\s+nuevo',
    ]
    if any(re.search(p, t) for p in followup_patterns):
        return False

    # Palabras clave que indican consulta real sobre el dominio estética/ventas
    pharma_patterns = [
        # Productos y sustancias Novacutan
        r'novacutan', r'biopro', r'bio\s*pro', r'fbio', r'f\s*bio',
        r'dvs', r'3dvs', r'biomodulador', r'relleno', r'filler',
        r'acido hialuronico', r'hialuronico', r'\bah\b', r'reticulante',
        r'divinilsulfona', r'microesfera', r'bdde',
        # Médico / clínico
        r'medico', r'doctor', r'paciente', r'prescri', r'dosis',
        r'indicaci', r'tratamiento', r'clinico', r'sesion',
        r'dermato', r'cirujano', r'plastico', r'estetico', r'estetica',
        # Técnicas y protocolos
        r'v.?lift', r'd.?lift', r'lifting', r'canula', r'aguja',
        r'protocolo', r'tecnica', r'inyecci', r'bolus', r'fanning',
        r'retrotrazante', r'subdermic', r'supraperiostic',
        # Zonas anatómicas
        r'facial', r'ovalo', r'pomulo', r'mandibul', r'menton',
        r'nasogeniano', r'surco', r'labio', r'ojera', r'lagrimal',
        r'temporal', r'periorbital', r'peribucal', r'cuello',
        # Condiciones estéticas
        r'flacidez', r'arruga', r'volumen', r'rejuvenecimiento',
        r'envejecimiento', r'firmeza', r'colageno', r'elastina',
        r'edema', r'hinchaz', r'hematoma',
        # Objeciones
        r'\bcaro\b', r'costoso', r'precio', r'barato', r'coste',
        r'no funciona', r'no sirve', r'no conoce',
        r'efecto.? secundario', r'contraindicac',
        r'otra marca', r'competencia', r'objecion',
        r'profhilo', r'juvederm',
        # Ventas y argumentos
        r'argumento', r'vender', r'\bventa\b', r'presentar', r'visita',
        r'represent', r'estrategi', r'perfil', r'diferenci',
        r'ventaja', r'evidencia', r'estudio', r'pitch',
        # Marca y certificaciones
        r'novacutan', r'fijie', r'marcado ce', r'certificac',
        r'dispositivo medico', r'clase iii',
        # Producto genérico
        r'producto', r'composici', r'concentraci', r'cohesividad',
        r'calidad', r'pureza', r'purificacion',
        # Seguridad
        r'embaraz', r'anticoagulant', r'herpes', r'alergia',
        r'hialuronidasa', r'complicaci', r'vascular', r'necrosis',
        # Acciones del dominio
        r'recomiend', r'recomendar', r'comparar', r'comparativ',
        r'que es\b', r'para que sirve', r'como funciona', r'como respondo',
        r'como presento', r'como vendo', r'como aplico',
    ]

    return not any(re.search(p, t) for p in pharma_patterns)


GREETING_RESPONSE = """Soy **Novia**, tu asistente de ventas de Novacutan. Para poder ayudarte, cuéntame qué necesitas. Por ejemplo:

- **Producto**: *"¿Qué es BioPRO y para qué sirve?"*
- **Objeción**: *"Un médico dice que es caro, ¿cómo respondo?"*
- **Argumento**: *"¿Cómo presento Novacutan a un dermatólogo?"*

> Puedes usar las **preguntas sugeridas** en la pantalla de inicio o escribir tu consulta directamente."""


@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    """
    WebSocket para chat con streaming en tiempo real
    """
    await websocket.accept()

    # Historial de conversación para mantener contexto
    conversation_history = []
    MAX_HISTORY = 10  # Mantener últimos 10 intercambios (20 mensajes)

    try:
        while True:
            # Recibir mensaje del usuario
            data = await websocket.receive_text()
            message_data = json.loads(data)
            msg_type = message_data.get("type", "chat")

            # Branch: solicitud de infografía
            if msg_type == "infographic_request":
                agent_response = message_data.get("agent_response", "")
                if agent_response.strip():
                    await handle_infographic_request(websocket, agent_response)
                continue

            user_message = message_data.get("message", "")
            response_mode = message_data.get("response_mode", "full")  # "short" o "full"

            # Contexto previo de chat guardado — poblar historial para continuidad
            prior = message_data.get("prior_context")
            if prior and not conversation_history:
                q = prior.get("question", "")
                a = prior.get("answer", "")
                if q and a:
                    conversation_history.append({"role": "user", "content": q})
                    conversation_history.append({"role": "assistant", "content": a})
                    print(f"[WS] Contexto previo restaurado: Q={q[:50]}... A={a[:50]}...")
                else:
                    print(f"[WS] prior_context recibido pero q/a vacíos: q='{q[:30]}' a='{a[:30]}'")
            elif prior and conversation_history:
                print(f"[WS] prior_context ignorado — ya hay {len(conversation_history)} msgs en historial")

            if not user_message.strip():
                continue

            # Strip wake word ("Hola Novia") from the message
            cleaned = strip_wake_word(user_message)
            if not cleaned:
                # Message was only a wake word — ignore silently
                continue
            user_message = cleaned

            is_vague = is_greeting_or_vague(user_message)
            print(f"[WS] Mensaje recibido — historial: {len(conversation_history)} msgs — vague: {is_vague} — query: '{user_message[:60]}'")

            # Saludos y mensajes vagos: responder directamente sin agente ni RAG
            # SOLO si no hay historial — si el usuario ya hizo preguntas, pasar al agente
            # para que pueda usar el contexto de la conversación anterior
            if is_vague and not conversation_history:
                await websocket.send_json({
                    "type": "agent_info",
                    "agent": "saludo",
                    "context_docs": 0,
                    "rag_coverage": "high",
                    "max_score": 0
                })
                # Enviar en chunks de ~20 chars para simular streaming natural
                chunk_size = 20
                for i in range(0, len(GREETING_RESPONSE), chunk_size):
                    await websocket.send_json({
                        "type": "token",
                        "content": GREETING_RESPONSE[i:i + chunk_size]
                    })
                    await asyncio.sleep(0.02)
                await websocket.send_json({"type": "end"})
                continue

            try:
                # Clasificar intención con reglas (rápido y sin API call)
                intent = orchestrator.classify_intent_rules(user_message)
                print(f"[DEBUG] Intent: {intent}")

                # Obtener agente correspondiente
                agent = orchestrator.get_agent(intent)
                print(f"[DEBUG] Agente: {agent.name}")

                # Buscar contexto relevante en RAG (con fallback si score bajo)
                results = agent.search_knowledge_with_fallback(user_message, top_k=5)
                context = agent.format_context(results, min_score=0.1)
                print(f"[DEBUG] RAG: {len(results)} resultados, contexto: {len(context)} chars")

                # Enriquecer contexto con inteligencia del agente
                enrichment = agent.enrich_context(user_message, results)
                if enrichment:
                    context += f"\n\n═══ CONTEXTO ADICIONAL DEL AGENTE ═══\n{enrichment}"

                # Evaluar cobertura RAG
                relevant_docs = [r for r in results if r[1] >= 0.1]
                strong_docs = [r for r in results if r[1] >= 0.35]
                max_score = max((r[1] for r in results), default=0.0)
                rag_coverage = "high" if len(strong_docs) >= 2 else ("medium" if len(relevant_docs) >= 1 else "low")

                # Enviar info del agente + cobertura RAG al frontend
                print(f"[DEBUG] RAG coverage: {rag_coverage}, max_score: {max_score:.2f}, docs: {len(relevant_docs)}")
                await websocket.send_json({
                    "type": "agent_info",
                    "agent": intent,
                    "context_docs": len(relevant_docs),
                    "rag_coverage": rag_coverage,
                    "max_score": round(max_score, 2)
                })
                print(f"[DEBUG] agent_info enviado al frontend")

                # Instrucciones dinámicas según cobertura RAG
                if rag_coverage == "low":
                    rag_instruction = """⚠️ COBERTURA RAG: BAJA — Hay poca información específica para esta consulta.

REGLAS:
1. Respuesta CORTA (máximo 150 palabras). No generes un argumentario completo.
2. NO inventes cifras, porcentajes ni datos específicos.
3. SÍ puedes mencionar consenso médico general sin cifras exactas (ej: "El ácido hialurónico reticulado con DVS ofrece mayor estabilidad y menor edema").
4. Si HAY algún dato relevante en el contexto RAG de arriba (aunque sea tangencial), úsalo — son datos verificados de Novacutan.
5. Redirige al usuario hacia temas que SÍ puedes cubrir con preguntas sugeridas.
6. NO muestres secciones vacías ni uses placeholders.

FORMATO para cobertura baja:
## [Tema consultado]

[Si hay datos RAG relevantes, preséntalos de forma útil y persuasiva]

[1-2 frases de consenso médico general SIN cifras inventadas si aplica]

**Te puedo ayudar con:**
- [Pregunta sugerida 1 sobre productos/protocolos de Novacutan]
- [Pregunta sugerida 2]
- [Pregunta sugerida 3]"""
                elif rag_coverage == "medium":
                    rag_instruction = """⚠️ COBERTURA RAG: PARCIAL — Los datos verificados de arriba son limitados.

REGLAS OBLIGATORIAS:
1. Usa SOLO la información de los HECHOS VERIFICADOS de arriba.
2. NO añadas datos externos. Si necesitas mencionar algo fuera del contexto, di "según consenso médico general" SIN cifras.
3. Si una sección de tu formato no tiene datos verificados, OMÍTELA entera. No incluyas tablas con celdas vacías ni secciones sin contenido real.
4. Aprovecha al MÁXIMO los datos que SÍ tienes: preséntelos de forma persuasiva, clara y útil para vender.
5. PROHIBIDO EXTRAPOLAR INDICACIONES: Si un producto aparece en los datos verificados con indicación X, NO lo recomiendes para indicación Y. Solo recomienda cada producto para las indicaciones que EXPLÍCITAMENTE aparecen en los datos verificados. Ejemplo: si un producto está indicado para "flacidez facial", NO lo recomiendes para relleno labial a menos que los datos verificados digan EXPLÍCITAMENTE que tiene esa indicación.
6. Menciona SOLO los productos que tengan indicación EXPLÍCITA para la condición consultada en los datos verificados."""
                else:
                    rag_instruction = """COBERTURA RAG: ALTA — Tienes buenos datos verificados arriba.
Responde EXCLUSIVAMENTE con los datos verificados. NO complementes con conocimiento externo.
Si alguna sección de tu formato no tiene datos verificados, OMÍTELA — no dejes huecos ni placeholders.
Presenta TODA la información disponible de forma persuasiva, completa y útil para que el representante venda con confianza.
PROHIBIDO EXTRAPOLAR INDICACIONES: Recomienda cada producto SOLO para las indicaciones que aparecen EXPLÍCITAMENTE en los datos verificados. No atribuyas indicaciones nuevas a un producto existente."""

                # Instrucción de longitud según modo de respuesta
                # Si cobertura baja, el formato ya está definido en rag_instruction — no aplicar templates de agente
                if rag_coverage == "low":
                    length_instruction = ""  # El formato de respuesta corta ya está en rag_instruction
                elif response_mode == "short":
                    # Formato resumido adaptado a cada agente — preserva los elementos de diseño clave
                    if intent == "productos":
                        length_instruction = """MODO RESUMIDO — Usa EXACTAMENTE este formato reducido (markdown):

## [Nombre del producto o tema]

| Parámetro | Valor |
|-----------|-------|
| (los 3-4 datos más importantes: composición, volumen, reticulante, zona) |

**Indicación principal**: Una frase directa con FAB.

**Protocolo**: Técnica y sesiones en una línea.

**Dato diferenciador**
> Frase clave FAB que el representante puede usar literalmente con el médico. OBLIGATORIO.

REGLAS DE MODO RESUMIDO:
- Máximo 200-250 palabras totales.
- La tabla, la indicación FAB y el dato diferenciador (blockquote) son OBLIGATORIOS.
- NO incluyas evidencia clínica, caso clínico ni secciones adicionales.
- El dato diferenciador SIEMPRE debe ser un blockquote (>) con una frase memorable."""
                    elif intent == "objeciones":
                        length_instruction = """MODO RESUMIDO — Usa EXACTAMENTE este formato reducido (markdown):

## Objeción: "[Resumen breve]"

### Reconocimiento
> Frase empática Feel-Felt-Found condensada en 2 líneas máximo.

### Datos clave
| Dato | Valor |
|------|-------|
| (2-3 datos que desmonta la objeción) |

### Reencuadre
Una frase de Boomerang o aversión a la pérdida. Máximo 2 líneas.

### Guion sugerido
> "Doctor/a, [frase lista para usar literalmente]." OBLIGATORIO.

REGLAS DE MODO RESUMIDO:
- Máximo 200-250 palabras totales.
- La tabla, el reconocimiento y el guion sugerido (blockquote) son OBLIGATORIOS.
- No incluyas secciones adicionales."""
                    else:  # argumentos
                        length_instruction = """MODO RESUMIDO — Usa EXACTAMENTE este formato reducido (markdown):

## Argumentario: [Especialidad]

### Insight clave
> Dato sorprendente en 1-2 líneas. OBLIGATORIO.

### Producto recomendado
| Producto | Dosis | Indicación |
|----------|-------|------------|
| (1 producto principal) |

### Argumentos clave
1. **[Argumento 1]**: Dato concreto en 1 línea.
2. **[Argumento 2]**: Dato concreto en 1 línea.

### Guion de apertura
> "Doctor/a, [frase de apertura lista para usar]." OBLIGATORIO.

REGLAS DE MODO RESUMIDO:
- Máximo 200-250 palabras totales.
- El insight (blockquote), la tabla y el guion de apertura (blockquote) son OBLIGATORIOS.
- NO incluyas SPIN, perfil de paciente, caso clínico ni plan de prescripción."""
                else:
                    length_instruction = "MODO EXTENDIDO: Responde con el formato completo y detallado según tu estructura habitual."

                # Preparar prompt completo con anti-fabricación AL INICIO + contexto RAG
                anti_fabrication = (
                    "══════════════════════════════════════════\n"
                    "REGLA #1 — LA MÁS IMPORTANTE DE TODAS:\n"
                    "══════════════════════════════════════════\n"
                    "USA SOLO datos de la sección 'DATOS VERIFICADOS DE NOVACUTAN' de abajo.\n"
                    "- NO inventes cifras (mg, %, ratios) ni estudios que no estén en los datos verificados.\n"
                    "- NO menciones productos que no aparezcan en los datos verificados.\n"
                    "- Si una sección de tu formato NO tiene datos verificados disponibles → OMITE esa sección ENTERA. No la incluyas.\n"
                    "- NUNCA pongas '—', 'No disponible', 'Consultar ficha técnica' ni celdas vacías. Si no hay dato, no pongas la fila/sección.\n"
                    "- SÍ usa técnicas de persuasión (FAB, SPIN, Feel-Felt-Found, storytelling) con los datos que SÍ tienes.\n"
                    "- Presenta los datos verificados de forma COMPLETA, ÚTIL y PERSUASIVA para que el representante pueda vender con confianza.\n"
                    "══════════════════════════════════════════\n\n"
                )

                full_prompt = f"""{anti_fabrication}{agent.system_prompt}

{context}

---
{rag_instruction}

{length_instruction}"""

                # Tokens según modo (low coverage siempre corto)
                if rag_coverage == "low":
                    max_tokens = 400
                elif response_mode == "short":
                    max_tokens = 500
                else:
                    max_tokens = 1000

                # Construir mensajes con historial de conversación
                messages = [{"role": "system", "content": full_prompt}]

                # Añadir historial previo (para contexto de conversación)
                for hist_msg in conversation_history:
                    messages.append(hist_msg)

                # Instrucción de continuidad conversacional (inyectada justo antes del user msg)
                if conversation_history:
                    # Extraer la última pregunta del historial para dar contexto explícito
                    last_user_q = ""
                    for h in reversed(conversation_history):
                        if h["role"] == "user":
                            last_user_q = h["content"][:120]
                            break
                    messages.append({"role": "system", "content": (
                        "CONTINUIDAD CONVERSACIONAL OBLIGATORIA:\n"
                        f"El usuario venía hablando sobre: \"{last_user_q}\"\n"
                        "Su nueva pregunta es un FOLLOW-UP de esa conversación.\n\n"
                        "REGLAS:\n"
                        "1. Tu respuesta DEBE conectar temáticamente con lo anterior. "
                        "Si antes hablaban de precio y ahora preguntan sobre duración, "
                        "conecta ambos temas (ej: el coste-beneficio a largo plazo).\n"
                        "2. NO uses frases genéricas como 'En relación con lo anterior...' o "
                        "'Continuando con el tema...'. En su lugar, conecta de forma ESPECÍFICA "
                        "mencionando el tema concreto (ej: 'Precisamente, uno de los argumentos "
                        "más potentes frente a la objeción del precio es el tiempo de respuesta...').\n"
                        "3. NO repitas información ya dada. Amplía, profundiza o conecta con ángulos nuevos.\n"
                        "4. Mantén tono conversacional natural, como un colega que te está explicando algo "
                        "y tú le haces otra pregunta — no como un chatbot que empieza de cero cada vez."
                    )})

                # Añadir mensaje actual del usuario
                messages.append({"role": "user", "content": user_message})

                print(f"[DEBUG] Llamando a Groq — modelo: {LLM_MODEL}, max_tokens: {max_tokens}, msgs: {len(messages)}")
                print(f"[DEBUG] System prompt: {len(messages[0]['content'])} chars")

                # Stream de respuesta con Kimi K2 (Groq) — async para no bloquear event loop
                stream = await llm_client.chat.completions.create(
                    model=LLM_MODEL,
                    messages=messages,
                    stream=True,
                    max_tokens=max_tokens,
                    temperature=0.3
                )

                # Enviar chunks al frontend — async for permite flush real entre tokens
                full_response = ""
                token_count = 0
                async for chunk in stream:
                    if chunk.choices and chunk.choices[0].delta.content:
                        token = chunk.choices[0].delta.content
                        full_response += token
                        token_count += 1
                        await websocket.send_json({
                            "type": "token",
                            "content": token
                        })
                print(f"[DEBUG] Stream terminado — {token_count} tokens enviados")

                # Guardar en historial
                conversation_history.append({"role": "user", "content": user_message})
                conversation_history.append({"role": "assistant", "content": full_response})

                # Limitar historial para no exceder contexto
                if len(conversation_history) > MAX_HISTORY * 2:
                    conversation_history = conversation_history[-(MAX_HISTORY * 2):]

                # Señal de fin de mensaje
                print(f"[DEBUG] Enviando 'end' al frontend...")
                await websocket.send_json({
                    "type": "end",
                    "full_response": full_response
                })
                print(f"[DEBUG] 'end' enviado OK — respuesta completa")

            except Exception as e:
                print(f"[ERROR] {type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()
                await websocket.send_json({
                    "type": "error",
                    "message": f"Error procesando mensaje: {str(e)}"
                })

    except WebSocketDisconnect:
        print(f"[WS] Cliente desconectado — historial tenía {len(conversation_history)} mensajes")
    except Exception as e:
        print(f"[WS] Error WebSocket: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=7862,
        reload=True
    )

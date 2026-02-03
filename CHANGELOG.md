# CHANGELOG - Novacutan (Novia)

Historial completo de desarrollo, problemas encontrados y soluciones aplicadas.

---

## v5.7.0 — 2026-02-03 (ACTUAL)

### Resumen
Se resuelve el bug cr\u00edtico de congelamiento del browser en respuestas largas (FAQ "Extendida")
integrando la librer\u00eda `streaming-markdown` para renderizado incremental del DOM.

### Problema principal: Browser se congela en respuestas largas

**S\u00edntomas:**
- Al seleccionar un chip de FAQ y elegir "Respuesta Extendida" (1000 tokens), el browser
  se congelaba completamente. No se pod\u00eda hacer scroll, abrir DevTools ni interactuar.
- El status "Novia escribiendo..." se quedaba permanente, nunca cambiaba a "En l\u00ednea".
- Las respuestas cortas ("Resumida", 500 tokens) funcionaban correctamente.
- El problema exist\u00eda en TODOS los proyectos: Novacutan local, Puro Omega local y
  Omia en Railway producci\u00f3n.

**Causa ra\u00edz identificada:**
El handler de tokens del WebSocket llamaba `renderMarkdown()` en CADA token recibido.
`renderMarkdown()` ejecuta `marked.parse(texto_completo) + DOMPurify.sanitize(html)`,
lo cual re-parsea TODO el documento acumulado desde cero en cada token.

Con 500+ tokens llegando r\u00e1pidamente:
- Token 1: parsea 1 token
- Token 2: parsea 2 tokens
- Token 100: parsea 100 tokens
- Token 500: parsea 500 tokens
- **Total: 1+2+3+...+500 = 125,250 operaciones de parseo** (complejidad O(n\u00b2))

Cada `marked.parse()` adem\u00e1s genera HTML completo que se asigna a `innerHTML`, forzando
al browser a destruir y reconstruir todo el DOM del mensaje en cada token.

**Verificaciones realizadas para aislar el problema:**

1. **Backend verificado OK**: Tests de WebSocket desde terminal confirmaron que tanto el
   modo "short" (342 tokens) como "full" (503 tokens) entregan todos los tokens + mensaje
   END correctamente, tanto en local como en Railway producci\u00f3n.

2. **Puro Omega no fue modificado**: `git diff HEAD -- main.py` y `git diff HEAD -- static/app.js`
   mostraron cero cambios vs \u00faltimo commit. El bug era preexistente en el c\u00f3digo compartido.

3. **Groq API operacional**: groqstatus.com confirm\u00f3 99.93% uptime, sin incidentes activos.

4. **Modelo LLM descartado como causa**: Se prob\u00f3 cambiar de Kimi K2 a Llama 3.3 — mismo
   comportamiento, confirmando que el problema era 100% frontend.

### Intentos de soluci\u00f3n previos (fallidos)

#### Intento 1: `requestAnimationFrame` throttle (v5.4.0)
```javascript
// Renderizar solo en el siguiente frame de animaci\u00f3n
if (!state._renderPending) {
    state._renderPending = true;
    requestAnimationFrame(() => {
        state._renderPending = false;
        assistantMessage.innerHTML = renderMarkdown(state.currentMessage, false);
    });
}
```
**Resultado**: Segu\u00eda congelando. rAF ejecuta ~60 veces/segundo, pero con 500+ tokens
llegando m\u00e1s r\u00e1pido que 60fps, cada render sigue siendo `marked.parse()` sobre texto
creciente. El cuello de botella es la complejidad del parseo, no la frecuencia.

#### Intento 2: `textContent` durante streaming (v5.5.0)
```javascript
// Texto plano durante streaming, markdown solo al final
assistantMessage.textContent = state.currentMessage;
```
**Resultado**: El browser ya no se congelaba, pero la respuesta se mostraba sin formato
(texto plano sin tablas, negritas ni headers). El usuario rechaz\u00f3 esta soluci\u00f3n porque
las respuestas necesitan formato markdown visible durante el streaming.

Adem\u00e1s, el status "Escribiendo..." segu\u00eda atascado porque el render final con
`renderMarkdown()` en el handler END bloqueaba el hilo principal antes de que el browser
pudiera pintar el cambio de status.

#### Intento 3: `setTimeout` throttle 150ms (v5.6.0)
```javascript
// Renderizar max cada 150ms
if (!state._renderPending) {
    state._renderPending = true;
    setTimeout(() => {
        assistantMessage.innerHTML = renderMarkdown(state.currentMessage, false);
    }, 150);
}
```
**Resultado**: Mejor\u00f3 un poco pero segu\u00eda congelando en respuestas largas. Aunque solo
se renderizaba ~7 veces/segundo, cada `marked.parse()` sobre un texto de 800+ tokens
sigue siendo una operaci\u00f3n pesada. El problema fundamental es O(n\u00b2), no la frecuencia.

### Soluci\u00f3n final: `streaming-markdown` (v5.7.0)

Se integr\u00f3 la librer\u00eda [`streaming-markdown`](https://github.com/thetarnav/streaming-markdown)
(3KB gzip), dise\u00f1ada espec\u00edficamente para este caso de uso.

**C\u00f3mo funciona:**
- En vez de re-parsear todo el documento en cada token, `streaming-markdown` mantiene un
  parser con estado que solo procesa el nuevo texto recibido.
- Usa `appendChild()` para a\u00f1adir nodos al DOM — nunca destruye ni reconstruye nodos existentes.
- Complejidad: O(1) por token en vez de O(n) por token.
- Total para 500 tokens: 500 operaciones simples vs 125,250 re-parseos.

**Cambios realizados:**

1. **`static/index.html`** \u2014 Se agreg\u00f3 la carga de la librer\u00eda:
   ```html
   <script type="module">
       import * as smd from "https://cdn.jsdelivr.net/npm/streaming-markdown/smd.min.js";
       window.smd = smd;
   </script>
   ```

2. **`static/app.js`** \u2014 Se reescribi\u00f3 el handler de WebSocket:

   **Token handler (antes):**
   ```javascript
   // O(n\u00b2) - re-parsea TODO en cada token
   assistantMessage.innerHTML = renderMarkdown(state.currentMessage, false);
   ```

   **Token handler (despu\u00e9s):**
   ```javascript
   // O(1) - solo procesa el nuevo token
   if (window.smd) {
       const renderer = window.smd.default_renderer(assistantMessage); // solo en primer token
       state._smdParser = window.smd.parser(renderer);
   }
   window.smd.parser_write(state._smdParser, data.content);
   ```

   **END handler (despu\u00e9s):**
   ```javascript
   // 1. Cambiar status INMEDIATAMENTE (s\u00edncrono)
   elements.chatStatus.textContent = 'En l\u00ednea';
   // 2. Flush del parser
   window.smd.parser_end(state._smdParser);
   // 3. Post-procesamiento (tablas, speaker, TTS)
   ```

3. **`static/app.js` estado global** \u2014 Se agreg\u00f3 `_smdParser: null` al objeto `state`.

4. **Fallback**: Si `window.smd` no est\u00e1 disponible (CDN ca\u00eddo), cae a `marked.parse()`.

**Librer\u00edas de referencia y documentaci\u00f3n:**
- [streaming-markdown (GitHub)](https://github.com/thetarnav/streaming-markdown)
- [Chrome DevRel: Best practices to render streamed LLM responses](https://developer.chrome.com/docs/ai/render-llm-responses)
- [Eliminate Redundant Markdown Parsing: 2-10x Faster](https://dev.to/kingshuaishuai/eliminate-redundant-markdown-parsing-typically-2-10x-faster-ai-streaming-4k94)
- [marked.js issue #3657: Handling incomplete markdown during streaming](https://github.com/markedjs/marked/issues/3657)

---

## v5.3.0 \u2014 v5.3.1 \u2014 2026-02-03

### AsyncOpenAI para streaming real

**Problema:**
El streaming de tokens desde Groq (Kimi K2) no era fluido. Los tokens llegaban todos
de golpe al final en vez de ir apareciendo progresivamente.

**Causa:**
`main.py` usaba `OpenAI` (s\u00edncrono) con `for chunk in stream:`. Esto bloqueaba el
event loop de asyncio/FastAPI, acumulando todos los tokens en buffer y envi\u00e1ndolos
de golpe cuando el stream terminaba.

**Soluci\u00f3n:**
Se cambi\u00f3 a `AsyncOpenAI` con `async for chunk in stream:`, permitiendo que cada token
se env\u00ede al WebSocket inmediatamente al llegar de Groq.

```python
# Antes (bloqueante):
from openai import OpenAI
stream = llm_client.chat.completions.create(..., stream=True)
for chunk in stream:
    token = chunk.choices[0].delta.content

# Despu\u00e9s (async, no bloquea event loop):
from openai import AsyncOpenAI
stream = await llm_client.chat.completions.create(..., stream=True)
async for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        token = chunk.choices[0].delta.content
```

**Guard de chunks vac\u00edos:**
Se a\u00f1adi\u00f3 `chunk.choices and chunk.choices[0].delta.content` como guardia, ya que
algunos chunks de Groq llegan con `choices=[]` o `delta.content=None`.

**Verificaci\u00f3n con test WebSocket:**
```
puro_omega (sync):  419 tokens, todos llegan a 3.1s (burst de 0.01s)
novacutan (async):  403 tokens, distribuidos de 0.52s a 1.75s (streaming real de 1.23s)
```

---

## v3.0 \u2014 2026-02-02/03

### Creaci\u00f3n del proyecto Novacutan

El proyecto se cre\u00f3 duplicando `puro_omega/` y adaptando todo para la marca Novacutan:

| Campo | Puro Omega | Novacutan |
|-------|-----------|-----------|
| Asistente IA | Omia | **Novia** |
| Wake word | "Hola, Omia" | **"Hola, Novia"** |
| Usuario demo | Pablo | **Jos\u00e9 Luis** |
| Puerto | 7860 | **7862** |
| Marca | Puro Omega | **Novacutan** |
| Productos | Omega-3, EPA/DHA | **BioPRO, FBio DVS Light/Medium/Volume** |

### Archivos creados/adaptados

- **`main.py`** \u2014 Backend FastAPI con WebSocket, TTS proxy, STT, sistema de agentes
- **`knowledge_base.json`** \u2014 ~130 pares Q&A extra\u00eddos de `GUIA_OPERATIVA_CHATBOT_NOVACUTAN.md`
  - Categor\u00edas: empresa_marca, tecnologia_dvs, productos_biopro, productos_fbio_dvs,
    protocolos_aplicacion, comparativas_competencia, objeciones, argumentos_venta,
    seguridad_contraindicaciones, complicaciones, cuidados_post
- **`static/index.html`** \u2014 UI completa con login, chat, mood slider, FAQ chips
- **`static/app.js`** \u2014 L\u00f3gica del cliente: WebSocket, voz, wake word, streaming
- **`static/manifest.json`** \u2014 PWA manifest para Novacutan
- **`agents/rag_engine.py`** \u2014 Motor RAG con stemming espa\u00f1ol, sin\u00f3nimos espec\u00edficos
  de medicina est\u00e9tica (DVS, BDDE, biomodulador, c\u00e1nula, etc.)
- **`agents/agent_productos.py`** \u2014 Mapeo condici\u00f3n \u2192 producto Novacutan
- **`agents/agent_objeciones.py`** \u2014 Manejo de objeciones de medicina est\u00e9tica
- **`agents/agent_argumentos.py`** \u2014 Argumentos por especialidad m\u00e9dica
- **`agents/orchestrator.py`** \u2014 Router de intenciones adaptado a terminolog\u00eda Novacutan
- **`agents/base_agent.py`** \u2014 Clase base con contexto RAG verificado
- **`Dockerfile`** \u2014 Para despliegue en Hugging Face Spaces (puerto 7862)
- **`requirements.txt`** \u2014 Dependencias: FastAPI, uvicorn, openai, groq, httpx, numpy
- **`.gitignore`** \u2014 Excluye __pycache__, .env, .DS_Store, PDFs/DOCX

---

## Notas t\u00e9cnicas

### Stack tecnol\u00f3gico
- **Backend**: FastAPI + WebSocket + AsyncOpenAI
- **LLM**: Groq API (Kimi K2 o Llama 3.3 como respaldo)
- **STT**: Groq Whisper
- **TTS**: ElevenLabs (voz Camila MX)
- **Frontend**: Vanilla JS + streaming-markdown + marked.js (fallback) + DOMPurify
- **RAG**: Motor custom con stemming espa\u00f1ol, sin\u00f3nimos, b\u00fasqueda h\u00edbrida (keyword + embedding)

### Modelo LLM actual
`llama-3.3-70b-versatile` (respaldo temporal mientras Kimi K2 `moonshotai/kimi-k2-instruct`
tiene sobrecarga 503 en Groq). Para volver a Kimi K2, cambiar `LLM_MODEL` en `main.py` l\u00ednea 36.

### Credenciales de prueba
- Usuario: Jos\u00e9 Luis / Contrase\u00f1a: Prisma (configurado en app.js)

### Puertos
- Novacutan: 7862
- Puro Omega: 7860

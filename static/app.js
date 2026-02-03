/**
 * Novia - App Principal Novacutan
 * Chat con voz y transiciones
 */

// Configuración del mood
const MOOD_CONFIG = {
    labels: [
        { min: 0,  max: 30,  label: 'MAL',         category: 'sad' },
        { min: 31, max: 65,  label: 'NO MUY BIEN',  category: 'neutral' },
        { min: 66, max: 100, label: 'BIEN',          category: 'happy' }
    ],
    reactions: {
        sad:     'Lamento que no te encuentres bien. Estoy aquí para ayudarte en lo que necesites.',
        neutral: 'Gracias por compartirlo. Vamos a hacer que tu día mejore.',
        happy:   'Me alegra saber que estás bien. Sigamos con energía.'
    },
    orbPresets: {
        sad: 'a',
        neutral: 'b',
        happy: 'c'
    },
    // Colores dinámicos del overlay — bg (fondo) y fg (textos/iconos)
    // Tres stops: 0 = sad, 50 = neutral, 100 = happy
    colors: {
        stops: [
            { at: 0,   bg: [235, 168, 157], fg: [120, 40, 30]  },   // Salmón / coral
            { at: 50,  bg: [245, 215, 140], fg: [100, 75, 20]  },   // Dorado / ámbar
            { at: 100, bg: [220, 200, 240], fg: [60, 10, 55]   }    // Lavanda cálido
        ]
    }
};

// Estado global
const state = {
    isRecording: false,
    mediaRecorder: null,
    audioChunks: [],
    websocket: null,
    currentMessage: '',
    orbMode: 'minimize', // Opción fija: orb minimizado flotante en chat
    audioStream: null,
    cachedMicStream: null,  // Cached mic stream to avoid repeated permission prompts
    // Silence detection
    audioContext: null,
    analyser: null,
    silenceTimer: null,
    // Wake word
    wakeWordEnabled: false,
    wakeWordRecognition: null,
    wakeWordActive: false, // true while SpeechRecognition is running
    // Voice interaction flow
    voiceTriggered: false,      // true when interaction was initiated by voice
    awaitingVoiceMode: null,    // pending message waiting for mode selection by voice
    voiceModeTimeout: null,     // timeout for auto-sending if no voice response
    voiceModeRecording: false,  // true when recording mode answer (longer silence detection)
    // iOS audio unlock
    iosAudioElement: null,      // pre-created Audio element for iOS
    // Streaming markdown parser (smd)
    _smdParser: null,
    // Mood
    mood: {
        value: 100,
        label: 'BIEN',
        category: 'happy',
        submitted: false,
        timestamp: null
    }
};

// Elementos
const elements = {
    // Login screen
    loginScreen: document.getElementById('login-screen'),
    loginUser: document.getElementById('login-user'),
    loginPassword: document.getElementById('login-password'),
    loginBtn: document.getElementById('login-btn'),
    faceidBtn: document.getElementById('faceid-btn'),
    loginOrbContainer: document.getElementById('login-orb-container'),

    // Welcome screen
    welcomeScreen: document.getElementById('welcome-screen'),
    profileBtn: document.getElementById('profile-btn'),
    messageInput: document.getElementById('message-input'),
    // Bento cards
    orbCard: document.getElementById('orb-card'),
    moodCard: document.getElementById('mood-card'),
    planCard: document.getElementById('plan-card'),
    faqSection: document.getElementById('faq-section'),

    // Chat screen
    chatScreen: document.getElementById('chat-screen'),
    backBtn: document.getElementById('back-btn'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    chatPhotoBtn: document.getElementById('chat-photo-btn'),
    chatMicBtn: document.getElementById('chat-mic-btn'),
    chatSendBtn: document.getElementById('chat-send-btn'),
    chatStatus: document.getElementById('chat-status'),

    // Plan screen
    planScreen: document.getElementById('plan-screen'),
    planBackBtn: document.getElementById('plan-back-btn'),
    planOverviewChips: document.querySelectorAll('.plan-filter-chip'),
    navChatBtn: document.getElementById('nav-chat-btn'),
    navOrb: document.getElementById('nav-orb'),

    // Logout buttons (all screens)
    logoutBtn: document.getElementById('logout-btn'),
    chatLogoutBtn: document.getElementById('chat-logout-btn'),
    planLogoutBtn: document.getElementById('plan-logout-btn'),

    // Mood overlay
    moodOverlay: document.getElementById('mood-overlay'),
    moodCloseBtn: document.getElementById('mood-close-btn'),
    moodInfoBtn: document.getElementById('mood-info-btn'),
    moodSlider: document.getElementById('mood-slider'),
    moodLabel: document.getElementById('mood-label'),
    moodSubmitBtn: document.getElementById('mood-submit-btn'),
    moodReaction: document.getElementById('mood-reaction'),
    moodEyeLeft: document.getElementById('mood-eye-left'),
    moodEyeRight: document.getElementById('mood-eye-right'),
    moodMouth: document.getElementById('mood-mouth')
};

// ============================================
// Sistema de Mood
// ============================================
function lerpChannel(a, b, t) {
    return Math.round(a + (b - a) * t);
}

function getMoodColors(value) {
    const stops = MOOD_CONFIG.colors.stops;
    // Encontrar entre qué dos stops estamos
    let lower = stops[0], upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (value >= stops[i].at && value <= stops[i + 1].at) {
            lower = stops[i];
            upper = stops[i + 1];
            break;
        }
    }
    const range = upper.at - lower.at || 1;
    const t = (value - lower.at) / range;
    const bg = [
        lerpChannel(lower.bg[0], upper.bg[0], t),
        lerpChannel(lower.bg[1], upper.bg[1], t),
        lerpChannel(lower.bg[2], upper.bg[2], t)
    ];
    const fg = [
        lerpChannel(lower.fg[0], upper.fg[0], t),
        lerpChannel(lower.fg[1], upper.fg[1], t),
        lerpChannel(lower.fg[2], upper.fg[2], t)
    ];
    return {
        bg: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`,
        fg: `rgb(${fg[0]}, ${fg[1]}, ${fg[2]})`
    };
}

function applyMoodColors(value) {
    if (!elements.moodOverlay) return;
    const colors = getMoodColors(value);
    elements.moodOverlay.style.setProperty('--mood-bg', colors.bg);
    elements.moodOverlay.style.setProperty('--mood-fg', colors.fg);
}

// Tintado sutil global — aplica una capa muy tenue del mood a toda la app
function applyGlobalMoodTint(value) {
    const stops = MOOD_CONFIG.colors.stops;
    let lower = stops[0], upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (value >= stops[i].at && value <= stops[i + 1].at) {
            lower = stops[i];
            upper = stops[i + 1];
            break;
        }
    }
    const range = upper.at - lower.at || 1;
    const t = (value - lower.at) / range;
    const r = lerpChannel(lower.bg[0], upper.bg[0], t);
    const g = lerpChannel(lower.bg[1], upper.bg[1], t);
    const b = lerpChannel(lower.bg[2], upper.bg[2], t);

    document.body.style.setProperty('--mood-tint', `${r}, ${g}, ${b}`);
    document.body.style.setProperty('--mood-tint-strength', '0.07'); // 7% — apenas perceptible
    document.body.setAttribute('data-mood-active', '');

    // Propagar al orb si la API existe
    if (window.orbSetMoodTint) {
        window.orbSetMoodTint(r, g, b);
    }
}

function getMoodCategory(value) {
    for (const cfg of MOOD_CONFIG.labels) {
        if (value >= cfg.min && value <= cfg.max) {
            return { label: cfg.label, category: cfg.category };
        }
    }
    return { label: 'BIEN', category: 'happy' };
}

function updateMoodFace(value) {
    const t = value / 100; // 0 = sad, 1 = happy

    // Ojos redondos: rx=12 siempre, ry varía poco (14 sad → 11 happy squint suave)
    const eyeRx = 12;
    const eyeRy = 14 - 3 * t;    // 14 → 11 (sutil, siempre redondos)
    const eyeCy = 40 + 2 * t;    // 40 → 42 (movimiento mínimo)

    if (elements.moodEyeLeft) {
        elements.moodEyeLeft.setAttribute('rx', eyeRx);
        elements.moodEyeLeft.setAttribute('ry', eyeRy);
        elements.moodEyeLeft.setAttribute('cy', eyeCy);
    }
    if (elements.moodEyeRight) {
        elements.moodEyeRight.setAttribute('rx', eyeRx);
        elements.moodEyeRight.setAttribute('ry', eyeRy);
        elements.moodEyeRight.setAttribute('cy', eyeCy);
    }

    // Boca: controlY de 58 (frown suave) a 78 (smile)
    const controlY = 58 + 20 * t;
    if (elements.moodMouth) {
        elements.moodMouth.setAttribute('d', `M42 68 Q50 ${controlY} 58 68`);
    }
}

function updateCardFace(value) {
    const t = value / 100;
    const eyeRx = 12;
    const eyeRy = 14 - 3 * t;
    const eyeCy = 40 + 2 * t;
    const controlY = 58 + 20 * t;

    // Actualizar la cara en la tarjeta del bento grid
    const card = elements.moodCard;
    if (!card) return;

    const eyeL = card.querySelector('ellipse:first-of-type');
    const eyeR = card.querySelector('ellipse:last-of-type');
    const mouth = card.querySelector('path');

    if (eyeL) { eyeL.setAttribute('rx', eyeRx); eyeL.setAttribute('ry', eyeRy); eyeL.setAttribute('cy', eyeCy); }
    if (eyeR) { eyeR.setAttribute('rx', eyeRx); eyeR.setAttribute('ry', eyeRy); eyeR.setAttribute('cy', eyeCy); }
    if (mouth) { mouth.setAttribute('d', `M42 68 Q50 ${controlY} 58 68`); }
}

function updateMoodLabel(value) {
    const { label } = getMoodCategory(value);
    if (elements.moodLabel) {
        elements.moodLabel.textContent = label;
    }
}

function openMoodOverlay() {
    if (!elements.moodOverlay) return;

    // Resetear estado visual
    elements.moodReaction.textContent = '';
    elements.moodReaction.classList.remove('visible');
    elements.moodSubmitBtn.disabled = false;
    elements.moodSubmitBtn.textContent = state.mood.submitted ? 'Actualizar' : 'Enviar';

    // Poner slider en el valor actual
    elements.moodSlider.value = state.mood.value;
    updateMoodFace(state.mood.value);
    updateMoodLabel(state.mood.value);
    applyMoodColors(state.mood.value);

    // Mostrar overlay con animación
    elements.moodOverlay.classList.remove('hidden');
    elements.moodOverlay.style.animation = 'moodOverlayEnter 0.4s var(--md-sys-motion-easing-emphasized-decelerate) forwards';
}

function closeMoodOverlay() {
    if (!elements.moodOverlay) return;

    elements.moodOverlay.style.animation = 'moodOverlayExit 0.3s var(--md-sys-motion-easing-emphasized-accelerate) forwards';
    elements.moodOverlay.addEventListener('animationend', function handler() {
        elements.moodOverlay.classList.add('hidden');
        elements.moodOverlay.style.animation = '';
        elements.moodOverlay.removeEventListener('animationend', handler);
    });
}

function onMoodSliderInput(e) {
    const value = parseInt(e.target.value, 10);
    updateMoodFace(value);
    updateMoodLabel(value);
    applyMoodColors(value);
}

function submitMood() {
    const value = parseInt(elements.moodSlider.value, 10);
    const { label, category } = getMoodCategory(value);
    const wasAlreadySubmitted = state.mood.submitted;

    // Actualizar estado
    state.mood.value = value;
    state.mood.label = label;
    state.mood.category = category;
    state.mood.submitted = true;
    state.mood.timestamp = Date.now();

    // Propagar a la tarjeta
    updateCardFace(value);
    const cardTitle = elements.moodCard?.querySelector('.bento-card__title');
    if (cardTitle) {
        cardTitle.textContent = `Hoy: ${label}`;
    }

    // Propagar al orb
    const orbPreset = MOOD_CONFIG.orbPresets[category];
    if (window.orbSetMoodPreset) window.orbSetMoodPreset(orbPreset);

    // Aplicar tintado global sutil
    applyGlobalMoodTint(value);

    // Guardar en localStorage
    saveMoodToStorage();

    // Mostrar reacción AI
    const reaction = wasAlreadySubmitted
        ? 'Actualizado. ' + MOOD_CONFIG.reactions[category]
        : MOOD_CONFIG.reactions[category];
    elements.moodReaction.textContent = reaction;
    elements.moodReaction.classList.add('visible');
    elements.moodSubmitBtn.disabled = true;

    // Cerrar overlay tras 2 segundos
    setTimeout(() => {
        closeMoodOverlay();
    }, 2000);
}

// Fecha local YYYY-MM-DD (sin depender de UTC)
function getLocalDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveMoodToStorage() {
    const data = {
        value: state.mood.value,
        label: state.mood.label,
        category: state.mood.category,
        date: getLocalDateStr(),
        timestamp: state.mood.timestamp
    };
    localStorage.setItem('novacutan_mood', JSON.stringify(data));
}

function loadMoodFromStorage() {
    try {
        const raw = localStorage.getItem('novacutan_mood');
        if (!raw) return;

        const data = JSON.parse(raw);
        const today = getLocalDateStr();

        // Reset diario: si es otro día, borrar y empezar de cero
        if (data.date !== today) {
            const utcToday = new Date().toISOString().slice(0, 10);
            if (data.date !== utcToday) {
                localStorage.removeItem('novacutan_mood');
                return;
            }
        }

        // Solo restaurar estado interno (para enviar mood en WebSocket)
        // La UI siempre arranca limpia con la pregunta "¿Cómo te encuentras hoy?"
        state.mood.value = data.value;
        state.mood.label = data.label;
        state.mood.category = data.category;
        state.mood.submitted = true;
        state.mood.timestamp = data.timestamp;

    } catch (e) {
        console.error('Error cargando mood:', e);
    }
}

// ============================================
// Búsquedas Recientes
// ============================================
const RECENT_SEARCHES_KEY = 'novacutan_recent_searches';
const MAX_RECENT_SEARCHES = 10;

// Iconos según tipo de búsqueda
const SEARCH_ICONS = {
    product:   'package',
    objection: 'shield',
    argument:  'trend-up',
    voice:     'microphone',
    default:   'clock'
};

function classifySearchIcon(query) {
    const q = query.toLowerCase();
    if (/producto|novacutan|biopro|fbio|dvs|hialuronic|relleno/i.test(q)) return 'product';
    if (/objeción|objecion|caro|no funciona|otra marca|profhilo/i.test(q)) return 'objection';
    if (/argumento|venta|presentar|dermatólogo|cirujano|perfil|ventaja/i.test(q)) return 'argument';
    return 'default';
}

function getSearchDescription(query) {
    const type = classifySearchIcon(query);
    switch (type) {
        case 'product':   return 'Consulta sobre productos Novacutan';
        case 'objection': return 'Manejo de objeciones médicas';
        case 'argument':  return 'Estrategia de argumentación comercial';
        default:          return 'Conversación con el asistente';
    }
}

function loadRecentSearches() {
    try {
        const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

/**
 * Sincroniza el historial con el servidor (carga desde servidor si hay datos más recientes)
 */
async function syncSearchHistory() {
    const username = localStorage.getItem('novia_user');
    if (!username) return;

    try {
        const response = await fetch('/api/history/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.searches && data.searches.length > 0) {
                const localSearches = loadRecentSearches();
                const localTimestamp = localSearches.length > 0
                    ? Math.max(...localSearches.map(s => s.timestamp || 0))
                    : 0;

                // Si el servidor tiene datos más recientes, usarlos
                if (data.last_sync > localTimestamp) {
                    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(data.searches));
                    console.log('[Sync] Loaded', data.searches.length, 'searches from server');
                    renderRecentSearches();
                } else {
                    // Local es más reciente, subir al servidor
                    await pushSearchHistory();
                }
            }
        }
    } catch (e) {
        console.log('[Sync] Could not sync with server:', e.message);
    }
}

/**
 * Sube el historial local al servidor
 */
async function pushSearchHistory() {
    const username = localStorage.getItem('novia_user');
    if (!username) return;

    const searches = loadRecentSearches();
    if (searches.length === 0) return;

    try {
        await fetch('/api/history/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, searches })
        });
        console.log('[Sync] Pushed', searches.length, 'searches to server');
    } catch (e) {
        console.log('[Sync] Could not push to server:', e.message);
    }
}

function saveRecentSearch(query, isVoice = false) {
    const searches = loadRecentSearches();

    // No duplicar la misma consulta (case-insensitive)
    const idx = searches.findIndex(s => s.query.toLowerCase() === query.toLowerCase());
    if (idx !== -1) {
        searches.splice(idx, 1);
    }

    const icon = isVoice ? 'voice' : classifySearchIcon(query);
    const desc = getSearchDescription(query);

    searches.unshift({
        query,
        icon,
        desc,
        timestamp: Date.now()
    });

    // Limitar a MAX
    if (searches.length > MAX_RECENT_SEARCHES) {
        searches.length = MAX_RECENT_SEARCHES;
    }

    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
    renderRecentSearches();

    // Sincronizar con servidor (async, no bloqueante)
    pushSearchHistory();
}

/**
 * Actualiza la búsqueda reciente más reciente que coincida con la query,
 * añadiendo la respuesta completa del agente para persistencia.
 */
function updateRecentSearchAnswer(query, answer) {
    const searches = loadRecentSearches();
    const idx = searches.findIndex(s => s.query.toLowerCase() === query.toLowerCase());
    if (idx !== -1) {
        searches[idx].answer = answer;
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
        // Sincronizar con servidor
        pushSearchHistory();
    }
}

function renderRecentSearches() {
    const container = document.getElementById('recent-searches-list');
    const section = document.getElementById('recent-searches');
    const emptyMsg = document.getElementById('recent-searches-empty');
    if (!container || !section) return;

    const searches = loadRecentSearches();

    if (searches.length === 0) {
        section.classList.add('recent-searches--empty');
        if (emptyMsg) emptyMsg.style.display = '';
        container.innerHTML = '';
        return;
    }

    section.classList.remove('recent-searches--empty');
    if (emptyMsg) emptyMsg.style.display = 'none';
    container.innerHTML = '';

    // Mostrar hasta 5 en la pantalla principal
    const visible = searches.slice(0, 5);

    for (const item of visible) {
        const iconName = SEARCH_ICONS[item.icon] || SEARCH_ICONS.default;

        const el = document.createElement('button');
        el.className = 'recent-search-item';
        el.innerHTML = `
            <div class="recent-search-item__icon">
                <i class="ph ph-${iconName}"></i>
            </div>
            <div class="recent-search-item__text">
                <span class="recent-search-item__query">${escapeHtml(item.query)}</span>
                <span class="recent-search-item__desc">${escapeHtml(item.desc)}</span>
            </div>
            <div class="recent-search-item__arrow">
                <i class="ph ph-arrow-right"></i>
            </div>
        `;
        el.addEventListener('click', () => {
            if (item.answer) {
                showChatScreenWithAnswer(item.query, item.answer);
            } else {
                showChatScreen(item.query, isActionableQuery(item.query));
            }
        });
        container.appendChild(el);
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================
// Sistema de Plan — Datos y renderizado
// ============================================

// Tareas mock con fechas reales relativas a hoy (27 enero 2026)
const PLAN_TASKS = [
    // --- En proceso (fecha de hoy) ---
    { id: 1, title: 'Visita Dra. García — Dermatología', date: '2026-01-27', project: 'visitas', status: 'in_progress', tasks: 2, subtasks: 1 },
    { id: 2, title: 'Estudiar ficha BioPRO', date: '2026-01-27', project: 'formacion', status: 'in_progress', tasks: 1, subtasks: 0 },
    { id: 3, title: 'Preparar argumentario Cirugía Plástica', date: '2026-01-27', project: 'visitas', status: 'in_progress', tasks: 3, subtasks: 2 },
    // --- Por hacer (futuro cercano) ---
    { id: 4, title: 'Visita Dra. López — Pediatría', date: '2026-01-28', project: 'visitas', status: 'todo', tasks: 2, subtasks: 0 },
    { id: 5, title: 'Informe semanal de ventas', date: '2026-01-29', project: 'admin', status: 'todo', tasks: 1, subtasks: 0 },
    { id: 6, title: 'Llamada farmacia central', date: '2026-01-30', project: 'visitas', status: 'todo', tasks: 1, subtasks: 1 },
    { id: 7, title: 'Revisar catálogo FBio DVS', date: '2026-01-31', project: 'formacion', status: 'todo', tasks: 2, subtasks: 0 },
    { id: 8, title: 'Reunión equipo zona norte', date: '2026-02-02', project: 'admin', status: 'todo', tasks: 1, subtasks: 0 },
    { id: 9, title: 'Visita Dr. Fernández — Dermatología', date: '2026-02-03', project: 'visitas', status: 'todo', tasks: 2, subtasks: 1 },
    { id: 10, title: 'Actualizar CRM contactos', date: '2026-02-05', project: 'admin', status: 'todo', tasks: 1, subtasks: 0 },
    { id: 11, title: 'Preparar presentación BioPRO', date: '2026-02-07', project: 'formacion', status: 'todo', tasks: 3, subtasks: 2 },
    // --- Retrasadas (antes de hoy) ---
    { id: 12, title: 'Seguimiento Dr. Martínez', date: '2026-01-26', project: 'visitas', status: 'overdue', tasks: 1, subtasks: 1 },
    { id: 13, title: 'Completar módulo tecnología DVS', date: '2026-01-25', project: 'formacion', status: 'overdue', tasks: 2, subtasks: 0 },
    { id: 14, title: 'Enviar muestras Hospital Clínic', date: '2026-01-24', project: 'visitas', status: 'overdue', tasks: 1, subtasks: 0 },
    // --- Completadas ---
    { id: 15, title: 'Visita Dra. Ruiz — Cirugía Plástica', date: '2026-01-23', project: 'visitas', status: 'done', tasks: 2, subtasks: 1 },
    { id: 16, title: 'Curso online DVS vs BDDE', date: '2026-01-22', project: 'formacion', status: 'done', tasks: 1, subtasks: 0 },
];

// Proyectos con sus colores
const PLAN_PROJECTS = {
    visitas:   { label: 'Visitas médicas', color: 'var(--md-sys-color-primary)' },
    formacion: { label: 'Formación',       color: 'var(--md-sys-color-secondary)' },
    admin:     { label: 'Administración',  color: 'var(--md-sys-color-tertiary)' }
};

// Grupos de estado con config visual
const STATUS_GROUPS = [
    { key: 'in_progress', label: 'En proceso', dotClass: 'plan-task-group__dot--in-progress' },
    { key: 'todo',        label: 'Por hacer',  dotClass: 'plan-task-group__dot--todo' },
    { key: 'overdue',     label: 'Retrasadas', dotClass: 'plan-task-group__dot--overdue' },
    { key: 'done',        label: 'Completadas', dotClass: 'plan-task-group__dot--done' }
];

// Estado actual del filtro overview
let currentOverview = 'hoy';

// Nombres de meses en español
const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function formatTaskDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getDate()} ${MESES_CORTO[d.getMonth()]}`;
}

// Calcular rango de fechas según overview
function getOverviewRange(overview) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const end = new Date(today);

    switch (overview) {
        case 'hoy':
            end.setHours(23, 59, 59, 999);
            break;
        case 'semana':
            // Lunes a domingo de esta semana
            const dayOfWeek = today.getDay(); // 0=dom, 1=lun...
            const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
            end.setDate(today.getDate() + daysToSunday);
            end.setHours(23, 59, 59, 999);
            break;
        case 'quincena':
            end.setDate(today.getDate() + 14);
            end.setHours(23, 59, 59, 999);
            break;
    }

    return { today, end };
}

// Clasificar tareas según el overview seleccionado
// SOLO incluye tareas cuya fecha cae dentro del rango (o retrasadas/completadas relevantes)
function classifyTasks(overview) {
    const { today, end } = getOverviewRange(overview);

    const result = {
        in_progress: [],
        todo: [],
        overdue: [],
        done: []
    };

    for (const task of PLAN_TASKS) {
        const taskDate = new Date(task.date + 'T00:00:00');

        // Completadas: solo mostrar si su fecha cae dentro del rango
        if (task.status === 'done') {
            if (taskDate >= today && taskDate <= end) {
                result.done.push(task);
            }
            continue;
        }

        // Retrasadas: fecha anterior a hoy — siempre se muestran (son pendientes atrasadas)
        if (taskDate < today) {
            result.overdue.push(task);
            continue;
        }

        // Fuera del rango del overview: no mostrar
        if (taskDate > end) {
            continue;
        }

        // Dentro del rango: clasificar según su status original
        if (task.status === 'in_progress') {
            result.in_progress.push(task);
        } else {
            result.todo.push(task);
        }
    }

    return result;
}

// Aplicar filtros de la sección de tareas
function applyTaskFilters(classified) {
    const projectFilter = document.getElementById('filter-project')?.value || 'all';
    const statusFilter = document.getElementById('filter-status')?.value || 'all';

    const filtered = {};
    for (const [status, tasks] of Object.entries(classified)) {
        filtered[status] = tasks.filter(t => {
            if (projectFilter !== 'all' && t.project !== projectFilter) return false;
            if (statusFilter !== 'all' && status !== statusFilter) return false;
            return true;
        });
    }
    return filtered;
}

// Actualizar contadores de stat cards (solo tareas visibles en el overview)
function updatePlanStats(classified) {
    const el = (id) => document.getElementById(id);

    // Reunir todas las tareas visibles
    const allVisible = [
        ...classified.in_progress,
        ...classified.todo,
        ...classified.overdue,
        ...classified.done
    ];
    const visibleProjects = new Set(allVisible.map(t => t.project));

    if (el('stat-in-progress')) el('stat-in-progress').textContent = classified.in_progress.length;
    if (el('stat-todo'))        el('stat-todo').textContent = classified.todo.length;
    if (el('stat-overdue'))     el('stat-overdue').textContent = classified.overdue.length;
    if (el('stat-projects'))    el('stat-projects').textContent = visibleProjects.size;
    if (el('stat-total'))       el('stat-total').textContent = allVisible.length;
}

// Renderizar la lista de tareas agrupadas
function renderPlanTasks() {
    const container = document.getElementById('plan-tasks-list');
    if (!container) return;

    const classified = classifyTasks(currentOverview);

    // Actualizar stats
    updatePlanStats(classified);

    // Aplicar filtros de sección
    const filtered = applyTaskFilters(classified);

    // Limpiar
    container.innerHTML = '';

    // Renderizar cada grupo que tenga tareas
    for (const group of STATUS_GROUPS) {
        const tasks = filtered[group.key];
        if (!tasks || tasks.length === 0) continue;

        const groupDiv = document.createElement('div');
        groupDiv.className = 'plan-task-group';

        // Label del grupo
        const label = document.createElement('h3');
        label.className = 'plan-task-group__label';
        label.innerHTML = `<span class="plan-task-group__dot ${group.dotClass}"></span> ${group.label}`;
        groupDiv.appendChild(label);

        // Task cards
        for (const task of tasks) {
            const card = document.createElement('div');
            card.className = 'plan-task-card' + (group.key === 'overdue' ? ' plan-task-card--overdue' : '') + (group.key === 'done' ? ' plan-task-card--done' : '');
            card.dataset.status = group.key;
            card.dataset.project = task.project;

            const metaParts = [];
            if (task.tasks > 0) metaParts.push(`${task.tasks} tarea${task.tasks > 1 ? 's' : ''}`);
            if (task.subtasks > 0) metaParts.push(`${task.subtasks} sub-tarea${task.subtasks > 1 ? 's' : ''}`);

            card.innerHTML = `
                <div class="plan-task-card__left">
                    <span class="plan-task-card__date">${formatTaskDate(task.date)}</span>
                    <span class="plan-task-card__title">${task.title}</span>
                    <span class="plan-task-card__meta">
                        <i class="ph ph-check-circle"></i> ${metaParts.join(' · ')}
                    </span>
                </div>
                <button class="plan-task-card__menu" title="Opciones">
                    <i class="ph ph-dots-three-vertical"></i>
                </button>
            `;
            groupDiv.appendChild(card);
        }

        container.appendChild(groupDiv);
    }

    // Si no hay tareas
    if (container.children.length === 0) {
        container.innerHTML = '<p class="plan-tasks-empty">No hay tareas para este filtro</p>';
    }
}

// ============================================
// Navegación entre pantallas
// ============================================
function showChatScreen(initialMessage, showSelector = false, skipSend = false) {
    // Fade out welcome
    elements.welcomeScreen.classList.add('fade-out');

    setTimeout(() => {
        elements.welcomeScreen.classList.add('hidden');
        elements.welcomeScreen.classList.remove('fade-out');
        elements.chatScreen.classList.remove('hidden');

        // Crear orb en el header del chat
        if (window.orbCreateChatHeader) window.orbCreateChatHeader();

        // Añadir mensaje del usuario
        if (initialMessage) {
            addMessage(initialMessage, 'user');
            if (skipSend) {
                // Voice mode: ask mode by TTS after transition
                askResponseModeByVoice(initialMessage);
            } else if (showSelector) {
                showResponseModeSelector(initialMessage);
            } else {
                sendToWebSocket(initialMessage);
            }
        }

        // Focus en input
        elements.chatInput.focus();
    }, 300);
}

function showChatScreenWithAnswer(question, answer) {
    elements.welcomeScreen.classList.add('fade-out');

    // Guardar contexto previo para que el próximo mensaje lo envíe al backend
    state.priorContext = { question, answer };

    setTimeout(() => {
        elements.welcomeScreen.classList.add('hidden');
        elements.welcomeScreen.classList.remove('fade-out');
        elements.chatScreen.classList.remove('hidden');

        // Crear orb en el header del chat
        if (window.orbCreateChatHeader) window.orbCreateChatHeader();

        // Mostrar pregunta y respuesta hardcodeadas
        addMessage(question, 'user');
        addMessage(answer, 'assistant');

        elements.chatInput.focus();
    }, 300);
}

function showWelcomeScreen() {
    // Detener TTS inmediatamente al navegar atrás
    stopTTS();

    elements.chatScreen.classList.add('hidden');
    elements.planScreen?.classList.add('hidden');
    elements.welcomeScreen.classList.remove('hidden');

    // Limpiar chat
    elements.chatMessages.innerHTML = '';

    // Cerrar WebSocket si existe
    if (state.websocket) {
        state.websocket.close();
        state.websocket = null;
    }

    // Limpiar contexto previo
    state.priorContext = null;

    // Actualizar búsquedas recientes
    renderRecentSearches();
}

function showPlanScreen() {
    // Fade out welcome
    elements.welcomeScreen.classList.add('fade-out');

    setTimeout(() => {
        elements.welcomeScreen.classList.add('hidden');
        elements.welcomeScreen.classList.remove('fade-out');
        elements.planScreen.classList.remove('hidden');

        // Renderizar tareas con el overview actual
        renderPlanTasks();

        // Crear orb en el nav
        if (window.orbCreateNav) window.orbCreateNav();
    }, 300);
}

function showWelcomeFromPlan() {
    stopTTS();
    elements.planScreen.classList.add('hidden');
    elements.welcomeScreen.classList.remove('hidden');
    renderRecentSearches();
}

function showChatFromPlan() {
    elements.planScreen.classList.add('hidden');
    elements.chatScreen.classList.remove('hidden');
    // Crear orb en el header del chat
    if (window.orbCreateChatHeader) window.orbCreateChatHeader();
}

// ============================================
// Markdown rendering + Phosphor icon enrichment
// ============================================

// Map of keywords to Phosphor icon names for semantic enrichment
const ICON_MAP_HEADERS = {
    // Product-related
    'producto':     'package',
    'productos':    'package',
    'novacutan':    'drop',
    'biopro':       'drop',
    'bio pro':      'drop',
    'fbio':         'syringe',
    'dvs':          'drop',
    'hialuronico':  'drop',
    'composición':  'flask',
    'composicion':  'flask',
    'ingrediente':  'flask',
    'formulación':  'flask',
    'formulacion':  'flask',
    // Clinical / medical
    'indicación':   'heartbeat',
    'indicacion':   'heartbeat',
    'indicaciones': 'heartbeat',
    'clínic':       'heartbeat',
    'clinic':       'heartbeat',
    'dosis':        'eyedropper',
    'dosificación': 'eyedropper',
    'posología':    'eyedropper',
    'beneficio':    'star',
    'beneficios':   'star',
    'ventaja':      'star',
    'ventajas':     'star',
    // Quality & tech
    'calidad':      'seal-check',
    'certificación':'seal-check',
    'certificacion':'seal-check',
    'tecnología':   'gear',
    'tecnologia':   'gear',
    'rtg':          'gear',
    'pureza':       'shield-check',
    'seguridad':    'shield-check',
    // Sales
    'argumento':    'megaphone',
    'argumentos':   'megaphone',
    'venta':        'trend-up',
    'ventas':       'trend-up',
    'estrategia':   'strategy',
    'presentación': 'presentation-chart',
    'presentacion': 'presentation-chart',
    // Objections
    'objeción':     'shield',
    'objecion':     'shield',
    'objeciones':   'shield',
    'precio':       'currency-circle-dollar',
    'costo':        'currency-circle-dollar',
    'coste':        'currency-circle-dollar',
    'eficacia':     'chart-line-up',
    'resultado':    'chart-line-up',
    'resultados':   'chart-line-up',
    // Medical specialties
    'cardio':       'heart',
    'cardiología':  'heart',
    'cardiologia':  'heart',
    'ginecología':  'gender-female',
    'ginecologia':  'gender-female',
    'neurología':   'brain',
    'neurologia':   'brain',
    'pediatría':    'baby',
    'pediatria':    'baby',
    'psiquiatría':  'brain',
    'psiquiatria':  'brain',
    'reumatología': 'bone',
    'reumatologia': 'bone',
    // Specialist
    'especialista': 'user-circle',
    'médico':       'stethoscope',
    'medico':       'stethoscope',
    'doctor':       'stethoscope',
    'paciente':     'user',
    'perfil':       'user-focus',
    // Sections
    'reconocimiento': 'handshake',
    'reencuadre':     'arrows-clockwise',
    'guion':          'quotes',
    'guión':          'quotes',
    'script':         'quotes',
    'datos clave':    'chart-bar',
    'evidencia':      'article',
    'estudio':        'book-open-text',
    'estudios':       'book-open-text',
    'referencia':     'book-open-text',
    'comparativa':    'scales',
    'comparación':    'scales',
    'comparacion':    'scales',
    'diferencia':     'scales',
    'diferenciación': 'star-four',
    'diferenciacion': 'star-four',
    'conclusión':     'check-circle',
    'conclusion':     'check-circle',
    'resumen':        'list-bullets',
    'recomendación':  'lightbulb',
    'recomendacion':  'lightbulb',
    'tip':            'lightbulb',
    'nota':           'note',
    'importante':     'warning-circle',
    'advertencia':    'warning',
    'interacción':    'warning',
    'interaccion':    'warning',
    'contraindicación': 'prohibit'
};

// Icon for table header cells based on content
const ICON_MAP_TABLE = {
    'producto':       'package',
    'nombre':         'tag',
    'composición':    'flask',
    'composicion':    'flask',
    'dosis':          'eyedropper',
    'concentración':  'flask',
    'concentracion':  'flask',
    'indicación':     'heartbeat',
    'indicacion':     'heartbeat',
    'presentación':   'pill',
    'presentacion':   'pill',
    'precio':         'currency-circle-dollar',
    'beneficio':      'star',
    'ventaja':        'star',
    'característica': 'check-circle',
    'caracteristica': 'check-circle',
    'aspecto':        'list-bullets',
    'dato':           'chart-bar',
    'detalle':        'info',
    'componente':     'flask',
    'vlift':          'activity',
    'dlift':          'activity',
    'forma':          'shapes',
    'certificación':  'seal-check',
    'certificacion':  'seal-check',
    'paso':           'number-circle-one',
    'acción':         'lightning',
    'accion':         'lightning',
    'argumento':      'megaphone',
    'objeción':       'shield',
    'objecion':       'shield',
    'respuesta':      'chat-circle-text'
};

/**
 * Find the best matching Phosphor icon for a text string.
 */
function findIconForText(text, iconMap) {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const lowerOriginal = text.toLowerCase();

    // Try exact or partial match
    for (const [keyword, icon] of Object.entries(iconMap)) {
        const kwNorm = keyword.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (lowerOriginal.includes(keyword) || lower.includes(kwNorm)) {
            return icon;
        }
    }
    return null;
}

/**
 * Post-process rendered HTML to inject Phosphor icons at semantic points.
 * - Before h2/h3 headings
 * - In table header cells
 * - Before blockquotes (as a quote icon)
 * - Before list items (subtle icon for key terms)
 */
function enrichWithIcons(html) {
    const container = document.createElement('div');
    container.innerHTML = html;

    // 1. Headings — inject icon before text
    container.querySelectorAll('h2, h3').forEach(heading => {
        const text = heading.textContent;
        const icon = findIconForText(text, ICON_MAP_HEADERS);
        if (icon) {
            const iconEl = document.createElement('i');
            iconEl.className = `ph ph-${icon} md-icon-heading`;
            heading.insertBefore(iconEl, heading.firstChild);
            // Add a space after icon
            heading.insertBefore(document.createTextNode(' '), iconEl.nextSibling);
        }
    });

    // 2. Table header cells — inject icon before text
    container.querySelectorAll('thead th').forEach(th => {
        const text = th.textContent;
        const icon = findIconForText(text, ICON_MAP_TABLE);
        if (icon) {
            const iconEl = document.createElement('i');
            iconEl.className = `ph ph-${icon} md-icon-th`;
            th.insertBefore(iconEl, th.firstChild);
            th.insertBefore(document.createTextNode(' '), iconEl.nextSibling);
        }
    });

    // 3. Blockquotes — add quote icon at the start
    container.querySelectorAll('blockquote').forEach(bq => {
        const firstP = bq.querySelector('p') || bq;
        if (!firstP.querySelector('.md-icon-bq')) {
            const iconEl = document.createElement('i');
            iconEl.className = 'ph ph-quotes md-icon-bq';
            firstP.insertBefore(iconEl, firstP.firstChild);
            firstP.insertBefore(document.createTextNode(' '), iconEl.nextSibling);
        }
    });

    // 4. Strong text inside list items — add contextual icon
    container.querySelectorAll('li').forEach(li => {
        const strong = li.querySelector('strong');
        if (strong) {
            const icon = findIconForText(strong.textContent, ICON_MAP_HEADERS);
            if (icon) {
                const iconEl = document.createElement('i');
                iconEl.className = `ph ph-${icon} md-icon-li`;
                li.insertBefore(iconEl, li.firstChild);
                li.insertBefore(document.createTextNode(' '), iconEl.nextSibling);
            }
        }
    });

    // 5. Source badge — replace external source markers with visual badge
    const GENERAL_MARKERS = [
        '(fuente externa no empresarial)',
        '(fuente externa no empresarial)',
        '*(fuente externa no empresarial)*',
        // Legacy markers (backward compat)
        '(información de la web)',
        '(informacion de la web)',
        '*(información de la web)*',
        '*(informacion de la web)*',
        '(conocimiento científico general)',
        '(conocimiento cientifico general)',
        '*(conocimiento científico general)*',
        '*(conocimiento cientifico general)*'
    ];
    const badgeHTML = '<span class="source-badge-general" tabindex="0"><i class="ph ph-warning-circle"></i> Fuente externa</span>';

    let finalHTML = container.innerHTML;
    for (const marker of GENERAL_MARKERS) {
        // Replace both the <em> wrapped version and raw text version
        const emWrapped = `<em>${marker.replace(/^\*|\*$/g, '')}</em>`;
        if (finalHTML.includes(emWrapped)) {
            finalHTML = finalHTML.split(emWrapped).join(badgeHTML);
        }
        if (finalHTML.includes(marker)) {
            finalHTML = finalHTML.split(marker).join(badgeHTML);
        }
    }

    // 6. Wrap tables in responsive scroll container
    finalHTML = finalHTML.replace(/<table([\s\S]*?)<\/table>/gi, (match) => {
        return `<div class="table-responsive">${match}</div>`;
    });

    // 7. Wrap "Ficha Técnica" section in a card div
    // Detects any <h3> containing "Ficha Técnica" — wraps from that h3 to the next <h2>/<h3> or end
    finalHTML = finalHTML.replace(
        /(<h3[^>]*>(?:[^<]*(?:<[^>]*>)*)*?[Ff]icha\s+[Tt][eé]cnica[\s\S]*?)(?=<h[23][^>]*>|$)/i,
        (fichaBlock) => {
            return `<div class="ficha-tecnica">${fichaBlock}</div>`;
        }
    );

    return finalHTML;
}

/**
 * Render markdown to HTML.
 * @param {string} text - raw markdown
 * @param {boolean} enrich - if true, inject Phosphor icons (use false during streaming for performance)
 */
function renderMarkdown(text, enrich = true) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        const html = marked.parse(text);
        const clean = DOMPurify.sanitize(html);
        return enrich ? enrichWithIcons(clean) : clean;
    }
    // Fallback: escape HTML
    return escapeHtml(text);
}

function stripMarkdown(text) {
    return text
        .replace(/#{1,6}\s+/g, '')           // headers
        .replace(/\*\*(.+?)\*\*/g, '$1')     // bold
        .replace(/\*(.+?)\*/g, '$1')         // italic
        .replace(/_(.+?)_/g, '$1')           // italic alt
        .replace(/~~(.+?)~~/g, '$1')         // strikethrough
        .replace(/`(.+?)`/g, '$1')           // inline code
        .replace(/```[\s\S]*?```/g, '')      // code blocks
        .replace(/>\s+/g, '')                // blockquotes
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
        .replace(/\|[^\n]+\|/g, '')          // table rows
        .replace(/[-|]+\s*/g, '')            // table separators
        .replace(/[-*+]\s+/g, '')            // unordered lists
        .replace(/\d+\.\s+/g, '')            // ordered lists
        .replace(/\n{2,}/g, '. ')            // double newlines to period
        .replace(/\n/g, ' ')                 // single newlines to space
        .replace(/\s{2,}/g, ' ')             // collapse spaces
        .trim();
}

// ============================================
// Responsive tables — scroll hints
// ============================================
/**
 * Initialise scroll-hint classes on .table-responsive wrappers
 * inside a given container (message element).
 */
function initResponsiveTables(container) {
    if (!container) return;
    container.querySelectorAll('.table-responsive').forEach(wrapper => {
        const update = () => {
            const { scrollLeft, scrollWidth, clientWidth } = wrapper;
            const scrollable = scrollWidth > clientWidth + 1;
            wrapper.classList.toggle('is-scrollable', scrollable && scrollLeft < 4);
            wrapper.classList.toggle('scrolled-mid', scrollable && scrollLeft >= 4 && scrollLeft + clientWidth < scrollWidth - 4);
            wrapper.classList.toggle('scrolled-end', scrollable && scrollLeft + clientWidth >= scrollWidth - 4);
        };
        wrapper.addEventListener('scroll', update, { passive: true });
        // Initial check (schedule to run after layout)
        requestAnimationFrame(update);
    });
}

// ============================================
// Mensajes del chat
// ============================================
function addMessage(text, role) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    if (role === 'assistant' && text) {
        messageDiv.innerHTML = renderMarkdown(text);
    } else {
        messageDiv.textContent = text;
    }

    if (role === 'assistant') {
        // Wrapper: orb arriba + burbuja abajo
        const row = document.createElement('div');
        row.className = 'message-row assistant';
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        // Crear orb animado real dentro del avatar
        if (window.orbCreateInElement) {
            window.orbCreateInElement(avatar, 28);
        }
        row.appendChild(avatar);
        row.appendChild(messageDiv);
        elements.chatMessages.appendChild(row);
    } else {
        elements.chatMessages.appendChild(messageDiv);
    }

    // Init responsive table wrappers
    initResponsiveTables(messageDiv);

    // Scroll al final
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    return messageDiv;
}

/**
 * Inserta un banner de advertencia cuando la cobertura RAG es baja o media.
 * Se muestra antes de la respuesta del asistente.
 */
function insertRagCoverageWarning(coverage, maxScore) {
    const warning = document.createElement('div');
    const isLow = coverage === 'low';

    warning.className = `rag-coverage-warning ${isLow ? 'rag-coverage-warning--low' : 'rag-coverage-warning--medium'}`;

    if (isLow) {
        warning.innerHTML = `
            <div class="rag-coverage-warning__icon">
                <i class="ph ph-warning-circle"></i>
            </div>
            <div class="rag-coverage-warning__content">
                <strong>Fuentes externas</strong>
                <span>Esta consulta no está cubierta en la base de conocimiento de Novacutan. La respuesta usa información externa general.</span>
            </div>
        `;
    } else {
        warning.innerHTML = `
            <div class="rag-coverage-warning__icon">
                <i class="ph ph-info"></i>
            </div>
            <div class="rag-coverage-warning__content">
                <strong>Cobertura parcial</strong>
                <span>Parte de esta respuesta puede incluir información de fuentes externas, marcada con el indicador correspondiente.</span>
            </div>
        `;
    }

    elements.chatMessages.appendChild(warning);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function addTypingIndicator() {
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    row.id = 'typing-indicator';
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    if (window.orbCreateInElement) {
        window.orbCreateInElement(avatar, 28);
    }
    const indicator = document.createElement('div');
    indicator.className = 'message assistant typing';
    indicator.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    row.appendChild(avatar);
    row.appendChild(indicator);
    elements.chatMessages.appendChild(row);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    return indicator;
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
}

// ============================================
// WebSocket
// ============================================
function sendToWebSocket(message, responseMode = 'full') {
    // Mostrar indicador de escritura
    addTypingIndicator();
    elements.chatStatus.textContent = 'Escribiendo...';

    state.currentMessage = '';
    state.currentQuery = message; // Guardar query para persistencia

    // Variable local para rastrear el mensaje del asistente de esta solicitud
    let assistantMessage = null;

    // Función para enviar el mensaje
    const sendMessage = () => {
        const payload = { message, response_mode: responseMode };
        if (state.mood.submitted) {
            payload.mood = {
                value: state.mood.value,
                label: state.mood.label,
                category: state.mood.category
            };
        }
        // Enviar contexto previo (chat guardado) para que el backend tenga historial
        if (state.priorContext) {
            payload.prior_context = state.priorContext;
            console.log('[WS] Enviando prior_context:', state.priorContext.question?.substring(0, 50));
            state.priorContext = null; // Solo enviar una vez
        }
        console.log('[WS] Payload keys:', Object.keys(payload).join(', '));
        state.websocket.send(JSON.stringify(payload));
    };

    // Función para manejar mensajes entrantes
    const handleMessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'token') {
            // Quitar indicador de escritura en el primer token
            if (!assistantMessage) {
                removeTypingIndicator();
                if (state.pendingRagCoverage && state.pendingRagCoverage !== 'high') {
                    insertRagCoverageWarning(state.pendingRagCoverage, state.pendingRagScore);
                }
                assistantMessage = addMessage('', 'assistant');
                // Inicializar streaming-markdown parser para este mensaje
                if (window.smd) {
                    const renderer = window.smd.default_renderer(assistantMessage);
                    state._smdParser = window.smd.parser(renderer);
                } else {
                    state._smdParser = null;
                }
            }

            state.currentMessage += data.content;

            // Usar streaming-markdown: solo append al DOM, O(1) por token
            if (state._smdParser) {
                window.smd.parser_write(state._smdParser, data.content);
            } else {
                // Fallback: marked.parse (puede congelar en respuestas largas)
                assistantMessage.innerHTML = renderMarkdown(state.currentMessage, false);
            }
            elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
        }
        else if (data.type === 'end') {
            console.log('[WS] END recibido — finalizando respuesta');

            // Cambiar status INMEDIATAMENTE
            elements.chatStatus.textContent = 'En línea';
            state.pendingRagCoverage = null;
            state.pendingRagScore = 0;

            // Finalizar streaming-markdown parser (flush remaining)
            if (state._smdParser) {
                window.smd.parser_end(state._smdParser);
                state._smdParser = null;
            }

            // Post-procesamiento (tablas responsive, speaker, TTS)
            if (assistantMessage && state.currentMessage) {
                initResponsiveTables(assistantMessage);
                elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

                if (state.currentQuery) {
                    updateRecentSearchAnswer(state.currentQuery, state.currentMessage);
                }
                addSpeakerButton(assistantMessage, state.currentMessage);
                if (state.ttsEnabled || state.voiceTriggered) {
                    playTTS(state.currentMessage);
                }
            }
            assistantMessage = null;
        }
        else if (data.type === 'agent_info') {
            console.log('Agente:', data.agent, '- Documentos:', data.context_docs, '- Cobertura RAG:', data.rag_coverage);
            // Guardar cobertura RAG para mostrar warning cuando llegue la respuesta
            state.pendingRagCoverage = data.rag_coverage || 'high';
            state.pendingRagScore = data.max_score || 0;
        }
        else if (data.type === 'error') {
            removeTypingIndicator();
            addMessage('Error: ' + data.message, 'assistant');
            elements.chatStatus.textContent = 'En línea';
            assistantMessage = null;
        }
    };

    // Reutilizar WebSocket existente si está abierto
    if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        console.log('[WS] Reutilizando conexión existente');
        // Actualizar handler para que use el nuevo closure (assistantMessage, etc.)
        state.websocket.onmessage = handleMessage;
        sendMessage();
        return;
    }
    console.log('[WS] Creando nueva conexión WebSocket');

    // Cerrar WebSocket anterior si existe pero no está abierto
    if (state.websocket) {
        state.websocket.close();
        state.websocket = null;
    }

    // Crear nuevo WebSocket
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.websocket = new WebSocket(`${wsProtocol}//${window.location.host}/ws/chat`);

    state.websocket.onopen = () => {
        sendMessage();
    };

    state.websocket.onmessage = handleMessage;

    state.websocket.onerror = () => {
        removeTypingIndicator();
        addMessage('Error de conexión', 'assistant');
        elements.chatStatus.textContent = 'Desconectado';
        state.websocket = null;
    };

    state.websocket.onclose = (event) => {
        console.log('[WS] Connection closed — code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
        elements.chatStatus.textContent = 'En línea';
        state.websocket = null;
    };
}

// ============================================
// Grabación de voz
// ============================================
async function startRecording() {
    // Prevent starting a new recording if one is already in progress
    if (state.isRecording) {
        console.log('[Recording] Already recording, ignoring startRecording()');
        return;
    }

    try {
        // Stop TTS if playing (don't talk while listening)
        stopTTS();

        // iOS: ensure audio element is warmed up for later TTS playback
        warmupIOSAudio();

        // Pause wake word listening while recording
        if (state.wakeWordActive) {
            stopWakeWordListening();
        }

        // Always request fresh getUserMedia — iOS requires this for each recording
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.audioStream = stream;

        // Detect supported mimeType (webm for desktop, mp4 for iOS)
        let mimeType = 'audio/webm;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            // iOS doesn't support webm — use mp4
            if (MediaRecorder.isTypeSupported('audio/mp4')) {
                mimeType = 'audio/mp4';
            } else if (MediaRecorder.isTypeSupported('audio/aac')) {
                mimeType = 'audio/aac';
            } else {
                // Fallback: let browser choose
                mimeType = '';
            }
        }
        console.log('[Recording] Using mimeType:', mimeType || 'browser default');

        const recorderOptions = mimeType ? { mimeType } : {};
        state.mediaRecorder = new MediaRecorder(stream, recorderOptions);
        state.recordingMimeType = mimeType; // Save for blob creation

        state.audioChunks = [];

        state.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                state.audioChunks.push(event.data);
            }
        };

        state.mediaRecorder.onstop = async () => {
            // Use the actual mimeType that was recorded
            const blobType = state.recordingMimeType || 'audio/webm';
            const extension = blobType.includes('mp4') ? 'mp4' : blobType.includes('aac') ? 'aac' : 'webm';
            const audioBlob = new Blob(state.audioChunks, { type: blobType });
            console.log('[Recording] Created blob:', blobType, 'size:', audioBlob.size);
            await transcribeAudio(audioBlob, extension);
            // Close tracks after each recording (iOS needs fresh stream each time)
            stream.getTracks().forEach(track => track.stop());
        };

        state.mediaRecorder.start();
        state.isRecording = true;

        // Start silence detection (auto-stop after 5s silence)
        startSilenceDetection(stream);

        updateRecordingUI(true);

    } catch (error) {
        console.error('Error micrófono:', error);
        if (elements.voiceStatus) {
            elements.voiceStatus.textContent = 'Error: No se pudo acceder al micrófono';
        }
    }
}

function stopRecording() {
    if (state.mediaRecorder && state.isRecording) {
        stopSilenceDetection();
        state.mediaRecorder.stop();
        state.isRecording = false;
        updateRecordingUI(false, true); // processing = true
    }
}

// ============================================
// Detección automática de silencio (pausa prudencial)
// ============================================
function startSilenceDetection(stream) {
    // Close any previous AudioContext to avoid iOS conflicts with multiple contexts
    if (state.audioContext) {
        state.audioContext.close().catch(() => {});
        state.audioContext = null;
        state.analyser = null;
    }
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);

    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    state.audioContext = audioContext;
    state.analyser = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const SILENCE_THRESHOLD = 15;
    // Voice mode answer is a single word — use faster silence detection
    const isVoiceMode = state.voiceModeRecording;
    const SILENCE_DURATION = isVoiceMode ? 1000 : 3000;   // 1s for mode, 3s normal
    const MIN_RECORDING = isVoiceMode ? 1000 : 1500;     // 1s for mode, 1.5s normal
    const MAX_RECORDING = 120000;   // Máximo absoluto: 2 minutos

    let silenceStart = null;
    let speechDetected = false;
    const recordStart = Date.now();

    function checkSilence() {
        if (!state.isRecording) return;

        const elapsed = Date.now() - recordStart;

        if (elapsed > MAX_RECORDING) {
            console.log('[Silence] Max recording time reached, stopping');
            stopRecording();
            return;
        }

        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        const avg = sum / dataArray.length;

        // Detect real speech
        if (avg > SILENCE_THRESHOLD * 1.5) {
            speechDetected = true;
        }

        // Only evaluate silence after MIN_RECORDING and after speech was detected
        if (avg < SILENCE_THRESHOLD && elapsed > MIN_RECORDING && speechDetected) {
            if (!silenceStart) {
                silenceStart = Date.now();
            } else if (Date.now() - silenceStart > SILENCE_DURATION) {
                console.log('[Silence] 5s silence after speech, auto-stopping');
                stopRecording();
                return;
            }
        } else if (avg >= SILENCE_THRESHOLD) {
            silenceStart = null;
        }

        state.silenceTimer = requestAnimationFrame(checkSilence);
    }

    checkSilence();
}

function stopSilenceDetection() {
    if (state.silenceTimer) {
        cancelAnimationFrame(state.silenceTimer);
        state.silenceTimer = null;
    }
    if (state.audioContext) {
        state.audioContext.close().catch(() => {});
        state.audioContext = null;
    }
    state.analyser = null;
}

function updateRecordingUI(recording, processing = false) {
    // Welcome screen — toggle class + update text
    if (elements.orbCard) {
        elements.orbCard.classList.toggle('listening', recording);
        const orbTitle = elements.orbCard.querySelector('.bento-card__title');
        if (orbTitle) {
            orbTitle.textContent = recording ? 'Toca para parar' : (processing ? 'Procesando...' : 'Habla conmigo');
        }
    }

    // Chat screen — toggle recording class + swap icon
    if (elements.chatMicBtn) {
        elements.chatMicBtn.classList.toggle('recording', recording);
        const icon = elements.chatMicBtn.querySelector('.ph');
        if (icon) {
            icon.className = recording ? 'ph ph-stop-circle' : 'ph ph-microphone';
        }
        elements.chatMicBtn.title = recording ? 'Parar grabación' : 'Micrófono';
    }

    // Orb 3D
    if (window.orbSetListening) window.orbSetListening(recording);

    // Textos
    if (elements.voiceStatus) {
        elements.voiceStatus.textContent = recording ? 'Grabando...' : (processing ? 'Procesando...' : '');
        elements.voiceStatus.classList.toggle('active', recording);
    }
}

async function transcribeAudio(audioBlob, extension = 'webm') {
    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, `recording.${extension}`);

        const response = await fetch('/api/voice', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success && data.text) {
            // Strip wake word from transcription so "Hola Novia, ..." becomes just "..."
            const cleanText = stripWakeWord(data.text);

            // If the transcription was ONLY a wake word (nothing else), skip sending
            if (!cleanText) {
                console.log('[Voice] Transcription was only a wake word, ignoring');
                // If awaiting voice mode, fallback to 'full' silently
                if (state.awaitingVoiceMode) {
                    const pendingMessage = state.awaitingVoiceMode;
                    state.awaitingVoiceMode = null;
                    state.voiceModeRecording = false;
                    if (state.voiceModeTimeout) { clearTimeout(state.voiceModeTimeout); state.voiceModeTimeout = null; }
                    const asking = document.querySelector('.voice-mode-asking');
                    if (asking) asking.remove();
                    sendToWebSocket(pendingMessage, 'full');
                }
                updateRecordingUI(false);
                resumeWakeWordAfterRecording();
                return;
            }

            // Check if we're awaiting voice mode selection (user answering "resumida" or "extendida")
            if (state.awaitingVoiceMode) {
                if (state.voiceModeTimeout) {
                    clearTimeout(state.voiceModeTimeout);
                    state.voiceModeTimeout = null;
                }
                state.voiceModeRecording = false;
                const pendingMessage = state.awaitingVoiceMode;
                state.awaitingVoiceMode = null;

                const lower = cleanText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const isShort = /\b(resumida|corta|breve|resumen|resumido)\b/.test(lower);
                const mode = isShort ? 'short' : 'full';

                // Remove visual indicator
                const asking = document.querySelector('.voice-mode-asking');
                if (asking) asking.remove();

                // Show what was transcribed and chosen mode
                console.log(`[Voice Mode] Transcribed answer: "${cleanText}" → mode: ${mode}`);

                // Show chosen mode badge
                const chosen = document.createElement('div');
                chosen.className = 'response-mode-chosen';
                chosen.innerHTML = mode === 'short'
                    ? '<i class="ph ph-list-bullets"></i> Resumida'
                    : '<i class="ph ph-article"></i> Extendida';
                elements.chatMessages.appendChild(chosen);

                sendToWebSocket(pendingMessage, mode);
                updateRecordingUI(false);
                resumeWakeWordAfterRecording();
                return;
            }

            // Guardar en búsquedas recientes (como voz)
            saveRecentSearch(cleanText, true);
            const actionable = isActionableQuery(cleanText);

            if (!elements.chatScreen.classList.contains('hidden')) {
                addMessage(cleanText, 'user');
                if (actionable && state.voiceTriggered) {
                    // Voice: ask mode by TTS and listen
                    // Return here — askResponseModeByVoice manages its own recording cycle
                    askResponseModeByVoice(cleanText);
                    return;
                } else {
                    // Non-actionable: send directly
                    sendToWebSocket(cleanText);
                }
            } else {
                // Coming from welcome/plan screen
                elements.planScreen?.classList.add('hidden');
                if (actionable && state.voiceTriggered) {
                    // Show chat first, then ask mode by voice
                    showChatScreen(cleanText, false, true); // skipSend=true
                    return;
                }
                showChatScreen(cleanText, false);
            }
        } else {
            console.error('Error transcripción:', data.error);
            // If awaiting voice mode answer and transcription failed, fallback to 'full' silently
            if (state.awaitingVoiceMode) {
                console.log('[Voice Mode] Transcription failed, falling back to full mode');
                if (state.voiceModeTimeout) { clearTimeout(state.voiceModeTimeout); state.voiceModeTimeout = null; }
                state.voiceModeRecording = false;
                const pendingMessage = state.awaitingVoiceMode;
                state.awaitingVoiceMode = null;
                const asking = document.querySelector('.voice-mode-asking');
                if (asking) asking.remove();
                sendToWebSocket(pendingMessage, 'full');
            } else {
                // Show capabilities message when transcription fails (only for normal queries)
                if (!elements.chatScreen.classList.contains('hidden')) {
                    addMessage('No pude entender lo que dijiste. Puedes preguntarme sobre:\n\n- **Productos**: "¿Qué es BioPRO?"\n- **Objeciones**: "Un médico dice que es caro"\n- **Argumentos**: "¿Cómo presento Novacutan a un dermatólogo?"', 'assistant');
                }
            }
        }

        updateRecordingUI(false);

    } catch (error) {
        console.error('Error transcripción:', error);
        // If awaiting voice mode answer and error, fallback to 'full' silently
        if (state.awaitingVoiceMode) {
            console.log('[Voice Mode] Transcription error, falling back to full mode');
            if (state.voiceModeTimeout) { clearTimeout(state.voiceModeTimeout); state.voiceModeTimeout = null; }
            state.voiceModeRecording = false;
            const pendingMessage = state.awaitingVoiceMode;
            state.awaitingVoiceMode = null;
            const asking = document.querySelector('.voice-mode-asking');
            if (asking) asking.remove();
            sendToWebSocket(pendingMessage, 'full');
        } else {
            if (!elements.chatScreen.classList.contains('hidden')) {
                addMessage('No pude entender lo que dijiste. Intenta de nuevo.', 'assistant');
            }
        }
        updateRecordingUI(false);
    }

    // Resume wake word listening after recording completes
    resumeWakeWordAfterRecording();
}

function toggleRecording() {
    // iOS: Pre-warm audio element on user gesture so TTS can play later
    warmupIOSAudio();

    if (state.isRecording) {
        stopRecording();
    } else {
        // Voice interaction → auto-enable TTS responses
        enableTTS();
        state.voiceTriggered = true;
        startRecording();
    }
}

/**
 * iOS Safari requires audio to be "unlocked" by user gesture.
 * This creates and plays a silent audio to enable future playback.
 */
function warmupIOSAudio() {
    // Warmup audio on user gesture - works on all browsers
    try {
        if (!state.iosAudioElement) {
            state.iosAudioElement = new Audio();
            state.iosAudioElement.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        }
        state.iosAudioElement.play().then(() => {
            state.iosAudioElement.pause();
            console.log('[Audio] Warmup OK');
        }).catch(() => {});
    } catch (e) {}
}

// ============================================
// Detección de consultas con contenido real
// ============================================
/**
 * Determina si un mensaje contiene una consulta real sobre
 * productos, objeciones o argumentos de Novacutan.
 * Solo muestra el selector de formato cuando hay contenido estética relevante.
 * Cualquier otra cosa (saludos, frases vagas, charla) se envía directo.
 */
function isActionableQuery(text) {
    const t = text.toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Palabras clave que indican consulta real sobre el dominio estética/ventas
    const pharmaKeywords = [
        // Productos y sustancias Novacutan
        /novacutan/i, /biopro/i, /bio\s*pro/i, /fbio/i, /f\s*bio/i,
        /dvs/i, /3dvs/i, /biomodulador/i, /relleno/i, /filler/i,
        /hialuronico/i, /acido hialuronico/i, /reticulante/i,
        /divinilsulfona/i, /microesfera/i, /bdde/i,
        // Médico / clínico
        /medico/i, /doctor/i, /paciente/i, /dosis/i,
        /indicaci/i, /tratamiento/i, /clinico/i, /sesion/i,
        /dermato/i, /cirujano/i, /plastico/i, /estetico/i, /estetica/i,
        // Técnicas y protocolos
        /v.?lift/i, /d.?lift/i, /lifting/i, /canula/i, /aguja/i,
        /protocolo/i, /tecnica/i, /inyecci/i, /bolus/i, /fanning/i,
        /retrotrazante/i, /subdermic/i, /supraperiostic/i,
        // Zonas anatómicas
        /facial/i, /ovalo/i, /pomulo/i, /mandibul/i, /menton/i,
        /nasogeniano/i, /surco/i, /labio/i, /ojera/i, /lagrimal/i,
        /temporal/i, /periorbital/i, /peribucal/i, /cuello/i,
        // Condiciones estéticas
        /flacidez/i, /arruga/i, /volumen/i, /rejuvenecimiento/i,
        /envejecimiento/i, /firmeza/i, /colageno/i, /elastina/i,
        /edema/i, /hinchaz/i, /hematoma/i,
        // Objeciones
        /caro/i, /costoso/i, /precio/i, /barato/i, /coste/i,
        /no funciona/i, /no sirve/i, /no conoce/i,
        /efecto.? secundario/i, /contraindicac/i,
        /otra marca/i, /competencia/i, /objecion/i,
        /profhilo/i, /juvederm/i,
        // Ventas y argumentos
        /argumento/i, /vender/i, /venta/i, /presentar/i, /visita/i,
        /represent/i, /estrategi/i, /perfil/i, /diferenci/i,
        /ventaja/i, /evidencia/i, /estudio/i, /pitch/i,
        // Marca y certificaciones
        /novacutan/i, /fijie/i, /marcado ce/i, /certificac/i,
        // Producto genérico
        /producto/i, /composici/i, /concentraci/i, /cohesividad/i,
        /calidad/i, /pureza/i, /purificacion/i,
        // Seguridad
        /embaraz/i, /anticoagulant/i, /herpes/i, /alergia/i,
        /hialuronidasa/i, /complicaci/i, /vascular/i, /necrosis/i,
        // Acciones del dominio
        /recomiend/i, /recomendar/i, /comparar/i, /comparativ/i,
        /que es\b/i, /para que sirve/i, /como funciona/i, /como respondo/i,
        /como presento/i, /como vendo/i, /como aplico/i,
    ];

    return pharmaKeywords.some(kw => kw.test(t));
}

// ============================================
// Enviar mensaje por texto
// ============================================
function sendMessage() {
    const input = elements.welcomeScreen.classList.contains('hidden')
        ? elements.chatInput
        : elements.messageInput;

    const message = input.value.trim();
    if (!message) return;

    input.value = '';

    // Guardar en búsquedas recientes
    saveRecentSearch(message);

    // Text input → always send directly as 'full', no mode selector
    state.voiceTriggered = false;
    releaseCachedMicStream();

    // Si estamos en welcome, ir al chat
    if (!elements.welcomeScreen.classList.contains('hidden')) {
        showChatScreen(message, false); // text: no selector
    } else {
        addMessage(message, 'user');
        sendToWebSocket(message); // text: send directly as 'full'
    }
}

/**
 * Asks response mode by voice: TTS asks "¿Resumida o extendida?",
 * then starts recording to listen for the user's voice answer.
 */
async function askResponseModeByVoice(message) {
    console.log('[Voice Mode] askResponseModeByVoice called for:', message);

    // 1. Show visual indicator
    const indicator = document.createElement('div');
    indicator.className = 'voice-mode-asking';
    indicator.innerHTML = `
        <i class="ph ph-speaker-high"></i>
        <span>Novia pregunta: ¿Resumida o extendida?</span>
    `;
    elements.chatMessages.appendChild(indicator);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    // 2. Play question via TTS (skip_summary = true, send text directly)
    try {
        console.log('[Voice Mode] Playing TTS question...');
        await playTTSAndWait('¿Quieres la respuesta resumida o extendida?');
        console.log('[Voice Mode] TTS question finished');
    } catch (e) {
        console.error('[Voice Mode] TTS failed:', e);
    }

    // 3. Wait 400ms for speaker echo to dissipate before opening mic
    await new Promise(r => setTimeout(r, 400));

    // 4. Update indicator to show we're listening
    indicator.innerHTML = `
        <i class="ph ph-microphone"></i>
        <span>Escuchando tu respuesta...</span>
    `;

    // 5. Set flag so transcribeAudio knows we're awaiting mode
    state.awaitingVoiceMode = message;

    // 6. Start recording to listen for answer (with longer min recording)
    console.log('[Voice Mode] Starting recording for mode answer...');
    state.voiceModeRecording = true; // flag for silence detection to use longer min
    startRecording();

    // 7. Safety timeout — if no answer in 10s, send as 'full'
    state.voiceModeTimeout = setTimeout(() => {
        if (state.awaitingVoiceMode) {
            console.log('[Voice Mode] Timeout — sending as full');
            state.voiceModeRecording = false;
            const msg = state.awaitingVoiceMode;
            state.awaitingVoiceMode = null;
            const asking = document.querySelector('.voice-mode-asking');
            if (asking) asking.remove();
            stopRecording();
            sendToWebSocket(msg, 'full');
        }
    }, 10000);
}

/**
 * Muestra un selector de modo de respuesta (resumida/extendida)
 * debajo del mensaje del usuario. Al elegir, envía al WebSocket.
 */
function showResponseModeSelector(message) {
    const selector = document.createElement('div');
    selector.className = 'response-mode-selector';
    selector.innerHTML = `
        <div class="response-mode-selector__header">
            <i class="ph ph-chat-dots"></i>
            <span>Formato de respuesta</span>
        </div>
        <div class="response-mode-selector__buttons">
            <button class="response-mode-btn response-mode-btn--short" data-mode="short">
                <div class="response-mode-btn__icon">
                    <i class="ph ph-list-bullets"></i>
                </div>
                <div class="response-mode-btn__text">
                    <strong>Resumida</strong>
                    <span>Datos clave y directa</span>
                </div>
            </button>
            <button class="response-mode-btn response-mode-btn--full" data-mode="full">
                <div class="response-mode-btn__icon">
                    <i class="ph ph-article"></i>
                </div>
                <div class="response-mode-btn__text">
                    <strong>Extendida</strong>
                    <span>Argumentario completo</span>
                </div>
            </button>
        </div>
    `;

    elements.chatMessages.appendChild(selector);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    // Handlers
    selector.querySelectorAll('.response-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            // Reemplazar selector con indicador del modo elegido
            const chosen = document.createElement('div');
            chosen.className = 'response-mode-chosen';
            chosen.innerHTML = mode === 'short'
                ? '<i class="ph ph-list-bullets"></i> Resumida'
                : '<i class="ph ph-article"></i> Extendida';
            selector.replaceWith(chosen);
            // Enviar al WebSocket con el modo
            sendToWebSocket(message, mode);
        });
    });
}

// ============================================
// Infographic Feature
// ============================================

const INFOGRAPHIC_THEMES = {
    productos:  { primary: '#6B5B95', primaryDark: '#4A3D6B', light: '#D8D0E8', accent: '#8B78B4', bg: '#EDEAF0', badge: '#F0ECF5', border: '#D5CDE0' },
    objeciones: { primary: '#7B6B95', primaryDark: '#524068', light: '#DDD0E8', accent: '#9B88B4', bg: '#EFECF2', badge: '#F2EEF7', border: '#D8CFE3' },
    argumentos: { primary: '#5B6B95', primaryDark: '#3D4A6B', light: '#D0D8E8', accent: '#7888B4', bg: '#EAEDF2', badge: '#ECF0F5', border: '#CDD5E0' }
};

function appendInfographicCTA(messageRow, fullResponse) {
    if (!messageRow || !fullResponse) return;

    const cta = document.createElement('div');
    cta.className = 'infographic-cta';
    cta.innerHTML = `
        <i class="ph ph-image-square"></i>
        <span class="infographic-cta__text">¿Quieres una infografía resumida para mostrar al médico?</span>
        <div class="infographic-cta__actions">
            <button class="infographic-cta__btn infographic-cta__btn--yes">
                <i class="ph ph-check"></i> Sí, generar
            </button>
            <button class="infographic-cta__btn infographic-cta__btn--no">
                <i class="ph ph-x"></i> No, gracias
            </button>
        </div>
    `;

    // Insert after the message row
    messageRow.after(cta);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    // Button handlers
    cta.querySelector('.infographic-cta__btn--yes').addEventListener('click', () => {
        requestInfographic(fullResponse, cta);
    });
    cta.querySelector('.infographic-cta__btn--no').addEventListener('click', () => {
        cta.classList.add('infographic-cta--exiting');
        cta.addEventListener('animationend', () => cta.remove());
    });
}

async function requestInfographic(agentResponse, ctaElement) {
    console.log('[Infographic] Requesting infographic via POST...');

    // Replace CTA with loading spinner
    const loading = document.createElement('div');
    loading.className = 'infographic-loading';
    loading.innerHTML = `
        <div class="infographic-loading__spinner"></div>
        <span class="infographic-loading__text">Generando infografía...</span>
    `;
    ctaElement.replaceWith(loading);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    try {
        const response = await fetch('/api/infographic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_response: agentResponse })
        });

        const result = await response.json();
        console.log('[Infographic] Response:', result.success);

        if (result.success && result.data) {
            console.log('[Infographic] Data received, rendering card');
            const insertAfter = loading.previousElementSibling || elements.chatMessages.lastElementChild;
            loading.remove();
            renderInfographic(result.data, insertAfter);
        } else {
            console.error('[Infographic] Error:', result.error || result.detail);
            loading.innerHTML = `
                <div class="infographic-error">
                    <i class="ph ph-warning-circle"></i>
                    <span>No se pudo generar la infografía: ${result.error || 'Error desconocido'}</span>
                </div>
            `;
            loading.className = 'infographic-error-container';
        }
    } catch (err) {
        console.error('[Infographic] Fetch error:', err);
        loading.innerHTML = `
            <div class="infographic-error">
                <i class="ph ph-warning-circle"></i>
                <span>Error de conexión al generar la infografía.</span>
            </div>
        `;
        loading.className = 'infographic-error-container';
    }
}

function renderInfographic(data, afterElement) {
    const theme = INFOGRAPHIC_THEMES[data.color_tema] || INFOGRAPHIC_THEMES.productos;

    // Build sections HTML (NotebookLM style: white cards with circular icon badges)
    const sectionsHTML = (data.secciones || []).map(sec => `
        <div class="infographic-card__section">
            <div class="infographic-card__section-header">
                <div class="infographic-card__section-icon">
                    <i class="ph ph-${sec.icono || 'circle'}"></i>
                </div>
                <span class="infographic-card__section-title">${sec.titulo}</span>
            </div>
            <ul class="infographic-card__section-list">
                ${(sec.puntos || []).map(p => `<li>${p}</li>`).join('')}
            </ul>
        </div>
    `).join('');

    // Build data grid HTML (KPI badges)
    const dataGridHTML = (data.datos_tabla || []).map(d => `
        <div class="infographic-card__kpi">
            <span class="infographic-card__kpi-value">${d.valor}</span>
            <span class="infographic-card__kpi-label">${d.etiqueta}</span>
        </div>
    `).join('');

    // Product highlight (circular icon badge)
    const prod = data.producto_destacado;
    const productHTML = (prod && prod.nombre) ? `
        <div class="infographic-card__product">
            <div class="infographic-card__product-icon">
                <i class="ph ph-package"></i>
            </div>
            <div class="infographic-card__product-info">
                <strong>${prod.nombre}</strong>
                ${prod.dosis ? `<span>${prod.dosis}</span>` : ''}
                ${prod.indicacion ? `<span>${prod.indicacion}</span>` : ''}
            </div>
        </div>
    ` : '';

    // Key phrase
    const quoteHTML = data.frase_clave ? `
        <blockquote class="infographic-card__quote">
            ${data.frase_clave}
        </blockquote>
    ` : '';

    // Build full card (NotebookLM style)
    const card = document.createElement('div');
    card.className = 'infographic-card';
    card.style.setProperty('--nblm-bg', theme.bg);
    card.style.setProperty('--nblm-primary', theme.primary);
    card.style.setProperty('--nblm-primary-dark', theme.primaryDark);
    card.style.setProperty('--nblm-primary-light', theme.light);
    card.style.setProperty('--nblm-accent', theme.accent);
    card.style.setProperty('--nblm-badge-bg', theme.badge);
    card.style.setProperty('--nblm-border', theme.border);
    card.innerHTML = `
        <div class="infographic-card__header">
            <div class="infographic-card__brand">
                <i class="ph-bold ph-pulse"></i>
                <span>Novia</span>
            </div>
            <h3 class="infographic-card__title">${data.titulo || 'Resumen'}</h3>
            ${data.subtitulo ? `<p class="infographic-card__subtitle">${data.subtitulo}</p>` : ''}
        </div>
        ${dataGridHTML ? `<div class="infographic-card__data-grid">${dataGridHTML}</div>` : ''}
        <div class="infographic-card__body">
            ${sectionsHTML}
            ${productHTML}
            ${quoteHTML}
        </div>
        <div class="infographic-card__footer">
            <span>Novia &middot; Infograf&iacute;a generada por IA</span>
        </div>
        <div class="infographic-actions">
            <button class="infographic-actions__download" title="Descargar PNG">
                <i class="ph ph-download-simple"></i> Descargar
            </button>
        </div>
    `;

    // Insert into chat
    if (afterElement && afterElement.parentNode) {
        afterElement.after(card);
    } else {
        elements.chatMessages.appendChild(card);
    }
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;

    // Download handler
    card.querySelector('.infographic-actions__download').addEventListener('click', () => {
        downloadInfographicAsPNG(card);
    });
}

function downloadInfographicAsPNG(cardElement) {
    if (typeof html2canvas === 'undefined') {
        console.error('html2canvas not loaded');
        return;
    }

    const actionsBar = cardElement.querySelector('.infographic-actions');
    if (actionsBar) actionsBar.style.display = 'none';

    html2canvas(cardElement, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#EDEAF0',
        logging: false
    }).then(canvas => {
        if (actionsBar) actionsBar.style.display = '';
        canvas.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'infografia-novacutan.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/png');
    }).catch(err => {
        if (actionsBar) actionsBar.style.display = '';
        console.error('Error generating PNG:', err);
    });
}


// ============================================
// Wake Word Detection — "Hola Novia" / "Hey Novia" / "Novia"
// ============================================
// Flexible patterns — no \b boundaries (Spanish SpeechRecognition
// transcripts often lack proper word spacing/punctuation)
const WAKE_WORD_PATTERNS = [
    /hola\s*novia/i,
    /hey\s*novia/i,
    /oye\s*novia/i,
    /ok\s*novia/i,
    /ola\s*novia/i,     // common speech-to-text typo
];

// Single-word fallback: standalone "novia" only if it's the whole transcript
const WAKE_WORD_SOLO = /^\s*novia\s*$/i;

/**
 * Checks if the transcript contains a wake word.
 */
function containsWakeWord(transcript) {
    const t = transcript.toLowerCase().trim();
    if (!t) return false;
    // Multi-word patterns first (more specific)
    if (WAKE_WORD_PATTERNS.some(p => p.test(t))) return true;
    // Solo "novia" only if the entire transcript is just the word
    if (WAKE_WORD_SOLO.test(t)) return true;
    return false;
}

/**
 * Strips wake word patterns from transcribed text.
 * Returns cleaned text, or empty string if the text was ONLY a wake word / greeting.
 */
function stripWakeWord(text) {
    let t = text.trim();

    // 1) Remove wake word patterns anywhere in the text (not just start)
    for (const pattern of WAKE_WORD_PATTERNS) {
        t = t.replace(new RegExp(pattern.source + '[,\\s.!?]*', 'gi'), '').trim();
    }

    // 2) Strip standalone "novia" variations
    t = t.replace(/\bnovia\b[,\s.!?]*/gi, '').trim();

    // 3) If what remains is just a greeting word or nothing, return empty
    const leftover = t.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/^\s*(hola|hey|oye|ok|buenas?|buenos?|que tal|como estas?|gracias?|adios|hasta luego)?\s*[.!?,]*\s*$/i.test(leftover)) {
        return '';
    }

    return t;
}

/**
 * Play a short beep to confirm wake word detection.
 */
function playWakeBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);  // A5
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
        osc.onended = () => ctx.close();
    } catch (e) {
        // Silently ignore — beep is optional UX nicety
    }
}

/**
 * Starts continuous SpeechRecognition listening for the wake word.
 * When detected, stops listening and triggers MediaRecorder recording.
 */
function startWakeWordListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('[WakeWord] SpeechRecognition not supported in this browser');
        return;
    }

    // Don't start if already running or currently recording
    if (state.wakeWordActive || state.isRecording) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3; // more alternatives = better chance of matching

    recognition.onstart = () => {
        state.wakeWordActive = true;
        updateWakeWordUI(true);
        console.log('[WakeWord] Listening for wake word...');
    };

    recognition.onresult = (event) => {
        // Check all results and all alternatives
        for (let i = event.resultIndex; i < event.results.length; i++) {
            for (let a = 0; a < event.results[i].length; a++) {
                const transcript = event.results[i][a].transcript;
                // Debug: log what the browser heard
                if (transcript.trim()) {
                    console.log('[WakeWord] Heard:', `"${transcript}"`, '| Match:', containsWakeWord(transcript));
                }
                if (containsWakeWord(transcript)) {
                    console.log('[WakeWord] Wake word detected:', transcript);
                    // Prevent onend from restarting listening during the transition
                    state.wakeWordEnabled = false;
                    recognition.abort();
                    state.wakeWordActive = false;

                    // Brief delay to release mic, then start recording
                    setTimeout(() => {
                        // Re-enable wake word (will restart after recording)
                        state.wakeWordEnabled = true;
                        onWakeWordDetected();
                    }, 400);
                    return;
                }
            }
        }
    };

    recognition.onerror = (event) => {
        // Log ALL errors for debugging (including no-speech)
        console.log('[WakeWord] Event error:', event.error);
        // 'no-speech', 'aborted', 'network' are normal in continuous mode
        if (['no-speech', 'aborted', 'network'].includes(event.error)) {
            return;
        }
        console.warn('[WakeWord] Error:', event.error);
        state.wakeWordActive = false;
        updateWakeWordUI(false);

        // If permission denied, disable wake word
        if (event.error === 'not-allowed') {
            state.wakeWordEnabled = false;
            updateWakeWordToggle(false);
            localStorage.setItem('novia_wake_word', 'off');
            return;
        }
    };

    recognition.onend = () => {
        console.log('[WakeWord] Session ended, will restart...');
        state.wakeWordActive = false;
        // Auto-restart: always restart if enabled, with a very short delay
        // Chrome stops continuous mode after ~5-10s of silence, so this is critical
        if (state.wakeWordEnabled && !state.isRecording) {
            setTimeout(() => {
                if (state.wakeWordEnabled && !state.isRecording && !state.wakeWordActive) {
                    startWakeWordListening();
                }
            }, 150); // shorter delay = faster recovery
        } else {
            updateWakeWordUI(false);
        }
    };

    state.wakeWordRecognition = recognition;

    try {
        recognition.start();
    } catch (e) {
        console.warn('[WakeWord] Failed to start:', e);
        state.wakeWordActive = false;
        // Retry after a brief pause
        if (state.wakeWordEnabled) {
            setTimeout(() => {
                if (state.wakeWordEnabled && !state.isRecording && !state.wakeWordActive) {
                    startWakeWordListening();
                }
            }, 1000);
        }
    }
}

/**
 * Stops wake word listening.
 */
function stopWakeWordListening() {
    if (state.wakeWordRecognition) {
        state.wakeWordRecognition.abort();
        state.wakeWordRecognition = null;
    }
    state.wakeWordActive = false;
    updateWakeWordUI(false);
}

/**
 * Called when the wake word is detected.
 * Plays beep, shows visual feedback, navigates to chat and starts recording.
 * Like Siri: say "Hola Novia" → it listens to everything you say.
 */
function onWakeWordDetected() {
    // No activar si el usuario no ha hecho login
    if (localStorage.getItem('novia_logged_in') !== 'true') {
        console.log('[WakeWord] Ignorado — usuario no logueado');
        return;
    }

    playWakeBeep();
    // Voice interaction → auto-enable TTS responses
    enableTTS();
    state.voiceTriggered = true;

    if (elements.chatScreen.classList.contains('hidden')) {
        // Navigate to chat, then start recording after transition
        showChatScreen('', false);
        setTimeout(() => {
            startRecording();
        }, 400);
    } else {
        // Already on chat — just start recording
        startRecording();
    }
}

/**
 * Shows a brief visual flash when wake word is detected.
 */
function showWakeWordFeedback() {
    // Flash the orb
    if (window.orbSetListening) window.orbSetListening(true);

    // Build centered overlay card
    const toast = document.createElement('div');
    toast.className = 'wake-word-toast';
    toast.innerHTML = `
        <div class="wake-word-toast__card">
            <div class="wake-word-toast__icon">
                <i class="ph ph-chat-circle-dots"></i>
            </div>
            <span class="wake-word-toast__text">Hola, soy Novia</span>
            <span class="wake-word-toast__hint">Abriendo chat...</span>
        </div>`;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.add('wake-word-toast--visible');
    });

    // Remove after 2.5s
    setTimeout(() => {
        toast.classList.remove('wake-word-toast--visible');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 2500);
}

/**
 * Toggles wake word detection on/off.
 */
function toggleWakeWord() {
    state.wakeWordEnabled = !state.wakeWordEnabled;
    updateWakeWordToggle(state.wakeWordEnabled);

    if (state.wakeWordEnabled) {
        startWakeWordListening();
        localStorage.setItem('novia_wake_word', 'on');
    } else {
        stopWakeWordListening();
        localStorage.setItem('novia_wake_word', 'off');
    }
}

/**
 * Updates the wake word toggle button visual state + text label.
 */
function updateWakeWordToggle(enabled) {
    ['wake-word-btn', 'chat-wake-word-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('wake-word-toggle--active', enabled);
        btn.title = enabled ? 'Desactivar Hola, Novia' : 'Activar Hola, Novia';
        const label = btn.querySelector('.wake-word-label');
        if (label) label.textContent = enabled ? 'Hola, Novia · on' : 'Hola, Novia · off';
        const icon = btn.querySelector('.ph');
        if (icon) {
            icon.className = enabled ? 'ph ph-microphone' : 'ph ph-microphone-slash';
        }
    });
}

/**
 * Updates the wake word listening indicator (no-op now, state shown by label).
 */
function updateWakeWordUI(listening) {
    // Visual state is fully handled by updateWakeWordToggle
}

/**
 * Restarts wake word listening after recording completes.
 * Called at the end of transcribeAudio().
 */
function resumeWakeWordAfterRecording() {
    if (state.wakeWordEnabled && !state.wakeWordActive) {
        setTimeout(() => {
            startWakeWordListening();
        }, 1000);
    }
}

// ============================================
// TTS — Lectura en voz alta (ElevenLabs)
// ============================================

// Estado TTS
state.ttsAudio = null;       // Audio element actual
state.ttsPlaying = false;    // Reproducción en curso
state.ttsEnabled = false;    // Auto-play desactivado por defecto — el usuario lo activa con el botón de voz

/**
 * Toggles TTS auto-play on/off via the voice button in chat bottom bar.
 */
function toggleTTS() {
    state.ttsEnabled = !state.ttsEnabled;
    updateVoiceButton(state.ttsEnabled);

    if (state.ttsEnabled) {
        localStorage.setItem('novia_tts', 'on');
    } else {
        stopTTS();
        localStorage.setItem('novia_tts', 'off');
    }
}

/**
 * Enables TTS silently (no toggle, just turn on).
 * Called when voice interaction starts (wake word, orb card, mic button).
 */
function enableTTS() {
    if (!state.ttsEnabled) {
        state.ttsEnabled = true;
        updateVoiceButton(true);
        localStorage.setItem('novia_tts', 'on');
    }
}

/**
 * Updates the voice orb button UI in the chat bottom bar.
 */
function updateVoiceButton(enabled) {
    const btn = document.getElementById('chat-voice-btn');
    if (!btn) return;
    if (enabled) {
        btn.classList.add('voice-orb--active');
        btn.title = 'Voz de Novia activada';
    } else {
        btn.classList.remove('voice-orb--active');
        btn.title = 'Voz de Novia desactivada';
    }
}

/**
 * Envía texto al endpoint /api/tts y reproduce el audio streaming.
 * Si ya hay un audio reproduciéndose, lo detiene primero.
 */
async function playTTS(text) {
    // Detener audio previo si existe
    stopTTS();
    state.ttsCancelled = false;  // Reset flag para esta nueva reproducción
    // Pausar wake word para que no capte el audio del TTS
    stopWakeWordListening();

    if (!text || !text.trim()) return;

    try {
        console.log(`[TTS] Requesting audio for ${text.length} chars...`);
        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });

        // Si el usuario navegó atrás mientras el fetch estaba en progreso, no reproducir
        if (state.ttsCancelled) {
            console.log('[TTS] Cancelled during fetch — not playing');
            return;
        }

        if (!response.ok) {
            console.error('[TTS] Server error:', response.status);
            return;
        }

        // Reproducir como blob (más compatible que MediaSource para MP3 streaming)
        const blob = await response.blob();

        // Revisar de nuevo después de leer el blob
        if (state.ttsCancelled) {
            console.log('[TTS] Cancelled during blob read — not playing');
            return;
        }

        const audioUrl = URL.createObjectURL(blob);

        // iOS Safari: reuse warmed-up audio element to keep user gesture context
        // Desktop/Android: create new Audio (no gesture restrictions)
        const audio = state.iosAudioElement || new Audio();
        audio.src = audioUrl;

        state.ttsAudio = audio;
        state.ttsPlaying = true;

        // Activar orb en modo "hablando"
        if (window.orbSetListening) window.orbSetListening(true);

        // Use one-time event handlers to avoid stacking listeners on reused element
        const onEnded = () => {
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
            state.ttsPlaying = false;
            URL.revokeObjectURL(audioUrl);
            if (window.orbSetListening) window.orbSetListening(false);

            // Si la interacción fue por voz, activar micrófono automáticamente
            if (state.voiceTriggered && state.ttsEnabled) {
                console.log('[TTS] Voice mode — auto-starting recording after TTS ended');
                // Pequeño delay para que el usuario sepa que puede hablar
                setTimeout(() => {
                    if (!state.isRecording && !state.ttsPlaying) {
                        startRecording();
                    }
                }, 300);
            } else {
                // Solo reanudar wake word si no es modo voz
                resumeWakeWordAfterRecording();
            }
        };

        const onError = (e) => {
            audio.removeEventListener('ended', onEnded);
            audio.removeEventListener('error', onError);
            console.error('[TTS] Audio playback error:', e);
            state.ttsPlaying = false;
            URL.revokeObjectURL(audioUrl);
            if (window.orbSetListening) window.orbSetListening(false);
        };

        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);

        await audio.play();
        console.log('[TTS] Playing audio');

    } catch (err) {
        console.error('[TTS] Error:', err);
        state.ttsPlaying = false;
        if (window.orbSetListening) window.orbSetListening(false);
    }
}

/**
 * Plays TTS and returns a Promise that resolves when audio finishes.
 * Used for voice mode question so we can wait before starting recording.
 */
function playTTSAndWait(text) {
    return new Promise(async (resolve) => {
        state.ttsCancelled = false;
        // Pausar wake word para que no capte el audio del TTS como wake word
        stopWakeWordListening();
        try {
            console.log('[TTS] playTTSAndWait: requesting audio for:', text.substring(0, 50) + '...');
            const response = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, skip_summary: true })
            });

            if (state.ttsCancelled) { resolve(); return; }

            if (!response.ok) {
                console.error('[TTS] playTTSAndWait: server error', response.status);
                resolve();
                return;
            }

            // Esperar a que se descargue todo el audio antes de reproducir
            const blob = await response.blob();

            if (state.ttsCancelled) { resolve(); return; }

            console.log('[TTS] playTTSAndWait: got complete blob, size:', blob.size);
            if (blob.size === 0) {
                console.error('[TTS] playTTSAndWait: empty blob');
                resolve();
                return;
            }

            const audioUrl = URL.createObjectURL(blob);

            // iOS Safari: reuse warmed-up audio element for user gesture context
            const audio = state.iosAudioElement || new Audio();
            audio.src = audioUrl;
            state.ttsAudio = audio;

            // Activar orb en modo "hablando"
            if (window.orbSetListening) window.orbSetListening(true);

            const onEnded = () => {
                audio.removeEventListener('ended', onEnded);
                audio.removeEventListener('error', onError);
                console.log('[TTS] playTTSAndWait: audio ended naturally');
                URL.revokeObjectURL(audioUrl);
                state.ttsAudio = null;
                if (window.orbSetListening) window.orbSetListening(false);
                resumeWakeWordAfterRecording();
                resolve();
            };
            const onError = (e) => {
                audio.removeEventListener('ended', onEnded);
                audio.removeEventListener('error', onError);
                console.error('[TTS] playTTSAndWait: audio error', e);
                URL.revokeObjectURL(audioUrl);
                state.ttsAudio = null;
                if (window.orbSetListening) window.orbSetListening(false);
                resumeWakeWordAfterRecording();
                resolve();
            };
            audio.addEventListener('ended', onEnded);
            audio.addEventListener('error', onError);

            console.log('[TTS] playTTSAndWait: starting playback, duration will be shown after load');
            audio.addEventListener('loadedmetadata', () => {
                console.log('[TTS] playTTSAndWait: audio duration:', audio.duration, 'seconds');
            }, { once: true });

            await audio.play();
            console.log('[TTS] playTTSAndWait: playback started');
        } catch (e) {
            console.error('[TTS] playTTSAndWait error:', e);
            if (window.orbSetListening) window.orbSetListening(false);
            resumeWakeWordAfterRecording();
            resolve();
        }
    });
}

/**
 * Detiene la reproducción TTS actual.
 */
function stopTTS() {
    state.ttsCancelled = true;  // Cancelar cualquier TTS en progreso (fetch pendiente)
    if (state.ttsAudio) {
        state.ttsAudio.pause();
        state.ttsAudio.currentTime = 0;
        // Don't null out if it's the reused iOS audio element — just stop playback
        if (state.ttsAudio !== state.iosAudioElement) {
            state.ttsAudio = null;
        }
    }
    state.ttsPlaying = false;
    if (window.orbSetListening) window.orbSetListening(false);
}

/**
 * Añade un botón de speaker a un mensaje del asistente para re-escuchar.
 */
function addSpeakerButton(messageElement, fullText) {
    if (!messageElement || !fullText) return;

    const row = messageElement.closest('.message-row') || messageElement;

    // No duplicar
    if (row.querySelector('.tts-speaker-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'tts-speaker-btn';
    btn.title = 'Escuchar respuesta';
    btn.innerHTML = '<i class="ph ph-speaker-high"></i>';

    btn.addEventListener('click', () => {
        if (state.ttsPlaying && state.ttsAudio) {
            stopTTS();
            btn.innerHTML = '<i class="ph ph-speaker-high"></i>';
            btn.title = 'Escuchar respuesta';
        } else {
            playTTS(fullText);
            btn.innerHTML = '<i class="ph ph-stop"></i>';
            btn.title = 'Detener audio';
            // Restaurar icono cuando termine
            const checkEnd = setInterval(() => {
                if (!state.ttsPlaying) {
                    btn.innerHTML = '<i class="ph ph-speaker-high"></i>';
                    btn.title = 'Escuchar respuesta';
                    clearInterval(checkEnd);
                }
            }, 500);
        }
    });

    row.appendChild(btn);
}


// ============================================
// Login & Authentication
// ============================================
let demoOrbClicked = false;

const VALID_CREDENTIALS = {
    usuario: 'José Luis',
    password: 'Prisma'
};

function showLoginScreen() {
    stopTTS();
    elements.loginScreen?.classList.remove('hidden');
    elements.welcomeScreen?.classList.add('hidden');
    elements.chatScreen?.classList.add('hidden');
    elements.planScreen?.classList.add('hidden');
}

function handleLogout() {
    // Detener TTS al cerrar sesión
    stopTTS();

    // Limpiar estado de sesión
    localStorage.removeItem('novia_logged_in');
    localStorage.removeItem('novia_user');

    // Limpiar campos de login
    if (elements.loginUser) elements.loginUser.value = '';
    if (elements.loginPassword) elements.loginPassword.value = '';

    // Reset demo orb click flag
    demoOrbClicked = false;

    // Mostrar pantalla de login
    showLoginScreen();
}

function hideLoginScreen() {
    elements.loginScreen?.classList.add('fade-out');
    setTimeout(() => {
        elements.loginScreen?.classList.add('hidden');
        elements.loginScreen?.classList.remove('fade-out');
        elements.welcomeScreen?.classList.remove('hidden');
    }, 300);
}

function handleLogin(username, password) {
    // Demo: validación simple (en producción sería un API call)
    if (username === VALID_CREDENTIALS.usuario && password === VALID_CREDENTIALS.password) {
        localStorage.setItem('novia_logged_in', 'true');
        localStorage.setItem('novia_user', username);
        hideLoginScreen();
        // Sincronizar historial después de login
        syncSearchHistory();
        return true;
    }
    return false;
}

async function handleFaceID() {
    // Verificar si Face ID / Touch ID está disponible (Web Authentication API)
    if (!window.PublicKeyCredential) {
        alert('Tu navegador no soporta autenticación biométrica');
        return;
    }

    try {
        // Verificar si ya hay credencial guardada
        const credentialId = localStorage.getItem('novia_faceid_credential');

        if (credentialId) {
            // Autenticar con credencial existente
            const credential = await navigator.credentials.get({
                publicKey: {
                    challenge: new Uint8Array(32),
                    timeout: 60000,
                    userVerification: 'required',
                    allowCredentials: [{
                        id: Uint8Array.from(atob(credentialId), c => c.charCodeAt(0)),
                        type: 'public-key'
                    }]
                }
            });

            if (credential) {
                localStorage.setItem('novia_logged_in', 'true');
                hideLoginScreen();
            }
        } else {
            // Primera vez: registrar Face ID
            const confirmed = confirm('¿Deseas configurar Face ID para acceder rápidamente?');
            if (!confirmed) return;

            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge: new Uint8Array(32),
                    rp: { name: 'Novia', id: window.location.hostname },
                    user: {
                        id: new Uint8Array(16),
                        name: 'usuario@novia.app',
                        displayName: 'Usuario Novia'
                    },
                    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                    timeout: 60000,
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',
                        userVerification: 'required'
                    }
                }
            });

            if (credential) {
                // Guardar credential ID para futuras autenticaciones
                const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
                localStorage.setItem('novia_faceid_credential', credId);
                localStorage.setItem('novia_logged_in', 'true');
                hideLoginScreen();
            }
        }
    } catch (err) {
        console.error('Face ID error:', err);
        if (err.name === 'NotAllowedError') {
            alert('Autenticación cancelada o no permitida');
        } else {
            alert('Error al usar Face ID. Intenta con usuario y contraseña.');
        }
    }
}

function checkAuthOnLoad() {
    // DEMO MODE: Siempre mostrar login para la demo
    // Comentar estas 2 líneas para producción
    localStorage.removeItem('novia_logged_in');
    localStorage.removeItem('novia_user');

    const isLoggedIn = localStorage.getItem('novia_logged_in') === 'true';
    if (isLoggedIn) {
        elements.loginScreen?.classList.add('hidden');
        elements.welcomeScreen?.classList.remove('hidden');
    } else {
        elements.loginScreen?.classList.remove('hidden');
        elements.welcomeScreen?.classList.add('hidden');
    }
}

// Demo: Orb click en login — saludo TTS, José Luis ingresa credenciales después
async function handleDemoOrbClick() {
    if (demoOrbClicked) return; // Prevent multiple clicks
    demoOrbClicked = true;

    // Unlock audio on user gesture (required for iOS)
    warmupIOSAudio();

    // Immediate visual feedback — activate 3D orb animation instantly
    if (window.orbSetListening) window.orbSetListening(true);

    const greetingText = 'Muchas gracias José Luis por la oportunidad de conocernos. Soy Novia, tu asistente de Novacutan. Estaré siempre a tu disposición y será un placer que colaboremos juntos.';

    try {
        // Play TTS greeting and wait for it to finish
        await playTTSAndWait(greetingText);
    } catch (e) {
        console.error('[Demo] TTS error:', e);
    }

    // Stop orb animation
    if (window.orbSetListening) window.orbSetListening(false);

    // Focus en el campo de usuario para que José Luis ingrese sus credenciales
    elements.loginUser?.focus();
}

// ============================================
// Event Listeners
// ============================================
function init() {
    // Check authentication on load
    checkAuthOnLoad();

    // Login button
    elements.loginBtn?.addEventListener('click', () => {
        const username = elements.loginUser?.value?.trim();
        const password = elements.loginPassword?.value;

        if (!handleLogin(username, password)) {
            alert('Usuario o contraseña incorrectos');
            elements.loginPassword.value = '';
            elements.loginPassword.focus();
        }
    });

    // Enter key on password field
    elements.loginPassword?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            elements.loginBtn?.click();
        }
    });

    // Face ID button
    elements.faceidBtn?.addEventListener('click', handleFaceID);

    // Login orb — demo presentation with TTS greeting
    elements.loginOrbContainer?.addEventListener('click', handleDemoOrbClick);

    // Logout buttons (all screens)
    elements.logoutBtn?.addEventListener('click', handleLogout);
    elements.chatLogoutBtn?.addEventListener('click', handleLogout);
    elements.planLogoutBtn?.addEventListener('click', handleLogout);

    // Welcome screen
    elements.profileBtn?.addEventListener('click', () => {
        alert('Pantalla de cuenta - próximamente');
    });

    // Bento cards — "Habla conmigo": go to chat + start recording
    elements.orbCard?.addEventListener('click', () => {
        // iOS: Pre-warm audio on user gesture
        warmupIOSAudio();

        if (state.isRecording) {
            stopRecording();
            return;
        }
        // Voice interaction → auto-enable TTS responses
        enableTTS();
        state.voiceTriggered = true;
        // Navigate to chat first, then start recording after transition
        if (elements.chatScreen.classList.contains('hidden')) {
            showChatScreen('', false);
            setTimeout(() => {
                startRecording();
            }, 400);
        } else {
            startRecording();
        }
    });

    elements.moodCard?.addEventListener('click', openMoodOverlay);

    elements.planCard?.addEventListener('click', showPlanScreen);

    // FAQ chips (event delegation) - iOS-optimized with INSTANT visual feedback
    let faqChipProcessing = false;

    const applyFaqChipActiveStyle = (chip) => {
        // Apply inline styles IMMEDIATELY for iOS - cannot rely on CSS classes
        chip.style.transform = 'scale(0.96)';
        chip.style.background = '#D6E2FF'; // primary-container
        chip.style.borderColor = '#2D5BA0'; // primary
        chip.style.color = '#142D5E'; // on-primary-container
    };

    const removeFaqChipActiveStyle = (chip) => {
        chip.style.transform = '';
        chip.style.background = '';
        chip.style.borderColor = '';
        chip.style.color = '';
    };

    const executeFaqChipAction = (chip) => {
        if (!chip || !chip.dataset.question || faqChipProcessing) return;
        faqChipProcessing = true;
        console.log('[FAQ Chip] Executing action for:', chip.dataset.question);
        saveRecentSearch(chip.dataset.question);
        showChatScreen(chip.dataset.question, true);
        // Reset after navigation
        setTimeout(() => { faqChipProcessing = false; }, 800);
    };

    // TOUCHSTART - immediate visual feedback on touch devices
    elements.faqSection?.addEventListener('touchstart', (e) => {
        const chip = e.target.closest('.faq-chip');
        if (chip) {
            applyFaqChipActiveStyle(chip);
        }
    }, { passive: true });

    // TOUCHEND - execute action and remove style
    elements.faqSection?.addEventListener('touchend', (e) => {
        const chip = e.target.closest('.faq-chip');
        if (chip) {
            // Execute action immediately on touchend (no delay)
            executeFaqChipAction(chip);
            // Remove style after short delay for visual feedback
            setTimeout(() => removeFaqChipActiveStyle(chip), 150);
        }
    }, { passive: true });

    // TOUCHCANCEL - cleanup
    elements.faqSection?.addEventListener('touchcancel', () => {
        document.querySelectorAll('.faq-chip').forEach(c => removeFaqChipActiveStyle(c));
    }, { passive: true });

    // MOUSEDOWN/MOUSEUP for desktop
    elements.faqSection?.addEventListener('mousedown', (e) => {
        const chip = e.target.closest('.faq-chip');
        if (chip) applyFaqChipActiveStyle(chip);
    });

    elements.faqSection?.addEventListener('mouseup', (e) => {
        const chip = e.target.closest('.faq-chip');
        if (chip) setTimeout(() => removeFaqChipActiveStyle(chip), 150);
    });

    // CLICK - fallback for desktop (touchend already handles mobile)
    elements.faqSection?.addEventListener('click', (e) => {
        // Only execute if not already processed by touchend
        if ('ontouchstart' in window) return; // Skip on touch devices
        const chip = e.target.closest('.faq-chip');
        if (chip && chip.dataset.question) {
            executeFaqChipAction(chip);
        }
    });

    // Input en welcome
    elements.messageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
    });

    // Chat screen
    elements.backBtn?.addEventListener('click', showWelcomeScreen);

    elements.chatMicBtn?.addEventListener('click', toggleRecording);

    elements.chatSendBtn?.addEventListener('click', sendMessage);

    elements.chatInput?.addEventListener('keydown', (e) => {
        // Enter envía, Shift+Enter nueva línea
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize textarea
    elements.chatInput?.addEventListener('input', () => {
        const textarea = elements.chatInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });

    // Plan screen
    elements.planBackBtn?.addEventListener('click', showWelcomeFromPlan);
    elements.navChatBtn?.addEventListener('click', showChatFromPlan);
    elements.navOrb?.addEventListener('click', toggleRecording);

    // Overview filter chips
    elements.planOverviewChips.forEach(chip => {
        chip.addEventListener('click', () => {
            elements.planOverviewChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            currentOverview = chip.dataset.filter;
            renderPlanTasks();
        });
    });

    // Task section filters (project, time, status)
    document.getElementById('filter-project')?.addEventListener('change', renderPlanTasks);
    document.getElementById('filter-time')?.addEventListener('change', () => {
        // Sync time filter with overview
        const timeFilter = document.getElementById('filter-time');
        if (timeFilter) {
            currentOverview = timeFilter.value;
            // Sync overview chips
            elements.planOverviewChips.forEach(c => {
                c.classList.toggle('active', c.dataset.filter === currentOverview);
            });
            renderPlanTasks();
        }
    });
    document.getElementById('filter-status')?.addEventListener('change', renderPlanTasks);

    // Mood overlay
    elements.moodCloseBtn?.addEventListener('click', closeMoodOverlay);
    elements.moodSlider?.addEventListener('input', onMoodSliderInput);
    elements.moodSubmitBtn?.addEventListener('click', submitMood);
    elements.moodInfoBtn?.addEventListener('click', () => {
        alert('Selecciona cómo te encuentras hoy moviendo el control deslizante. Tu estado de ánimo personaliza la experiencia de la app.');
    });

    // Cargar mood del día desde localStorage
    loadMoodFromStorage();

    // Seed: insertar búsquedas de ejemplo con respuesta hardcodeada
    // Si no hay búsquedas, o si las existentes no tienen 'answer' (versión vieja), reemplazar
    const SEED_DATA = [
        {
            query: '¿Cuál es la diferencia entre BioPRO y FBio DVS?',
            icon: 'product',
            desc: 'Consulta sobre productos Novacutan',
            timestamp: Date.now() - 3600000,
            answer: 'BioPRO es un biomodulador de matriz celular (2ml) con triple acción celular (extracelular, intracelular y subcelular), indicado para lifting y rejuvenecimiento global con protocolos V-Lift y D-Lift. FBio DVS son rellenos dérmicos (1ml) en tres versiones: Light (zonas delicadas como ojeras), Medium (surcos nasogenianos, pómulos) y Volume (mentón, mandíbula). Todos usan la misma tecnología DVS con 20mg/ml de ácido hialurónico.'
        },
        {
            query: '¿Cómo manejar la objeción de que el precio es alto?',
            icon: 'objection',
            desc: 'Manejo de objeciones médicas',
            timestamp: Date.now() - 7200000,
            answer: 'Cuando un médico menciona el precio, es clave reencuadrar el valor:\n\n1) El efecto dura 12+ meses vs 6 meses de otros productos — menos sesiones de mantenimiento.\n2) Menor edema post-tratamiento gracias al DVS — menos quejas y menos retoques gratuitos.\n3) Triple acción celular única en el mercado — diferenciación como clínica premium.\n4) Propuesta de cierre: "¿Qué le parece si empezamos con un pack de prueba para que vea los resultados en sus propios pacientes?"'
        },
    ];
    const existing = loadRecentSearches();
    const needsSeed = existing.length === 0 || (existing.length <= 2 && !existing[0].answer);
    if (needsSeed) {
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(SEED_DATA));
    }

    // Renderizar búsquedas recientes
    renderRecentSearches();

    // Sincronizar historial con servidor si el usuario está logueado
    if (localStorage.getItem('novia_logged_in') === 'true') {
        syncSearchHistory();
    }

    // Wake word toggle buttons
    document.getElementById('wake-word-btn')?.addEventListener('click', toggleWakeWord);
    document.getElementById('chat-wake-word-btn')?.addEventListener('click', toggleWakeWord);

    // Restore wake word preference from localStorage
    const savedWakeWord = localStorage.getItem('novia_wake_word');
    if (savedWakeWord === 'on') {
        state.wakeWordEnabled = true;
        updateWakeWordToggle(true);
        startWakeWordListening();
    }

    // TTS voice button in chat bottom bar
    document.getElementById('chat-voice-btn')?.addEventListener('click', toggleTTS);

    // Restore TTS preference from localStorage (default: off)
    const savedTTS = localStorage.getItem('novia_tts');
    if (savedTTS === 'on') {
        state.ttsEnabled = true;
        updateVoiceButton(true);
    } else {
        state.ttsEnabled = false;
        updateVoiceButton(false);
    }

    // Detener TTS cuando el usuario sale de la pestaña o navega atrás en el navegador
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopTTS();
    });
    window.addEventListener('pagehide', () => {
        stopTTS();
        releaseCachedMicStream();
    });

    console.log('Novia inicializada');
}

// Iniciar
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

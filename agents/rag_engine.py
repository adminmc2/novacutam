"""
Motor RAG Mejorado - Base de conocimiento compartida por todos los agentes
v2.0 - Con stemming español, sinónimos y búsqueda híbrida
"""
import json
import numpy as np
from collections import Counter
from typing import List, Tuple, Optional, Set, Dict
import math
import os
import re


# ============================================
# STEMMER ESPAÑOL SIMPLIFICADO
# ============================================
class SpanishStemmer:
    """Stemmer ligero para español basado en sufijos comunes"""

    SUFFIXES = [
        # Verbales (ordenados de mayor a menor longitud)
        'ándose', 'iéndose', 'amente', 'mente',
        'ación', 'ición', 'ando', 'iendo', 'ador', 'edor', 'idor',
        'ante', 'ente', 'anza', 'encia', 'ible', 'able',
        'ivo', 'iva', 'oso', 'osa', 'dad', 'ión',
        'ar', 'er', 'ir', 'do', 'da', 'os', 'as', 'es',
    ]

    # Palabras que no deben ser stemmed
    EXCEPTIONS = {
        'novacutan', 'biopro', 'fbio', 'dvs', '3dvs', 'bdde',
        'light', 'medium', 'volume', 'hialuronidasa',
        'embarazo', 'profhilo', 'juvederm', 'lifting',
    }

    @classmethod
    def stem(cls, word: str) -> str:
        """Reduce una palabra a su raíz"""
        word = word.lower()
        if word in cls.EXCEPTIONS or len(word) < 4:
            return word

        for suffix in cls.SUFFIXES:
            if word.endswith(suffix) and len(word) - len(suffix) >= 3:
                return word[:-len(suffix)]
        return word


# ============================================
# DICCIONARIO DE SINÓNIMOS Y EXPANSIÓN
# ============================================
SYNONYMS: Dict[str, List[str]] = {
    # Productos Novacutan
    'biopro': ['biomodulador', 'bio pro', 'bioproducto', 'novacutan biopro'],
    'biomodulador': ['biopro', 'bioestimulador', 'regenerador'],
    'fbio': ['f bio', 'relleno', 'filler', 'fbio dvs'],
    'relleno': ['filler', 'fbio', 'ácido hialurónico', 'dermal filler'],
    'filler': ['relleno', 'fbio', 'ácido hialurónico'],
    'light': ['ligero', 'suave', 'sutil', 'fbio light', 'fbio dvs light'],
    'medium': ['medio', 'moderado', 'fbio medium', 'fbio dvs medium'],
    'volume': ['volumen', 'volumizador', 'fbio volume', 'fbio dvs volume'],

    # Tecnología
    'dvs': ['divinilsulfona', '3dvs', 'reticulante', 'reticulación'],
    '3dvs': ['dvs', 'microesferas', 'tecnología', 'tridimensional'],
    'bdde': ['competencia', 'reticulante competencia', 'juvederm'],
    'microesferas': ['3dvs', 'estructura', 'porosa', 'tridimensional'],
    'reticulante': ['dvs', 'divinilsulfona', 'bdde', 'reticulación'],

    # Ácido hialurónico
    'hialurónico': ['ácido hialurónico', 'ah', 'hialuronato'],
    'hialuronico': ['ácido hialurónico', 'ah', 'hialuronato'],
    'hialuronidasa': ['disolver', 'reversible', 'hyalase', 'emergencia'],

    # Técnicas y protocolos
    'vlift': ['v-lift', 'v lift', 'lifting', 'cánula'],
    'dlift': ['d-lift', 'd lift', 'aguja', 'bolus'],
    'lifting': ['vlift', 'levantamiento', 'tensado', 'reafirmante'],
    'cánula': ['canula', 'instrumento', 'inyección'],
    'aguja': ['needle', 'instrumento', 'inyección'],
    'protocolo': ['técnica', 'procedimiento', 'tratamiento', 'aplicación'],

    # Zonas anatómicas
    'ojera': ['surco lagrimal', 'periorbital', 'tear trough'],
    'lagrimal': ['ojera', 'periorbital', 'tear trough'],
    'labio': ['labial', 'peribucal', 'boca', 'vermillion'],
    'mandíbula': ['mandibula', 'mandibular', 'jawline', 'ángulo mandibular'],
    'surco': ['nasogeniano', 'nasolabial', 'pliegue'],
    'pómulo': ['pomulo', 'malar', 'pómulos', 'mejilla'],
    'mentón': ['menton', 'chin', 'mentoniano'],

    # Condiciones estéticas
    'flacidez': ['laxitud', 'caída', 'descolgamiento', 'firmeza'],
    'arruga': ['línea', 'surco', 'pliegue', 'rítide'],
    'volumen': ['proyección', 'relleno', 'aumento', 'definición'],
    'rejuvenecimiento': ['anti-aging', 'regeneración', 'juventud'],

    # Comparativas
    'mejor': ['superior', 'óptimo', 'ideal', 'recomendado', 'preferible'],
    'diferencia': ['comparar', 'comparativa', 'versus', 'contra', 'diferente'],
    'precio': ['costo', 'coste', 'valor', 'económico', 'caro', 'barato'],
    'profhilo': ['competencia', 'bioestimulador', 'sin reticular'],
    'juvederm': ['competencia', 'bdde', 'relleno competencia'],

    # Seguridad
    'contraindicación': ['contraindicacion', 'riesgo', 'prohibido', 'no tratar'],
    'complicación': ['complicacion', 'problema', 'emergencia', 'adverso'],
    'embarazo': ['embarazada', 'gestación', 'lactancia'],
    'edema': ['hinchazón', 'inflamación', 'hinchado'],
}

# Keywords que indican intención específica
INTENT_KEYWORDS: Dict[str, List[str]] = {
    'comparacion': ['comparar', 'diferencia', 'versus', 'mejor', 'cuál', 'cual', 'elegir', 'entre', 'profhilo', 'juvederm'],
    'protocolo': ['protocolo', 'técnica', 'aplicar', 'inyectar', 'sesiones', 'cánula', 'aguja', 'vlift', 'dlift'],
    'precio': ['precio', 'costo', 'coste', 'caro', 'barato', 'económico', 'vale', 'cuesta', 'descuento'],
    'indicacion': ['indicado', 'indicación', 'sirve', 'usar', 'recomendar', 'paciente', 'zona'],
    'seguridad': ['contraindicación', 'contraindicacion', 'seguro', 'riesgo', 'embarazo', 'herpes', 'anticoagulante'],
    'complicaciones': ['complicación', 'edema', 'nódulo', 'vascular', 'hialuronidasa', 'disolver', 'emergencia'],
    'productos': ['biopro', 'fbio', 'light', 'medium', 'volume', 'dvs', 'biomodulador', 'relleno'],
}

# Frases de consulta comunes que mapean a preguntas específicas de la KB
QUERY_PATTERNS: Dict[str, List[str]] = {
    'protocolo': ['cómo se aplica', 'como se aplica', 'protocolo v-lift', 'protocolo d-lift',
                  'cuántas sesiones', 'qué aguja', 'técnica de inyección'],
    'productos': ['qué es biopro', 'que es biopro', 'diferencia light medium volume',
                  'qué producto uso', 'que producto uso'],
}


class RAGEngine:
    """Motor de búsqueda RAG mejorado con stemming, sinónimos y búsqueda híbrida"""

    def __init__(self, knowledge_base_path: str):
        self.qa_pairs = []
        self.embeddings = []
        self.vocab = []
        self.word_to_idx = {}
        self.idf = {}
        self.stemmer = SpanishStemmer()

        # Índice invertido para búsqueda por keywords
        self.keyword_index: Dict[str, Set[int]] = {}

        self.load_knowledge_base(knowledge_base_path)
        self.compute_embeddings()
        self.build_keyword_index()

    def load_knowledge_base(self, path: str):
        """Carga la base de conocimiento desde JSON"""
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        self.qa_pairs = data['qa_pairs']
        print(f"[RAG] Cargadas {len(self.qa_pairs)} preguntas")

    def _normalize(self, text: str) -> str:
        """Normaliza texto: minúsculas, sin acentos para búsqueda"""
        text = text.lower()
        # Preservar acentos en el texto pero normalizar para búsqueda
        replacements = {
            'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u',
            'ü': 'u', 'ñ': 'n'
        }
        for acc, plain in replacements.items():
            text = text.replace(acc, plain)
        return text

    def _tokenize(self, text: str, apply_stemming: bool = True) -> List[str]:
        """Tokeniza texto con normalización y stemming opcional"""
        text = self._normalize(text)
        text = re.sub(r'[^\w\s]', ' ', text)
        words = text.split()

        stopwords = {
            'el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una',
            'y', 'a', 'que', 'es', 'por', 'para', 'con', 'se', 'su',
            'al', 'lo', 'como', 'mas', 'pero', 'sus', 'le', 'ya', 'o',
            'que', 'como', 'cual', 'cuales', 'donde', 'cuando', 'si',
            'no', 'muy', 'sin', 'sobre', 'este', 'esta', 'esto', 'eso',
            'mi', 'tu', 'me', 'te', 'nos', 'les', 'tiene', 'hay'
        }

        tokens = [w for w in words if w not in stopwords and len(w) > 2]

        if apply_stemming:
            tokens = [self.stemmer.stem(w) for w in tokens]

        return tokens

    def _expand_query(self, query: str) -> str:
        """Expande la query con sinónimos"""
        words = self._tokenize(query, apply_stemming=False)
        expanded = list(words)

        for word in words:
            word_lower = word.lower()
            if word_lower in SYNONYMS:
                expanded.extend(SYNONYMS[word_lower][:3])  # Max 3 sinónimos por palabra

        return ' '.join(expanded)

    def build_keyword_index(self):
        """Construye índice invertido para búsqueda por keywords"""
        for i, qa in enumerate(self.qa_pairs):
            text = qa['pregunta'] + ' ' + qa['respuesta']
            tokens = set(self._tokenize(text, apply_stemming=False))
            tokens_stemmed = set(self._tokenize(text, apply_stemming=True))
            all_tokens = tokens | tokens_stemmed

            for token in all_tokens:
                if token not in self.keyword_index:
                    self.keyword_index[token] = set()
                self.keyword_index[token].add(i)

        print(f"[RAG] Índice de keywords: {len(self.keyword_index)} términos únicos")

    def compute_embeddings(self):
        """Calcula embeddings TF-IDF para todas las Q&A"""
        documents = [qa['pregunta'] + ' ' + qa['respuesta'] for qa in self.qa_pairs]

        # Construir vocabulario con stemming
        all_words = []
        for doc in documents:
            all_words.extend(self._tokenize(doc))

        self.vocab = list(set(all_words))
        self.word_to_idx = {word: idx for idx, word in enumerate(self.vocab)}

        # Calcular IDF
        doc_freq = Counter()
        for doc in documents:
            unique_words = set(self._tokenize(doc))
            for word in unique_words:
                doc_freq[word] += 1

        n_docs = len(documents)
        self.idf = {word: math.log(n_docs / (freq + 1)) for word, freq in doc_freq.items()}

        # Calcular embeddings
        self.embeddings = []
        for doc in documents:
            vec = self._get_vector(doc)
            self.embeddings.append(vec)

        print(f"[RAG] Embeddings calculados: {len(self.vocab)} palabras en vocabulario")

    def _get_vector(self, text: str) -> np.ndarray:
        """Obtiene vector TF-IDF de un texto"""
        words = self._tokenize(text)
        tf = Counter(words)
        vec = np.zeros(len(self.vocab))
        for word, count in tf.items():
            if word in self.word_to_idx:
                vec[self.word_to_idx[word]] = count * self.idf.get(word, 0)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec

    def _keyword_search(self, query: str, top_k: int = 10) -> List[Tuple[int, float]]:
        """Búsqueda por keywords con boost por coincidencias múltiples"""
        tokens = set(self._tokenize(query, apply_stemming=False))
        tokens_stemmed = set(self._tokenize(query, apply_stemming=True))
        all_tokens = tokens | tokens_stemmed

        # Palabras clave de alta importancia (boost extra)
        high_value_terms = {'biopro', 'fbio', 'dvs', '3dvs', 'biomodulador',
                           'lifting', 'relleno', 'protocolo', 'precio'}

        # Expandir con sinónimos
        expanded_tokens = set(all_tokens)
        for token in list(all_tokens):
            if token in SYNONYMS:
                expanded_tokens.update(SYNONYMS[token][:3])  # más sinónimos

        # Contar matches por documento
        doc_scores: Dict[int, float] = {}
        for token in expanded_tokens:
            if token in self.keyword_index:
                for doc_idx in self.keyword_index[token]:
                    if doc_idx not in doc_scores:
                        doc_scores[doc_idx] = 0
                    # Boost para tokens originales vs sinónimos
                    boost = 2.0 if token in all_tokens else 1.0
                    # Boost extra para términos de alta importancia
                    if token in high_value_terms:
                        boost *= 1.5
                    doc_scores[doc_idx] += boost

        # Boost adicional por coincidencia directa en pregunta
        query_normalized = self._normalize(query)
        for i, qa in enumerate(self.qa_pairs):
            pregunta_norm = self._normalize(qa['pregunta'])
            # Si palabras clave de la query aparecen en la pregunta
            matches = sum(1 for t in all_tokens if t in pregunta_norm and len(t) > 3)
            if matches > 0 and i in doc_scores:
                doc_scores[i] *= (1 + matches * 0.3)

        # Normalizar scores
        if doc_scores:
            max_score = max(doc_scores.values())
            doc_scores = {k: v / max_score for k, v in doc_scores.items()}

        # Ordenar por score
        sorted_docs = sorted(doc_scores.items(), key=lambda x: x[1], reverse=True)
        return sorted_docs[:top_k]

    def _detect_intent(self, query: str) -> Optional[str]:
        """Detecta la intención de la query basado en keywords"""
        query_lower = self._normalize(query)

        # Primero verificar patrones de query completos
        for intent, patterns in QUERY_PATTERNS.items():
            for pattern in patterns:
                if self._normalize(pattern) in query_lower:
                    return intent

        for intent, keywords in INTENT_KEYWORDS.items():
            for kw in keywords:
                if kw in query_lower:
                    return intent
        return None

    def search(self, query: str, top_k: int = 5, categories: Optional[List[str]] = None) -> List[Tuple[dict, float]]:
        """
        Búsqueda híbrida: TF-IDF + keywords + expansión de sinónimos.

        Args:
            query: Texto de búsqueda
            top_k: Número de resultados
            categories: Lista de categorías para filtrar (None = todas)

        Returns:
            Lista de (qa_pair, score)
        """
        # 1. Expandir query con sinónimos
        expanded_query = self._expand_query(query)

        # 2. Búsqueda TF-IDF con query expandida
        query_vec = self._get_vector(expanded_query)

        tfidf_results = []
        for i, (qa, emb) in enumerate(zip(self.qa_pairs, self.embeddings)):
            if categories and qa['categoria'] not in categories:
                continue
            score = float(np.dot(query_vec, emb))
            tfidf_results.append((i, score))

        # 3. Búsqueda por keywords
        keyword_results = self._keyword_search(query, top_k=top_k * 2)
        keyword_dict = dict(keyword_results)

        # 4. Combinar scores (híbrido)
        # TF-IDF tiene más peso pero keywords ayuda cuando TF-IDF falla
        combined_scores: Dict[int, float] = {}

        # Detectar intent una vez
        intent = self._detect_intent(query)

        for i, tfidf_score in tfidf_results:
            keyword_score = keyword_dict.get(i, 0)
            # Ponderación: 60% TF-IDF, 40% keywords
            combined = (tfidf_score * 0.6) + (keyword_score * 0.4)

            qa = self.qa_pairs[i]

            # Boost adicional si coincide con categoría de intent detectado
            if intent:
                category = qa.get('categoria', '')
                if intent in category or any(kw in category for kw in INTENT_KEYWORDS.get(intent, [])):
                    combined *= 1.2

            # Boost especial para intent de concentración: buscar en pregunta/respuesta
            if intent == 'concentracion':
                pregunta_norm = self._normalize(qa['pregunta'])
                respuesta_norm = self._normalize(qa['respuesta'])
                if 'concentracion' in pregunta_norm:
                    combined = max(combined * 4.0, 0.5)  # boost muy significativo
                elif 'concentrado' in pregunta_norm or 'potente' in pregunta_norm:
                    combined = max(combined * 3.0, 0.4)
                elif 'concentracion' in respuesta_norm or 'concentrado' in respuesta_norm:
                    combined *= 2.0

            combined_scores[i] = combined

        # 5. Ordenar y devolver top_k
        sorted_results = sorted(combined_scores.items(), key=lambda x: x[1], reverse=True)

        results = []
        for i, score in sorted_results[:top_k]:
            if categories and self.qa_pairs[i]['categoria'] not in categories:
                continue
            results.append((self.qa_pairs[i], score))

        return results[:top_k]

    def get_categories(self) -> List[str]:
        """Retorna todas las categorías disponibles"""
        return list(set(qa['categoria'] for qa in self.qa_pairs))


# Singleton del motor RAG
_rag_instance = None

def get_rag_engine() -> RAGEngine:
    """Obtiene la instancia singleton del RAG"""
    global _rag_instance
    if _rag_instance is None:
        base_path = os.path.dirname(os.path.dirname(__file__))
        kb_path = os.path.join(base_path, 'knowledge_base.json')
        _rag_instance = RAGEngine(kb_path)
    return _rag_instance

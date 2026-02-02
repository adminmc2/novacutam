"""
Clase base para todos los agentes
"""
from typing import List, Tuple, Optional
from abc import ABC, abstractmethod
from .rag_engine import get_rag_engine


class BaseAgent(ABC):
    """Clase base abstracta para agentes especializados"""

    def __init__(self):
        self.rag = get_rag_engine()
        self.name = "BaseAgent"
        self.description = ""
        self.categories = []  # Categorías del RAG que este agente maneja

    @property
    @abstractmethod
    def system_prompt(self) -> str:
        """Prompt de sistema específico del agente"""
        pass

    def search_knowledge(self, query: str, top_k: int = 5) -> List[Tuple[dict, float]]:
        """Busca en la base de conocimiento filtrado por las categorías del agente"""
        return self.rag.search(query, top_k=top_k, categories=self.categories if self.categories else None)

    def search_knowledge_with_fallback(self, query: str, top_k: int = 5,
                                       score_threshold: float = 0.25) -> List[Tuple[dict, float]]:
        """Búsqueda dual: primero filtrada por categorías, si no hay buenos resultados busca sin filtro"""

        # 1. Búsqueda filtrada por categorías del agente
        filtered_results = self.rag.search(
            query, top_k=top_k,
            categories=self.categories if self.categories else None
        )

        # 2. Evaluar calidad
        best_score = max((score for _, score in filtered_results), default=0.0)

        if best_score >= score_threshold:
            return filtered_results  # Buenos resultados, usar filtrados

        # 3. Fallback activado — log para métricas
        print(f"[FALLBACK] Query: '{query[:50]}' | Score: {best_score:.2f} | Agent: {self.name}")

        # 4. Búsqueda SIN filtro de categorías
        unfiltered_results = self.rag.search(query, top_k=top_k, categories=None)

        # 5. Combinar: boost 1.1x a resultados de categorías nativas
        combined = {}
        for qa, score in unfiltered_results:
            combined[qa['pregunta']] = (qa, score)

        for qa, score in filtered_results:
            key = qa['pregunta']
            if key in combined:
                combined[key] = (qa, max(score * 1.1, combined[key][1]))
            else:
                combined[key] = (qa, score)

        results = sorted(combined.values(), key=lambda x: x[1], reverse=True)
        return results[:top_k]

    def enrich_context(self, query: str, results: List[Tuple[dict, float]]) -> str:
        """Enriquece el contexto RAG con conocimiento estructurado del agente.
        Override en subclases para aportar inteligencia específica."""
        return ""

    def format_context(self, results: List[Tuple[dict, float]], min_score: float = 0.1) -> str:
        """Formatea los resultados de búsqueda como HECHOS VERIFICADOS numerados para el LLM"""
        context_parts = []
        fact_num = 1

        for qa, score in results:
            if score >= min_score:
                context_parts.append(
                    f"HECHO VERIFICADO #{fact_num} (confianza: {score:.0%}):\n"
                    f"  Producto/Tema: {qa['pregunta']}\n"
                    f"  Datos confirmados: {qa['respuesta']}"
                )
                fact_num += 1

        if not context_parts:
            return "NO HAY DATOS VERIFICADOS para esta consulta. NO inventes ningún dato."

        header = (
            "═══ DATOS VERIFICADOS DE NOVACUTAN ═══\n"
            "IMPORTANTE: Solo los datos listados abajo son REALES y VERIFICADOS.\n"
            "Cualquier dato que NO esté aquí abajo es INVENTADO y está PROHIBIDO usarlo.\n\n"
        )
        return header + "\n\n".join(context_parts)

    def get_response_prompt(self, query: str, context: str) -> str:
        """Construye el prompt completo con contexto"""
        return f"""{self.system_prompt}

CONTEXTO DE LA BASE DE CONOCIMIENTO:
{context}

---
PREGUNTA DEL USUARIO: {query}

Responde basándote ÚNICAMENTE en el contexto proporcionado."""

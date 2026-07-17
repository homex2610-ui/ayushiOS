# Project Guidelines

## AI / ML Constraint

- Do not use any LLMs, AI APIs, neural networks, embeddings, vector databases, semantic search, or runtime model inference.
- Do not add OpenAI, Ollama, Gemini, Claude, Groq, HuggingFace, or similar dependencies.
- All intelligence in this project must be implemented using deterministic algorithms and code.
- Implement planning, navigation, memory, decision-making, learning, and reasoning using traditional software engineering techniques such as behavior trees, finite state machines, hierarchical task networks (HTN), GOAP (Goal-Oriented Action Planning), utility AI, graph search, rule engines, and persistent world knowledge.
- The bot must become more capable over time by storing structured information (JSON/SQLite/files), not by using machine learning or external model inference.
- The root project should not include active LLM or external inference dependencies by default. Keep `settings.enable_llm` disabled unless explicitly enabling an experimental model path for research only.
- The final project must remain fully offline and runnable without any internet connection or AI model.

## Recommended Architecture for Ayushi

- Use a persistent World Knowledge Graph or equivalent structured memory store for waypoints, NPCs, warps, regions, chests, player relationships, and discovered server-specific information.
- Use deterministic, rule-based planners such as GOAP plus behavior trees, HTN, or utility AI. These should be the core of the decision-making system.
- Use graph-based navigation for pathfinding and route planning, with annotations for safety, travel cost, and shortcuts.
- Use deterministic perception first: parse in-game metadata (packets, entity data, GUI titles, chat text, sign text) and only use local OCR/vision heuristics if necessary.
- Prefer explicit code over implicitly learned behavior. If the bot needs to improve, do so by updating rules, state, and persistent memory rather than by adding model inference.

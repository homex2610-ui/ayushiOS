const settings = {
    "minecraft_version": "1.21.11", // Match Docker server version
    "host": "127.0.0.1",
    "port": 59446,
    "auth": "offline", // "offline" for cracked servers / singleplayer LAN; "microsoft" for premium servers
    "password": process.env.MC_PASSWORD || "", // Password for auto-/register and /login (AuthMe, etc.)

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens dashboard in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./andy.json",
        // "./player2_guide.json", // companion bot — needs llamacpp on :4315; re-enable when running it
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": true, // load memory from previous session (continues where bot left off)
    "init_message": null, // sends to all on spawn (null = no message, avoids drawing attention)
    "only_chat_with": ["updesh"], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": true, // show bot's view in browser at localhost:3000, 3001... (dashboard vision)

    "fabric_compat": true, // disable Fabric mod declarations for vanilla cracked servers
    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 3, // max msgs in context (reduced to save tokens ~70%)
    "num_examples": 0, // no examples (saves tokens)
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "none", // "full", "shortened", or "none" — "none" hides all command text from chat
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 60, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 300, // delay between placing blocks (ms) — helps avoid anti-cheat kicks. 150ms mimics human reaction time.
  
    "log_all_prompts": false, // log ALL prompts to file

    // Baby AI / Curiosity Engine
    "enable_curiosity": true, // enabled - learns from environment
    "enable_deep_awareness": true, // enabled - world awareness

    // Advanced Brain Systems — all enabled (no API cost, runs locally)
    "enable_emotions": true,
    "enable_goal_planner": true,
    "enable_relationships": true,
    "enable_knowledge_graph": true,
    "enable_episodic_replay": true,
    "enable_reflection": true,
    "enable_skill_learning": true,
    "enable_meta_learning": true,

    // LLM — disable to run code-only (BT + intent pipeline + task queue only)
    "enable_llm": false, // false = no LLM calls at all; relies on BT, intent pipeline, and canned responses

    // Behavior Tree AI — replaces LLM per-tick decisions with utility scoring
    "bt_enabled": false, // P0-4: BT strategic brain DISABLED — ExecutiveBrain is sole strategist. SpinalCord owns reflexes. Set true only for legacy debugging.
    "bt_log": false, // verbose BT decision logging

    // Connection & World Management
    "connection_prefer_lan": true, // scan LAN (127.0.0.1) first for local worlds before using configured SMP
    "connection_auto_fallback": true, // fall back to public SMP if LAN unavailable
    "connection_auto_reconnect": true, // auto reconnect on disconnect
    "connection_auto_detect_hub": false, // disabled - connect directly, let bot work even in hub spawn

    // Intent Pipeline
    "enable_intent_pipeline": true, // use intent parser + task queue for 90% of requests
    "enable_fast_reply": true, // instant 200-500ms acknowledgments
    "enable_task_queue": true, // persistent task queue surviving restarts

    // Terminal Console
    "enable_terminal_console": true, // enable stdin terminal for bot control
    "terminal_console_prefix": "/", // prefix for terminal commands

    "enable_brain": true, // AyushiOS autonomous brain (need/emotion/personality system)
    "auto_task": true, // every run starts with the standing goal (tasks/iron_armor.json; override via auto_task_file)
    "auto_task_file": "./tasks/iron_armor_house.json", // combined goal: iron armor + small house

    "goal_plan_interval": 120000, // ms between autonomous plan cycles
    "episodic_replay_interval": 1500000, // ms between memory consolidation (~25min)
    "reflection_interval": 3600000, // ms between reflections (1hr)
    "meta_learning_interval": 1200000, // ms between meta-learning (~20min)
};

export default settings;

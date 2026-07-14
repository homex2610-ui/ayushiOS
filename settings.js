const settings = {
    "minecraft_version": "auto", // "auto" detects version; or set a specific version like "1.21.4"
    "host": "play.driftsmp.net", // server IP: "localhost", "your.ip.address.here", or "play.example.com"
    "port": 25565, // -1 auto-scans LAN; set specific port for servers (e.g. 25565)
    "auth": "offline", // "offline" for cracked servers / singleplayer LAN; "microsoft" for premium servers
    "password": "ayushi_ds_2026", // Password for auto-/register and /login (AuthMe, etc.)

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./andy.json",
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
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 6, // max number of messages to keep in context (reduced to save tokens)
    "num_examples": 1, // number of examples to give to the model (reduced to save tokens)
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "none", // "full", "shortened", or "none" — "none" hides all command text from chat
    "narrate_behavior": false, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 150, // delay between placing blocks (ms) — helps avoid anti-cheat kicks. 150ms mimics human reaction time.
  
    "log_all_prompts": false, // log ALL prompts to file

    // Baby AI / Curiosity Engine
    "enable_curiosity": false, // disabled to save tokens (bot explores and sets random goals)
    "enable_deep_awareness": true, // bot tracks surroundings ($WORLD_AWARE)

    // Advanced Brain Systems
    "enable_emotions": true, // internal emotion state influences decisions
    "enable_goal_planner": false, // disabled to save tokens (autonomous goal generation every 2min)
    "enable_relationships": false, // disabled to save tokens (track player relationships)
    "enable_knowledge_graph": false, // disabled to save tokens (relational triple memory)
    "enable_episodic_replay": false, // disabled to save tokens (memory consolidation every 25min)
    "enable_reflection": false, // disabled to save tokens (hourly self-reflection)
    "enable_skill_learning": false, // disabled to save tokens (learn new skills)
    "enable_meta_learning": false, // disabled to save tokens (strategy improvement)

    "goal_plan_interval": 120000, // ms between autonomous plan cycles
    "episodic_replay_interval": 1500000, // ms between memory consolidation (~25min)
    "reflection_interval": 3600000, // ms between reflections (1hr)
    "meta_learning_interval": 1200000, // ms between meta-learning (~20min)
};

export default settings;